@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo  YUNSEUL MEET ??Node (Apache ?ㅻ떒 3000)
echo  怨듦컻 ?묒냽: https://ppt.smrun.net/
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [?ㅻ쪟] Node.js 媛 ?놁뒿?덈떎. https://nodejs.org ?먯꽌 LTS ?ㅼ튂 ???ㅼ떆 ?ㅽ뻾?섏꽭??
  pause
  exit /b 1
)

if not exist "node_modules\socket.io" (
  echo [1/2] ?⑦궎吏 ?ㅼ튂 以?..
  call npm install
  if errorlevel 1 (
    echo npm install ?ㅽ뙣
    pause
    exit /b 1
  )
)

echo [?ㅽ뻾] 127.0.0.1:3000  (Apache媛 80/443?먯꽌 ???ы듃濡??꾨줉??
echo        醫낅즺: Ctrl+C
echo.
set PORT=3000
set HOST=127.0.0.1
node server\index.js
pause

