# -*- coding: utf-8 -*-
"""桌面启动入口：启动本地服务并自动用默认浏览器打开实验台页面。

开发环境运行：python launcher.py
打包后运行：CircuitTFLab.exe（前端静态资源由 PyInstaller 一并打包）
"""

from __future__ import annotations

import socket
import threading
import webbrowser

import uvicorn

from backend.main import app

HOST = "127.0.0.1"
DEFAULT_PORT = 8848


def _pick_port(start: int) -> int:
    """从 start 开始找一个空闲端口（上一次运行未关闭时自动换端口）。"""
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            if s.connect_ex((HOST, port)) != 0:
                return port
    raise RuntimeError("8848-8897 端口都被占用，请关闭占用程序后重试。")


def main() -> None:
    port = _pick_port(DEFAULT_PORT)
    url = f"http://{HOST}:{port}"

    print("=" * 46)
    print("  自动控制原理 · 电路求传递函数实验台")
    print(f"  服务地址：{url}")
    print("  浏览器会自动打开；若未打开请手动访问上面的地址。")
    print("  关闭本窗口即停止服务。")
    print("=" * 46, flush=True)

    threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=HOST, port=port, log_level="warning")


if __name__ == "__main__":
    main()
