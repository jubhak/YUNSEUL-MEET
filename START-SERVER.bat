@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  YUNSEUL PPT — Node (Apache 뒤단 3000)
echo  공개 접속: https://ppt.smrun.net/
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js 가 없습니다. https://nodejs.org 에서 LTS 설치 후 다시 실행하세요.
  pause
  exit /b 1
)

if not exist "node_modules\socket.io" (
  echo [1/2] 패키지 설치 중...
  call npm install
  if errorlevel 1 (
    echo npm install 실패
    pause
    exit /b 1
  )
)

echo [실행] 127.0.0.1:3000  (Apache가 80/443에서 이 포트로 프록시)
echo        종료: Ctrl+C
echo.
set PORT=3000
set HOST=127.0.0.1
node server\index.js
pause
