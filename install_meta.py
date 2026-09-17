# -*- coding: utf-8 -*-
"""설치기 설치본 판별 및 바로가기 / 제거 도우미 모듈."""

import json
import os
import subprocess
import sys
import tempfile

MARKER_NAME = "install.json"
PRODUCT_NAME = "YUNSEUL-PPT"
APP_EXE_NAME = "YUNSEUL-PPT.exe"
DESKTOP_LNK_NAME = "YUNSEUL-PPT.lnk"
STARTMENU_FOLDER_NAME = "YUNSEUL-PPT"


def get_app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def marker_path(install_dir=None):
    return os.path.join(install_dir or get_app_dir(), MARKER_NAME)


def is_installed_copy():
    """설치기로 복사된 실행 파일에서만 True. 포터블 exe / 소스 실행은 False."""
    if not getattr(sys, "frozen", False):
        return False
    return os.path.isfile(marker_path())


def load_install_meta(install_dir=None):
    path = marker_path(install_dir)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return None
        return data
    except (OSError, json.JSONDecodeError):
        return None


def write_install_meta(install_dir, desktop_lnk="", startmenu_dir=""):
    data = {
        "product": PRODUCT_NAME,
        "install_dir": os.path.abspath(install_dir),
        "desktop_lnk": desktop_lnk or "",
        "startmenu_dir": startmenu_dir or "",
    }
    os.makedirs(install_dir, exist_ok=True)
    with open(marker_path(install_dir), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _ps_quote(value):
    return "'" + str(value or "").replace("'", "''") + "'"


def is_safe_install_dir(path):
    if not path:
        return False
    abs_path = os.path.abspath(path)
    if len(abs_path) < 8:
        return False
    exe_path = os.path.join(abs_path, APP_EXE_NAME)
    return os.path.isfile(exe_path) and os.path.isfile(marker_path(abs_path))


def create_shortcut(target, shortcut_path, icon_path="", description=""):
    try:
        ps_cmd = (
            f'$ws = New-Object -ComObject WScript.Shell; '
            f'$s = $ws.CreateShortcut("{shortcut_path}"); '
            f'$s.TargetPath = "{target}"; '
            f'$s.WorkingDirectory = "{os.path.dirname(target)}";'
        )
        if icon_path and os.path.exists(icon_path):
            ps_cmd += f' $s.IconLocation = "{icon_path}";'
        if description:
            ps_cmd += f' $s.Description = "{description}";'
        ps_cmd += " $s.Save()"
        subprocess.run(
            ["powershell", "-Command", ps_cmd],
            capture_output=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return True
    except Exception:
        return False


def start_uninstall_helper(wait_pid, install_dir=None, meta=None, show_done=True):
    target_dir = os.path.abspath(install_dir or get_app_dir())
    if not is_safe_install_dir(target_dir):
        return False, "설치 폴더를 확인할 수 없어 제거를 시작하지 않았습니다."

    meta = meta or load_install_meta(target_dir) or {}
    desktop_lnk = meta.get("desktop_lnk") or os.path.join(
        os.environ.get("USERPROFILE", ""), "Desktop", DESKTOP_LNK_NAME
    )
    startmenu_dir = meta.get("startmenu_dir") or os.path.join(
        os.environ.get("APPDATA", ""),
        "Microsoft", "Windows", "Start Menu", "Programs", STARTMENU_FOLDER_NAME,
    )

    show_done_ps = "$true" if show_done else "$false"
    script = f"""$ErrorActionPreference = 'SilentlyContinue'
$waitPid = {int(wait_pid)}
$installDir = {_ps_quote(target_dir)}
$desktopLnk = {_ps_quote(desktop_lnk)}
$startMenuDir = {_ps_quote(startmenu_dir)}
$showDone = {show_done_ps}

if ($waitPid -gt 0) {{
    try {{
        $proc = Get-Process -Id $waitPid -ErrorAction SilentlyContinue
        if ($proc) {{
            $null = $proc.WaitForExit(7000)
        }}
    }} catch {{}}
}}

Start-Sleep -Milliseconds 500

if (Test-Path $desktopLnk) {{
    Remove-Item -Path $desktopLnk -Force -ErrorAction SilentlyContinue
}}

if (Test-Path $startMenuDir) {{
    Remove-Item -Path $startMenuDir -Recurse -Force -ErrorAction SilentlyContinue
}}

if (Test-Path $installDir) {{
    for ($i = 0; $i -lt 5; $i++) {{
        Remove-Item -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $installDir)) {{ break }}
        Start-Sleep -Milliseconds 400
    }}
}}

if ($showDone) {{
    [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms') | Out-Null
    [System.Windows.Forms.MessageBox]::Show('YUNSEUL-PPT 프로그램이 성공적으로 제거되었습니다.', 'YUNSEUL-PPT 제거 완료', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
}}
"""
    try:
        fd, script_path = tempfile.mkstemp(prefix="yunseul_ppt_uninst_", suffix=".ps1")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(script)

        subprocess.Popen(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy", "Bypass",
                "-File", script_path,
            ],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "DETACHED_PROCESS", 0x00000008),
            close_fds=True,
        )
        return True, "제거 프로세스가 실행되었습니다."
    except Exception as exc:
        return False, f"제거 실패: {exc}"
