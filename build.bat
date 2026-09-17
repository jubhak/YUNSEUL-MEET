@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ========================================================
echo   YUNSEUL-PPT 위젯 앱 및 인스톨 쉴드(Setup.exe) 빌드
echo ========================================================
echo.

where python >nul 2>&1
if errorlevel 1 (
  echo [오류] Python이 설치되어 있지 않거나 PATH에 없습니다.
  pause
  exit /b 1
)

python tools\build_setup.py

pause
