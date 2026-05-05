# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec 文件 —— 打包 Sound Capsule LAN 为绿色版桌面应用。

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
from PyInstaller.utils.hooks import collect_all, collect_data_files

block_cipher = None
ROOT = Path(os.getcwd())

# 收集 pythonnet / clr_loader 的所有运行时文件（pywebview WinForms 后端需要）
pythonnet_datas, pythonnet_binaries, pythonnet_hiddenimports = collect_all('pythonnet')
clr_datas, clr_binaries, clr_hiddenimports = collect_all('clr_loader')
webview_datas, webview_binaries, webview_hiddenimports = collect_all('webview')

a = Analysis(
    [str(ROOT / 'main.py')],
    pathex=[str(ROOT / 'server'), str(ROOT / 'data-pipeline')],
    binaries=pythonnet_binaries + clr_binaries + webview_binaries,
    datas=[
        # 前端构建产物
        (str(ROOT / 'webapp' / 'dist'), 'webapp'),
        # data-pipeline 模块
        (str(ROOT / 'data-pipeline'), 'data-pipeline'),
        # 服务端辅助模块
        (str(ROOT / 'server' / 'app.py'), 'server'),
        (str(ROOT / 'server' / 'bundle.py'), 'server'),
        (str(ROOT / 'server' / 'net.py'), 'server'),
    ] + pythonnet_datas + clr_datas + webview_datas,
    hiddenimports=[
        'flask',
        'flask_cors',
        'requests',
        'webview',
        'webview.platforms.winforms',
        'webview.platforms.edgechromium',
        'pythonnet',
        'clr',
        'clr_loader',
        'clr_loader.netfx',
        'clr_loader.util',
    ] + pythonnet_hiddenimports + clr_hiddenimports + webview_hiddenimports,
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
