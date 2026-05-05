"""Sound Capsule LAN — 桌面入口

跨平台方案：
- macOS: PyWebView (WebKit 原生，无 .NET 依赖)
- Windows: Edge App Mode (无需 pythonnet，免安装)

关闭窗口 = 退出整个程序（含后端）。
"""

import os
import sys
import threading
import time
import platform
import subprocess

if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

_server_dir = os.path.join(APP_DIR, "server")
_pipeline_dir = os.path.join(APP_DIR, "data-pipeline")

if os.path.isdir(_server_dir):
    sys.path.insert(0, _server_dir)
else:
    sys.path.insert(0, APP_DIR)

if os.path.isdir(_pipeline_dir):
    sys.path.insert(0, _pipeline_dir)

os.chdir(APP_DIR)

_PORT = 5005
_URL = f"http://127.0.0.1:{_PORT}"


def start_flask():
    """在后台线程启动 Flask"""
    from app import app, HOST, PORT
    app.run(host=HOST, port=PORT, debug=False, threaded=True, use_reloader=False)


def wait_for_server(timeout=15):
    """等待 Flask 启动就绪"""
    import urllib.request
    start = time.time()
    while time.time() - start < timeout:
        try:
            urllib.request.urlopen(f"{_URL}/api/health", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def _find_edge_windows():
    """查找 Windows 上的 Edge 可执行路径"""
    candidates = [
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Edge", "Application", "msedge.exe"),
    ]
    for p in candidates:
        if p and os.path.isfile(p):
            return p
    return None


def run_windows():
    """Windows: 用 Edge --app 模式打开，监控进程退出"""
    edge_path = _find_edge_windows()
    if not edge_path:
        # 回退：用默认浏览器打开
        os.startfile(_URL)
        print("未找到 Edge，已用默认浏览器打开。关闭此窗口以退出后端。")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        return

    # 使用独立的 user-data-dir 避免与用户正常浏览器冲突
    user_data = os.path.join(APP_DIR, "data", ".edge-profile")
    os.makedirs(user_data, exist_ok=True)

    cmd = [
        edge_path,
        f"--app={_URL}",
        f"--user-data-dir={user_data}",
        "--window-size=1200,800",
        "--disable-extensions",
        "--no-first-run",
    ]

    proc = subprocess.Popen(cmd)
    proc.wait()
    # Edge 窗口关闭 → 退出


def run_macos():
    """macOS: 用 PyWebView (WebKit)"""
    import webview
    window = webview.create_window(
        title="Sound Capsule",
        url=_URL,
        width=1200,
        height=800,
        min_size=(900, 600),
    )
    webview.start()


def main():
    flask_thread = threading.Thread(target=start_flask, daemon=True)
    flask_thread.start()

    if not wait_for_server():
        print("警告: Flask 后端未能在 15 秒内就绪")

    system = platform.system()
    if system == "Windows":
        run_windows()
    elif system == "Darwin":
        run_macos()
    else:
        # Linux 回退
        run_macos()

    sys.exit(0)


if __name__ == "__main__":
    main()
