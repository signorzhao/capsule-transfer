# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec 文件 —— 打包 Sound Capsule LAN 为绿色版可执行文件。

使用方法：
    cd capsule-transfer
    # 先构建前端
    cd webapp && npm run build && cd ..
    # 打包
    pyinstaller capsule-transfer.spec

产出目录 dist/CapsuleTransfer/ 即为绿色版，可直接复制分发。
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
        # 前端构建产物
        (str(ROOT / 'webapp' / 'dist'), 'webapp'),
        # data-pipeline 模块
        (str(ROOT / 'data-pipeline'), 'data-pipeline'),
        # 服务端辅助模块
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
    [],
    exclude_binaries=True,
    name='CapsuleTransfer',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
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
