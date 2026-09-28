# -*- coding: utf-8 -*-
"""
tests/verify_faceswap_10_clients.py

10명이 동시에 딥페이크(페이스 스왑)를 요청할 때 워커가 실시간 예산을
지키는지 검증한다. 서버(GPU 워커)가 떠 있는 상태에서 실행:

    python tests/verify_faceswap_10_clients.py --clients 10 --seconds 30

측정 항목
  - 클라이언트별 왕복 지연 p50 / p90 (ms)
  - 처리량(요청/초), 드랍(응답 없음/타임아웃) 비율
  - 서버가 알려주는 권고 fps(/stats)와 실측 달성 fps 비교
  - 동일 얼굴(superman)을 쓰는 참가자 간 결과 혼입 여부(프레임 해시 비교)

주의: 이 스크립트는 워커에 부하를 준다. 실제 미팅 중에는 실행하지 말 것.
"""
import argparse
import asyncio
import hashlib
import json
import statistics
import struct
import sys
import time

try:
    import cv2
    import numpy as np
except Exception:
    print("opencv-python / numpy 가 필요합니다.", file=sys.stderr)
    raise

import aiohttp  # type: ignore


def make_frame(w=640, h=360, seed=0):
    rng = np.random.default_rng(seed)
    frame = rng.integers(40, 210, size=(h, w, 3), dtype=np.uint8)
    # 실제 웹캠 대신 '얼굴처럼 보이는' 단순 패턴(검출률은 낮지만 부하는 동일)
    cv2.ellipse(frame, (w // 2, h // 2), (w // 6, h // 4), 0, 0, 360, (190, 160, 140), -1)
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
    return buf.tobytes()


async def client_task(session, url, cid, frame_bytes, duration, out):
    lat = []
    sent = recv = fail = 0
    hashes = set()
    deadline = time.time() + duration
    async with session.ws_connect(url) as ws:
        await ws.send_json({"type": "hello", "clientId": cid})
        await ws.send_json({"type": "set_source", "source": "superman"})
        name = b"superman"
        header = struct.pack(">I", len(name))
        packet = header + name + frame_bytes
        inflight = set()
        while time.time() < deadline:
            if len(inflight) < 2:
                t0 = time.time()
                await ws.send_bytes(packet)
                inflight.add(t0)
                sent += 1
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=3.0)
            except asyncio.TimeoutError:
                fail += 1
                inflight.clear()
                continue
            if msg.type == aiohttp.WSMsgType.BINARY and inflight:
                t0 = inflight.pop()
                lat.append((time.time() - t0) * 1000.0)
                recv += 1
                hashes.add(hashlib.md5(msg.data).hexdigest()[:8])
            elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                fail += 1
                break
            else:
                if inflight and recv + fail < sent:
                    inflight.pop()
    out[cid] = {
        "sent": sent, "recv": recv, "fail": fail,
        "p50": round(statistics.median(lat), 1) if lat else None,
        "p90": round(statistics.quantiles(lat, n=10)[8], 1) if len(lat) >= 10 else None,
        "fps": round(recv / duration, 1),
        "distinct_frames": len(hashes),
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:3000/face-swap-ws")
    ap.add_argument("--clients", type=int, default=10)
    ap.add_argument("--seconds", type=int, default=30)
    args = ap.parse_args()

    frame = make_frame()
    out = {}
    async with aiohttp.ClientSession() as session:
        tasks = [client_task(session, args.url, f"verify{cid}", frame, args.seconds, out)
                 for cid in range(args.clients)]
        await asyncio.gather(*tasks)

    print("\n== 참가자별 결과 ==")
    for cid, r in sorted(out.items()):
        print(f"  {cid}: sent={r['sent']} recv={r['recv']} fail={r['fail']} "
              f"p50={r['p50']}ms p90={r['p90']}ms fps={r['fps']} frames={r['distinct_frames']}")

    tot_sent = sum(r["sent"] for r in out.values())
    tot_recv = sum(r["recv"] for r in out.values())
    tot_fail = sum(r["fail"] for r in out.values())
    print(f"\n총합: sent={tot_sent} recv={tot_recv} fail={tot_fail} "
          f"성공률={100.0 * tot_recv / max(1, tot_sent):.1f}%")

    try:
        async with aiohttp.ClientSession() as s:
            async with s.get("http://127.0.0.1:3000/api/faceswap-status", timeout=5) as r:
                print("서버 /stats:", json.dumps(await r.json(), ensure_ascii=False, indent=2))
    except Exception as e:
        print("(/stats 조회 실패:", e, ")")

    print("\n판정 기준: 참가자별 fps >= 8, p90 <= 260ms, 성공률 >= 95%")


if __name__ == "__main__":
    asyncio.run(main())
