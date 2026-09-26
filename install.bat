@echo off
chcp 65001 >nul
cd /d "%~dp0"

:: ----------------------------------------------------
:: [0단계] 관리자 권한 확인 및 자동 승격 (방화벽 설정 필수)
:: ----------------------------------------------------
net session >nul 2>&1
if errorlevel 1 (
    echo.
    echo ========================================================
    echo   [안내] 윈도우 방화벽 규칙 자동 등록 및 환경 구성을 위해
    echo          관리자 권한이 필요합니다.
    echo.
    echo   UAC(사용자 계정 컨트롤) 승인 창이 뜨면 '예(Yes)'를 선택해 주세요...
    echo ========================================================
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd.exe -ArgumentList '/c \"\"%~f0\"\"' -Verb RunAs"
    exit /b
)

echo ========================================================
echo   YUNSEUL-PPT 자동 환경 구성 및 빌드 마법사 (install.bat)
echo ========================================================
echo.

:: ----------------------------------------------------
:: [1단계] 필수 런타임(Python / Node.js) 확인 및 자동 설치
:: ----------------------------------------------------
echo [1/4] 필수 프로그램(Python, Node.js) 확인 중...

where python >nul 2>&1
if errorlevel 1 (
    echo.
    echo [알림] Python이 감지되지 않았습니다.
    where winget >nul 2>&1
    if not errorlevel 1 (
        echo winget을 통해 Python 최신 버전을 자동으로 설치합니다...
        winget install --id Python.Python.3.13 -e --source winget --accept-package-agreements --accept-source-agreements
        echo.
        echo [안내] Python 설치가 완료되었습니다. 새 환경 변수 반영을 위해
        echo        현재 창을 닫고 install.bat을 다시 한 번 실행해 주세요!
        pause
        exit /b 0
    ) else (
        echo [오류] https://www.python.org/ 에서 Python을 설치해 주세요.
        echo        (설치 시 'Add python.exe to PATH' 체크 필수)
        pause
        exit /b 1
    )
) else (
    echo   - Python: 확인 완료
)

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo [알림] Node.js가 감지되지 않았습니다.
    where winget >nul 2>&1
    if not errorlevel 1 (
        echo winget을 통해 Node.js LTS 버전을 자동으로 설치합니다...
        winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
        echo.
        echo [안내] Node.js 설치가 완료되었습니다. 새 환경 변수 반영을 위해
        echo        현재 창을 닫고 install.bat을 다시 한 번 실행해 주세요!
        pause
        exit /b 0
    ) else (
        echo [오류] https://nodejs.org/ 에서 Node.js LTS를 설치해 주세요.
        pause
        exit /b 1
    )
) else (
    echo   - Node.js: 확인 완료
)

echo.
:: ----------------------------------------------------
:: [2단계] 필수 패키지 및 라이브러리 설치 (npm & pip)
:: ----------------------------------------------------
echo [2/4] 필수 라이브러리(Node 패키지 및 Python 라이브러리) 설치 중...
echo.

echo   (1) npm 패키지 설치 중 (npm install)...
call npm install
if errorlevel 1 (
    echo [경고] npm install 중 일부 경고가 발생했을 수 있습니다. 계속 진행합니다.
)

echo.
echo   (2) Python 필수 라이브러리 설치 중 (PyInstaller, PyQt6, Pillow)...
python -m pip install --upgrade pip >nul 2>&1
python -m pip install pyinstaller PyQt6 Pillow
if errorlevel 1 (
    echo [오류] Python 라이브러리 설치에 실패했습니다. 네트워크 연결을 확인해 주세요.
    pause
    exit /b 1
)

echo.
:: ----------------------------------------------------
:: [3단계] 단일 실행 파일 및 인스톨러 빌드
:: ----------------------------------------------------
echo [3/4] 실행 파일(.exe) 및 인스톨 쉴드(Setup.exe) 자동 빌드 중...
echo.

python tools\build_setup.py
if errorlevel 1 (
    echo.
    echo [오류] 빌드 도중 문제가 발생했습니다.
    pause
    exit /b 1
)

echo.
:: ----------------------------------------------------
:: [4단계] 윈도우 방화벽 인바운드 규칙 자동 등록
:: ----------------------------------------------------
echo [4/4] 윈도우 방화벽 인바운드 허용 포트 등록 중...
echo.

echo   (1) 웹 & 소켓 포트 등록 (TCP 3000)...
netsh advfirewall firewall delete rule name="YUNSEUL-PPT 웹 서버 (TCP 3000)" >nul 2>&1
netsh advfirewall firewall add rule name="YUNSEUL-PPT 웹 서버 (TCP 3000)" dir=in action=allow protocol=TCP localport=3000 profile=any description="YUNSEUL-PPT Web Server and Socket.io" >nul 2>&1

echo   (2) 화상/미디어 스트리밍 포트 등록 (UDP/TCP 44444)...
netsh advfirewall firewall delete rule name="YUNSEUL-PPT SFU 미디어 (UDP 44444)" >nul 2>&1
netsh advfirewall firewall add rule name="YUNSEUL-PPT SFU 미디어 (UDP 44444)" dir=in action=allow protocol=UDP localport=44444 profile=any description="YUNSEUL-PPT WebRTC SFU RTC Port" >nul 2>&1

netsh advfirewall firewall delete rule name="YUNSEUL-PPT SFU 미디어 (TCP 44444)" >nul 2>&1
netsh advfirewall firewall add rule name="YUNSEUL-PPT SFU 미디어 (TCP 44444)" dir=in action=allow protocol=TCP localport=44444 profile=any description="YUNSEUL-PPT WebRTC SFU RTC TCP Port" >nul 2>&1

echo   (3) 다중 접속 보조 미디어 포트 대역 등록 (UDP 40000-49999)...
netsh advfirewall firewall delete rule name="YUNSEUL-PPT SFU 미디어 범위 (UDP 40000-49999)" >nul 2>&1
netsh advfirewall firewall add rule name="YUNSEUL-PPT SFU 미디어 범위 (UDP 40000-49999)" dir=in action=allow protocol=UDP localport=40000-49999 profile=any description="YUNSEUL-PPT WebRTC Dynamic Media Port Range" >nul 2>&1

echo.
echo   - 윈도우 방화벽 허용 규칙 등록이 완료되었습니다.

echo.
echo ========================================================
echo   [성공] 모든 환경 설정, 빌드 및 방화벽 등록이 완료되었습니다!
echo.
echo   * 데스크톱 위젯: YUNSEUL-PPT.exe
echo   * 설치 마법사:   YUNSEUL-PPT-Setup.exe
echo   * 윈도우 방화벽: 포트 3000(TCP), 44444(UDP/TCP), 40000-49999(UDP) 등록 완료
echo.
echo   [안내] 외부 참가자가 접속할 수 있도록 공유기 포트포워딩 설정 안내 창이 열립니다.
echo ========================================================
echo.

if exist "%~dp0공유기_포트포워딩_설정안내.txt" (
    start "" notepad.exe "%~dp0공유기_포트포워딩_설정안내.txt"
)

pause
