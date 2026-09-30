# -*- coding: utf-8 -*-
"""
tests/bench_faceswap_gpu.py — 딥페이크(페이스 스왑) 워커 GPU/CPU 부하 벤치마크

실제 얼굴이 들어있는 프레임(photo/ 폴더 사진)을 N명의 가상 참가자가 목표 fps 로
계속 보내고, 워커가 실제로 얼마나 처리하는지 측정한다.

    python tests/bench_faceswap_gpu.py --url ws://127.0.0.1:8765/ws --clients 12 --seconds 20 --fps 15 --depth 2

측정: 참가자별/합계 수신 fps, 왕복 지연 p50/p90/p99, 드랍 수, GPU 사용률/VRAM(nvidia-smi 폴링), 프로세스 CPU%
v1(원본 JPEG 응답)과 v2(FS2 헤더 + JPEG 응답) 프로토콜을 모두 지원한다.
"""
import argparse
import asyncio
import json
import statistics
import struct
import subprocess
import sys
import time
from pathlib import Path

import aiohttp
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PHOTO_DIR = ROOT / "photo"


def load_frames(n_variants=6, w=640, h=360):
    files = sorted([p for p in PHOTO_DIR.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png")])
    if not files:
        raise SystemExit("photo/ 폴더에 사진이 없습니다.")
    frames = []
    for i in range(n_variants):
        img = cv2.imdecode(np.fromfile(str(files[i % len(files)]), dtype=np.uint8), cv2.IMREAD_COLOR)
        ih, iw = img.shape[:2]
        # 16:9 로 중앙 크롭 후 리사이즈 (웹캠 프레임 모사)
        target_ratio = w / h
        if iw / ih > target_ratio:
            nw = int(ih * target_ratio)
            x0 = (iw - nw) // 2
            img = img[:, x0:x0 + nw]
        else:
            nh = int(iw / target_ratio)
            y0 = max(0, (ih - nh) // 4)
            img = img[y0:y0 + nh, :]
        img = cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        frames.append(buf.tobytes())
    return frames, [f.stem for f in files]


def gpu_sample():
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total,power.draw",
             "--format=csv,noheader,nounits"], timeout=3).decode().strip().split(",")
        return float(out[0]), float(out[1]), float(out[2]), float(out[3])
    except Exception:
        return None


async def gpu_poller(stop, samples):
    while not stop.is_set():
        s = await asyncio.to_thread(gpu_sample)
        if s:
            samples.append(s)
        try:
            await asyncio.wait_for(stop.wait(), timeout=0.5)
        except asyncio.TimeoutError:
            pass


def parse_response(data: bytes):
    """v2: b'FS2\\0' + u32 seq + u32 procMs + jpeg  /  v1: 순수 JPEG"""
    if len(data) >= 12 and data[:4] == b"FS2\0":
        seq, proc_ms = struct.unpack(">II", data[4:12])
        return seq, proc_ms, data[12:]
    return None, None, data


async def client_task(session, url, cid, frames, source, duration, fps, depth, out, warmup, plain_name=False):
    lat = []
    sent = recv = dropped = 0
    async with session.ws_connect(url, max_msg_size=10 * 1024 * 1024) as ws:
        await ws.send_json({"type": "hello", "clientId": cid})
        inflight = {}
        seq = 0
        t_start = time.time()
        deadline = t_start + duration + warmup
        next_send = t_start
        interval = 1.0 / fps
        recv_task = None
        while time.time() < deadline:
            now = time.time()
            if now >= next_send and len(inflight) < depth:
                seq += 1
                name = (source if plain_name else f"{source}\x1f{seq}").encode()
                packet = struct.pack(">I", len(name)) + name + frames[seq % len(frames)]
                inflight[seq] = now
                await ws.send_bytes(packet)
                if now - t_start >= warmup:
                    sent += 1
                next_send = max(next_send + interval, now - interval)
            if recv_task is None:
                recv_task = asyncio.ensure_future(ws.receive())
            done, _ = await asyncio.wait({recv_task}, timeout=max(0.001, min(interval / 2, 0.01)))
            if done:
                msg = recv_task.result()
                recv_task = None
                if msg.type == aiohttp.WSMsgType.BINARY:
                    rseq, _pm, _jpg = parse_response(msg.data)
                    if rseq is None:
                        t0 = inflight.pop(min(inflight), None) if inflight else None
                    else:
                        t0 = inflight.pop(rseq, None)
                        # 이보다 오래된 요청은 건너뛴 것으로 간주 (드랍)
                        for k in [k for k in inflight if k < rseq]:
                            inflight.pop(k, None)
                    if t0 is not None and t0 - t_start >= warmup:
                        lat.append((time.time() - t0) * 1000.0)
                        recv += 1
                elif msg.type == aiohttp.WSMsgType.TEXT:
                    try:
                        j = json.loads(msg.data)
                    except Exception:
                        j = {}
                    if j.get("type") in ("skip", "drop"):
                        if j.get("seq") in inflight:
                            inflight.pop(j.get("seq"), None)
                        elif inflight:
                            inflight.pop(min(inflight), None)
                        dropped += 1
                elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                    break
            # 오래된 in-flight 정리 (3초)
            for k in [k for k, t in inflight.items() if time.time() - t > 3.0]:
                inflight.pop(k, None)
                dropped += 1
        if recv_task:
            recv_task.cancel()
    out[cid] = {"sent": sent, "recv": recv, "dropped": dropped, "lat": lat}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8765/ws")
    ap.add_argument("--clients", type=int, default=12)
    ap.add_argument("--seconds", type=int, default=20)
    ap.add_argument("--warmup", type=float, default=6.0)
    ap.add_argument("--fps", type=float, default=15.0)
    ap.add_argument("--depth", type=int, default=1)
    ap.add_argument("--stats-url", default="")
    ap.add_argument("--plain-name", action="store_true", help="v1 워커용: seq 없이 얼굴 이름만 전송")
    args = ap.parse_args()

    frames, names = load_frames()
    source = names[-1]
    out = {}
    stop = asyncio.Event()
    samples = []
    async with aiohttp.ClientSession() as session:
        poller = asyncio.create_task(gpu_poller(stop, samples))
        t0 = time.time()
        await asyncio.gather(*[
            client_task(session, args.url, f"bench{i}", frames, source, args.seconds, args.fps,
                        args.depth, out, args.warmup, args.plain_name)
            for i in range(args.clients)
        ])
        stop.set()
        await poller
        elapsed = time.time() - t0 - args.warmup

        all_lat = [x for r in out.values() for x in r["lat"]]
        tot_recv = sum(r["recv"] for r in out.values())
        tot_sent = sum(r["sent"] for r in out.values())
        tot_drop = sum(r["dropped"] for r in out.values())
        per_client_fps = [r["recv"] / max(1.0, args.seconds) for r in out.values()]

        def pct(v, p):
            if not v:
                return None
            v = sorted(v)
            return round(v[min(len(v) - 1, int(len(v) * p))], 1)

        print(f"\n=== 벤치 결과: clients={args.clients} target_fps={args.fps} depth={args.depth} {args.seconds}s ===")
        print(f"합계 수신: {tot_recv} 프레임 → {tot_recv / max(1.0, args.seconds):.1f} fps (요청 {tot_sent}, 드랍/타임아웃 {tot_drop})")
        print(f"참가자별 fps: 평균 {statistics.mean(per_client_fps):.1f} / 최소 {min(per_client_fps):.1f} / 최대 {max(per_client_fps):.1f}")
        print(f"왕복 지연(ms): p50={pct(all_lat, .5)} p90={pct(all_lat, .9)} p99={pct(all_lat, .99)}")
        if samples:
            util = [s[0] for s in samples]
            mem = [s[1] for s in samples]
            pw = [s[3] for s in samples]
            print(f"GPU: 사용률 평균 {statistics.mean(util):.0f}% / 최대 {max(util):.0f}%, "
                  f"VRAM 최대 {max(mem):.0f}/{samples[0][2]:.0f} MiB, 전력 평균 {statistics.mean(pw):.0f}W")
        summary = {
            "clients": args.clients, "target_fps": args.fps, "depth": args.depth,
            "total_fps": round(tot_recv / max(1.0, args.seconds), 1),
            "avg_client_fps": round(statistics.mean(per_client_fps), 1),
            "min_client_fps": round(min(per_client_fps), 1),
            "p50_ms": pct(all_lat, .5), "p90_ms": pct(all_lat, .9), "p99_ms": pct(all_lat, .99),
            "dropped": tot_drop,
            "gpu_util_avg": round(statistics.mean([s[0] for s in samples]), 0) if samples else None,
            "gpu_util_max": max([s[0] for s in samples]) if samples else None,
            "vram_max_mib": max([s[1] for s in samples]) if samples else None,
        }
        print("SUMMARY_JSON " + json.dumps(summary, ensure_ascii=False))
        if args.stats_url:
            try:
                async with session.get(args.stats_url, timeout=5) as r:
                    print("서버 /stats:", json.dumps(await r.json(), ensure_ascii=False))
            except Exception as e:
                print("(/stats 조회 실패)", e)


if __name__ == "__main__":
    asyncio.run(main())
