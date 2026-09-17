# -*- coding: utf-8 -*-
"""
widget_app.py - YUNSEUL-PPT 위젯 컨트롤러 데스크톱 앱
서버 상태 실시간 표시, 서버 시작/정지 토글, 브라우저 열기 및 시스템 트레이 지원.
"""

import os
import sys
import json
import time
import urllib.request
import urllib.error
import subprocess
import webbrowser
from pathlib import Path

from PyQt6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QPushButton, QFrame, QSystemTrayIcon, QMenu,
    QGraphicsDropShadowEffect, QDialog
)
from PyQt6.QtCore import Qt, QTimer, QPoint, pyqtSignal, QThread
from PyQt6.QtGui import QFont, QColor, QIcon, QPixmap, QCursor, QAction


def get_base_dir():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def find_server_dir():
    """server/index.js가 있는 프로젝트 루트 디렉토리를 찾습니다."""
    base = get_base_dir()
    # 1. 현재 폴더에 server/index.js 있는지 확인
    if (base / "server" / "index.js").exists():
        return base
    # 2. 상위 폴더 확인
    if (base.parent / "server" / "index.js").exists():
        return base.parent
    # 3. 개발 워크스페이스 고정 경로 폴더
    dev_path = Path(r"D:\workspace\YUNSEUL-PPT")
    if (dev_path / "server" / "index.js").exists():
        return dev_path
    return base


class ConfirmExitDialog(QDialog):
    """서버 종료 및 프로그램 종료 확인 모달 대화상자"""
    def __init__(self, is_running=False, parent=None):
        super().__init__(parent)
        self.is_running = is_running
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.Dialog |
            Qt.WindowType.WindowStaysOnTopHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setFixedSize(390, 215 if is_running else 195)
        self.drag_position = QPoint()

        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 10, 10, 10)

        card = QFrame()
        card.setObjectName("dialogCard")
        card.setStyleSheet("""
            QFrame#dialogCard {
                background-color: #0f172a;
                border: 1px solid #334155;
                border-radius: 14px;
            }
        """)
        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(20)
        shadow.setColor(QColor(0, 0, 0, 220))
        shadow.setOffset(0, 4)
        card.setGraphicsEffect(shadow)

        c_layout = QVBoxLayout(card)
        c_layout.setContentsMargins(20, 18, 20, 18)
        c_layout.setSpacing(12)

        # 상단 헤더 (아이콘 + 타이틀)
        header = QHBoxLayout()
        header.setSpacing(8)

        icon_lbl = QLabel("⚠️" if is_running else "ℹ️")
        icon_lbl.setStyleSheet("font-size: 18px;")
        header.addWidget(icon_lbl)

        title_text = "미팅 서버 종료 확인" if is_running else "프로그램 종료"
        title = QLabel(title_text)
        title.setStyleSheet("font-size: 15px; font-weight: bold; color: #f8fafc; font-family: 'Segoe UI', sans-serif;")
        header.addWidget(title)
        header.addStretch()

        btn_close_x = QPushButton("✕")
        btn_close_x.setFixedSize(22, 22)
        btn_close_x.clicked.connect(self.reject)
        btn_close_x.setStyleSheet("""
            QPushButton {
                background: transparent;
                border: none;
                color: #94a3b8;
                font-size: 12px;
            }
            QPushButton:hover { color: #ffffff; }
        """)
        header.addWidget(btn_close_x)

        c_layout.addLayout(header)

        # 본문 안내 메시지 (실행 중일 때와 정지 상태일 때 분기)
        if is_running:
            msg_text = (
                "실행 중인 PPT 미팅 서버를 중단하고\n"
                "프로그램을 완전히 종료하시겠습니까?\n\n"
                "※ 종료 시 진행 중인 발표 및 시청자 연결이 모두 종료됩니다."
            )
        else:
            msg_text = (
                "PPT 미팅 서버를 종료합니다.\n"
                "프로그램을 완전히 종료하시겠습니까?"
            )

        msg = QLabel(msg_text)
        msg.setStyleSheet("color: #cbd5e1; font-size: 12px; line-height: 1.4;")
        c_layout.addWidget(msg)

        c_layout.addStretch()

        # 하단 버튼 (취소 / 종료)
        btn_box = QHBoxLayout()
        btn_box.setSpacing(10)

        btn_cancel = QPushButton("취소")
        btn_cancel.setFixedHeight(36)
        btn_cancel.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        btn_cancel.setStyleSheet("""
            QPushButton {
                background-color: #1e293b;
                color: #cbd5e1;
                border: 1px solid #475569;
                border-radius: 6px;
                font-size: 12px;
                font-weight: 600;
                padding: 0 16px;
            }
            QPushButton:hover {
                background-color: #334155;
                color: #ffffff;
            }
            QPushButton:pressed {
                background-color: #0f172a;
            }
        """)
        btn_cancel.clicked.connect(self.reject)
        btn_box.addWidget(btn_cancel)

        exit_btn_text = "서버 종료" if is_running else "종료"
        btn_exit = QPushButton(exit_btn_text)
        btn_exit.setFixedHeight(36)
        btn_exit.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        btn_exit.setStyleSheet("""
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #dc2626, stop:1 #b91c1c);
                color: #ffffff;
                border: none;
                border-radius: 6px;
                font-size: 12px;
                font-weight: bold;
                padding: 0 18px;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #ef4444, stop:1 #dc2626);
            }
            QPushButton:pressed {
                background-color: #991b1b;
            }
        """)
        btn_exit.clicked.connect(self.accept)
        btn_box.addWidget(btn_exit)

        c_layout.addLayout(btn_box)
        layout.addWidget(card)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.drag_position = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event):
        if event.buttons() == Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self.drag_position)
            event.accept()


class HealthCheckWorker(QThread):
    status_signal = pyqtSignal(bool, dict)

    def __init__(self, port=3000):
        super().__init__()
        self.port = port

    def run(self):
        url = f"http://127.0.0.1:{self.port}/api/health"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "YUNSEUL-PPT-Widget"})
            with urllib.request.urlopen(req, timeout=1.0) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    self.status_signal.emit(True, data)
                    return
        except Exception:
            pass
        self.status_signal.emit(False, {})


class PPTWidget(QWidget):
    def __init__(self):
        super().__init__()
        self.server_dir = find_server_dir()
        self.server_process = None
        self.is_running = False
        self.port = 3000
        self.drag_position = QPoint()
        self.is_transitioning = False

        self.init_ui()
        self.init_tray()
        self.init_timer()
        self.check_status_now()

    def init_ui(self):
        # 프레임리스 창 설정 및 투명 배경 (둥근 모서리 효과용)
        self.setWindowFlags(Qt.WindowType.FramelessWindowHint | Qt.WindowType.Window)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setFixedSize(460, 260)
        self.setWindowTitle("YUNSEUL PPT Controller")

        ico_path = str(get_base_dir() / "app_icon.ico")
        if os.path.exists(ico_path):
            self.setWindowIcon(QIcon(ico_path))

        # 메인 컨테이너 (그림자 효과 마진 12)
        root_layout = QVBoxLayout(self)
        root_layout.setContentsMargins(12, 12, 12, 12)

        # 메인 카드 프레임
        self.card = QFrame()
        self.card.setObjectName("mainCard")
        self.card.setStyleSheet("""
            QFrame#mainCard {
                background-color: #0f172a;
                border-radius: 16px;
                border: 1px solid #334155;
            }
        """)

        # 카드 그림자
        shadow = QGraphicsDropShadowEffect(self)
        shadow.setBlurRadius(24)
        shadow.setColor(QColor(0, 0, 0, 180))
        shadow.setOffset(0, 6)
        self.card.setGraphicsEffect(shadow)

        card_layout = QVBoxLayout(self.card)
        card_layout.setContentsMargins(18, 14, 18, 18)
        card_layout.setSpacing(12)

        # --- 1. 상단 헤더 바 (드래그 핸들, 타이틀, 핀/최소화/닫기) ---
        header = QHBoxLayout()
        header.setContentsMargins(0, 0, 0, 0)
        header.setSpacing(8)

        # 앱 아이콘 (PNG)
        icon_label = QLabel()
        png_path = str(get_base_dir() / "app_icon.png")
        if os.path.exists(png_path):
            pix = QPixmap(png_path).scaled(24, 24, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
            icon_label.setPixmap(pix)
        header.addWidget(icon_label)

        title_label = QLabel("YUNSEUL PPT")
        title_label.setStyleSheet("font-size: 14px; font-weight: bold; color: #f8fafc; font-family: 'Segoe UI', sans-serif;")
        header.addWidget(title_label)

        ver_badge = QLabel("v2.0")
        ver_badge.setStyleSheet("""
            background-color: #1e293b;
            color: #38bdf8;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 600;
            padding: 2px 6px;
            border: 1px solid #38bdf840;
        """)
        header.addWidget(ver_badge)

        header.addStretch()

        # 항상 위 핀 버튼
        self.btn_pin = QPushButton("📌")
        self.btn_pin.setFixedSize(26, 26)
        self.btn_pin.setToolTip("항상 위에 표시 토글")
        self.btn_pin.setCheckable(True)
        self.btn_pin.clicked.connect(self.toggle_pin)
        self.btn_pin.setStyleSheet("""
            QPushButton {
                background: transparent;
                border: none;
                border-radius: 6px;
                color: #94a3b8;
                font-size: 12px;
            }
            QPushButton:hover { background-color: #1e293b; color: #ffffff; }
            QPushButton:checked { background-color: #0369a1; color: #ffffff; }
        """)
        header.addWidget(self.btn_pin)

        # 화면 내림 (최소화) 버튼 -> 트레이 아이콘으로 이동
        btn_min = QPushButton("─")
        btn_min.setFixedSize(26, 26)
        btn_min.setToolTip("화면 내림 (트레이 아이콘으로 이동)")
        btn_min.clicked.connect(self.hide_to_tray)
        btn_min.setStyleSheet("""
            QPushButton {
                background: transparent;
                border: none;
                border-radius: 6px;
                color: #94a3b8;
                font-size: 13px;
                font-weight: bold;
            }
            QPushButton:hover { background-color: #1e293b; color: #ffffff; }
        """)
        header.addWidget(btn_min)

        # ✕ 닫기 버튼 -> 종료 확인창 호출
        btn_close = QPushButton("✕")
        btn_close.setFixedSize(26, 26)
        btn_close.setToolTip("서버 및 프로그램 종료")
        btn_close.clicked.connect(self.confirm_and_quit)
        btn_close.setStyleSheet("""
            QPushButton {
                background: transparent;
                border: none;
                border-radius: 6px;
                color: #94a3b8;
                font-size: 12px;
            }
            QPushButton:hover { background-color: #dc2626; color: #ffffff; }
        """)
        header.addWidget(btn_close)

        card_layout.addLayout(header)

        # --- 2. 상태 표시 디스플레이 카드 ---
        self.status_box = QFrame()
        self.status_box.setStyleSheet("""
            QFrame {
                background-color: #1e293b;
                border-radius: 12px;
                border: 1px solid #334155;
                padding: 6px;
            }
        """)
        status_layout = QHBoxLayout(self.status_box)
        status_layout.setContentsMargins(14, 10, 14, 10)
        status_layout.setSpacing(14)

        # 상태 인디케이터 점
        self.indicator_dot = QLabel()
        self.indicator_dot.setFixedSize(16, 16)
        self.set_indicator_color("#ef4444")
        status_layout.addWidget(self.indicator_dot)

        # 상태 텍스트 영역
        text_layout = QVBoxLayout()
        text_layout.setSpacing(2)

        self.lbl_status_main = QLabel("서버 정지됨")
        self.lbl_status_main.setStyleSheet("font-size: 15px; font-weight: bold; color: #ef4444; font-family: 'Segoe UI', sans-serif;")
        text_layout.addWidget(self.lbl_status_main)

        self.lbl_status_sub = QLabel("Node.js 서버가 대기 상태입니다.")
        self.lbl_status_sub.setStyleSheet("font-size: 11px; color: #94a3b8;")
        text_layout.addWidget(self.lbl_status_sub)

        status_layout.addLayout(text_layout)
        status_layout.addStretch()

        # 정보 뱃지들
        info_layout = QVBoxLayout()
        info_layout.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        info_layout.setSpacing(3)

        self.lbl_badge_port = QLabel("PORT: 3000")
        self.lbl_badge_port.setStyleSheet("""
            background-color: #0f172a;
            color: #cbd5e1;
            border-radius: 4px;
            font-size: 10px;
            padding: 2px 6px;
            border: 1px solid #334155;
        """)
        info_layout.addWidget(self.lbl_badge_port)

        self.lbl_badge_extra = QLabel("SFU 준비완료")
        self.lbl_badge_extra.setStyleSheet("""
            background-color: #0f172a;
            color: #64748b;
            border-radius: 4px;
            font-size: 10px;
            padding: 2px 6px;
            border: 1px solid #334155;
        """)
        info_layout.addWidget(self.lbl_badge_extra)

        status_layout.addLayout(info_layout)
        card_layout.addWidget(self.status_box)

        # --- 3. 컨트롤 버튼 영역 ---
        btn_layout = QHBoxLayout()
        btn_layout.setSpacing(10)

        # [서버 시작 / 정지] 메인 버튼
        self.btn_toggle = QPushButton("▶ 서버 시작")
        self.btn_toggle.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self.btn_toggle.setFixedHeight(44)
        self.btn_toggle.clicked.connect(self.toggle_server)
        self.btn_toggle.setStyleSheet("""
            QPushButton {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #10b981, stop:1 #059669);
                color: #ffffff;
                font-size: 13px;
                font-weight: bold;
                border-radius: 8px;
                border: none;
                padding: 0 16px;
            }
            QPushButton:hover {
                background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #34d399, stop:1 #10b981);
            }
            QPushButton:pressed {
                background-color: #047857;
            }
        """)
        btn_layout.addWidget(self.btn_toggle, 3)

        # [🌐 브라우저 열기] 버튼
        self.btn_open_browser = QPushButton("🌐 열기")
        self.btn_open_browser.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self.btn_open_browser.setFixedHeight(44)
        self.btn_open_browser.setToolTip("기본 브라우저에서 메인 페이지 열기")
        self.btn_open_browser.clicked.connect(lambda: self.open_url("http://127.0.0.1:3000/"))
        self.btn_open_browser.setStyleSheet("""
            QPushButton {
                background-color: #1e293b;
                color: #38bdf8;
                font-size: 13px;
                font-weight: 600;
                border-radius: 8px;
                border: 1px solid #38bdf850;
                padding: 0 12px;
            }
            QPushButton:hover {
                background-color: #0369a1;
                color: #ffffff;
                border: 1px solid #38bdf8;
            }
            QPushButton:pressed {
                background-color: #0c4a6e;
            }
        """)
        btn_layout.addWidget(self.btn_open_browser, 2)

        # [🖥️ 호스트] 바로가기 버튼
        self.btn_host = QPushButton("🖥️ 호스트")
        self.btn_host.setCursor(QCursor(Qt.CursorShape.PointingHandCursor))
        self.btn_host.setFixedHeight(44)
        self.btn_host.setToolTip("발표자(호스트) 전용 화면 열기")
        self.btn_host.clicked.connect(lambda: self.open_url("http://127.0.0.1:3000/host.html"))
        self.btn_host.setStyleSheet("""
            QPushButton {
                background-color: #1e293b;
                color: #f8fafc;
                font-size: 12px;
                font-weight: 500;
                border-radius: 8px;
                border: 1px solid #475569;
                padding: 0 10px;
            }
            QPushButton:hover {
                background-color: #334155;
                color: #ffffff;
            }
            QPushButton:pressed {
                background-color: #1e293b;
            }
        """)
        btn_layout.addWidget(self.btn_host, 2)

        card_layout.addLayout(btn_layout)
        root_layout.addWidget(self.card)

    def set_indicator_color(self, hex_color):
        self.indicator_dot.setStyleSheet(f"""
            QLabel {{
                background-color: {hex_color};
                border-radius: 8px;
                border: 2px solid rgba(255, 255, 255, 0.4);
            }}
        """)

    def init_tray(self):
        self.tray = QSystemTrayIcon(self)
        ico_path = str(get_base_dir() / "app_icon.ico")
        if os.path.exists(ico_path):
            self.tray.setIcon(QIcon(ico_path))

        tray_menu = QMenu()
        tray_menu.setStyleSheet("""
            QMenu {
                background-color: #0f172a;
                color: #f8fafc;
                border: 1px solid #334155;
                border-radius: 8px;
                padding: 6px;
            }
            QMenu::item {
                padding: 6px 20px;
                border-radius: 4px;
            }
            QMenu::item:selected {
                background-color: #2563eb;
                color: #ffffff;
            }
            QMenu::separator {
                height: 1px;
                background-color: #334155;
                margin: 4px 6px;
            }
        """)

        act_show = QAction("위젯 열기", self)
        act_show.triggered.connect(self.show_and_activate)
        tray_menu.addAction(act_show)

        tray_menu.addSeparator()

        self.act_tray_toggle = QAction("서버 시작", self)
        self.act_tray_toggle.triggered.connect(self.toggle_server)
        tray_menu.addAction(self.act_tray_toggle)

        act_open_web = QAction("브라우저 열기 (메인)", self)
        act_open_web.triggered.connect(lambda: self.open_url("http://127.0.0.1:3000/"))
        tray_menu.addAction(act_open_web)

        act_open_host = QAction("호스트 화면 열기", self)
        act_open_host.triggered.connect(lambda: self.open_url("http://127.0.0.1:3000/host.html"))
        tray_menu.addAction(act_open_host)

        tray_menu.addSeparator()

        # 우클릭 메뉴의 '서버 종료' 항목
        act_quit = QAction("서버 종료", self)
        act_quit.triggered.connect(self.confirm_and_quit)
        tray_menu.addAction(act_quit)

        self.tray.setContextMenu(tray_menu)
        self.tray.activated.connect(self.on_tray_activated)
        self.tray.show()

    def on_tray_activated(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick or reason == QSystemTrayIcon.ActivationReason.Trigger:
            if self.isVisible():
                self.hide_to_tray()
            else:
                self.show_and_activate()

    def show_and_activate(self):
        self.show()
        self.setWindowState(self.windowState() & ~Qt.WindowState.WindowMinimized | Qt.WindowState.WindowActive)
        self.activateWindow()

    def hide_to_tray(self):
        self.hide()
        self.tray.showMessage(
            "YUNSEUL PPT",
            "위젯이 트레이로 이동되었습니다. 작업 표시줄 우측 아이콘을 클릭하여 다시 열 수 있습니다.",
            QSystemTrayIcon.MessageIcon.Information,
            1500
        )

    def confirm_and_quit(self):
        """서버 종료 확인 대화상자 표시 후 종료 또는 취소 처리"""
        dlg = ConfirmExitDialog(is_running=self.is_running, parent=self if self.isVisible() else None)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            # [종료/서버 종료] 선택 시 (실행 중인 경우 동기 중단)
            if self.is_running:
                self.stop_server_sync()
            self.tray.hide()
            QApplication.quit()
        else:
            # [취소] 선택 시 아무런 변화 없이 확인창만 닫힘
            pass

    def toggle_pin(self):
        flags = self.windowFlags()
        if self.btn_pin.isChecked():
            self.setWindowFlags(flags | Qt.WindowType.WindowStaysOnTopHint)
            self.btn_pin.setToolTip("항상 위에 고정됨")
        else:
            self.setWindowFlags(flags & ~Qt.WindowType.WindowStaysOnTopHint)
            self.btn_pin.setToolTip("항상 위에 표시 토글")
        self.show()

    def init_timer(self):
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.check_status_now)
        self.timer.start(1500)

    def check_status_now(self):
        if self.is_transitioning:
            return
        self.worker = HealthCheckWorker(self.port)
        self.worker.status_signal.connect(self.on_health_checked)
        self.worker.start()

    def on_health_checked(self, is_ok, data):
        if self.is_transitioning:
            return

        self.is_running = is_ok
        if is_ok:
            self.set_indicator_color("#22c55e")
            self.lbl_status_main.setText("서버 실행 중")
            self.lbl_status_main.setStyleSheet("font-size: 15px; font-weight: bold; color: #22c55e; font-family: 'Segoe UI', sans-serif;")

            rooms_cnt = data.get("rooms", 0)
            engine = data.get("engine", "node")
            self.lbl_status_sub.setText(f"실시간 스트리밍 대기 중 | 활성 방: {rooms_cnt}개")
            self.lbl_badge_extra.setText(f"{engine}")
            self.lbl_badge_extra.setStyleSheet("""
                background-color: #064e3b;
                color: #6ee7b7;
                border-radius: 4px;
                font-size: 10px;
                padding: 2px 6px;
                border: 1px solid #059669;
            """)

            # 버튼: 서버 정지 모드로 변경
            self.btn_toggle.setText("⏹ 서버 정지")
            self.btn_toggle.setStyleSheet("""
                QPushButton {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #ef4444, stop:1 #dc2626);
                    color: #ffffff;
                    font-size: 13px;
                    font-weight: bold;
                    border-radius: 8px;
                    border: none;
                    padding: 0 16px;
                }
                QPushButton:hover {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #f87171, stop:1 #ef4444);
                }
                QPushButton:pressed {
                    background-color: #b91c1c;
                }
            """)
            self.act_tray_toggle.setText("서버 정지")
        else:
            self.set_indicator_color("#ef4444")
            self.lbl_status_main.setText("서버 정지됨")
            self.lbl_status_main.setStyleSheet("font-size: 15px; font-weight: bold; color: #ef4444; font-family: 'Segoe UI', sans-serif;")
            self.lbl_status_sub.setText("Node.js 서버가 대기 상태입니다.")
            self.lbl_badge_extra.setText("SFU 대기")
            self.lbl_badge_extra.setStyleSheet("""
                background-color: #0f172a;
                color: #64748b;
                border-radius: 4px;
                font-size: 10px;
                padding: 2px 6px;
                border: 1px solid #334155;
            """)

            # 버튼: 서버 시작 모드로 변경
            self.btn_toggle.setText("▶ 서버 시작")
            self.btn_toggle.setStyleSheet("""
                QPushButton {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #10b981, stop:1 #059669);
                    color: #ffffff;
                    font-size: 13px;
                    font-weight: bold;
                    border-radius: 8px;
                    border: none;
                    padding: 0 16px;
                }
                QPushButton:hover {
                    background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #34d399, stop:1 #10b981);
                }
                QPushButton:pressed {
                    background-color: #047857;
                }
            """)
            self.act_tray_toggle.setText("서버 시작")

    def toggle_server(self):
        if self.is_running:
            self.stop_server()
        else:
            self.start_server()

    def start_server(self):
        self.is_transitioning = True
        self.set_indicator_color("#f59e0b")
        self.lbl_status_main.setText("서버 시작 중...")
        self.lbl_status_main.setStyleSheet("font-size: 15px; font-weight: bold; color: #f59e0b; font-family: 'Segoe UI', sans-serif;")
        self.lbl_status_sub.setText("Node.js 프로세스를 초기화하고 있습니다.")
        QApplication.processEvents()

        server_index = self.server_dir / "server" / "index.js"
        if not server_index.exists():
            self.lbl_status_sub.setText(f"오류: {server_index} 파일을 찾을 수 없습니다.")
            self.is_transitioning = False
            return

        env = os.environ.copy()
        env["PORT"] = str(self.port)
        env["HOST"] = "127.0.0.1"

        try:
            # CREATE_NO_WINDOW 플래그로 콘솔 창 없이 백그라운드 구동
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            self.server_process = subprocess.Popen(
                ["node", str(server_index)],
                cwd=str(self.server_dir),
                env=env,
                creationflags=flags,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
        except Exception as exc:
            self.lbl_status_sub.setText(f"실행 실패: {exc}")
            self.is_transitioning = False
            return

        # 1초 뒤 상태 재검사
        QTimer.singleShot(1200, self._finish_transition)

    def stop_server(self):
        self.is_transitioning = True
        self.set_indicator_color("#f59e0b")
        self.lbl_status_main.setText("서버 정지 중...")
        self.lbl_status_main.setStyleSheet("font-size: 15px; font-weight: bold; color: #f59e0b; font-family: 'Segoe UI', sans-serif;")
        self.lbl_status_sub.setText("연결된 프로세스를 정리하고 있습니다.")
        QApplication.processEvents()

        self.stop_server_sync()
        QTimer.singleShot(1000, self._finish_transition)

    def stop_server_sync(self):
        """동기식으로 서버 프로세스 및 포트 3000 프로세스를 완전히 종료"""
        if self.server_process:
            try:
                self.server_process.terminate()
                self.server_process.wait(timeout=1.0)
            except Exception:
                try:
                    self.server_process.kill()
                except Exception:
                    pass
            self.server_process = None

        kill_cmd = (
            "$p = Get-NetTCPConnection -LocalPort 3000 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess; "
            "if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }"
        )
        try:
            subprocess.run(
                ["powershell", "-Command", kill_cmd],
                capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)
            )
        except Exception:
            pass

    def _finish_transition(self):
        self.is_transitioning = False
        self.check_status_now()

    def open_url(self, url):
        webbrowser.open(url)

    # --- 프레임리스 윈도우 마우스 드래그 이동 처리 ---
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.drag_position = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event):
        if event.buttons() == Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self.drag_position)
            event.accept()


def main():
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)

    font = QFont("Pretendard", 9)
    if not font.exactMatch():
        font = QFont("Segoe UI", 9)
    app.setFont(font)

    widget = PPTWidget()
    widget.show()

    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
