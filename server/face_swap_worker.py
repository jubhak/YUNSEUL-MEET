# -*- coding: utf-8 -*-
"""
server/face_swap_worker.py - YUNSEUL-PPT Deep-Live-Cam 실시간 페이스 스왑 워커
- InsightFace + inswapper_128_fp16.onnx 모델 상시 로드
- WebSocket (ws://...:8765/ws) 및 HTTP POST (/api/swap-frame) 동시 지원
- photo/ 폴더의 영웅/인물 사진 임베딩 자동 캐싱 및 신규 사진 업로드 처리
"""

import os
import sys
import time
import json
import struct
import logging
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

import cv2
import numpy as np
import asyncio
from aiohttp import web

import modules.globals

# DirectML (DirectX 12 GPU 가속 - RTX 5070 Ti 등 하드웨어 가속) 활성화
_avail_providers = []
try:
    import onnxruntime as ort
    _all_avail = ort.get_available_providers()
    if "DmlExecutionProvider" in _all_avail:
        _avail_providers.append("DmlExecutionProvider")
    if "CUDAExecutionProvider" in _all_avail:
        _avail_providers.append("CUDAExecutionProvider")
except Exception:
    pass
_avail_providers.append("CPUExecutionProvider")
modules.globals.execution_providers = _avail_providers

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
        if f.suffix.lower() in [".jpg", ".jpeg", ".png"]:
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


LAST_SWAPPED_FRAMES = {}


def process_frame(source_name: str, frame_bytes: bytes) -> bytes:
    """웹캠 프레임을 받아 선택된 얼굴로 스왑 또는 정밀 뷰티 스킨 처리한 최고화질 JPEG를 반환합니다."""
    source_key = (source_name or "").strip().lower()
    try:
        np_arr = np.frombuffer(frame_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if frame is None:
            if source_key in ("none", "beauty", "real"):
                return frame_bytes
            return LAST_SWAPPED_FRAMES.get(source_key) or LAST_SWAPPED_FRAMES.get("_latest") or b""

        # 순수 뷰티 모드: 내 실제 얼굴에서 주름만 지우고 머리카락/안경/눈은 초고화질 유지
        if source_key in ("none", "beauty", "real"):
            enhanced = precision_beauty_skin(frame)
            _, encoded = cv2.imencode(".jpg", enhanced, [int(cv2.IMWRITE_JPEG_QUALITY), 95, int(cv2.IMWRITE_JPEG_OPTIMIZE), 1])
            return encoded.tobytes()

        # [사생활 절대 보호] 소스 얼굴 로드 실패 시 원본 얼굴 유출 방지
        source_face = load_source_face(source_name)
        if source_face is None:
            if source_key in LAST_SWAPPED_FRAMES:
                return LAST_SWAPPED_FRAMES[source_key]
            if "_latest" in LAST_SWAPPED_FRAMES:
                return LAST_SWAPPED_FRAMES["_latest"]
            blurred = cv2.GaussianBlur(frame, (99, 99), 30)
            _, encoded = cv2.imencode(".jpg", blurred, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            return encoded.tobytes()

        # 고속 타겟 얼굴 다중 감지 (DirectML GPU 가속)
        target_faces = detect_many_faces_fast(frame)
        if not target_faces:
            # 타겟 얼굴 미감지 시에도 실물 얼굴 유출 0% 보장: 직전 스왑 프레임 또는 블러 반환
            if source_key in LAST_SWAPPED_FRAMES:
                return LAST_SWAPPED_FRAMES[source_key]
            if "_latest" in LAST_SWAPPED_FRAMES:
                return LAST_SWAPPED_FRAMES["_latest"]
            blurred = cv2.GaussianBlur(frame, (99, 99), 30)
            _, encoded = cv2.imencode(".jpg", blurred, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            return encoded.tobytes()

        # 얼굴 크기(면적) 순으로 정렬 (주 발표자 우선 처리, 최대 3명 동시 스왑)
        target_faces = sorted(
            target_faces,
            key=lambda f: (float(f.bbox[2]) - float(f.bbox[0])) * (float(f.bbox[3]) - float(f.bbox[1])),
            reverse=True
        )[:3]

        # 화면에 잡힌 모든 인물에 스왑 적용 (다른 사람이 잡혀도 기존 얼굴 스왑이 해지되지 않고 전원 유지!)
        swapped = frame.copy()
        successful_swaps = 0
        for target_face in target_faces:
            try:
                # 얼굴 영역 샘플링으로 실제 스왑 적용 여부 검증
                bx1, by1, bx2, by2 = [int(v) for v in target_face.bbox]
                bx1, by1 = max(0, bx1), max(0, by1)
                bx2, by2 = min(frame.shape[1], bx2), min(frame.shape[0], by2)
                cx, cy = (bx1 + bx2) // 2, (by1 + by2) // 2
                r = min(15, max(3, (bx2 - bx1) // 8))
                pre_sample = swapped[max(0, cy - r):min(frame.shape[0], cy + r), max(0, cx - r):min(frame.shape[1], cx + r)].copy()

                res = swap_face(source_face, target_face, swapped)
                if res is not None:
                    post_sample = res[max(0, cy - r):min(frame.shape[0], cy + r), max(0, cx - r):min(frame.shape[1], cx + r)]
                    diff = np.mean(np.abs(post_sample.astype(np.float32) - pre_sample.astype(np.float32)))
                    if diff > 1.0:
                        swapped = res
                        successful_swaps += 1
                    else:
                        logger.warning(f"Face swap diff too low ({diff:.2f}) - swap not applied")
            except Exception as swap_err:
                logger.warning(f"Face swap error on target face: {swap_err}")

        # [사생활 절대 보호] 스왑이 성공하지 않은 경우 (성공 0건), 절대 원본 frame을 인코딩하거나 반환해서는 안 됨!
        if successful_swaps == 0:
            if source_key in LAST_SWAPPED_FRAMES:
                return LAST_SWAPPED_FRAMES[source_key]
            if "_latest" in LAST_SWAPPED_FRAMES:
                return LAST_SWAPPED_FRAMES["_latest"]
            safe_frame = frame.copy()
            blurred_any = False
            for tf in target_faces:
                fx1, fy1, fx2, fy2 = [int(v) for v in tf.bbox]
                fx1, fy1 = max(0, fx1), max(0, fy1)
                fx2, fy2 = min(frame.shape[1], fx2), min(frame.shape[0], fy2)
                if fx2 > fx1 + 5 and fy2 > fy1 + 5:
                    roi = safe_frame[fy1:fy2, fx1:fx2]
                    kw = max(15, min(99, ((fx2 - fx1) // 2) * 2 + 1))
                    kh = max(15, min(99, ((fy2 - fy1) // 2) * 2 + 1))
                    safe_frame[fy1:fy2, fx1:fx2] = cv2.GaussianBlur(roi, (kw, kh), 30)
                    blurred_any = True
            if not blurred_any:
                safe_frame = cv2.GaussianBlur(frame, (99, 99), 30)
            _, encoded = cv2.imencode(".jpg", safe_frame, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
            return encoded.tobytes()

        # 고속 JPEG 인코딩 (품질 80, 실시간 초고속 전송)
        _, encoded = cv2.imencode(".jpg", swapped, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        result_bytes = encoded.tobytes()
        LAST_SWAPPED_FRAMES[source_key] = result_bytes
        LAST_SWAPPED_FRAMES["_latest"] = result_bytes
        return result_bytes
    except Exception as e:
        logger.error(f"Error processing frame: {e}")
        if source_key not in ("none", "beauty", "real"):
            if "_latest" in LAST_SWAPPED_FRAMES:
                return LAST_SWAPPED_FRAMES["_latest"]
            try:
                blurred = cv2.GaussianBlur(frame, (99, 99), 30)
                _, encoded = cv2.imencode(".jpg", blurred, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
                return encoded.tobytes()
            except Exception:
                pass
            placeholder = np.zeros((360, 640, 3), dtype=np.uint8)
            cv2.putText(placeholder, "Protecting Face...", (180, 180), cv2.FONT_HERSHEY_SIMPLEX, 1, (200, 200, 200), 2)
            _, encoded = cv2.imencode(".jpg", placeholder, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            return encoded.tobytes()
        return frame_bytes


# ----------------------------------------------------
# aiohttp HTTP & WebSocket 핸들러
# ----------------------------------------------------

async def handle_ping(request):
    return web.json_response({
        "status": "ok",
        "service": "deep-live-cam-faceswap",
        "cached_faces": list(SOURCE_FACE_CACHE.keys())
    })


async def handle_list_photos(request):
    """사용 가능한 얼굴 사진 목록 반환"""
    photos = []
    if PHOTO_DIR.exists():
        for p in sorted(PHOTO_DIR.iterdir()):
            if p.suffix.lower() in [".jpg", ".jpeg", ".png", ".webp"]:
                s = p.stem.lower()
                name = ("슈퍼맨 (Superman)" if s == "superman"
                        else "배트맨 (Batman)" if s == "batman"
                        else "스파이더맨 (Spider-Man)" if s == "spiderman"
                        else p.stem)
                photos.append({
                    "id": s,
                    "filename": p.name,
                    "name": name,
                    "url": f"photo/{p.name}"
                })
    return web.json_response({"ok": True, "photos": photos})


async def handle_swap_frame(request):
    """HTTP POST 프레임 스왑 (바이너리 입력 -> 바이너리 출력)"""
    source_name = request.headers.get("X-Source-Face", "superman")
    body = await request.read()
    if not body:
        return web.Response(status=400, text="Empty frame body")

    swapped = await asyncio.to_thread(process_frame, source_name, body)
    return web.Response(body=swapped, content_type="image/jpeg", headers={
        "Access-Control-Allow-Origin": "*",
        "X-Source-Face": source_name,
    })


async def handle_upload_photo(request):
    """사용자가 직접 얼굴 사진 업로드"""
    reader = await request.multipart()
    field = await reader.next()
    if field.name != "photo":
        return web.json_response({"ok": False, "error": "photo field required"}, status=400)

    filename = field.filename or f"custom_{int(time.time())}.jpg"
    dest = PHOTO_DIR / filename
    with open(dest, "wb") as f:
        while True:
            chunk = await field.read_chunk()
            if not chunk:
                break
            f.write(chunk)

    face = await asyncio.to_thread(load_source_face, filename)
    return web.json_response({
        "ok": True,
        "id": dest.stem.lower(),
        "filename": filename,
        "url": f"photo/{filename}",
        "faceDetected": face is not None
    })


async def handle_websocket(request):
    """실시간 양방향 WebSocket 핸들러 - 최신 프레임 우선 처리(버퍼 적체 및 고속 재생 완벽 방지)"""
    ws = web.WebSocketResponse(max_msg_size=10 * 1024 * 1024)
    await ws.prepare(request)
    client_id = id(ws)
    logger.info(f"WebSocket client connected: {client_id}")
    current_source = "superman"

    latest_pending = None
    processing_event = asyncio.Event()
    is_closed = False

    async def worker_loop():
        nonlocal latest_pending
        while not is_closed and not ws.closed:
            await processing_event.wait()
            processing_event.clear()
            if is_closed or ws.closed:
                break
            if latest_pending is not None:
                src_name, frame_bytes = latest_pending
                latest_pending = None
                try:
                    swapped = await asyncio.to_thread(process_frame, src_name, frame_bytes)
                    if not ws.closed:
                        await ws.send_bytes(swapped)
                except Exception as ex:
                    logger.warning(f"Error sending swapped frame: {ex}")

    worker_task = asyncio.create_task(worker_loop())

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.BINARY:
                data = msg.data
                if len(data) < 5:
                    continue
                name_len = struct.unpack(">I", data[:4])[0]
                if 4 + name_len <= len(data):
                    src_name = data[4:4 + name_len].decode("utf-8", errors="ignore") or current_source
                    frame_bytes = data[4 + name_len:]
                else:
                    src_name = current_source
                    frame_bytes = data

                # 항상 최신 프레임으로 덮어써서 이전 적체 프레임 즉시 드랍 (지연 누적 원천 방지)
                latest_pending = (src_name, frame_bytes)
                processing_event.set()

            elif msg.type == web.WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                    mtype = payload.get("type", "")

                    if mtype == "ping":
                        await ws.send_json({"type": "pong", "time": time.time()})

                    elif mtype == "set_source":
                        req_source = payload.get("source", "superman")
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
                        swapped = await asyncio.to_thread(process_frame, src_name, raw_bytes)
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
        logger.info(f"WebSocket client disconnected: {client_id}")

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
    app.router.add_get("/api/photos", handle_list_photos)
    app.router.add_post("/api/swap-frame", handle_swap_frame)
    app.router.add_post("/api/upload-face", handle_upload_photo)
    app.router.add_get("/ws", handle_websocket)
    app.router.add_get("/", handle_websocket)
    return app


async def start_server():
    logger.info("Deep-Live-Cam models & engines initializing...")
    get_face_analyser()
    get_face_swapper()
    logger.info("✅ Deep-Live-Cam AI models loaded successfully!")

    preload_all_photos()
    logger.info(f"✅ Preloaded {len(SOURCE_FACE_CACHE)} source face embeddings!")

    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, HOST, PORT)
    await site.start()
    logger.info(f"🚀 Face swap worker running on http://{HOST}:{PORT} and ws://{HOST}:{PORT}/ws")

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    if "--test" in sys.argv:
        print("Running diagnostic test on server/face_swap_worker.py...")
        get_face_analyser()
        get_face_swapper()
        preload_all_photos()
        test_img_path = PHOTO_DIR / "superman.jpg"
        if test_img_path.exists():
            test_bytes = test_img_path.read_bytes()
            swapped = process_frame("superman", test_bytes)
            print(f"Test swap finished. Input: {len(test_bytes)} bytes -> Output: {len(swapped)} bytes.")
        print("Diagnostic test completed successfully.")
        sys.exit(0)

    try:
        asyncio.run(start_server())
    except KeyboardInterrupt:
        logger.info("Server stopped by user.")

