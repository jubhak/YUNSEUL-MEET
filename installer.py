# -*- coding: utf-8 -*-
"""
installer.py - YUNSEUL-PPT 모던 인스톨 쉴드 설치 마법사 (PyQt6)
다크 테마 QWizard 기반 설치 프로그램.
"""

import sys
import os
import shutil
import subprocess
import time
from pathlib import Path

from PyQt6.QtWidgets import (
    QApplication, QWizard, QWizardPage, QVBoxLayout, QHBoxLayout,
    QLabel, QLineEdit, QPushButton, QCheckBox, QProgressBar,
    QFileDialog, QMessageBox, QFrame, QWidget
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from PyQt6.QtGui import QFont, QColor, QIcon, QPixmap

from install_meta import (
    PRODUCT_NAME, APP_EXE_NAME, DESKTOP_LNK_NAME, STARTMENU_FOLDER_NAME,
    write_install_meta, create_shortcut
)

INSTALL_DIR_DEFAULT = os.path.join(os.environ.get("LOCALAPPDATA", "C:\\"), "Programs", PRODUCT_NAME)


def get_bundle_dir():
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(sys.executable)))
    return os.path.dirname(os.path.abspath(__file__))


def get_wizard_style():
    return """
QWizard {
    background-color: #0f172a;
    font-family: 'Pretendard', 'Segoe UI', 'Malgun Gothic', sans-serif;
    color: #f8fafc;
}
QWizardPage, QWizard > QWidget, QWizardPage > QWidget {
    background-color: #0f172a;
    color: #f8fafc;
}
QLabel {
    color: #f8fafc;
    font-size: 13px;
    background: transparent;
}
QLabel#title {
    font-size: 18px;
    font-weight: bold;
    color: #38bdf8;
    background: transparent;
}
QLabel#subtitle {
    font-size: 13px;
    color: #94a3b8;
    background: transparent;
    line-height: 1.5;
}
QLineEdit {
    background-color: #1e293b;
    border: 1px solid #475569;
    border-radius: 6px;
    padding: 8px 12px;
    color: #ffffff;
    font-size: 13px;
}
QLineEdit:focus {
    border: 1px solid #38bdf8;
}
QPushButton {
    background-color: #2563eb;
    color: #ffffff;
    border: none;
    border-radius: 6px;
    padding: 8px 20px;
    font-size: 13px;
    font-weight: bold;
}
QPushButton:hover {
    background-color: #3b82f6;
}
QPushButton:pressed {
    background-color: #1d4ed8;
}
QPushButton#secondaryBtn {
    background-color: #1e293b;
    border: 1px solid #475569;
    color: #cbd5e1;
}
QPushButton#secondaryBtn:hover {
    background-color: #334155;
    color: #ffffff;
}
QCheckBox {
    color: #f8fafc;
    font-size: 13px;
    spacing: 8px;
    background: transparent;
}
QCheckBox::indicator {
    width: 18px;
    height: 18px;
    border-radius: 4px;
    border: 1px solid #475569;
    background-color: #1e293b;
}
QCheckBox::indicator:checked {
    background-color: #2563eb;
    border-color: #38bdf8;
}
QProgressBar {
    background-color: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    text-align: center;
    color: #ffffff;
    font-size: 12px;
    font-weight: bold;
    height: 20px;
}
QProgressBar::chunk {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 #0284c7, stop:1 #38bdf8);
    border-radius: 5px;
}
"""


class InstallThread(QThread):
    progress_signal = pyqtSignal(int, str)
    finished_signal = pyqtSignal(bool, str)

    def __init__(self, target_dir, create_desktop, create_startmenu):
        super().__init__()
        self.target_dir = os.path.abspath(target_dir)
        self.create_desktop = create_desktop
        self.create_startmenu = create_startmenu

    def run(self):
        try:
            self.progress_signal.emit(10, "설치 디렉토리 준비 중...")
            os.makedirs(self.target_dir, exist_ok=True)
            time.sleep(0.3)

            # 1. 실행 파일 복사
            self.progress_signal.emit(30, "프로그램 실행 파일 복사 중...")
            target_exe = os.path.join(self.target_dir, APP_EXE_NAME)
            current_exe = sys.executable if getattr(sys, "frozen", False) else sys.argv[0]

            if getattr(sys, "frozen", False):
                shutil.copy2(current_exe, target_exe)
            else:
                # 개발 모드: 소스 디렉토리에서 복사 테스트
                pass

            # 2. 관련 파일 및 디렉토리 복사 (server, public 웹 파일 등)
            self.progress_signal.emit(50, "웹 서버 및 구성 요소 복사 중...")
            src_root = get_bundle_dir()
            # 만약 개발 워크스페이스에 있다면 소스 루트 복사
            dev_root = Path(r"D:\workspace\YUNSEUL-PPT")
            root_to_copy = dev_root if dev_root.exists() else Path(src_root)

            copy_items = [
                "server", "api", "css", "js", "img", "data", "uploads", "scripts",
                "index.html", "host.html", "viewer.html", "check.html",
                "package.json", "package-lock.json", ".env", "START-SERVER.bat",
                "install.bat", "공유기_포트포워딩_설정안내.txt",
                "app_icon.ico", "app_icon.png"
            ]

            for item in copy_items:
                src_item = root_to_copy / item
                dst_item = Path(self.target_dir) / item
                if src_item.is_dir():
                    if dst_item.exists():
                        shutil.rmtree(dst_item, ignore_errors=True)
                    shutil.copytree(src_item, dst_item, ignore=shutil.ignore_patterns("*.log", "node_modules"))
                elif src_item.is_file():
                    shutil.copy2(src_item, dst_item)

            time.sleep(0.3)
            self.progress_signal.emit(75, "바로가기 생성 중...")

            # 3. 바로가기 생성
            icon_file = os.path.join(self.target_dir, "app_icon.ico")
            if not os.path.isfile(icon_file):
                icon_file = target_exe

            desktop_lnk_path = ""
            if self.create_desktop:
                desktop = os.path.join(os.environ.get("USERPROFILE", ""), "Desktop")
                if os.path.isdir(desktop):
                    desktop_lnk_path = os.path.join(desktop, DESKTOP_LNK_NAME)
                    create_shortcut(target_exe, desktop_lnk_path, icon_file, "YUNSEUL-PPT 실시간 프레젠테이션 컨트롤러")

            startmenu_dir_path = ""
            if self.create_startmenu:
                startmenu = os.path.join(
                    os.environ.get("APPDATA", ""),
                    "Microsoft", "Windows", "Start Menu", "Programs", STARTMENU_FOLDER_NAME
                )
                os.makedirs(startmenu, exist_ok=True)
                startmenu_dir_path = startmenu
                create_shortcut(
                    target_exe,
                    os.path.join(startmenu, DESKTOP_LNK_NAME),
                    icon_file,
                    "YUNSEUL-PPT 실시간 프레젠테이션 컨트롤러"
                )

            self.progress_signal.emit(90, "설치 정보 기록 중...")
            write_install_meta(self.target_dir, desktop_lnk=desktop_lnk_path, startmenu_dir=startmenu_dir_path)

            self.progress_signal.emit(100, "설치 완료!")
            time.sleep(0.3)
            self.finished_signal.emit(True, "설치가 성공적으로 완료되었습니다.")
        except Exception as exc:
            self.finished_signal.emit(False, str(exc))


class WelcomePage(QWizardPage):
    def __init__(self):
        super().__init__()
        self.setTitle("")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(16)

        header_layout = QHBoxLayout()
        header_layout.setSpacing(16)

        ico_path = os.path.join(get_bundle_dir(), "app_icon.png")
        if os.path.exists(ico_path):
            icon_lbl = QLabel()
            pix = QPixmap(ico_path).scaled(64, 64, Qt.AspectRatioMode.KeepAspectRatio, Qt.TransformationMode.SmoothTransformation)
            icon_lbl.setPixmap(pix)
            header_layout.addWidget(icon_lbl)

        title_box = QVBoxLayout()
        title_box.setSpacing(4)
        t = QLabel("YUNSEUL-PPT 설치 마법사")
        t.setObjectName("title")
        sub = QLabel("실시간 PPT 공유 & 컨트롤러 (Node.js + Socket.io + SFU)")
        sub.setObjectName("subtitle")
        title_box.addWidget(t)
        title_box.addWidget(sub)
        header_layout.addLayout(title_box)
        header_layout.addStretch()

        layout.addLayout(header_layout)

        line = QFrame()
        line.setStyleSheet("border-top: 1px solid #334155; margin: 8px 0;")
        layout.addWidget(line)

        desc = QLabel(
            "이 마법사는 컴퓨터에 YUNSEUL-PPT를 설치합니다.\n\n"
            "• 컴팩트한 데스크톱 위젯 컨트롤러 탑재\n"
            "• 원클릭 실시간 웹 서버 시작 / 정지 / 모니터링\n"
            "• 시스템 트레이 백그라운드 구동 지원\n\n"
            "계속하려면 [다음] 버튼을 클릭하십시오."
        )
        desc.setObjectName("subtitle")
        layout.addWidget(desc)
        layout.addStretch()


class DirectoryPage(QWizardPage):
    def __init__(self):
        super().__init__()
        self.setTitle("")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(14)

        t = QLabel("설치 위치 선택")
        t.setObjectName("title")
        sub = QLabel("프로그램을 설치할 폴더를 선택하십시오.")
        sub.setObjectName("subtitle")
        layout.addWidget(t)
        layout.addWidget(sub)

        layout.addSpacing(10)

        path_box = QHBoxLayout()
        self.path_edit = QLineEdit(INSTALL_DIR_DEFAULT)
        path_box.addWidget(self.path_edit)

        btn_browse = QPushButton("찾아보기...")
        btn_browse.setObjectName("secondaryBtn")
        btn_browse.clicked.connect(self.browse)
        path_box.addWidget(btn_browse)

        layout.addLayout(path_box)

        guide = QLabel("기본 위치에 설치하는 것을 권장합니다.")
        guide.setStyleSheet("color: #64748b; font-size: 11px;")
        layout.addWidget(guide)

        layout.addStretch()

    def browse(self):
        d = QFileDialog.getExistingDirectory(self, "설치 폴더 선택", self.path_edit.text())
        if d:
            self.path_edit.setText(os.path.join(d, PRODUCT_NAME))


class OptionsPage(QWizardPage):
    def __init__(self):
        super().__init__()
        self.setTitle("")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(14)

        t = QLabel("추가 옵션 선택")
        t.setObjectName("title")
        sub = QLabel("설치 시 생성할 바로가기를 선택하십시오.")
        sub.setObjectName("subtitle")
        layout.addWidget(t)
        layout.addWidget(sub)

        layout.addSpacing(10)

        self.chk_desktop = QCheckBox("바탕화면에 바로가기 만들기")
        self.chk_desktop.setChecked(True)
        layout.addWidget(self.chk_desktop)

        self.chk_startmenu = QCheckBox("시작 메뉴에 바로가기 만들기")
        self.chk_startmenu.setChecked(True)
        layout.addWidget(self.chk_startmenu)

        layout.addStretch()


class ProgressPage(QWizardPage):
    def __init__(self):
        super().__init__()
        self.setTitle("")
        self.is_done = False
        self.install_success = False

        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(14)

        t = QLabel("설치 진행 중")
        t.setObjectName("title")
        self.status_lbl = QLabel("설치를 준비하고 있습니다...")
        self.status_lbl.setObjectName("subtitle")
        layout.addWidget(t)
        layout.addWidget(self.status_lbl)

        layout.addSpacing(14)

        self.progress_bar = QProgressBar()
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(0)
        layout.addWidget(self.progress_bar)

        layout.addStretch()

    def initializePage(self):
        wizard = self.wizard()
        wizard.button(QWizard.WizardButton.BackButton).setEnabled(False)
        wizard.button(QWizard.WizardButton.NextButton).setEnabled(False)

        target_dir = wizard.dir_page.path_edit.text().strip() or INSTALL_DIR_DEFAULT
        create_desktop = wizard.opt_page.chk_desktop.isChecked()
        create_startmenu = wizard.opt_page.chk_startmenu.isChecked()

        self.thread = InstallThread(target_dir, create_desktop, create_startmenu)
        self.thread.progress_signal.connect(self.on_progress)
        self.thread.finished_signal.connect(self.on_finished)
        self.thread.start()

    def on_progress(self, val, text):
        self.progress_bar.setValue(val)
        self.status_lbl.setText(text)

    def on_finished(self, success, message):
        self.is_done = True
        self.install_success = success
        if success:
            self.status_lbl.setText("설치가 성공적으로 완료되었습니다!")
            self.wizard().button(QWizard.WizardButton.NextButton).setEnabled(True)
            self.wizard().next()
        else:
            self.status_lbl.setText(f"설치 실패: {message}")
            QMessageBox.critical(self, "설치 오류", f"설치 도중 문제가 발생했습니다.\n\n{message}")

    def isComplete(self):
        return self.is_done and self.install_success


class FinishPage(QWizardPage):
    def __init__(self):
        super().__init__()
        self.setTitle("")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(24, 20, 24, 20)
        layout.setSpacing(16)

        t = QLabel("YUNSEUL-PPT 설치 완료")
        t.setObjectName("title")
        sub = QLabel("프로그램이 컴퓨터에 성공적으로 설치되었습니다.")
        sub.setObjectName("subtitle")
        layout.addWidget(t)
        layout.addWidget(sub)

        layout.addSpacing(10)

        self.chk_launch = QCheckBox("지금 바로 YUNSEUL-PPT 실행")
        self.chk_launch.setChecked(True)
        layout.addWidget(self.chk_launch)

        layout.addStretch()


class ModernInstallerWizard(QWizard):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("YUNSEUL-PPT 설치")
        self.setFixedSize(560, 420)
        self.setStyleSheet(get_wizard_style())
        self.setWizardStyle(QWizard.WizardStyle.ModernStyle)

        ico_path = os.path.join(get_bundle_dir(), "app_icon.ico")
        if os.path.exists(ico_path):
            self.setWindowIcon(QIcon(ico_path))

        self.welcome_page = WelcomePage()
        self.dir_page = DirectoryPage()
        self.opt_page = OptionsPage()
        self.progress_page = ProgressPage()
        self.finish_page = FinishPage()

        self.addPage(self.welcome_page)
        self.addPage(self.dir_page)
        self.addPage(self.opt_page)
        self.addPage(self.progress_page)
        self.addPage(self.finish_page)

        # 버튼 텍스트 설정
        self.setButtonText(QWizard.WizardButton.NextButton, "다음 >")
        self.setButtonText(QWizard.WizardButton.BackButton, "< 이전")
        self.setButtonText(QWizard.WizardButton.FinishButton, "마침")
        self.setButtonText(QWizard.WizardButton.CancelButton, "취소")


def main():
    app = QApplication(sys.argv)
    wizard = ModernInstallerWizard()
    wizard.show()
    code = app.exec()

    if code == 0 and wizard.finish_page.chk_launch.isChecked():
        target_dir = wizard.dir_page.path_edit.text().strip() or INSTALL_DIR_DEFAULT
        target_exe = os.path.join(target_dir, APP_EXE_NAME)
        if os.path.isfile(target_exe):
            subprocess.Popen([target_exe], cwd=target_dir)
        else:
            # 소스 모드인 경우
            widget_py = os.path.join(target_dir, "widget_app.py")
            if os.path.isfile(widget_py):
                subprocess.Popen([sys.executable, widget_py], cwd=target_dir)

    return code


if __name__ == "__main__":
    sys.exit(main())
