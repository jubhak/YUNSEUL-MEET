# -*- coding: utf-8 -*-
"""
server/face_swap_worker.py - YUNSEUL-PPT Deep-Live-Cam 실시간 페이스 스왑 워커
- InsightFace + inswapper_128_fp16.onnx 모델 상시 로드
- WebSocket (ws://...:8765/ws) 및 HTTP POST (/api/swap-frame) 동시 지원
- photo/ 폴더의 인물 사진 임베딩 자동 캐싱 (사진 업로드 기능은 제거됨)

[v2 개선 요약]
- 인프로세스 "모델 인스턴스 풀": 스레드마다 독립 ONNX 세션(검출+스왑)을 가져 GPU 동시성을 확보
  (기존: 세션 1개를 스레드 2개가 공유 → 사실상 직렬. VRAM 은 남는데 GPU/CPU 는 놀았다)
- 프로토콜 v2: 요청에 seq 를 실어 보내고(이름 뒤 \\x1f seq), 응답은 b'FS2\\0'+seq+처리시간 헤더 + JPEG
  → 클라이언트가 순서/지연을 알고 파이프라이닝(depth 2)과 재생 버퍼를 쓸 수 있다.
  구 클라이언트(v1: 이름만 전송)는 그대로 순수 JPEG 응답을 받는다(하위 호환).
- 오래 기다린 프레임은 GPU 에 올리지 않고 폐기(drop) → 과부하 시 지연 누적 방지
- /stats 에 GPU 사용률/VRAM/처리량/드랍 수 노출
"""

import os
import sys
import time
import json
import struct
import logging
import uuid
import threading
import collections
import multiprocessing as mp
import queue as queue_mod
from pathlib import Path

# Windows 콘솔 인코딩 보호
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT_DIR = Path(__file__).resolve().parents[1]
DLC_DIR = ROOT_DIR / "deep-live-cam"
PHOTO_DIR = ROOT_DIR / "photo"

if str(DLC_DIR) not in sys.path:
    sys.path.insert(0, str(DLC_DIR))
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# ONNX Runtime / OpenMP 스레드 수를 워커당 1~2로 제한한다.
# 워커(추론 프로세스)를 여러 개 띄울 때 각 프로세스가 CPU 전 코어를 잡으면
# 스레드 스래싱으로 총 처리량이 오히려 떨어진다. 반드시 onnxruntime/cv2
# import 이전에 설정해야 하므로 여기(최상단 주입부)에서 처리한다.
if os.environ.get("FACE_SWAP_SET_THREADS", "1") == "1":
    _thr = str(int(os.environ.get("FACE_SWAP_OMP_THREADS", "2")))
    for _k in ("OMP_NUM_THREADS", "ORT_NUM_THREADS", "MKL_NUM_THREADS",
               "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(_k, _thr)

import cv2
import numpy as np
import asyncio
from aiohttp import web

import modules.globals

# GPU 실행 프로바이더 선택
# CUDA를 최우선으로 사용한다: CUDA는 동일 세션에 대한 동시(멀티스레드/멀티프로세스) 추론
# 호출을 공식 지원하므로, DirectML처럼 전역 락(dml_lock)으로 완전 직렬화할 필요가 없다.
# RTX 계열 카드는 CUDA 실행 provider(onnxruntime-gpu + CUDA/cuDNN)가 설치되어 있으면
# DirectML보다 이 워크로드에서 유리하다. CUDA가 없는 환경(예: CUDA 미설치, 다른 GPU
# 벤더)에서는 DirectML로, 그것도 없으면 CPU로 자동 폴백한다.
_avail_providers = []
try:
    import onnxruntime as ort
    _all_avail = ort.get_available_providers()
    if "CUDAExecutionProvider" in _all_avail:
        _avail_providers.append("CUDAExecutionProvider")
    elif "DmlExecutionProvider" in _all_avail:
        _avail_providers.append("DmlExecutionProvider")
except Exception:
    pass
_avail_providers.append("CPUExecutionProvider")
modules.globals.execution_providers = _avail_providers
USING_CUDA = "CUDAExecutionProvider" in _avail_providers

from modules.face_analyser import get_face_analyser, get_one_face, detect_one_face_fast, detect_many_faces_fast
from modules.processors.frame.face_swapper import get_face_swapper, swap_face

logging.basicConfig(level=logging.INFO, format="[FaceSwapWorker] %(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("FaceSwapWorker")
logger.info(f"Initialized ONNX execution providers: {modules.globals.execution_providers}")

PORT = int(os.environ.get("FACE_SWAP_PORT", 8765))
HOST = os.environ.get("FACE_SWAP_HOST", "0.0.0.0")

# 소스 사진 임베딩 캐시: { "superman": Face, "batman": Face, ... }
SOURCE_FACE_CACHE = {}


def load_source_face(source_name_or_path: str):
    """지정된 이름이나 경로의 소스 얼굴을 로드하고 캐시합니다."""
    key = str(source_name_or_path).strip().lower()
    if key in SOURCE_FACE_CACHE:
        return SOURCE_FACE_CACHE[key]

    # 후보 경로 탐색
    candidates = [
        PHOTO_DIR / f"{key}.jpg",
        PHOTO_DIR / f"{key}.jpeg",
        PHOTO_DIR / f"{key}.png",
        PHOTO_DIR / f"{key}.webp",
        PHOTO_DIR / source_name_or_path,
        ROOT_DIR / source_name_or_path,
        Path(source_name_or_path),
    ]

    found_path = None
    for cand in candidates:
        if cand.exists() and cand.is_file():
            found_path = cand
            break

    if not found_path:
        logger.warning(f"Source photo not found: {source_name_or_path}")
        return None

    try:
        # cv2.imread Unicode 안전 로딩
        stream = open(str(found_path), "rb")
        bytes_data = bytearray(stream.read())
        stream.close()
        numpy_array = np.asarray(bytes_data, dtype=np.uint8)
        img = cv2.imdecode(numpy_array, cv2.IMREAD_COLOR)
        if img is None:
            logger.error(f"Image decode failed: {found_path}")
            return None

        face = get_one_face(img)
        if face is None:
            logger.warning(f"No face detected in: {found_path}")
            return None

        SOURCE_FACE_CACHE[key] = face
        SOURCE_FACE_CACHE[found_path.stem.lower()] = face
        SOURCE_FACE_CACHE[found_path.name.lower()] = face
        logger.info(f"Source face loaded & cached: {found_path.name}")
        return face
    except Exception as e:
        logger.error(f"Error loading source face: {e}")
        return None


def preload_all_photos():
    """photo/ 폴더에 있는 모든 기본 사진들을 사전 로드합니다."""
    if not PHOTO_DIR.exists():
        return
    for f in PHOTO_DIR.iterdir():
        if f.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp"]:
            try:
                load_source_face(f.name)
            except Exception as e:
                logger.warning(f"Preload skipped: {f.name} ({e})")


def precision_beauty_skin(frame: np.ndarray, target_face=None) -> np.ndarray:
    """
    초고화질 정밀 피부 보정 필터:
    - 머리카락, 안경테, 눈/동공, 속눈썹, 입술, 의상, 배경 등은 100% 원본 선명도를 유지하며 추가 언샵 마스크로 또렷하게 살림
    - 얼굴 피부(이마, 뺨, 턱, 눈밑 주름) 영역만 YCrCb 피부색 및 랜드마크 기반으로 정밀 마스킹하여 잔주름만 부드럽게 완화
    - 뿌옇거나 하얗게 뜨는 인위적인 안개(Fog) 효과를 완전히 제거하고 자연스러운 피부결 유지
    """
    try:
        h, w = frame.shape[:2]
        crisp = cv2.addWeighted(frame, 1.20, cv2.GaussianBlur(frame, (0, 0), 1.5), -0.20, 0)

        face = target_face
        if face is None:
            face = detect_one_face_fast(frame)
        if face is None:
            return crisp

        # 1. YCrCb 피부색 마스크 (머리카락, 눈, 배경 자동 배제)
        ycrcb = cv2.cvtColor(frame, cv2.COLOR_BGR2YCrCb)
        skin_mask = cv2.inRange(ycrcb, (0, 133, 77), (255, 173, 127))

        # 2. 얼굴 BBox 영역 제한 및 헤어라인(이마 위쪽 머리카락) 배제
        bx1, by1, bx2, by2 = face.bbox.astype(int)
        face_roi = np.zeros((h, w), dtype=np.uint8)
        hairline_y = int(by1 + 0.22 * (by2 - by1))
        face_roi[max(0, hairline_y):min(h, by2), max(0, bx1):min(w, bx2)] = 255
        skin_mask = cv2.bitwise_and(skin_mask, face_roi)

        # 3. 눈과 입술 영역 보호 (선명도 유지)
        if hasattr(face, 'kps') and face.kps is not None and len(face.kps) >= 5:
            eye_r = int(0.09 * (bx2 - bx1))
            cv2.circle(skin_mask, (int(face.kps[0][0]), int(face.kps[0][1])), eye_r, 0, -1)
            cv2.circle(skin_mask, (int(face.kps[1][0]), int(face.kps[1][1])), eye_r, 0, -1)
            mouth_cx = int((face.kps[3][0] + face.kps[4][0]) / 2)
            mouth_cy = int((face.kps[3][1] + face.kps[4][1]) / 2)
            cv2.ellipse(skin_mask, (mouth_cx, mouth_cy), (int(eye_r * 1.6), eye_r), 0, 0, 360, 0, -1)

        # 부드러운 경계 페더링
        feathered_mask = cv2.GaussianBlur(skin_mask, (15, 15), 4).astype(np.float32) / 255.0
        feathered_mask = feathered_mask[:, :, np.newaxis]

        # 4. 피부 요철만 정밀 완화 (뿌연 느낌 없이 텍스처와 모공 보존)
        smooth_skin = cv2.bilateralFilter(frame, d=5, sigmaColor=15, sigmaSpace=15)

        # 5. 합성: 피부만 보정, 머리카락/눈/입/배경은 초고선명 유지!
        output = (smooth_skin * feathered_mask + crisp * (1.0 - feathered_mask)).astype(np.uint8)
        return output
    except Exception as e:
        logger.warning(f"Precision beauty error: {e}")
        return frame


# ── 참가자별 최근 스왑 프레임 캐시 ──────────────────────────────
# 키: f"{client_key}|{source_key}"
# 기존 구현은 소스 얼굴 이름만으로 전역 키를 만들었다. 그래서 두 참가자가
# 같은 얼굴(superman 등)을 쓰면 서로의 스왑 프레임을 폴백으로 받아가
# 화면 크로스토크가 발생했다(사생활 보호 관점에서도 치명적).
LAST_SWAPPED_FRAMES = {}
_MAX_CLIENT_CACHE = int(os.environ.get("FACE_SWAP_CACHE_PER_CLIENT", "48"))

# ── 참가자별 얼굴 추적 캐시 ─────────────────────────────────────
# 매 프레임 RetinaFace 전체 검출(640×640, 15~30ms)을 돌리는 것이 10인
# 동시 접속에서 처리량이 무너지는 1순위 원인이었다. 프레임마다가 아니라
# N프레임(FACE_SWAP_DETECT_EVERY)마다 1회만 검출하고 그 사이는 bbox/kps를
# 재사용한다. 재사용 전에 해당 영역 픽셀 변화량을 확인하여 얼굴이 크게
# 움직였거나 다른 사람이 들어오면 즉시 재검출한다.
_TRACK_CACHE = {}
_FRAME_SEQ = collections.Counter()
_DETECT_EVERY = max(1, int(os.environ.get("FACE_SWAP_DETECT_EVERY", "5")))


def _cache_key(client_key: str, source_key: str) -> str:
    return f"{(client_key or 'anon')}|{source_key or 'none'}"


def _cache_get(client_key: str, source_key: str):
    return LAST_SWAPPED_FRAMES.get(_cache_key(client_key, source_key))


def _cache_put(client_key: str, source_key: str, data: bytes):
    if not data:
        return
    k = _cache_key(client_key, source_key)
    if len(LAST_SWAPPED_FRAMES) > _MAX_CLIENT_CACHE and k not in LAST_SWAPPED_FRAMES:
        for kk in list(LAST_SWAPPED_FRAMES.keys())[: max(1, _MAX_CLIENT_CACHE // 4)]:
            LAST_SWAPPED_FRAMES.pop(kk, None)
    LAST_SWAPPED_FRAMES[k] = data


def _blur_faces(frame: np.ndarray, faces) -> np.ndarray:
    """[사생활 보호] 스왑이 실패한 프레임에서 얼굴 영역만 안전하게 가린다."""
    out = frame.copy()
    blurred_any = False
    for tf in faces or []:
        fx1, fy1, fx2, fy2 = [int(v) for v in tf.bbox]
        fx1, fy1 = max(0, fx1), max(0, fy1)
        fx2, fy2 = min(frame.shape[1], fx2), min(frame.shape[0], fy2)
        if fx2 > fx1 + 5 and fy2 > fy1 + 5:
            roi = out[fy1:fy2, fx1:fx2]
            kw = max(15, min(99, ((fx2 - fx1) // 2) * 2 + 1))
            kh = max(15, min(99, ((fy2 - fy1) // 2) * 2 + 1))
            out[fy1:fy2, fx1:fx2] = cv2.GaussianBlur(roi, (kw, kh), 30)
            blurred_any = True
    if not blurred_any:
        out = cv2.GaussianBlur(frame, (99, 99), 30)
    return out


def _track_faces(frame: np.ndarray, client_key: str):
    """추적 기반 얼굴 검출 (검출 횟수를 1/N로 축소)."""
    from insightface.app.common import Face

    seq = _FRAME_SEQ[client_key] + 1
    _FRAME_SEQ[client_key] = seq
    cached = _TRACK_CACHE.get(client_key)

    reuse = False
    if cached and (seq % _DETECT_EVERY) != 0:
        bx1, by1, bx2, by2 = cached["bbox"]
        h, w = frame.shape[:2]
        x1, y1 = max(0, int(bx1)), max(0, int(by1))
        x2, y2 = min(w, int(bx2)), min(h, int(by2))
        if x2 - x1 > 12 and y2 - y1 > 12:
            try:
                patch = cv2.resize(frame[y1:y2, x1:x2], (16, 16),
                                   interpolation=cv2.INTER_AREA).astype(np.float32)
                ref = cached.get("patch")
                if ref is None:
                    reuse = True
                else:
                    # 조명/미세 움직임은 diff가 작고, 자리 이동·다른 사람 등장은 크다
                    reuse = float(np.mean(np.abs(patch - ref))) < 18.0
                cached["patch"] = patch
            except Exception:
                reuse = False

    if reuse:
        return [Face(bbox=np.asarray(cached["bbox"], dtype=np.float32),
                     kps=np.asarray(cached["kps"], dtype=np.float32),
                     det_score=float(cached.get("det_score", 0.9)))]

    faces = detect_many_faces_fast(frame)
    if not faces:
        _TRACK_CACHE.pop(client_key, None)
        return []

    # 실시간 라이브: 가장 큰 얼굴 1명 (다중 얼굴 스왑은 지연 폭증)
    faces = sorted(
        faces,
        key=lambda f: (float(f.bbox[2]) - float(f.bbox[0])) * (float(f.bbox[3]) - float(f.bbox[1])),
        reverse=True,
    )[:1]
    f = faces[0]
    bx1, by1, bx2, by2 = [float(v) for v in f.bbox]
    h, w = frame.shape[:2]
    x1, y1 = max(0, int(bx1)), max(0, int(by1))
    x2, y2 = min(w, int(bx2)), min(h, int(by2))
    patch = None
    if x2 - x1 > 12 and y2 - y1 > 12:
        try:
            patch = cv2.resize(frame[y1:y2, x1:x2], (16, 16),
                               interpolation=cv2.INTER_AREA).astype(np.float32)
        except Exception:
            patch = None
    _TRACK_CACHE[client_key] = {
        "bbox": [bx1, by1, bx2, by2],
        "kps": np.asarray(f.kps, dtype=np.float32),
        "det_score": float(getattr(f, "det_score", 0.9) or 0.9),
        "patch": patch,
    }
    return [f]

# ----------------------------------------------------
# 동시 접속자(딥페이크 활성 참가자) 수 기반 적응형 스로틀링
#
# 이 프로세스는 얼굴 검출/스왑용 ONNX 세션을 단 하나만 들고 있고,
# DirectML 사용 시 modules.globals.dml_lock 이 모든 검출/스왑 호출을
# 전역적으로 완전 직렬화한다 (DML 세션이 멀티스레드 동시 Run()을
# 지원하지 않기 때문에 필요한 락). 즉 참가자가 늘어나도 처리량 자체는
# 늘지 않고, 참가자 수만큼 순서를 기다리는 줄만 길어진다.
#
# 따라서 참가자 1명일 때는 고해상도/고fps로 처리하고, 참가자가 늘어날
# 수록 처리 해상도와 클라이언트의 요청 fps를 함께 낮춰서, "동시 처리
# 총량"이 실시간 예산(약 33~50ms/frame)을 넘지 않도록 맞춘다.
# ----------------------------------------------------
CONNECTED_WS = set()
FS2_MAGIC = b"FS2\x00"   # v2 응답 헤더: magic(4) + seq(u32) + procMs(u16) + totalMs(u16) + JPEG
INFERENCE_SEMAPHORE = asyncio.Semaphore(3)  # (비풀 모드) 동시 추론 상한
WORKER_COUNT_EFFECTIVE = 0  # start_server 에서 확정

# ── 처리 지연 실측 기반 백프레셔 ────────────────────────────────
# 기존 구현은 "접속자 수"만 보고 고정 표로 fps를 낮췄다(10명이면 8fps).
# 하지만 8fps × 10명 = 80fps 요구인데 워커 2개 처리능력은 ~30fps →
# 여전히 큐가 무너져 프레임 드랍 폭주 → 화면 정지가 반복된다.
# 실제로 중요한 값은 "프레임 1장 처리에 걸리는 실측 시간"이므로,
# p50/p90 지연과 워커 수로 초당 처리능력을 계산해 요청 fps를 그 예산
# 안으로 되돌린다(과부하 자동 강하 / 여유 시 자동 상향).
_LATENCY_SAMPLES = collections.deque(maxlen=60)


def record_latency(ms: float):
    # 모델 웜업 및 첫 임베딩 추출 스파이크(> 500ms)는 백프레셔 통계를 오염시키므로 제외
    if ms and 5.0 <= ms <= 500.0:
        _LATENCY_SAMPLES.append(float(ms))


def _latency_percentile(p: float = 0.5) -> float:
    if not _LATENCY_SAMPLES:
        return 40.0  # 기본 정상 추론 시간 가정 (약 25 FPS)
    vals = sorted(_LATENCY_SAMPLES)
    idx = min(len(vals) - 1, max(0, int(round((len(vals) - 1) * p))))
    return vals[idx]


def get_adaptive_profile(n_clients: int) -> dict:
    """활성 클라이언트 수 + 실측 지연 + 워커 수로
    처리 해상도 상한(max_w)과 클라이언트 권고 fps를 계산한다."""
    n = max(1, int(n_clients or 1))
    threads = max(1, _MODEL_THREADS or WORKER_COUNT_EFFECTIVE or WORKER_COUNT)
    p50 = _latency_percentile(0.5)
    p90 = _latency_percentile(0.9)

    # 이론 처리능력: 스레드 수 × (1000/서비스시간). 단, GPU 는 스레드에 비례해 늘지 않으므로(측정: K=4 에서
    # 포화, 1스레드 대비 약 1.3~1.9배) 0.55 를 곱해 보수적으로 잡고, 실측 최고 처리량(EMA)이 더 크면 그것을 신뢰한다.
    service_ms = max(8.0, p50)
    theory_fps = (1000.0 / service_ms) * threads * 0.55
    measured = measured_throughput_fps()
    capacity_fps = max(theory_fps, _PEAK_FPS_EMA)
    # 최근 4초 안에 "대기 초과 폐기"가 여러 번 있었다면 과부하 → 실측 처리량을 기준으로 강하
    now_t = time.time()
    recent_stale = sum(1 for t in _STALE_EVENTS if now_t - t < 4.0)
    if recent_stale >= 3 and measured > 0:
        capacity_fps = min(capacity_fps, max(6.0, measured * 1.05))
    per_client = (capacity_fps * 0.90) / n

    # 참가자 수별 하한(floor)/상한(cap) — 1인 호스트는 절대 끊기지 않게, 다수일수록 fps 를 낮추되
    # 해상도는 예전(320px)처럼 뭉개지 않는다 (스왑 GPU 비용은 프레임 해상도와 무관하게 128px 크롭 기준).
    if n <= 1:
        fps_floor, fps_cap, max_w = 24.0, 30.0, 640
    elif n == 2:
        fps_floor, fps_cap, max_w = 20.0, 26.0, 640
    elif n <= 4:
        fps_floor, fps_cap, max_w = 16.0, 22.0, 640
    elif n <= 7:
        fps_floor, fps_cap, max_w = 12.0, 18.0, 576
    elif n <= 12:
        fps_floor, fps_cap, max_w = 10.0, 15.0, 512
    else:
        fps_floor, fps_cap, max_w = 8.0, 12.0, 448

    fps = float(max(fps_floor, min(fps_cap, per_client)))
    if p90 > 0 and p50 > 0 and p90 > p50 * 2.5:
        fps = max(fps_floor, fps * 0.85)  # 꼬리 지연 완화

    return {
        "max_w": max_w,
        "fps": int(round(fps)),
        "detect_every": _DETECT_EVERY,
        "workers": threads,
        "clients": n,
        "p50_ms": round(p50, 1),
        "p90_ms": round(p90, 1),
        "capacity_fps": round(capacity_fps, 1),
        "measured_fps": round(measured, 1),
    }


_LAST_BROADCAST_N = -1


async def broadcast_throttle():
    """현재 접속자 수에 맞는 fps 캡을 모든 클라이언트에게 알려준다."""
    global _LAST_BROADCAST_N
    n = len(CONNECTED_WS)
    profile = get_adaptive_profile(n)
    if n != _LAST_BROADCAST_N:
        _LAST_BROADCAST_N = n
        logger.info(f"Active swap clients: {n} -> profile {profile}")
    payload = json.dumps({"type": "throttle", "fps": profile["fps"], "clients": n,
                          "max_w": profile["max_w"], "p50_ms": profile["p50_ms"]})
    dead = []
    for client_ws in list(CONNECTED_WS):
        try:
            if not client_ws.closed:
                await client_ws.send_str(payload)
        except Exception:
            dead.append(client_ws)
    for d in dead:
        CONNECTED_WS.discard(d)


def _downscale_for_load(frame: np.ndarray, n_clients: int):
    """현재 접속자 수 기준 처리 해상도 상한을 넘으면 축소한다.
    반환값: (처리용 프레임, 원본 크기로 되돌리기 위한 (orig_w, orig_h) 또는 None)"""
    max_w = get_adaptive_profile(n_clients)["max_w"]
    h, w = frame.shape[:2]
    if w <= max_w:
        return frame, None
    scale = max_w / float(w)
    new_w, new_h = max_w, max(1, int(round(h * scale)))
    small = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_AREA)
    return small, (w, h)


def _finalize_and_encode(img: np.ndarray, quality: int, restore_size, optimize: bool = False) -> bytes:
    """(필요 시) 원본 해상도로 되돌린 뒤 JPEG로 인코딩한다."""
    if restore_size is not None:
        img = cv2.resize(img, restore_size, interpolation=cv2.INTER_LINEAR)
    params = [int(cv2.IMWRITE_JPEG_QUALITY), quality]
    if optimize:
        params += [int(cv2.IMWRITE_JPEG_OPTIMIZE), 1]
    _, encoded = cv2.imencode(".jpg", img, params)
    return encoded.tobytes()


def process_frame(source_name: str, frame_bytes: bytes, n_clients: int = 0,
                  client_key: str = "anon") -> bytes:
    """웹캠 프레임을 받아 선택된 얼굴로 스왑(또는 뷰티 스킨)한 JPEG를 반환한다.

    - client_key 단위로 프레임 캐시/추적 캐시를 분리한다(참가자 간 결과 혼입 방지).
    - 처리 지연을 계측해 get_adaptive_profile 의 백프레셔 계산에 반영한다.
    - [사생활 보호] 스왑이 1건도 성공하지 않으면 원본 프레임을 절대 반환하지 않는다.
    """
    source_key = (source_name or "").strip().lower()
    t0 = time.perf_counter()
    frame = None
    try:
        np_arr = np.frombuffer(frame_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if frame is None:
            if source_key in ("none", "beauty", "real"):
                return frame_bytes
            return (_cache_get(client_key, source_key)
                    or _cache_get(client_key, "_latest") or b"")

        # 순수 뷰티 모드 (얼굴 검출 1회만 사용)
        if source_key in ("none", "beauty", "real"):
            frame_s, restore_size = _downscale_for_load(frame, n_clients)
            enhanced = precision_beauty_skin(frame_s)
            # 다운스케일한 프레임을 원본 크기로 다시 업스케일하지 않는다.
            return _finalize_and_encode(enhanced, 92, None, optimize=True)

        # [사생활 절대 보호] 소스 얼굴 로드 실패 시 원본 얼굴 유출 방지
        source_face = load_source_face(source_name)
        if source_face is None:
            return (_cache_get(client_key, source_key)
                    or _cache_get(client_key, "_latest")
                    or _finalize_and_encode(cv2.GaussianBlur(frame, (99, 99), 30), 80, None))

        frame_s, restore_size = _downscale_for_load(frame, n_clients)

        target_faces = _track_faces(frame_s, client_key)
        if not target_faces:
            return (_cache_get(client_key, source_key)
                    or _cache_get(client_key, "_latest")
                    or _finalize_and_encode(_blur_faces(frame_s, None), 80, restore_size))

        swapped = frame_s.copy()
        successful_swaps = 0
        for target_face in target_faces:
            try:
                bx1, by1, bx2, by2 = [int(v) for v in target_face.bbox]
                bx1, by1 = max(0, bx1), max(0, by1)
                bx2, by2 = min(frame_s.shape[1], bx2), min(frame_s.shape[0], by2)
                cx, cy = (bx1 + bx2) // 2, (by1 + by2) // 2
                r = min(15, max(3, (bx2 - bx1) // 8))
                pre_sample = swapped[max(0, cy - r):min(frame_s.shape[0], cy + r),
                                     max(0, cx - r):min(frame_s.shape[1], cx + r)].copy()

                res = swap_face(source_face, target_face, swapped)
                if res is not None:
                    post_sample = res[max(0, cy - r):min(frame_s.shape[0], cy + r),
                                      max(0, cx - r):min(frame_s.shape[1], cx + r)]
                    diff = float(np.mean(np.abs(post_sample.astype(np.float32)
                                                - pre_sample.astype(np.float32))))
                    if diff > 1.0:
                        swapped = res
                        successful_swaps += 1
                    else:
                        logger.warning(f"Face swap diff too low ({diff:.2f}) - swap not applied")
            except Exception as swap_err:
                logger.warning(f"Face swap error on target face: {swap_err}")

        # 스왑 성공 0건이면 원본 반환 금지 (직전 스왑 프레임 → 얼굴 블러)
        if successful_swaps == 0:
            return (_cache_get(client_key, source_key)
                    or _cache_get(client_key, "_latest")
                    or _finalize_and_encode(_blur_faces(frame_s, target_faces), 80, restore_size))

        # 스왑 결과를 원본 해상도로 되돌리지 않는다(순수 낭비 제거).
        result_bytes = _finalize_and_encode(swapped, 80, None)
        _cache_put(client_key, source_key, result_bytes)
        _cache_put(client_key, "_latest", result_bytes)
        return result_bytes
    except Exception as e:
        logger.error(f"Error processing frame: {e}")
        if source_key not in ("none", "beauty", "real"):
            cached = _cache_get(client_key, "_latest") or _cache_get(client_key, source_key)
            if cached:
                return cached
            try:
                base = frame if frame is not None else np.zeros((360, 640, 3), dtype=np.uint8)
                return _finalize_and_encode(cv2.GaussianBlur(base, (99, 99), 30), 80, None)
            except Exception:
                pass
            placeholder = np.zeros((360, 640, 3), dtype=np.uint8)
            cv2.putText(placeholder, "Protecting Face...", (180, 180),
                        cv2.FONT_HERSHEY_SIMPLEX, 1, (200, 200, 200), 2)
            _, encoded = cv2.imencode(".jpg", placeholder, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            return encoded.tobytes()
        return frame_bytes or b""
    finally:
        record_latency((time.perf_counter() - t0) * 1000.0)


# ----------------------------------------------------
# 인프로세스 모델 인스턴스 풀 (기본 모드 — GPU/VRAM 을 실제로 쓰는 병렬 처리)
#
# [측정 결과 — RTX 5070 Ti, 12명 동시]
#  · 예전 구조(세션 1개 + 스레드 2개): 합계 ~77fps → 참가자당 6.4fps, GPU 66%, VRAM 3.2GB/16GB
#  · inswapper 순수 추론은 GPU 상 ~6ms(≈165 inf/s 상한). 배치(>1)는 모델이 지원하지 않는다.
#  · 따라서 목표는 "GPU 를 놀리지 않게" 여러 독립 세션(스레드별)을 두어 CPU 전/후처리와
#    GPU 추론을 겹치는 것. 세션은 검출 모델 + 스왑 모델 한 쌍이며 VRAM 은 인스턴스당 ~0.3~0.6GB.
# ----------------------------------------------------
import concurrent.futures as _cf
import subprocess as _subprocess

_tls = threading.local()
_MODEL_THREADS = 0                       # start_server 에서 확정
_EXECUTOR = None                         # type: ignore
PROCESSED_TOTAL = 0
DROPPED_TOTAL = 0
STALE_DROPPED_TOTAL = 0
_THROUGHPUT_EVENTS = collections.deque(maxlen=512)   # 완료 시각 (초) — 실측 처리량 계산용
_STALE_EVENTS = collections.deque(maxlen=256)        # 대기 초과로 폐기된 시각 — 과부하 감지용
_PEAK_FPS_EMA = 0.0
MAX_QUEUE_MS = float(os.environ.get("FACE_SWAP_MAX_QUEUE_MS", "350"))


def _install_thread_local_models():
    """DLC 모듈의 전역 싱글턴 getter 를 '스레드 로컬 우선' 으로 감싼다.
    풀 스레드에서는 자기 전용 세션을, 그 외 스레드(메인/이벤트 루프)에서는 원래 싱글턴을 쓴다."""
    import modules.face_analyser as fa_mod
    import modules.processors.frame.face_swapper as fs_mod

    if getattr(fa_mod, "_ym_tls_installed", False):
        return
    orig_analyser = fa_mod.get_face_analyser
    orig_swapper = fs_mod.get_face_swapper

    def tl_analyser():
        a = getattr(_tls, "analyser", None)
        return a if a is not None else orig_analyser()

    def tl_swapper():
        s = getattr(_tls, "swapper", None)
        return s if s is not None else orig_swapper()

    fa_mod.get_face_analyser = tl_analyser
    fs_mod.get_face_swapper = tl_swapper
    fa_mod._ym_tls_installed = True


_BUILD_LOCK = threading.Lock()


def _build_thread_models():
    """현재 스레드 전용 검출+스왑 세션을 만든다(스레드당 1회).
    CUDA Graph 캡처는 캡처 중 다른 스레드의 CUDA 호출을 실패시키므로 모델 생성은 직렬화한다."""
    with _BUILD_LOCK:
        _build_thread_models_locked()


def _build_thread_models_locked():
    import insightface
    import modules.face_analyser as fa_mod
    import modules.processors.frame.face_swapper as fs_mod
    from modules.processors.frame._onnx_enhancer import build_provider_config

    providers = build_provider_config()
    # 검출 입력 크기: 웹캠 프레임은 얼굴이 크므로 640 보다 작아도 검출된다(비용 ~ 면적에 비례).
    det_edge = int(os.environ.get("FACE_SWAP_DET_SIZE", "480"))
    analyser = insightface.app.FaceAnalysis(
        name="buffalo_l", providers=providers, allowed_modules=["detection"])
    analyser.prepare(ctx_id=0, det_size=(det_edge, det_edge))

    fp32 = os.path.join(fs_mod.models_dir, "inswapper_128.onnx")
    fp16 = os.path.join(fs_mod.models_dir, "inswapper_128_fp16.onnx")
    if getattr(fs_mod, "_HAS_TORCH_CUDA", False) and os.path.exists(fp16):
        model_path = fp16
    elif os.path.exists(fp32):
        model_path = fp32
    else:
        model_path = fp16
    swap_providers = providers
    if os.environ.get("FACE_SWAP_TRT", "0") == "1" and USING_CUDA:
        # (선택) TensorRT FP16 — `pip install tensorrt-cu12` 등으로 TensorRT 라이브러리가 있을 때만 유효.
        # 실패하면 ONNX Runtime 이 자동으로 CUDA 로 폴백한다. 첫 기동 시 엔진 빌드로 수 분 걸릴 수 있다.
        cache_dir = os.path.join(fs_mod.models_dir, "trt_cache")
        os.makedirs(cache_dir, exist_ok=True)
        swap_providers = [("TensorrtExecutionProvider", {
            "trt_fp16_enable": True, "trt_engine_cache_enable": True, "trt_engine_cache_path": cache_dir,
        })] + list(providers)
    swapper = insightface.model_zoo.get_model(model_path, providers=swap_providers)
    if USING_CUDA and os.environ.get("FACE_SWAP_CUDA_GRAPH", "1") == "1" and "TensorrtExecutionProvider" not in str(swap_providers):
        _wrap_with_cuda_graph(swapper, model_path)
    _tls.analyser = analyser
    _tls.swapper = swapper


class _GraphSession:
    """스레드 전용 CUDA Graph 세션 어댑터 (insightface INSwapper 가 호출하는 session.run 만 대체).
    커널 런치 오버헤드를 제거하고, 입력/출력 버퍼를 GPU 에 상주시켜 호스트↔디바이스 복사를 줄인다."""

    def __init__(self, underlying, sess, io, ort_in, ort_lat, out_name):
        self._underlying = underlying
        self._sess = sess
        self._io = io
        self._in = ort_in
        self._lat = ort_lat
        self._out = out_name

    def run(self, output_names, input_dict, **kwargs):
        try:
            keys = list(input_dict.keys())
            self._in.update_inplace(np.ascontiguousarray(input_dict[keys[0]], dtype=np.float32))
            self._lat.update_inplace(np.ascontiguousarray(input_dict[keys[1]], dtype=np.float32))
            self._sess.run_with_iobinding(self._io)
            return [self._io.get_outputs()[0].numpy()]
        except Exception:
            return self._underlying.run(output_names, input_dict, **kwargs)

    def __getattr__(self, name):
        return getattr(self._underlying, name)


def _wrap_with_cuda_graph(swapper, model_path: str):
    try:
        import onnxruntime as ort_
        sess = ort_.InferenceSession(
            model_path, providers=[("CUDAExecutionProvider", {"enable_cuda_graph": "1"}), "CPUExecutionProvider"])
        in_names = [i.name for i in sess.get_inputs()]
        out_name = sess.get_outputs()[0].name
        ort_in = ort_.OrtValue.ortvalue_from_numpy(np.zeros((1, 3, 128, 128), dtype=np.float32), "cuda", 0)
        ort_lat = ort_.OrtValue.ortvalue_from_numpy(np.zeros((1, 512), dtype=np.float32), "cuda", 0)
        io = sess.io_binding()
        io.bind_ortvalue_input(in_names[0], ort_in)
        io.bind_ortvalue_input(in_names[1], ort_lat)
        io.bind_output(out_name, "cuda", 0)
        sess.run_with_iobinding(io)   # 1회차: 그래프 캡처
        sess.run_with_iobinding(io)
        swapper.session = _GraphSession(swapper.session, sess, io, ort_in, ort_lat, out_name)
    except Exception as e:
        logger.warning(f"CUDA graph 세션 생성 실패 → 일반 세션 사용: {e}")


def _resolve_model_threads() -> int:
    """동시 모델 인스턴스(=추론 스레드) 수.
    FACE_SWAP_CONCURRENCY 로 직접 지정 가능. 기본은 VRAM/CPU 에 맞춰 자동 결정."""
    raw = str(os.environ.get("FACE_SWAP_CONCURRENCY", "auto")).strip().lower()
    if raw not in ("", "auto"):
        try:
            return int(max(1, min(int(raw), 12)))
        except ValueError:
            pass
    cpu = os.cpu_count() or 4
    if not USING_CUDA:
        return int(max(1, min(2, cpu // 4)))
    vram = _detect_vram_gb()
    # 측정: 세션 4개에서 GPU 처리량이 포화(K>=4 이후 증가 거의 없음). VRAM 여유가 크면 4, 작으면 줄인다.
    if vram >= 10:
        n = 4
    elif vram >= 6:
        n = 3
    else:
        n = 2
    return int(max(1, min(n, max(1, cpu // 2))))


def _init_executor(n_threads: int):
    """추론 스레드 풀 생성 + 각 스레드에서 모델 인스턴스를 병렬로 미리 만들고 워밍업한다."""
    global _EXECUTOR, _MODEL_THREADS
    _install_thread_local_models()
    _MODEL_THREADS = max(1, n_threads)
    _EXECUTOR = _cf.ThreadPoolExecutor(max_workers=_MODEL_THREADS, thread_name_prefix="swap")
    barrier = threading.Barrier(_MODEL_THREADS)
    errors = []

    def warm(idx):
        try:
            if _MODEL_THREADS > 1:
                _build_thread_models()
            else:
                # 단일 스레드는 원래 싱글턴을 그대로 사용
                _tls.analyser = get_face_analyser()
                _tls.swapper = get_face_swapper()
            # 더미 프레임으로 cuDNN 알고리즘 선택/메모리 풀 워밍업
            dummy = np.full((360, 640, 3), 127, dtype=np.uint8)
            try:
                _tls.analyser.det_model.detect(dummy, max_num=0, metric="default")
            except Exception:
                pass
            barrier.wait(timeout=120)
        except Exception as e:  # pragma: no cover
            errors.append(str(e))
            try:
                barrier.abort()
            except Exception:
                pass

    futs = [_EXECUTOR.submit(warm, i) for i in range(_MODEL_THREADS)]
    for f in futs:
        f.result()
    # 붙여넣기(paste-back)는 얼굴 크롭(~200px) 수준이라 CPU(cv2 SIMD)가 더 싸다. torch .cuda() 왕복은
    # 기본(NULL) 스트림에서 동기화를 유발해 다른 스레드의 GPU 작업과 서로 기다리게 만든다 → 기본은 CPU 경로.
    if os.environ.get("FACE_SWAP_CPU_PASTE", "1") == "1":
        try:
            import modules.processors.frame.face_swapper as _fsm
            _fsm._HAS_TORCH_CUDA = False   # 모델 선택은 이미 끝났으므로 paste-back 경로만 바뀐다
        except Exception:
            pass
    if errors:
        logger.error(f"모델 인스턴스 초기화 오류: {errors[:2]}")
    logger.info(f"✅ 모델 인스턴스 풀 준비: threads={_MODEL_THREADS} (스레드별 독립 ONNX 세션)")


def _note_completed(dropped: bool = False, stale: bool = False):
    global PROCESSED_TOTAL, DROPPED_TOTAL, STALE_DROPPED_TOTAL, _PEAK_FPS_EMA
    if dropped:
        DROPPED_TOTAL += 1
        if stale:
            STALE_DROPPED_TOTAL += 1
            _STALE_EVENTS.append(time.time())
        return
    PROCESSED_TOTAL += 1
    now = time.time()
    _THROUGHPUT_EVENTS.append(now)


def update_peak_throughput():
    """2초마다 호출: 실측 처리량이 지금까지의 최고치보다 높으면 갱신(포화 상태에서의 처리능력 자가 보정)."""
    global _PEAK_FPS_EMA
    m = measured_throughput_fps()
    if m > _PEAK_FPS_EMA:
        _PEAK_FPS_EMA = m if not _PEAK_FPS_EMA else (0.6 * _PEAK_FPS_EMA + 0.4 * m)
    else:
        _PEAK_FPS_EMA *= 0.985


def measured_throughput_fps(window: float = 4.0) -> float:
    now = time.time()
    n = 0
    for t in reversed(_THROUGHPUT_EVENTS):
        if now - t > window:
            break
        n += 1
    return n / window


def _process_in_thread(source_name, frame_bytes, n_clients, client_key, enq_ts):
    """풀 스레드에서 실행. 너무 오래 대기한 프레임은 GPU 에 올리지 않고 None(폐기)."""
    waited_ms = (time.time() - enq_ts) * 1000.0
    if waited_ms > MAX_QUEUE_MS:
        return None, waited_ms, 0.0
    t0 = time.perf_counter()
    data = process_frame(source_name, frame_bytes, n_clients, client_key)
    return data, waited_ms, (time.perf_counter() - t0) * 1000.0


_GPU_CACHE = {"t": 0.0, "v": None}


def gpu_snapshot():
    """nvidia-smi 로 GPU 사용률/VRAM 을 2초 캐시로 조회 (실패 시 None)."""
    now = time.time()
    if now - _GPU_CACHE["t"] < 2.0:
        return _GPU_CACHE["v"]
    v = None
    try:
        out = _subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
             "--format=csv,noheader,nounits"], timeout=2.5, creationflags=getattr(_subprocess, "CREATE_NO_WINDOW", 0)
        ).decode(errors="ignore").strip().splitlines()[0].split(",")
        v = {
            "name": out[0].strip(),
            "util_pct": float(out[1]),
            "vram_used_mib": float(out[2]),
            "vram_total_mib": float(out[3]),
            "temp_c": float(out[4]),
            "power_w": float(out[5]),
        }
    except Exception:
        v = None
    _GPU_CACHE["t"] = now
    _GPU_CACHE["v"] = v
    return v


# ----------------------------------------------------
# 멀티프로세스 GPU 워커 풀 (선택 — FACE_SWAP_WORKERS>0 일 때만; 측정상 인프로세스 풀이 더 빠르고 VRAM 도 덜 쓴다)
#
# 기존 구조는 이 서버 프로세스 하나가 얼굴 검출/스왑 모델을 직접 들고
# 있었다 (전역 dml_lock으로 사실상 완전 직렬화). 이제는 이 프로세스는
# WebSocket/HTTP 입출력만 담당하는 "디스패처"가 되고, 실제 GPU 추론은
# 별도 OS 프로세스(워커)들이 각자 자기 모델 인스턴스 + 자기 CUDA
# 컨텍스트를 갖고 수행한다.
#
# - CUDA는 여러 프로세스/스레드에서 동시에 세션을 호출하는 것을
#   공식적으로 지원하므로, 워커 프로세스마다 독립된 모델을 두면
#   진짜 병렬 처리가 가능하다 (DirectML처럼 전역 락으로 묶일 필요가 없음).
# - 모든 워커가 하나의 공유 작업 큐(POOL_TASK_QUEUE)를 소비하므로,
#   놀고 있는 워커가 자연스럽게 다음 프레임을 가져가는 최소부하(least-busy)
#   분산이 별도 구현 없이 이루어진다.
# - 워커 프로세스 수(FACE_SWAP_WORKERS)는 GPU VRAM에 맞춰 조절해야 한다.
#   모델 하나당 대략 1~2GB 내외를 쓰므로, 예를 들어 VRAM 12GB면
#   워커 3~4개 정도가 현실적인 시작점이다. 값을 0으로 두면 예전처럼
#   이 프로세스 안에서 직접 처리한다(GPU가 없는 개발 환경 등에서 유용).
# ----------------------------------------------------

def _detect_vram_gb() -> float:
    """사용 가능한 GPU VRAM(GB). 감지 실패 시 0.
    FACE_SWAP_VRAM_GB 환경변수로 직접 지정할 수도 있다."""
    env = os.environ.get("FACE_SWAP_VRAM_GB")
    if env:
        try:
            return float(env)
        except ValueError:
            pass
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            return float(getattr(props, "total_memory", 0)) / (1024 ** 3)
    except Exception:
        pass
    return 0.0


def _resolve_worker_count() -> int:
    """GPU 추론 워커(=독립 프로세스) 수.

    - 기본값 0: 인프로세스 비동기 CUDA 모드.
      프로세스 간 Pickle 직렬화 및 OS 파이프 IPC 오버헤드가 '0'이며, 단일 CUDA 세션으로
      GPU 컨텍스트 스위칭 경합이 없어 1~5인 환경에서 가장 빠르고 프레임 지연이 최소화됩니다.
    - 다중 GPU 프로세스 분할이 명시적으로 필요한 경우에만 FACE_SWAP_WORKERS 환경변수로 양수를 지정합니다.
    """
    raw = str(os.environ.get("FACE_SWAP_WORKERS", "0")).strip().lower()
    if raw in ("0", "auto", "single", ""):
        return 0
    try:
        n = int(raw)
    except ValueError:
        n = 0
    return int(max(0, min(n, 8)))


WORKER_COUNT = _resolve_worker_count()
POOL_TASK_QUEUES: list = []          # 워커별 전용 큐 (클라이언트 고정 라우팅용)
POOL_TASK_QUEUE = None               # (호환) 풀 활성 여부 플래그로만 사용
POOL_RESULT_QUEUE: "mp.Queue | None" = None
CLIENT_WORKER: dict = {}             # client_key -> worker_id (sticky)
POOL_PROCESSES: list = []
PENDING_FUTURES: dict = {}
MAIN_LOOP = None
POOL_ENABLED = WORKER_COUNT > 0


def _gpu_worker_main(worker_id: int, task_queue: "mp.Queue", result_queue: "mp.Queue"):
    """워커 프로세스의 진입점. 이 프로세스 안에서만 쓰이는 자기 모델 인스턴스를
    한 번 로드한 뒤, 작업 큐에서 프레임을 받아 순서대로(이 프로세스는 단일
    스레드로 돈다) 처리해서 결과 큐로 돌려준다."""
    worker_logger = logging.getLogger(f"FaceSwapWorker.pool{worker_id}")
    logging.basicConfig(level=logging.INFO, format="[FaceSwapWorker] %(asctime)s [%(levelname)s] %(message)s")
    try:
        worker_logger.info(f"GPU worker #{worker_id} starting (providers={modules.globals.execution_providers})...")
        get_face_analyser()
        get_face_swapper()
        worker_logger.info(f"GPU worker #{worker_id} ready.")
    except Exception as e:
        worker_logger.error(f"GPU worker #{worker_id} failed to initialize: {e}")
        result_queue.put(("__worker_init_failed__", worker_id, str(e)))
        return

    while True:
        try:
            item = task_queue.get()
        except (EOFError, OSError):
            break
        if item is None:  # 종료 신호
            break
        req_id, source_name, frame_bytes, n_clients, client_key = item
        try:
            result_bytes = process_frame(source_name, frame_bytes, n_clients, client_key)
        except Exception as e:
            worker_logger.warning(f"process_frame error: {e}")
            result_bytes = b""
        try:
            result_queue.put((req_id, result_bytes))
        except Exception as e:
            worker_logger.warning(f"Failed to publish result: {e}")


def _drain_pool_results():
    """메인 프로세스의 백그라운드 스레드에서 실행. 워커들의 결과 큐를 계속
    비우면서, 대기 중인 asyncio Future를 이벤트 루프 스레드에서 안전하게
    완료시킨다 (call_soon_threadsafe)."""
    while True:
        try:
            req_id, result_bytes = POOL_RESULT_QUEUE.get()
        except (EOFError, OSError):
            return
        if req_id == "__worker_init_failed__":
            logger.error(f"A GPU worker failed to initialize: {result_bytes}")
            continue
        if MAIN_LOOP is None:
            continue

        def _resolve(rid=req_id, data=result_bytes):
            fut = PENDING_FUTURES.pop(rid, None)
            if fut is not None and not fut.done():
                fut.set_result(data)

        MAIN_LOOP.call_soon_threadsafe(_resolve)


def start_worker_pool():
    """워커 프로세스들과 결과 드레인 스레드를 시작한다."""
    global POOL_TASK_QUEUE, POOL_RESULT_QUEUE, MAIN_LOOP
    if not POOL_ENABLED:
        logger.info("FACE_SWAP_WORKERS=0 — 워커 풀을 쓰지 않고 이 프로세스에서 직접 처리합니다.")
        return
    MAIN_LOOP = asyncio.get_event_loop()
    # 결과 큐도 유한 크기로 두어, 드레인 스레드가 밀리면 워커가 자연스럽게
    # 블로킹되도록 한다(무한 적체 방지).
    POOL_RESULT_QUEUE = mp.Queue(maxsize=max(16, WORKER_COUNT * 8))
    # 워커마다 전용 큐(깊이 2). 같은 참가자의 프레임은 항상 같은 워커로 가야
    # 프로세스별 전역인 _TRACK_CACHE/LAST_SWAPPED_FRAMES 가 유효하다.
    for i in range(WORKER_COUNT):
        q = mp.Queue(maxsize=2)
        POOL_TASK_QUEUES.append(q)
        p = mp.Process(target=_gpu_worker_main, args=(i, q, POOL_RESULT_QUEUE), daemon=True)
        p.start()
        POOL_PROCESSES.append(p)
    POOL_TASK_QUEUE = POOL_TASK_QUEUES[0]
    threading.Thread(target=_drain_pool_results, daemon=True).start()
    logger.info(f"✅ GPU worker pool started with {WORKER_COUNT} process(es).")


def _assign_worker(client_key: str) -> int:
    """참가자를 담당 워커에 고정 배정한다(현재 담당 인원이 가장 적은 워커)."""
    wid = CLIENT_WORKER.get(client_key)
    if wid is not None and wid < len(POOL_TASK_QUEUES):
        return wid
    load = collections.Counter(CLIENT_WORKER.values())
    wid = min(range(len(POOL_TASK_QUEUES)), key=lambda i: load.get(i, 0))
    CLIENT_WORKER[client_key] = wid
    return wid


async def run_inproc(source_name: str, frame_bytes: bytes, n_clients: int, client_key: str):
    """인프로세스 모델 풀(스레드별 독립 세션)에서 프레임 1장 처리.
    반환: (jpeg bytes | None(폐기), 큐 대기 ms, 처리 ms)"""
    if _EXECUTOR is None:
        t0 = time.perf_counter()
        data = await asyncio.to_thread(process_frame, source_name, frame_bytes, n_clients, client_key)
        return data, 0.0, (time.perf_counter() - t0) * 1000.0
    loop = asyncio.get_running_loop()
    data, waited, proc = await loop.run_in_executor(
        _EXECUTOR, _process_in_thread, source_name, frame_bytes, n_clients, client_key, time.time())
    if data is None:
        _note_completed(dropped=True, stale=True)
    else:
        _note_completed()
    return data, waited, proc


async def submit_frame(source_name: str, frame_bytes: bytes, n_clients: int,
                       client_key: str = "anon", timeout: float = None) -> bytes:
    """프레임 하나를 처리 요청한다. 풀이 활성화되어 있으면 워커 프로세스로,
    아니면 이 프로세스의 스레드풀로 보낸다. 어느 쪽이든 호출부 입장에서는
    동일하게 await 가능한 인터페이스다."""
    if timeout is None:
        prof = get_adaptive_profile(len(CONNECTED_WS))
        # 첫 프레임 및 고부하 상황에서 타임아웃으로 인한 스킵을 원천 방지 (최소 4.5초)
        timeout = max(4.5, min(12.0, (1000.0 / max(4, prof["fps"])) * 4 / 1000.0))

    if not POOL_ENABLED or POOL_TASK_QUEUE is None or len(POOL_TASK_QUEUES) == 0:
        data, _w, _p = await run_inproc(source_name, frame_bytes, n_clients, client_key)
        if data is None:  # 대기 초과로 폐기 → 직전 스왑 프레임(있으면)
            return _cache_get(client_key, "_latest") or b""
        return data

    wid = _assign_worker(client_key)
    req_id = uuid.uuid4().hex
    future = MAIN_LOOP.create_future()
    PENDING_FUTURES[req_id] = future
    try:
        POOL_TASK_QUEUES[wid].put_nowait((req_id, source_name, frame_bytes, n_clients, client_key))
    except queue_mod.Full:
        PENDING_FUTURES.pop(req_id, None)
        # 큐 가득 찼을 때도 직전 캐시나 직접 추론으로 폴백
        async with INFERENCE_SEMAPHORE:
            return await asyncio.to_thread(process_frame, source_name, frame_bytes, n_clients, client_key)

    _t_submit = time.perf_counter()
    try:
        data = await asyncio.wait_for(future, timeout=timeout)
        record_latency((time.perf_counter() - _t_submit) * 1000.0)
        return data
    except asyncio.TimeoutError:
        PENDING_FUTURES.pop(req_id, None)
        logger.warning(f"Worker pool timed out ({timeout:.1f}s) for {client_key}, falling back to direct process_frame")
        async with INFERENCE_SEMAPHORE:
            return await asyncio.to_thread(process_frame, source_name, frame_bytes, n_clients, client_key)


# ----------------------------------------------------
# aiohttp HTTP & WebSocket 핸들러
# ----------------------------------------------------

async def handle_ping(request):
    return web.json_response({
        "status": "ok",
        "service": "deep-live-cam-faceswap",
        "cached_faces": list(SOURCE_FACE_CACHE.keys())
    })


async def handle_stats(request):
    """워커 수 / 참가자 수 / 실측 지연 / 현재 백프레셔 프로파일."""
    n = len(CONNECTED_WS)
    return web.json_response({
        "status": "ok",
        "workers": max(1, WORKER_COUNT_EFFECTIVE or WORKER_COUNT),
        "clients": n,
        "profile": get_adaptive_profile(n),
        "latency": {
            "p50_ms": round(_latency_percentile(0.5), 1),
            "p90_ms": round(_latency_percentile(0.9), 1),
            "samples": len(_LATENCY_SAMPLES),
        },
        "detect_every": _DETECT_EVERY,
        "tracked_clients": len(_TRACK_CACHE),
        "cached_faces": list(SOURCE_FACE_CACHE.keys()),
        "model_threads": _MODEL_THREADS,
        "throughput_fps": round(measured_throughput_fps(), 1),
        "peak_fps": round(_PEAK_FPS_EMA, 1),
        "processed_total": PROCESSED_TOTAL,
        "dropped_total": DROPPED_TOTAL,
        "stale_dropped_total": STALE_DROPPED_TOTAL,
        "protocol": "v2",
        "gpu": await asyncio.to_thread(gpu_snapshot),
        "providers": modules.globals.execution_providers,
    })


def get_default_photo_source() -> str:
    """사용 가능한 첫 번째 사진의 stem을 기본값으로 반환합니다."""
    if PHOTO_DIR.exists():
        for p in sorted(PHOTO_DIR.iterdir()):
            if p.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp"]:
                return p.stem
    return ""


async def handle_list_photos(request):
    """사용 가능한 얼굴 사진 목록 반환"""
    photos = []
    if PHOTO_DIR.exists():
        for p in sorted(PHOTO_DIR.iterdir()):
            if p.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp"]:
                s = p.stem.lower()
                name = p.stem.replace("_", " ")
                photos.append({
                    "id": s,
                    "filename": p.name,
                    "name": name,
                    "url": f"photo/{p.name}"
                })
    return web.json_response({"ok": True, "photos": photos})


async def handle_swap_frame(request):
    """HTTP POST 프레임 스왑 (바이너리 입력 -> 바이너리 출력)"""
    source_name = request.headers.get("X-Source-Face") or get_default_photo_source()
    body = await request.read()
    if not body:
        return web.Response(status=400, text="Empty frame body")

    client_key = request.headers.get("X-Client-Id") or "http"
    swapped = await submit_frame(source_name, body, len(CONNECTED_WS), client_key)
    return web.Response(body=swapped, content_type="image/jpeg", headers={
        "Access-Control-Allow-Origin": "*",
        "X-Source-Face": source_name,
    })


async def handle_websocket(request):
    """실시간 양방향 WebSocket 핸들러 - 최신 프레임 우선 처리(버퍼 적체 및 고속 재생 완벽 방지)"""
    # JPEG 은 압축이 되지 않으므로 permessage-deflate 를 끈다(프레임당 CPU/지연 낭비 방지)
    ws = web.WebSocketResponse(max_msg_size=10 * 1024 * 1024, heartbeat=30.0, compress=False)
    await ws.prepare(request)
    client_id = id(ws)
    # Node 프록시가 넘겨준 X-Client-Id(또는 ?client=)를 우선 사용한다.
    # 참가자별로 프레임 캐시·얼굴 추적을 분리해 서로의 결과가 섞이지 않게 한다.
    client_key = (request.headers.get("X-Client-Id")
                  or request.query.get("client")
                  or request.query.get("client_id")
                  or f"ws{client_id}")
    logger.info(f"WebSocket client connected: {client_id} key={client_key}")
    current_source = get_default_photo_source()

    CONNECTED_WS.add(ws)
    await broadcast_throttle()

    # 참가자당 "최신 프레임 1장" 슬롯. 새 프레임이 오면 아직 시작 못 한 이전 프레임은 폐기하고
    # (v2 클라이언트에는 drop 알림) 항상 가장 최근 프레임만 GPU 에 올린다 → 지연 누적/고속재생 방지.
    latest_pending = None   # (src_name, frame_bytes, seq|None, recv_ts)
    processing_event = asyncio.Event()
    is_closed = False

    async def send_drop(seq):
        try:
            if not ws.closed:
                if seq is None:
                    await ws.send_str('{"type":"skip"}')
                else:
                    await ws.send_str('{"type":"drop","seq":%d}' % seq)
        except Exception:
            pass

    async def worker_loop():
        nonlocal latest_pending
        while not is_closed and not ws.closed:
            await processing_event.wait()
            processing_event.clear()
            if is_closed or ws.closed:
                break
            while latest_pending is not None and not ws.closed:
                src_name, frame_bytes, seq, recv_ts = latest_pending
                latest_pending = None
                try:
                    if POOL_ENABLED:
                        swapped = await submit_frame(src_name, frame_bytes, len(CONNECTED_WS), client_key)
                        waited, proc = 0.0, 0.0
                    else:
                        swapped, waited, proc = await run_inproc(
                            src_name, frame_bytes, len(CONNECTED_WS), client_key)
                    if ws.closed:
                        break
                    if not swapped:
                        await send_drop(seq)
                    elif seq is None:
                        await ws.send_bytes(swapped)          # v1: 순수 JPEG
                    else:
                        total_ms = min(65535, int((time.time() - recv_ts) * 1000))
                        proc_ms = min(65535, int(proc))
                        await ws.send_bytes(
                            FS2_MAGIC + struct.pack(">IHH", seq & 0xFFFFFFFF, proc_ms, total_ms) + swapped)
                except Exception as ex:
                    logger.warning(f"Error sending swapped frame: {ex}")
                    await send_drop(seq)

    worker_task = asyncio.create_task(worker_loop())

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.BINARY:
                data = msg.data
                if len(data) < 5:
                    continue
                name_len = struct.unpack(">I", data[:4])[0]
                seq = None
                if 4 + name_len <= len(data):
                    raw_name = data[4:4 + name_len].decode("utf-8", errors="ignore")
                    frame_bytes = data[4 + name_len:]
                    # v2: "얼굴이름\x1fseq" — seq 가 있으면 v2 응답 헤더를 붙여 돌려준다
                    if "\x1f" in raw_name:
                        raw_name, _, seq_s = raw_name.partition("\x1f")
                        try:
                            seq = int(seq_s)
                        except ValueError:
                            seq = None
                    src_name = raw_name or current_source
                else:
                    src_name = current_source
                    frame_bytes = data

                # 항상 최신 프레임으로 덮어써서 이전 적체 프레임 즉시 드랍 (지연 누적 원천 방지)
                if latest_pending is not None:
                    _note_completed(dropped=True)
                    await send_drop(latest_pending[2])
                latest_pending = (src_name, frame_bytes, seq, time.time())
                processing_event.set()

            elif msg.type == web.WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                    mtype = payload.get("type", "")

                    if mtype == "ping":
                        await ws.send_json({"type": "pong", "time": time.time()})

                    elif mtype == "hello":
                        # 클라이언트가 명시적으로 보낸 식별자를 우선 적용
                        cid = str(payload.get("clientId") or "").strip()
                        if cid:
                            client_key = cid
                        await ws.send_json({"type": "hello_ack", "clientId": client_key})

                    elif mtype == "set_source":
                        req_source = payload.get("source") or get_default_photo_source()
                        face = await asyncio.to_thread(load_source_face, req_source)
                        current_source = req_source
                        await ws.send_json({
                            "type": "source_set",
                            "source": current_source,
                            "success": face is not None
                        })

                    elif mtype == "swap_base64":
                        src_name = payload.get("source", current_source)
                        img_b64 = payload.get("image", "")
                        if "," in img_b64:
                            img_b64 = img_b64.split(",", 1)[1]
                        import base64
                        raw_bytes = base64.b64decode(img_b64)
                        swapped = await submit_frame(src_name, raw_bytes, len(CONNECTED_WS), client_key)
                        out_b64 = "data:image/jpeg;base64," + base64.b64encode(swapped).decode("ascii")
                        await ws.send_json({
                            "type": "swapped_base64",
                            "source": src_name,
                            "image": out_b64
                        })
                except Exception as ex:
                    logger.warning(f"WebSocket JSON error: {ex}")

            elif msg.type == web.WSMsgType.ERROR:
                logger.error(f"WebSocket error: {ws.exception()}")

    finally:
        is_closed = True
        processing_event.set()
        worker_task.cancel()
        CONNECTED_WS.discard(ws)
        _TRACK_CACHE.pop(client_key, None)
        CLIENT_WORKER.pop(client_key, None)
        await broadcast_throttle()
        logger.info(f"WebSocket client disconnected: {client_id} key={client_key}")

    return ws


def create_app():
    app = web.Application()
    # CORS 헤더 허용
    async def cors_middleware(app, handler):
        async def middleware(request):
            if request.method == "OPTIONS":
                return web.Response(headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, X-Source-Face",
                })
            response = await handler(request)
            response.headers["Access-Control-Allow-Origin"] = "*"
            return response
        return middleware

    app.middlewares.append(cors_middleware)

    app.router.add_get("/ping", handle_ping)
    app.router.add_get("/stats", handle_stats)
    app.router.add_get("/api/photos", handle_list_photos)
    app.router.add_post("/api/swap-frame", handle_swap_frame)
    app.router.add_get("/ws", handle_websocket)
    app.router.add_get("/", handle_websocket)
    return app


async def start_server():
    global WORKER_COUNT_EFFECTIVE, INFERENCE_SEMAPHORE
    WORKER_COUNT_EFFECTIVE = max(1, WORKER_COUNT)
    if POOL_ENABLED:
        logger.info(f"GPU worker pool mode: spawning {WORKER_COUNT} worker process(es)...")
        logger.info("(워커 1개당 VRAM 1~2GB 사용 — 부족하면 FACE_SWAP_WORKERS 값을 낮추세요)")
        start_worker_pool()
        logger.info("(모델은 각 워커 프로세스 안에서 백그라운드로 로드됩니다 — 첫 몇 초간은 프레임이 지연/드롭될 수 있습니다.)")
    else:
        INFERENCE_SEMAPHORE = asyncio.Semaphore(max(2, WORKER_COUNT_EFFECTIVE))
        logger.info("Deep-Live-Cam models & engines initializing (in-process mode)...")
        get_face_analyser()
        get_face_swapper()
        logger.info("✅ Deep-Live-Cam AI models loaded successfully!")
        preload_all_photos()
        logger.info(f"✅ Preloaded {len(SOURCE_FACE_CACHE)} source face embeddings!")
        n_threads = _resolve_model_threads()
        logger.info(f"모델 인스턴스 풀 초기화 중... threads={n_threads} "
                    f"(VRAM={_detect_vram_gb():.1f}GB, cpu={os.cpu_count()})")
        await asyncio.get_running_loop().run_in_executor(None, _init_executor, n_threads)
        WORKER_COUNT_EFFECTIVE = _MODEL_THREADS

    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, HOST, PORT)
    await site.start()
    logger.info(f"🚀 Face swap worker running on http://{HOST}:{PORT} and ws://{HOST}:{PORT}/ws")
    logger.info(f"   workers={WORKER_COUNT_EFFECTIVE} detectEvery={_DETECT_EVERY} "
                f"threads={os.environ.get('OMP_NUM_THREADS')}")

    # 부하 변화(참가자 수/지연/큐 적체)를 반영해 1초마다 fps 캡을 다시 알린다.
    # 접속/해제 시에만 브로드캐스트하면, 이미 포화된 상태에서는 새 접속이
    # 없을 때 캡이 갱신되지 않아 클라이언트가 계속 높은 fps로 밀어넣는다.
    async def _throttle_loop():
        while True:
            await asyncio.sleep(2.0)
            try:
                update_peak_throughput()
                if len(CONNECTED_WS) > 0:
                    await broadcast_throttle()
            except Exception:
                pass
    asyncio.create_task(_throttle_loop())

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    if "--test" in sys.argv:
        print("Running diagnostic test on server/face_swap_worker.py...")
        get_face_analyser()
        get_face_swapper()
        preload_all_photos()
        photos = [p for p in PHOTO_DIR.iterdir() if p.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp"]] if PHOTO_DIR.exists() else []
        if photos:
            test_img_path = photos[0]
            test_bytes = test_img_path.read_bytes()
            swapped = process_frame(test_img_path.stem, test_bytes)
            print(f"Test swap finished with {test_img_path.name}. Input: {len(test_bytes)} bytes -> Output: {len(swapped)} bytes.")
        print("Diagnostic test completed successfully.")
        sys.exit(0)

    try:
        asyncio.run(start_server())
    except KeyboardInterrupt:
        logger.info("Server stopped by user.")

