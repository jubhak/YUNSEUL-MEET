# -*- coding: utf-8 -*-
"""
tests/tune_onnx_providers.py — inswapper ONNX 세션 옵션/동시성별 순수 추론 속도 측정

    python tests/tune_onnx_providers.py

1) CUDA provider 옵션 비교 (기본 / HEURISTIC / max_workspace / IO binding / TensorRT)
2) 같은 프로세스에서 "독립 세션 K개 × 스레드 K개" 병렬 처리량 (VRAM 을 더 써서 GPU 동시성 확보)
"""
import os
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "deep-live-cam" / "models" / "inswapper_128_fp16.onnx"

import numpy as np
import torch  # noqa: F401  (torch 를 먼저 import 하면 CUDA/cuDNN DLL 을 공유한다 — 워커와 동일 조건)
import onnxruntime as ort


def make_session(provider_opts=None, providers=None, so=None):
    if providers is None:
        providers = [("CUDAExecutionProvider", provider_opts or {}), "CPUExecutionProvider"]
    return ort.InferenceSession(str(MODEL), sess_options=so, providers=providers)


def feed():
    return {
        "target": np.random.rand(1, 3, 128, 128).astype(np.float32),
        "source": np.random.rand(1, 512).astype(np.float32),
    }


def time_run(sess, n=200, use_io_binding=False):
    f = feed()
    if use_io_binding:
        io = sess.io_binding()
        t = ort.OrtValue.ortvalue_from_numpy(f["target"], "cuda", 0)
        s = ort.OrtValue.ortvalue_from_numpy(f["source"], "cuda", 0)
        io.bind_ortvalue_input("target", t)
        io.bind_ortvalue_input("source", s)
        io.bind_output(sess.get_outputs()[0].name, "cuda", 0)
        for _ in range(20):
            sess.run_with_iobinding(io)
        t0 = time.perf_counter()
        for _ in range(n):
            t.update_inplace(f["target"])
            sess.run_with_iobinding(io)
            io.get_outputs()[0].numpy()
        return (time.perf_counter() - t0) * 1000 / n
    for _ in range(20):
        sess.run(None, f)
    t0 = time.perf_counter()
    for _ in range(n):
        sess.run(None, f)
    return (time.perf_counter() - t0) * 1000 / n


def throughput(k, seconds=6.0, opts=None):
    sessions = [make_session(opts) for _ in range(k)]
    counts = [0] * k
    stop = time.time() + seconds
    f = feed()

    def loop(i):
        s = sessions[i]
        for _ in range(10):
            s.run(None, f)
        end = time.time() + seconds
        while time.time() < end:
            s.run(None, f)
            counts[i] += 1

    ths = [threading.Thread(target=loop, args=(i,)) for i in range(k)]
    t0 = time.time()
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    el = time.time() - t0
    return sum(counts) / el


def main():
    print("model:", MODEL.name, "ort", ort.__version__, ort.get_available_providers())
    inputs = [i.name for i in make_session().get_inputs()]
    print("inputs:", inputs)

    print("\n[1] 단일 세션 옵션 비교 (추론 1회, ms)")
    cases = {
        "default": {},
        "HEURISTIC": {"cudnn_conv_algo_search": "HEURISTIC"},
        "DEFAULT algo": {"cudnn_conv_algo_search": "DEFAULT"},
        "max_workspace": {"cudnn_conv_use_max_workspace": "1"},
        "same_as_requested": {"arena_extend_strategy": "kSameAsRequested"},
        "prefer_nhwc": {"prefer_nhwc": "1"},
        "nhwc+heuristic": {"prefer_nhwc": "1", "cudnn_conv_algo_search": "HEURISTIC"},
        "tf32 off": {"use_tf32": "0"},
    }
    for name, opts in cases.items():
        try:
            s = make_session(opts)
            print(f"  {name:18s}: {time_run(s):6.2f} ms   (io_binding: {time_run(s, use_io_binding=True):6.2f} ms)")
        except Exception as e:
            print(f"  {name:18s}: 실패 {e}")

    try:
        so = ort.SessionOptions()
        trt = make_session(providers=[("TensorrtExecutionProvider", {
            "trt_fp16_enable": True, "trt_engine_cache_enable": True,
            "trt_engine_cache_path": str(ROOT / "deep-live-cam" / "models" / "trt_cache"),
        }), "CUDAExecutionProvider"], so=so)
        active = trt.get_providers()
        print(f"  TensorRT           : {time_run(trt):6.2f} ms   (실제 provider: {active[:2]})")
    except Exception as e:
        print(f"  TensorRT           : 사용 불가 ({str(e)[:100]})")

    best = os.environ.get("TUNE_OPTS")
    opts = eval(best) if best else None  # 예: TUNE_OPTS="{'prefer_nhwc':'1'}"
    print("\n[2] 독립 세션 K개 × 스레드 K개 처리량 (추론/초)  opts=", opts)
    for k in (1, 2, 4, 6):
        tp = throughput(k, opts=opts)
        mem = ""
        try:
            import subprocess
            mem = subprocess.check_output(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"]).decode().strip()
        except Exception:
            pass
        print(f"  K={k}: {tp:7.1f} inf/s   (VRAM {mem} MiB)")


if __name__ == "__main__":
    main()
