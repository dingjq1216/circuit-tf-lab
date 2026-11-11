# -*- coding: utf-8 -*-
"""信号发生器与时域响应仿真。

输入传递函数的有理分式系数和激励信号参数，输出输入/输出波形采样点，
并给出阶跃响应的时域性能指标（超调量、上升时间、调节时间等）。
"""

from __future__ import annotations

import numpy as np
from scipy import signal as sig

SIGNAL_NAMES = {
    "step": "阶跃信号",
    "square": "方波信号",
    "ramp": "斜坡信号",
    "accel": "加速度信号",
    "sine": "正弦信号",
}


def _gen_signal(kind: str, amp: float, freq: float, duty: float, t: np.ndarray, phase: float = 0.0):
    """生成激励信号采样序列。"""
    if kind == "step":
        return np.full_like(t, amp)
    if kind == "square":
        if freq <= 0:
            raise ValueError("方波频率必须大于 0。")
        phase_t = np.mod(t * freq + phase / 360.0, 1.0)
        return np.where(phase_t < duty, amp, -amp)
    if kind == "ramp":
        return amp * t
    if kind == "accel":
        return 0.5 * amp * t ** 2
    if kind == "sine":
        if freq <= 0:
            raise ValueError("正弦频率必须大于 0。")
        return amp * np.sin(2 * np.pi * freq * t + np.deg2rad(phase))
    raise ValueError(f"未知信号类型：{kind}")


def _auto_duration(den: np.ndarray, kind: str, freq: float) -> float:
    """根据极点（时间常数）与信号周期自动选择仿真时长。"""
    poles = np.roots(den) if len(den) > 1 else np.array([])
    taus = [1.0 / abs(p.real) for p in poles if p.real < -1e-12]
    tau = max(taus) if taus else 1.0

    t_end = 8.0 * tau
    if kind in ("sine", "square") and freq > 0:
        t_end = max(t_end, 5.0 / freq)
    if kind in ("ramp", "accel"):
        t_end = max(6.0 * tau, 1.0)
    return float(min(max(t_end, 1e-4), 500.0))


def _step_metrics(t: np.ndarray, y: np.ndarray, u_amp: float) -> dict:
    """计算阶跃响应性能指标（无量纲或秒）。"""
    if len(y) < 5:
        return {}
    y_ss = float(np.mean(y[-max(3, len(y) // 50):]))
    span = y_ss if abs(y_ss) > 1e-12 else 1.0
    y_norm = y / span
    peak = float(np.max(y_norm))
    overshoot = max(0.0, (peak - 1.0) * 100.0)
    idx_peak = int(np.argmax(y_norm))

    def cross(level: float) -> float | None:
        idx = np.where(y_norm >= level)[0]
        return float(t[idx[0]]) if len(idx) else None

    t10, t90 = cross(0.1), cross(0.9)
    rise = (t90 - t10) if (t10 is not None and t90 is not None) else None

    # 调节时间：±2% 误差带
    settle = None
    tol = 0.02
    outside = np.where(np.abs(y_norm - 1.0) > tol)[0]
    if len(outside) == 0:
        settle = 0.0
    elif outside[-1] + 1 < len(t):
        settle = float(t[outside[-1] + 1])

    return {
        "steady": y_ss,
        "peak": float(np.max(y)),
        "peakTime": float(t[idx_peak]),
        "overshoot": overshoot,
        "riseTime": rise,
        "settleTime": settle,
        "inputAmplitude": u_amp,
    }


def simulate(tf: dict, signal: dict) -> dict:
    """对传递函数做时域仿真。

    tf: {"num": [...], "den": [...]}（高次在前）
    signal: {"type", "amplitude", "frequency", "duty", "tEnd", "autoTime"}
    """
    num = np.array([float(x) for x in tf.get("num", [1.0])], dtype=float)
    den = np.array([float(x) for x in tf.get("den", [1.0])], dtype=float)
    if len(den) == 0 or abs(den[0]) < 1e-15:
        raise ValueError("传递函数分母无效。")
    num = np.trim_zeros(num, "f")
    if len(num) == 0:
        num = np.array([0.0])

    kind = str(signal.get("type", "step"))
    if kind not in SIGNAL_NAMES:
        raise ValueError(f"未知信号类型：{kind}")
    amp = float(signal.get("amplitude", 1.0))
    freq = float(signal.get("frequency", 1.0))
    duty = float(signal.get("duty", 50.0)) / 100.0
    if not (0.0 < duty < 1.0):
        duty = 0.5
    phase = float(signal.get("phase", 0.0))

    warnings: list[str] = []
    # 自动时长按原始传递函数（不含下面人为附加的高频极点）估计
    den_auto = np.array(den, dtype=float)
    # 非真系统：附加高频极点做数值近似
    if len(num) > len(den):
        poles = np.roots(den) if len(den) > 1 else np.array([])
        base = max([abs(p) for p in poles] + [1.0])
        wp = max(base * 1000.0, 1e5)
        for _ in range(len(num) - len(den)):
            den = np.polymul(den, np.array([1.0 / wp, 1.0]))
        warnings.append("系统为非真系统（含理想微分），已附加高频极点近似后进行数值仿真。")

    auto = bool(signal.get("autoTime", True))
    t_end = _auto_duration(den_auto, kind, freq) if auto else float(signal.get("tEnd", 5.0))
    t_end = float(min(max(t_end, 1e-6), 1000.0))

    n_dense = 6000
    t_dense = np.linspace(0.0, t_end, n_dense)
    u_dense = _gen_signal(kind, amp, freq, duty, t_dense, phase)

    sys_tf = sig.TransferFunction(num, den)
    try:
        _, y_dense, _ = sig.lsim(sys_tf, u_dense, t_dense)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"仿真失败：{exc}") from exc

    y_dense = np.nan_to_num(y_dense, nan=0.0, posinf=0.0, neginf=0.0)

    # 抽稀后返回，保证前端绘图流畅
    n_out = 1200
    stride = max(1, n_dense // n_out)
    idx = np.arange(0, n_dense, stride)
    if idx[-1] != n_dense - 1:
        idx = np.append(idx, n_dense - 1)

    metrics = _step_metrics(t_dense, y_dense, amp) if kind == "step" else {}

    return {
        "ok": True,
        "signal": kind,
        "signalName": SIGNAL_NAMES[kind],
        "t": np.round(t_dense[idx], 9).tolist(),
        "u": np.round(u_dense[idx], 9).tolist(),
        "y": np.round(y_dense[idx], 9).tolist(),
        "tEnd": t_end,
        "metrics": metrics,
        "warnings": warnings,
    }
