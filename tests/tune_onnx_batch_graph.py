# -*- coding: utf-8 -*-
"""
tests/tune_onnx_batch_graph.py — inswapper 배치 추론 / CUDA Graph 가능 여부 및 속도 측정
(배치 추론이 되면 참가자 N명의 얼굴을 한 번의 GPU 호출로 처리해 처리량을 크게 올릴 수 있다)
"""
import sys
import time
from pathlib import Path

import numpy as np
import torch  # noqa: F401
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "deep-live-cam" / "models" / "inswapper_128_fp16.onnx"


def run_ms(sess, batch, n=100):
    f = {"target": np.random.rand(batch, 3, 128, 128).astype(np.float32),
         "source": np.random.rand(batch, 512).astype(np.float32)}
    for _ in range(10):
        sess.run(None, f)
    t0 = time.perf_counter()
    for _ in range(n):
        out = sess.run(None, f)
    return (time.perf_counter() - t0) * 1000 / n, out[0].shape


def main():
    sess = ort.InferenceSession(str(MODEL), providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    print("inputs:", [(i.name, i.shape) for i in sess.get_inputs()])
    print("outputs:", [(o.name, o.shape) for o in sess.get_outputs()])
    for b in (1, 2, 4, 8, 12, 16):
        try:
            ms, shp = run_ms(sess, b)
            print(f"  batch={b:2d}: {ms:7.2f} ms/call → {ms / b:6.2f} ms/face  ({1000.0 * b / ms:6.1f} faces/s) out={shp}")
        except Exception as e:
            print(f"  batch={b:2d}: 불가 ({str(e)[:90]})")
            break

    try:
        s2 = ort.InferenceSession(str(MODEL), providers=[("CUDAExecutionProvider", {"enable_cuda_graph": "1"}), "CPUExecutionProvider"])
        t = ort.OrtValue.ortvalue_from_numpy(np.random.rand(1, 3, 128, 128).astype(np.float32), "cuda", 0)
        s = ort.OrtValue.ortvalue_from_numpy(np.random.rand(1, 512).astype(np.float32), "cuda", 0)
        io = s2.io_binding()
        io.bind_ortvalue_input("target", t)
        io.bind_ortvalue_input("source", s)
        io.bind_output(s2.get_outputs()[0].name, "cuda", 0)
        for _ in range(10):
            s2.run_with_iobinding(io)
        t0 = time.perf_counter()
        for _ in range(200):
            s2.run_with_iobinding(io)
        ms = (time.perf_counter() - t0) * 1000 / 200
        print(f"  CUDA graph (batch 1): {ms:6.2f} ms/call")
    except Exception as e:
        print("  CUDA graph 실패:", str(e)[:120])


if __name__ == "__main__":
    main()
