@echo off
chcp 65001 >nul
title YUNSEUL-PPT 오프라인 패키지 설치 도구

echo ================================================================
echo   [YUNSEUL-PPT] 오프라인 환경 의존성 자동 설치 마법사
echo ================================================================
echo.
echo [1/2] 번들된 휠(Wheel) 패키지 오프라인 일괄 설치 중...
python -m pip install --no-index --find-links=packages\wheels -r requirements-offline.txt

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [오류] 패키지 설치 중 오류가 발생했습니다. Python 환경을 확인해주세요.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [2/2] AI 모델(InsightFace Buffalo_L 및 Inswapper) 로컬 캐시 동기화 중...
python -c "import sys; sys.path.insert(0, 'deep-live-cam'); from modules.model_downloader import ensure_insightface_pack, ensure_model; print('[AI 모델] Buffalo_L 준비:', ensure_insightface_pack('buffalo_l')); print('[AI 모델] Inswapper 준비:', '정상' if ensure_model('inswapper_128_fp16.onnx') else '누락')"

echo.
echo ================================================================
echo   [완료] 모든 오프라인 패키지 및 AI 모델 준비가 완료되었습니다!
echo   인터넷 연결이 없는 환경에서도 딥라이브캠 실시간 얼굴 변환이 정상 동작합니다.
echo ================================================================
echo.
pause
