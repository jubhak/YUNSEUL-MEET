@echo off
title YUNSEUL PPT - Deep-Live-Cam
cls

echo =======================================================
echo          YUNSEUL-PPT : Deep-Live-Cam AI 실행기
echo =======================================================
echo.
echo [1/2] Python 환경 및 필수 패키지 점검 중...

python -c "import PySide6, insightface, cv2_enumerate_cameras" >nul 2>&1
if errorlevel 1 (
    echo [안내] 필수 AI 패키지를 자동 설치합니다...
    python -m pip install PySide6 insightface cv2_enumerate_cameras pygrabber opennsfw2
)

echo [1/2] 필수 패키지 확인 완료.
echo.
echo =======================================================
echo [사용 방법]
echo  1. Deep-Live-Cam 창이 열리면 [Select a face] 클릭
echo  2. photo 폴더 내 영웅 사진 선택:
echo     - photo\superman.jpg  (슈퍼맨)
echo     - photo\batman.jpg    (배트맨)
echo     - photo\spiderman.jpg (스파이더맨)
echo.
echo  3. [Live] 버튼 클릭 - 웹캠 실시간 얼굴 변환 시작
echo  4. 가상 카메라(OBS Virtual Camera)로 미팅 송출
echo =======================================================
echo.
echo [2/2] Deep-Live-Cam 프로그램을 시작합니다...
cd /d "%~dp0deep-live-cam"
python run.py
cd /d "%~dp0"

pause
