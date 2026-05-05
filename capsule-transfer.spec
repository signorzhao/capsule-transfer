# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec 文件 —— 打包 Sound Capsule LAN 为绿色版桌面应用。

Windows 版使用 Edge App Mode，不需要 pythonnet。
"""

import os
from pathlib import Path

block_cipher = None
ROOT = Path(os.getcwd())

a = Analysis(
    [str(ROOT / 'main.py')],
    pathex=[str(ROOT / 'server'), str(ROOT / 'data-pipeline')],
    binaries=[],
    datas=[
        # 前端构建产物
        (str(ROOT / 'webapp' / 'dist'), 'webapp'),
        # data-pipeline 模块
        (str(ROOT / 'data-pipeline'), 'data-pipeline'),
        # 服务端辅助模块
        (str(ROOT / 'server' / 'app.py'), 'server'),
        (str(ROOT / 'server' / 'bundle.py'), 'server'),
        (str(ROOT / 'server' / 'net.py'), 'server'),
    ],
    hiddenimports=[
        'flask',
        'flask_cors',
        'requests',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['pythonnet', 'clr', 'clr_loader', 'webview'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='CapsuleTransfer',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='CapsuleTransfer',
)
