# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — 打包 Flask 后端为 Tauri sidecar 可执行文件。

产出: dist/flask-backend/flask-backend.exe (Windows)
放入 src-tauri/binaries/ 后由 Tauri 管理生命周期。
"""

import os
from pathlib import Path

block_cipher = None
ROOT = Path(os.getcwd())

a = Analysis(
    [str(ROOT / 'server' / 'app.py')],
    pathex=[str(ROOT / 'server'), str(ROOT / 'data-pipeline')],
    binaries=[],
    datas=[
        (str(ROOT / 'data-pipeline'), 'data-pipeline'),
        (str(ROOT / 'server' / 'bundle.py'), '.'),
        (str(ROOT / 'server' / 'net.py'), '.'),
    ],
    hiddenimports=[
        'flask',
        'flask_cors',
        'requests',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='flask-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
)
