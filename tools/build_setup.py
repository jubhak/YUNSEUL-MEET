# -*- coding: utf-8 -*-
"""
build_setup.py - YUNSEUL-PPT PyInstaller 단일 실행 파일 및 Setup.exe 빌드 스크립트
"""

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ICON_ICO = ROOT / "app_icon.ico"
ICON_PNG = ROOT / "app_icon.png"


def run_cmd(cmd: list[str]) -> None:
    print(">", " ".join(cmd))
    res = subprocess.run(cmd, cwd=ROOT)
    if res.returncode != 0:
        raise SystemExit(f"명령 실패: {cmd[0]} (종료 코드: {res.returncode})")


def build() -> None:
    os.environ.pop("PYTHONHOME", None)
    os.environ.pop("PYTHONPATH", None)

    # 실행 중인 프로세스 정리 (파일 잠금 해제)
    if os.name == "nt":
        subprocess.run(["taskkill", "/f", "/im", "YUNSEUL-PPT.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["taskkill", "/f", "/im", "YUNSEUL-PPT-Setup.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)

    # 1. 아이콘 확인 및 생성
    if not ICON_ICO.exists() or not ICON_PNG.exists():
        print("== 1. 앱 아이콘 생성 ==")
        from generate_icon import generate_icon
        generate_icon()
    else:
        print("== 1. 앱 아이콘 확인 완료 ==")

    # 2. PyInstaller 빌드
    print("== 2. PyInstaller 빌드 (Setup.exe 및 독립 실행기) ==")
    sep = ";" if os.name == "nt" else ":"

    # 공통 add-data
    add_datas = [
        f"--add-data={ICON_ICO}{sep}.",
        f"--add-data={ICON_PNG}{sep}.",
    ]

    hidden_imports = [
        "--hidden-import=PyQt6",
        "--hidden-import=PyQt6.QtCore",
        "--hidden-import=PyQt6.QtGui",
        "--hidden-import=PyQt6.QtWidgets",
        "--hidden-import=PyQt6.QtNetwork",
        "--hidden-import=installer",
        "--hidden-import=widget_app",
        "--hidden-import=install_meta",
    ]

    # 빌드 1: YUNSEUL-PPT-Setup.exe
    print("\n[빌드 1/2] YUNSEUL-PPT-Setup.exe (인스톨 쉴드 설치 마법사)...")
    cmd_setup = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--windowed",
        "--name", "YUNSEUL-PPT-Setup",
        "--icon", str(ICON_ICO),
        *add_datas,
        *hidden_imports,
        "--distpath", str(ROOT),
        "--workpath", str(ROOT / "build" / "build_setup"),
        "--specpath", str(ROOT / "build"),
        str(ROOT / "main.py"),
    ]
    run_cmd(cmd_setup)

    # 빌드 2: YUNSEUL-PPT.exe (단독 위젯 실행기)
    print("\n[빌드 2/2] YUNSEUL-PPT.exe (위젯 단독 실행 파일)...")
    cmd_app = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--windowed",
        "--name", "YUNSEUL-PPT",
        "--icon", str(ICON_ICO),
        *add_datas,
        *hidden_imports,
        "--distpath", str(ROOT),
        "--workpath", str(ROOT / "build" / "build_app"),
        "--specpath", str(ROOT / "build"),
        str(ROOT / "widget_app.py"),
    ]
    run_cmd(cmd_app)

    setup_exe = ROOT / "YUNSEUL-PPT-Setup.exe"
    app_exe = ROOT / "YUNSEUL-PPT.exe"

    print("\n=======================================================")
    print("[성공] 빌드 완료!")
    if setup_exe.exists():
        print(f" * 인스톨러: {setup_exe} ({setup_exe.stat().st_size / (1024*1024):.2f} MB)")
    if app_exe.exists():
        print(f" * 위젯 앱: {app_exe} ({app_exe.stat().st_size / (1024*1024):.2f} MB)")
    print("=======================================================\n")


if __name__ == "__main__":
    os.chdir(ROOT)
    build()
