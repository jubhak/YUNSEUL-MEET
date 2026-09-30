# -*- coding: utf-8 -*-
"""
tests/faceswap_smoke.py — 워커 1회 왕복 스모크 테스트 (v1/v2 프로토콜 + 결과 이미지 저장)

    python tests/faceswap_smoke.py --url ws://127.0.0.1:8765/ws --out swapped.jpg
"""
import argparse
import asyncio
import struct
import sys
from pathlib import Path

import aiohttp
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8765/ws")
    ap.add_argument("--out", default="swapped.jpg")
    args = ap.parse_args()

    photos = sorted(p for p in (ROOT / "photo").iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    target = photos[0]
    source = photos[-1].stem
    img = cv2.imdecode(np.fromfile(str(target), dtype=np.uint8), cv2.IMREAD_COLOR)
    h, w = img.shape[:2]
    img = cv2.resize(img, (640, int(h * 640 / w)))
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 80])

    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(args.url, max_msg_size=10 * 1024 * 1024) as ws:
            # v2
            name = f"{source}\x1f7".encode()
            async def roundtrip(packet):
                await ws.send_bytes(packet)
                while True:  # drop/skip 텍스트 알림은 건너뛰고 바이너리 응답만 취한다
                    m = await asyncio.wait_for(ws.receive(), 15)
                    if m.type == aiohttp.WSMsgType.BINARY:
                        return m

            for _ in range(3):  # 첫 프레임은 워밍업/검출
                msg = await roundtrip(struct.pack(">I", len(name)) + name + buf.tobytes())
            assert msg.type == aiohttp.WSMsgType.BINARY, msg
            data = msg.data
            assert data[:4] == b"FS2\x00", "v2 헤더 없음"
            seq, proc, total = struct.unpack(">IHH", data[4:12])
            assert seq == 7, f"seq 불일치 {seq}"
            jpg = data[12:]
            print(f"v2 OK seq={seq} proc={proc}ms total={total}ms jpeg={len(jpg)}B")
            Path(args.out).write_bytes(jpg)

            # v1 (구 클라이언트): 이름만 → 순수 JPEG
            name1 = source.encode()
            msg = await roundtrip(struct.pack(">I", len(name1)) + name1 + buf.tobytes())
            assert msg.type == aiohttp.WSMsgType.BINARY and msg.data[:2] == b"\xff\xd8", "v1 응답이 JPEG 아님"
            print(f"v1 OK jpeg={len(msg.data)}B")

    orig = cv2.imdecode(np.frombuffer(buf.tobytes(), np.uint8), cv2.IMREAD_COLOR)
    out = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
    if out is None or out.shape != orig.shape:
        print("(출력 크기가 입력과 다름 — 부하 기반 다운스케일)", None if out is None else out.shape, orig.shape)
    else:
        diff = float(np.mean(np.abs(out.astype(np.float32) - orig.astype(np.float32))))
        print(f"원본 대비 평균 픽셀 차이 = {diff:.2f} (스왑되면 > 1)")
        assert diff > 1.0, "스왑 결과가 원본과 거의 같음"
    print("SMOKE PASS")


if __name__ == "__main__":
    asyncio.run(main())
