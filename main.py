"""Sound Capsule LAN — PyWebView 桌面入口

启动 Flask 后端（后台线程）+ PyWebView 原生窗口。
关闭窗口 = 退出整个程序（含后端）。
"""

import os
import sys
import threading
import time

# 确保打包后路径正确
if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

# 把 server/ 和 data-pipeline/ 加入 sys.path
_server_dir = os.path.join(APP_DIR, "server")
_pipeline_dir = os.path.join(APP_DIR, "data-pipeline")

if os.path.isdir(_server_dir):
    sys.path.insert(0, _server_dir)
else:
    sys.path.insert(0, APP_DIR)

if os.path.isdir(_pipeline_dir):
    sys.path.insert(0, _pipeline_dir)

os.chdir(APP_DIR)

# Flask 端口
_PORT = 5005


def start_flask():
    """在后台线程启动 Flask"""
    from app import app, HOST, PORT
    app.run(host=HOST, port=PORT, debug=False, threaded=True, use_reloader=False)


def wait_for_server(timeout=10):
    """等待 Flask 启动就绪"""
    import urllib.request
    start = time.time()
    while time.time() - start < timeout:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{_PORT}/api/health", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def main():
    import webview

    # 启动 Flask 后端（daemon 线程，主进程退出时自动结束）
    flask_thread = threading.Thread(target=start_flask, daemon=True)
    flask_thread.start()

    # 等待 Flask 就绪
    if not wait_for_server():
        print("警告: Flask 后端未能在 10 秒内就绪")

    # 创建原生窗口（关闭窗口 = 退出程序）
    window = webview.create_window(
        title="Sound Capsule",
        url=f"http://127.0.0.1:{_PORT}",
        width=1200,
        height=800,
        min_size=(900, 600),
    )

    # 启动 WebView 事件循环（阻塞直到窗口关闭）
    webview.start()

    # 窗口关闭 → 程序退出，daemon Flask 线程自动终止
    sys.exit(0)


if __name__ == "__main__":
    main()
