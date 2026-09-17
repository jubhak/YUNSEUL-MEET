# -*- coding: utf-8 -*-
"""YUNSEUL-PPT 앱 아이콘 (.png 및 .ico) 자동 생성 스크립트."""

import os
import struct
import sys
from pathlib import Path
from PyQt6.QtCore import Qt, QRectF, QPointF
from PyQt6.QtGui import (
    QGuiApplication, QImage, QPainter, QColor, QPen, QBrush,
    QLinearGradient, QPainterPath
)

ROOT = Path(__file__).resolve().parents[1]
ICON_PNG = ROOT / "app_icon.png"
ICON_ICO = ROOT / "app_icon.ico"


def generate_icon(size: int = 256) -> None:
    if QGuiApplication.instance() is None:
        QGuiApplication(sys.argv)

    img = QImage(size, size, QImage.Format.Format_ARGB32_Premultiplied)
    img.fill(Qt.GlobalColor.transparent)

    p = QPainter(img)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)

    # 1. 메인 둥근 배경 (고급스러운 딥 블루-다크 슬레이트 그라데이션)
    bg_grad = QLinearGradient(0, 0, size, size)
    bg_grad.setColorAt(0.0, QColor("#0f172a"))
    bg_grad.setColorAt(1.0, QColor("#1e293b"))
    p.setBrush(QBrush(bg_grad))
    p.setPen(QPen(QColor("#334155"), 2))
    p.drawRoundedRect(QRectF(12, 12, size - 24, size - 24), 52, 52)

    # 2. 프레젠테이션 슬라이드 모니터/스크린 (16:9 느낌의 카드)
    slide_rect = QRectF(38, 48, 180, 115)
    slide_grad = QLinearGradient(38, 48, 218, 163)
    slide_grad.setColorAt(0.0, QColor("#ea580c"))  # PPT 특유의 에너지 넘치는 오렌지-레드
    slide_grad.setColorAt(1.0, QColor("#f97316"))
    p.setBrush(QBrush(slide_grad))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawRoundedRect(slide_rect, 14, 14)

    # 스크린 내부 디테일: 상단 슬라이드 바
    p.setBrush(QColor(255, 255, 255, 60))
    p.drawRoundedRect(QRectF(48, 58, 45, 10), 4, 4)

    # 차트/슬라이드 내용 그래픽 (화이트/반투명 막대들)
    p.setBrush(QColor(255, 255, 255, 220))
    p.drawRoundedRect(QRectF(52, 122, 20, 26), 4, 4)
    p.drawRoundedRect(QRectF(78, 98, 20, 50), 4, 4)
    p.drawRoundedRect(QRectF(104, 80, 20, 68), 4, 4)

    # 슬라이드 내 재생/공유 삼각 심볼
    play_path = QPainterPath()
    play_path.moveTo(148, 92)
    play_path.lineTo(178, 112)
    play_path.lineTo(148, 132)
    play_path.closeSubpath()
    p.setBrush(QColor("#ffffff"))
    p.drawPath(play_path)

    # 3. 프레젠테이션 스탠드 받침대
    stand_grad = QLinearGradient(128, 163, 128, 205)
    stand_grad.setColorAt(0.0, QColor("#94a3b8"))
    stand_grad.setColorAt(1.0, QColor("#64748b"))
    p.setBrush(QBrush(stand_grad))
    p.setPen(Qt.PenStyle.NoPen)
    # 기둥
    p.drawRoundedRect(QRectF(122, 163, 12, 32), 4, 4)
    # 베이스
    p.drawRoundedRect(QRectF(90, 195, 76, 12), 6, 6)

    # 4. 실시간 전송/스트리밍을 상징하는 전파 링 (우측 상단)
    p.setBrush(Qt.BrushStyle.NoBrush)
    p.setPen(QPen(QColor("#38bdf8"), 5, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
    p.drawArc(QRectF(185, 25, 45, 45), 30 * 16, 120 * 16)
    p.setPen(QPen(QColor("#0ea5e9"), 4, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
    p.drawArc(QRectF(195, 35, 25, 25), 30 * 16, 120 * 16)
    p.setBrush(QColor("#38bdf8"))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawEllipse(QPointF(207, 47), 4.5, 4.5)

    p.end()

    # PNG 저장
    img.save(str(ICON_PNG))
    print(f"PNG 아이콘 생성 완료: {ICON_PNG}")

    # ICO 파일 규격 패킹
    png_bytes = ICON_PNG.read_bytes()
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png_bytes), 6 + 16)
    ICON_ICO.write_bytes(header + entry + png_bytes)
    print(f"ICO 아이콘 생성 완료: {ICON_ICO}")


if __name__ == "__main__":
    generate_icon()
