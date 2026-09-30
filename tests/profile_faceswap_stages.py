# -*- coding: utf-8 -*-
"""
tests/profile_faceswap_stages.py — 프레임 1장 처리 시간을 단계별로 쪼개서 병목 확인

    python tests/profile_faceswap_stages.py [--n 150] [--w 640]
단계: JPEG 디코드 / 얼굴 검출 / 스왑 추론(ONNX) / 붙여넣기(paste-back) / JPEG 인코드
"""
import argparse
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "deep-live-cam"))
os.environ.setdefault("FACE_SWAP_SET_THREADS", "1")

import cv2
import numpy as np

import face_swap_worker as fw  # noqa: E402
from modules.face_analyser import detect_many_faces_fast  # noqa: E402
from modules.processors.frame import face_swapper as fs  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--w", type=int, default=640)
    args = ap.parse_args()

    files = sorted(p for p in (ROOT / "photo").iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    img = cv2.imdecode(np.fromfile(str(files[0]), dtype=np.uint8), cv2.IMREAD_COLOR)
    h, w = img.shape[:2]
    scale = args.w / float(w)
    img = cv2.resize(img, (args.w, int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
    jpg = buf.tobytes()

    fw.get_face_analyser()
    swapper = fs.get_face_swapper()
    src = fw.load_source_face(files[-1].name)
    assert src is not None, "소스 얼굴 로드 실패"

    def bench(fn, n):
        for _ in range(10):
            fn()
        t0 = time.perf_counter()
        for _ in range(n):
            fn()
        return (time.perf_counter() - t0) * 1000.0 / n

    t_dec = bench(lambda: cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR), args.n)
    frame = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
    t_det = bench(lambda: detect_many_faces_fast(frame), args.n)
    faces = detect_many_faces_fast(frame)
    assert faces, "얼굴 검출 실패"
    face = faces[0]

    t_get = bench(lambda: swapper.get(frame.copy(), face, src, paste_back=False), args.n)
    bgr_fake, M = swapper.get(frame.copy(), face, src, paste_back=False)
    from insightface.utils.face_align import norm_crop2
    aimg, _ = norm_crop2(frame, face.kps, swapper.input_size[0])
    t_paste = bench(lambda: fs._fast_paste_back(frame.copy(), bgr_fake, aimg, M), args.n)
    t_swap_face = bench(lambda: fs.swap_face(src, face, frame.copy()), args.n)
    out = fs.swap_face(src, face, frame.copy())
    t_enc = bench(lambda: cv2.imencode(".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), 74]), args.n)
    t_full = bench(lambda: fw.process_frame(files[-1].name, jpg, 1, "prof"), args.n)

    print(f"frame={args.w}x{img.shape[0]}  providers={fw.modules.globals.execution_providers}")
    print(f"  JPEG decode         : {t_dec:6.2f} ms")
    print(f"  face detect (full)  : {t_det:6.2f} ms   (매 {fw._DETECT_EVERY}프레임마다 1회)")
    print(f"  swapper.get (ONNX)  : {t_get:6.2f} ms")
    print(f"  paste-back          : {t_paste:6.2f} ms")
    print(f"  swap_face 전체      : {t_swap_face:6.2f} ms")
    print(f"  JPEG encode         : {t_enc:6.2f} ms")
    print(f"  process_frame 전체  : {t_full:6.2f} ms  → 단일 스레드 최대 {1000.0 / t_full:.0f} fps")


if __name__ == "__main__":
    main()
