# -*- coding: utf-8 -*-
"""
main.py - YUNSEUL-MEET 통합 진입점
실행 파일명이 *Setup*.exe 이거나 --install 인자가 주어지면 인스톨러 마법사 실행,
그 외에는 위젯 컨트롤러 앱(widget_app) 실행.
"""

import os
import sys
from pathlib import Path


def is_setup_mode() -> bool:
    args = {a.lower() for a in sys.argv[1:]}
    if "--app" in args:
        return False
    if "--install" in args or "--setup" in args:
        return True

    exe_path = sys.executable if getattr(sys, "frozen", False) else sys.argv[0]
    name = Path(exe_path).stem.lower()
    return "setup" in name


def main() -> int:
    if is_setup_mode():
        import installer
        return installer.main()
    else:
        import widget_app
        return widget_app.main()


if __name__ == "__main__":
    sys.exit(main())
