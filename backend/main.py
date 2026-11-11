# -*- coding: utf-8 -*-
"""FastAPI 服务入口：提供传递函数求解与波形仿真接口，并托管前端页面。"""

from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .circuit_solver import CircuitError, analyze
from .simulator import simulate

# 打包成可执行文件后，前端资源被解包到临时目录（sys._MEIPASS）
if getattr(sys, "frozen", False):
    BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
else:
    BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="电路传递函数教学实验台", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "circuit-tf-lab"}


@app.post("/api/analyze")
def api_analyze(payload: dict):
    """求解电路传递函数并返回两套推导步骤。"""
    try:
        return analyze(payload)
    except CircuitError as exc:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": f"求解失败：{exc}"},
        )


@app.post("/api/simulate")
def api_simulate(payload: dict):
    """对给定传递函数做时域仿真。"""
    try:
        tf = payload.get("tf") or {}
        signal = payload.get("signal") or {}
        return simulate(tf, signal)
    except ValueError as exc:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": f"仿真失败：{exc}"},
        )


# 前端静态资源（放在最后，避免覆盖 /api 路由）
app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
