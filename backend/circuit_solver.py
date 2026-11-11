# -*- coding: utf-8 -*-
"""电路网络传递函数求解器。

工作流程：
1. 接收前端传来的「元件 + 导线」拓扑；
2. 用并查集（Union-Find）把相连的元件引脚合并成电气节点；
3. 用改进节点法（MNA）在 s 域列写方程，求解输出端电压；
4. H(s) = V_out(s) / V_in(s)，并化简为有理分式；
5. 同时生成「复阻抗法」与「电路方程法」两套教学推导步骤。

约定：
- 每个元件有固定引脚名，见 PINS；
- 输入电压源的负极、输出端的负极、放大器的接地脚若悬空，则自动视为接地；
- 所有接地点（GND 元件）彼此等电位，视为同一个参考节点（0 V）。
"""

from __future__ import annotations

import math
from fractions import Fraction
from typing import Any

import sympy as sp

S = sp.Symbol("s")
VIN = sp.Symbol("V_{in}")

# 元件引脚定义
PINS: dict[str, list[str]] = {
    "R": ["a", "b"],
    "L": ["a", "b"],
    "C": ["a", "b"],
    "SRC": ["a", "b"],
    "OUT": ["a", "b"],
    "AMP": ["in", "out", "gnd"],
    "OPAMP": ["p", "n", "out"],
    "GND": ["g"],
}

TYPE_NAME = {
    "R": "电阻",
    "L": "电感",
    "C": "电容",
    "SRC": "电压源",
    "OUT": "输出端",
    "AMP": "放大器",
    "OPAMP": "理想运放",
    "GND": "接地",
}

# 元件默认符号前缀
SYM_PREFIX = {"R": "R", "L": "L", "C": "C", "AMP": "K", "SRC": "U"}


class CircuitError(ValueError):
    """电路拓扑或参数错误，直接反馈给前端展示。"""


# --------------------------------------------------------------------------
# 基础工具
# --------------------------------------------------------------------------
class _DSU:
    """并查集：用于把导线连起来的引脚合并为同一个节点。"""

    def __init__(self) -> None:
        self.parent: dict[Any, Any] = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:  # 路径压缩
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a, b) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


_SI_PREFIX = [
    (1e9, "G"), (1e6, "M"), (1e3, "k"), (1.0, ""),
    (1e-3, "m"), (1e-6, "μ"), (1e-9, "n"), (1e-12, "p"),
]


def _pick_prefix(value: float) -> tuple[float, str, float]:
    """选取合适的 SI 词头。"""
    if value == 0:
        return 1.0, "", 0.0
    mag = abs(value)
    for scale, prefix in _SI_PREFIX:
        if mag >= scale * 0.999:
            return scale, prefix, value / scale
    return 1e-12, "p", value / 1e-12


def fmt_si(value: float, unit: str, latex: bool = False) -> str:
    """把数值格式化成带 SI 词头的字符串。"""
    if value == 0:
        return "0"
    _, prefix, scaled = _pick_prefix(value)
    num = f"{scaled:.3g}"
    if latex:
        pre = f"\\mathrm{{{prefix}}}" if prefix else ""
        if unit == "Ω":
            return f"{num}\\,{pre}\\Omega"
        return f"{num}\\,{pre}\\mathrm{{{unit}}}"
    return f"{num} {prefix}{unit}"


def _num_latex(x: float) -> str:
    """数字转 LaTeX，过大或过小时使用科学计数法。"""
    if x == 0:
        return "0"
    if abs(x) >= 1e4 or abs(x) < 1e-3:
        mant, exp = f"{x:.3e}".split("e")
        return f"{float(mant):g}\\times10^{{{int(exp)}}}"
    return f"{x:.4g}"


def _comp_latex(x: complex) -> str:
    """复数转 LaTeX / 普通文本。"""
    re, im = x.real, x.imag
    if abs(im) < 1e-9 * max(1.0, abs(re)):
        return f"{re:.4g}"
    sign = "+" if im >= 0 else "-"
    return f"{re:.4g} {sign} j{abs(im):.4g}"


def _poly_latex(coeffs: list[float], var: str = "s") -> str:
    """多项式系数（高次在前）转 LaTeX。"""
    n = len(coeffs) - 1
    parts: list[str] = []
    for i, c in enumerate(coeffs):
        power = n - i
        if abs(c) < 1e-14:
            continue
        mag = abs(c)
        body = _num_latex(mag)
        if power == 0:
            term = body
        elif power == 1:
            term = f"{var}" if abs(mag - 1) < 1e-12 else f"{body}{var}"
        else:
            term = f"{var}^{{{power}}}" if abs(mag - 1) < 1e-12 else f"{body}{var}^{{{power}}}"
        if not parts:
            parts.append(("-" if c < 0 else "") + term)
        else:
            parts.append((" - " if c < 0 else " + ") + term)
    return "".join(parts) if parts else "0"


def _join_terms(terms: list[tuple[int, str]]) -> str:
    """把带符号的项拼成一条表达式。"""
    out = ""
    for idx, (sign, expr) in enumerate(terms):
        if idx == 0:
            out += ("-" if sign < 0 else "") + expr
        else:
            out += (" - " if sign < 0 else " + ") + expr
    return out if out else "0"


# --------------------------------------------------------------------------
# 拓扑解析
# --------------------------------------------------------------------------
def _prepare(payload: dict) -> dict:
    """校验输入并解析出节点、元件连接关系。"""
    comps_in = payload.get("components") or []
    wires_in = payload.get("wires") or []
    if not comps_in:
        raise CircuitError("电路为空，请先从左侧元件库拖入元件。")

    comps: list[dict] = []
    counter: dict[str, int] = {}
    for raw in comps_in:
        ctype = str(raw.get("type", "")).upper()
        if ctype not in PINS:
            raise CircuitError(f"未知元件类型：{raw.get('type')}")
        cid = str(raw.get("id") or f"{ctype}_{len(comps)}")
        counter[ctype] = counter.get(ctype, 0) + 1
        comp = dict(raw)
        comp["id"] = cid
        comp["type"] = ctype
        comp["index"] = counter[ctype]
        comp["name"] = raw.get("name") or (
            "GND" if ctype == "GND" else
            ("U1" if ctype == "SRC" else
             ("OUT1" if ctype == "OUT" else f"{SYM_PREFIX.get(ctype, ctype)}{counter[ctype]}"))
        )
        if ctype in ("R", "C", "L"):
            try:
                comp["value"] = float(raw.get("value"))
            except (TypeError, ValueError):
                raise CircuitError(f"{comp['name']} 的参数值无效。")
            if comp["value"] <= 0:
                raise CircuitError(f"{comp['name']} 的参数必须大于 0。")
        if ctype == "AMP":
            try:
                comp["gain"] = float(raw.get("gain", raw.get("value", 1.0)))
            except (TypeError, ValueError):
                raise CircuitError("放大器增益无效。")
        comps.append(comp)

    by_id = {c["id"]: c for c in comps}
    srcs = [c for c in comps if c["type"] == "SRC"]
    outs = [c for c in comps if c["type"] == "OUT"]
    if len(srcs) != 1:
        raise CircuitError("请放置且仅放置一个输入电压源（U1）。")
    if len(outs) != 1:
        raise CircuitError("请放置且仅放置一个输出端（OUT）。")

    # 并查集合并引脚
    dsu = _DSU()
    for c in comps:
        for pin in PINS[c["type"]]:
            dsu.find((c["id"], pin))

    used_terms: set[tuple[str, str]] = set()
    wires: list[dict] = []
    for w in wires_in:
        try:
            a = (str(w["a"][0]), str(w["a"][1]))
            b = (str(w["b"][0]), str(w["b"][1]))
        except (KeyError, IndexError, TypeError):
            raise CircuitError("导线数据格式错误。")
        for term in (a, b):
            if term[0] not in by_id or term[1] not in PINS[by_id[term[0]]["type"]]:
                raise CircuitError("导线连接到了不存在的引脚。")
        dsu.union(a, b)
        used_terms.update((a, b))
        wires.append({"a": a, "b": b})

    # 确定接地引脚：GND 元件 + 悬空的放大器接地脚
    gnd_comps = [c for c in comps if c["type"] == "GND"]
    ground_terms: list[tuple[str, str]] = [(c["id"], "g") for c in gnd_comps]
    for c in comps:
        if c["type"] == "AMP" and (c["id"], "gnd") not in used_terms:
            ground_terms.append((c["id"], "gnd"))

    auto_ground = False
    if gnd_comps:
        # 有接地符号：悬空的源负端、输出负端一并接地
        for c in comps:
            if c["type"] in ("SRC", "OUT") and (c["id"], "b") not in used_terms:
                ground_terms.append((c["id"], "b"))
    else:
        # 教材图常不画接地符号，只标 u_i、u_o 两个端口。
        # 此时以输入电压源的负端为参考节点（0 V），其余悬空端默认接到该参考点。
        auto_ground = True
        ref = (srcs[0]["id"], "b")
        for c in comps:
            if c["type"] in ("SRC", "OUT") and (c["id"], "b") not in used_terms:
                dsu.union((c["id"], "b"), ref)
            if c["type"] == "AMP" and (c["id"], "gnd") not in used_terms:
                dsu.union((c["id"], "gnd"), ref)
        ground_terms = [ref]

    ground_roots = {dsu.find(t) for t in ground_terms}

    # 按出现顺序给节点编号
    order: list[Any] = []
    seen: set[Any] = set()
    for c in comps:
        for pin in PINS[c["type"]]:
            root = dsu.find((c["id"], pin))
            if root not in seen:
                seen.add(root)
                order.append(root)
    node_label: dict[Any, str] = {}
    idx = 0
    for root in order:
        if root in ground_roots:
            node_label[root] = "0"
        else:
            idx += 1
            node_label[root] = str(idx)

    def net_of(cid: str, pin: str):
        return dsu.find((cid, pin))

    return {
        "comps": comps,
        "by_id": by_id,
        "wires": wires,
        "ground": ground_roots,
        "node_label": node_label,
        "order": order,
        "net_of": net_of,
        "src": srcs[0],
        "out": outs[0],
        "used_terms": used_terms,
        "auto_ground": auto_ground,
    }


def _exact(value: float):
    """把浮点参数转成精确有理数，避免数值消元时公因式约不干净。"""
    frac = Fraction(float(value)).limit_denominator(10 ** 12)
    return sp.Rational(frac.numerator, frac.denominator)


def _val(comp: dict, symbolic: bool):
    """取元件参数值（数值或符号）。数值模式使用精确有理数。"""
    if not symbolic:
        if comp["type"] == "AMP":
            return _exact(comp.get("gain", 1.0))
        return _exact(comp["value"])
    if comp["type"] == "AMP":
        return sp.Symbol(f"K_{comp['index']}")
    return sp.Symbol(f"{comp['type']}_{comp['index']}")


def _build_mna(ctx: dict, symbolic: bool):
    """构造 MNA 方程 M x = rhs，返回 (矩阵, 右端, 节点列索引, 支路电流列索引)。"""
    comps = ctx["comps"]
    net_of = ctx["net_of"]
    ground = ctx["ground"]
    node_label = ctx["node_label"]

    nodes = [n for n in ctx["order"] if n not in ground]
    node_col = {n: i for i, n in enumerate(nodes)}

    extras: list[tuple[str, dict]] = []
    for c in comps:
        if c["type"] == "SRC":
            extras.append(("src", c))
        elif c["type"] in ("AMP", "OPAMP"):
            extras.append(("amp", c))
    col_ex = {c["id"]: len(nodes) + i for i, (_, c) in enumerate(extras)}

    size = len(nodes) + len(extras)
    if size == 0:
        raise CircuitError("电路中没有任何独立节点。")

    M = [[sp.Integer(0) for _ in range(size)] for _ in range(size)]
    rhs = [sp.Integer(0) for _ in range(size)]

    def col_of(root):
        return node_col.get(root)

    def add_admittance(ca, cb, y):
        """两端导纳元件对节点方程的贡献。"""
        if ca is not None:
            M[ca][ca] += y
        if cb is not None:
            M[cb][cb] += y
        if ca is not None and cb is not None:
            M[ca][cb] -= y
            M[cb][ca] -= y

    for c in comps:
        t = c["type"]
        if t == "R":
            add_admittance(col_of(net_of(c["id"], "a")), col_of(net_of(c["id"], "b")), 1 / _val(c, symbolic))
        elif t == "C":
            add_admittance(col_of(net_of(c["id"], "a")), col_of(net_of(c["id"], "b")), S * _val(c, symbolic))
        elif t == "L":
            add_admittance(col_of(net_of(c["id"], "a")), col_of(net_of(c["id"], "b")), 1 / (S * _val(c, symbolic)))
        elif t == "SRC":
            ca = col_of(net_of(c["id"], "a"))
            cb = col_of(net_of(c["id"], "b"))
            ci = col_ex[c["id"]]
            if ca is not None:
                M[ca][ci] += 1
            if cb is not None:
                M[cb][ci] -= 1
            # 约束行：V_a - V_b = Vin
            crow = ci
            if ca is not None:
                M[crow][ca] = 1
            if cb is not None:
                M[crow][cb] = -1
            rhs[crow] = VIN
        elif t == "AMP":
            gin = col_of(net_of(c["id"], "in"))
            gout = col_of(net_of(c["id"], "out"))
            ggnd = col_of(net_of(c["id"], "gnd"))
            ci = col_ex[c["id"]]
            if gout is not None:
                M[gout][ci] += 1
            if ggnd is not None:
                M[ggnd][ci] -= 1
            k = _val(c, symbolic)
            crow = ci
            if gout is not None:
                M[crow][gout] += 1
            if ggnd is not None:
                M[crow][ggnd] += -1 + k
            if gin is not None:
                M[crow][gin] += -k
        elif t == "OPAMP":
            # 理想运放（虚短）：V_p = V_n，输出电流由电路决定
            gp = col_of(net_of(c["id"], "p"))
            gn = col_of(net_of(c["id"], "n"))
            gout = col_of(net_of(c["id"], "out"))
            ci = col_ex[c["id"]]
            if gout is not None:
                M[gout][ci] += 1
            if gp is not None:
                M[ci][gp] += 1
            if gn is not None:
                M[ci][gn] -= 1

    return sp.Matrix(M), sp.Matrix(rhs), node_col, col_ex, extras


def _solve_tf(ctx: dict, symbolic: bool):
    """求解传递函数 H(s) = Vout / Vin。"""
    M, rhs, node_col, col_ex, extras = _build_mna(ctx, symbolic)
    try:
        sol = M.LUsolve(rhs)
    except Exception as exc:  # noqa: BLE001
        raise CircuitError(
            "电路方程无法求解（矩阵奇异）。请检查是否出现悬空节点、理想电压源被短路，"
            "或电容/电感形成了纯电压源回路。"
        ) from exc

    out = ctx["out"]
    net_of = ctx["net_of"]
    ground = ctx["ground"]
    vout = sp.Integer(0)
    ca = node_col.get(net_of(out["id"], "a"))
    cb = node_col.get(net_of(out["id"], "b"))
    if ca is not None:
        vout += sol[ca]
    if cb is not None:
        vout -= sol[cb]

    h = sp.cancel(sp.together(vout / VIN))
    return sp.simplify(h), (M, rhs)


def _tf_numbers(h_expr) -> dict:
    """把传递函数表达式转成分子/分母多项式系数（高次在前）。"""
    if h_expr == 0:
        raise CircuitError("输出端电压恒为 0，请检查输出端是否接到了有效节点。")
    num, den = sp.fraction(sp.cancel(h_expr))
    num = sp.expand(num)
    den = sp.expand(den)
    if den == 0:
        raise CircuitError("传递函数分母为零，电路结构异常。")
    dpoly = sp.Poly(den, S)
    npoly = sp.Poly(num, S)
    lead = dpoly.LC()
    # 分母首项系数归一化（sympy 的 Poly 除法返回表达式，这里重新构造）
    den = sp.expand(den / lead)
    num = sp.expand(num / lead)
    dpoly = sp.Poly(den, S)
    npoly = sp.Poly(num, S)
    den_c = [float(x) for x in dpoly.all_coeffs()]
    num_c = [float(x) for x in npoly.all_coeffs()]
    # 精确有理数求解后系数已无噪声，只需去掉非零但位置多余的零项
    while len(num_c) > 1 and num_c[0] == 0:
        num_c.pop(0)
    while len(den_c) > 1 and den_c[0] == 0:
        den_c.pop(0)
    return {"num": num_c, "den": den_c}


def _roots(coeffs: list[float]) -> list[complex]:
    """用 numpy 求多项式根（高次在前）。"""
    import numpy as np

    c = [x for x in coeffs]
    while len(c) > 1 and abs(c[0]) == 0:
        c.pop(0)
    if len(c) <= 1:
        return []
    return [complex(r) for r in np.roots(np.array(c, dtype=float))]


def _poly_text(coeffs: list[float], latex: bool) -> str:
    return _poly_latex(coeffs) if latex else _poly_latex(coeffs)


# --------------------------------------------------------------------------
# 推导步骤生成
# --------------------------------------------------------------------------
def _impedance_latex(comp: dict, symbolic: bool) -> str:
    """给出元件的复阻抗表达式。"""
    t = comp["type"]
    sym = _val(comp, True)
    if t == "R":
        return f"{sp.latex(sym)}"
    if t == "C":
        return f"\\dfrac{{1}}{{{sp.latex(S)}\\,{sp.latex(sym)}}}"
    if t == "L":
        return f"{sp.latex(S)}\\,{sp.latex(sym)}"
    if t == "AMP":
        return f"V_{{out}} = {sp.latex(sym)}\\,V_{{in}}"
    return ""


def _term_latex(comp: dict, node_root, other_root, node_label, mode: str) -> str | None:
    """生成元件在某个节点上的电流项（不含正负号）。

    mode = "s"：s 域复阻抗法；mode = "t"：时域电路方程法。
    """
    t = comp["type"]
    if t in ("GND", "OUT"):
        return None
    la = node_label.get(node_root, "0")
    lb = node_label.get(other_root, "0") if other_root is not None else None
    sym = _val(comp, True)

    if mode == "s":
        if lb is None or lb == "0":
            diff = f"V_{{{la}}}"
        else:
            diff = f"V_{{{la}}} - V_{{{lb}}}"
        if t == "R":
            return f"\\dfrac{{{diff}}}{{{sp.latex(sym)}}}"
        if t == "C":
            body = f"{sp.latex(S)}\\,{sp.latex(sym)}"
            if " - " in diff:
                return f"{body}\\left({diff}\\right)"
            return f"{body}\\,{diff}"
        if t == "L":
            return f"\\dfrac{{{diff}}}{{{sp.latex(S)}\\,{sp.latex(sym)}}}"
    else:
        if lb is None or lb == "0":
            diff = f"v_{{{la}}}(t)"
        else:
            diff = f"\\left[v_{{{la}}}(t)-v_{{{lb}}}(t)\\right]"
        if t == "R":
            return f"\\dfrac{{{diff}}}{{{sp.latex(sym)}}}"
        if t == "C":
            if lb is None or lb == "0":
                return f"{sp.latex(sym)}\\dfrac{{dv_{{{la}}}(t)}}{{dt}}"
            return f"{sp.latex(sym)}\\dfrac{{d}}{{dt}}{diff}"
        if t == "L":
            return f"\\dfrac{{1}}{{{sp.latex(sym)}}}\\int {diff}\\,dt"
    return None


def _node_terms(ctx: dict, mode: str) -> dict:
    """汇总每个非地节点的电流项列表。"""
    comps = ctx["comps"]
    net_of = ctx["net_of"]
    ground = ctx["ground"]
    node_label = ctx["node_label"]
    rows: dict[Any, list[tuple[int, str]]] = {
        n: [] for n in ctx["order"] if n not in ground
    }

    for c in comps:
        t = c["type"]
        if t in ("GND", "OUT"):
            continue
        if t in ("R", "C", "L"):
            na = net_of(c["id"], "a")
            nb = net_of(c["id"], "b")
            # 每个节点都写「从本节点流出的电流」，因此两端都取正号
            if na in rows:
                term = _term_latex(c, na, nb, node_label, mode)
                if term:
                    rows[na].append((1, term))
            if nb in rows:
                term = _term_latex(c, nb, na, node_label, mode)
                if term:
                    rows[nb].append((1, term))
        elif t == "SRC":
            na = net_of(c["id"], "a")
            nb = net_of(c["id"], "b")
            cur = f"I_{{{c['name']}}}" if mode == "s" else f"i_{{{c['name']}}}(t)"
            if na in rows:
                rows[na].append((1, cur))
            if nb in rows:
                rows[nb].append((-1, cur))
        elif t in ("AMP", "OPAMP"):
            gout = net_of(c["id"], "out")
            cur = f"I_{{{c['name']}}}" if mode == "s" else f"i_{{{c['name']}}}(t)"
            if gout in rows:
                rows[gout].append((1, cur))
            if t == "AMP":
                ggnd = net_of(c["id"], "gnd")
                if ggnd in rows:
                    rows[ggnd].append((-1, cur))
    return rows


def _node_name(root, node_label) -> str:
    lab = node_label.get(root, "0")
    return "参考节点（0 V）" if lab == "0" else f"节点 {lab}"


def _build_steps(ctx: dict, h_expr, tf: dict, h_sym=None) -> dict:
    """构造复阻抗法与电路方程法两套推导步骤。"""
    comps = ctx["comps"]
    ground = ctx["ground"]
    node_label = ctx["node_label"]
    nodes = [n for n in ctx["order"] if n not in ground]
    src = ctx["src"]
    out = ctx["out"]

    # ---- 元件表 ----
    elem_rows = []
    for c in comps:
        if c["type"] in ("GND", "OUT"):
            continue
        sym = _val(c, True) if c["type"] != "OPAMP" else None
        if c["type"] == "AMP":
            val_txt = f"K = {c['gain']:g}"
            imp = f"V_{{o}} = {sp.latex(sym)}\\,V_{{i}}"
        elif c["type"] == "OPAMP":
            val_txt = "理想"
            imp = "V_{p} = V_{n}"
        elif c["type"] == "SRC":
            val_txt = "输入 u_i"
            imp = "激励源"
        else:
            unit = {"R": "Ω", "C": "F", "L": "H"}[c["type"]]
            val_txt = fmt_si(c["value"], unit)
            imp = _impedance_latex(c, True)
        elem_rows.append([c["name"], TYPE_NAME[c["type"]], val_txt, imp])

    # ---- 节点表 ----
    node_rows = []
    for root in ctx["order"]:
        lab = node_label[root]
        kind = "参考节点" if lab == "0" else "独立节点"
        conn = []
        for c in comps:
            for pin in PINS[c["type"]]:
                if ctx["net_of"](c["id"], pin) == root:
                    conn.append(f"{c['name']}.{pin}")
        node_rows.append([f"{lab}" if lab != "0" else "0", kind, "、".join(conn) if conn else "—"])

    # ---- 复阻抗法 ----
    imp_terms = _node_terms(ctx, "s")
    imp_eqs = []
    float_nodes = []
    for n in nodes:
        terms = imp_terms.get(n, [])
        if not terms:
            float_nodes.append(node_label[n])
            imp_eqs.append(f"\\text{{节点 {node_label[n]} 悬空，无电流方程}}")
        else:
            imp_eqs.append(f"{_join_terms(terms)} = 0")
    imp_eq_latex = "\\\\[6pt] ".join(imp_eqs)

    # ---- 电路方程法 ----
    time_terms = _node_terms(ctx, "t")
    time_eqs = []
    for n in nodes:
        terms = time_terms.get(n, [])
        if terms:
            time_eqs.append(f"{_join_terms(terms)} = 0")
    time_eq_latex = "\\\\[6pt] ".join(time_eqs) if time_eqs else "\\text{无独立节点}"

    # 放大器约束方程
    amp_constraints = []
    for c in comps:
        if c["type"] == "OPAMP":
            gp = node_label.get(ctx["net_of"](c["id"], "p"), "0")
            gn = node_label.get(ctx["net_of"](c["id"], "n"), "0")
            amp_constraints.append(f"V_{{{gp}}} = V_{{{gn}}}")
            amp_constraints.append(f"v_{{{gp}}}(t) = v_{{{gn}}}(t)")
            continue
        if c["type"] != "AMP":
            continue
        k = _val(c, True)
        gg = node_label.get(ctx["net_of"](c["id"], "gnd"), "0")
        gi = node_label.get(ctx["net_of"](c["id"], "in"), "0")
        go = node_label.get(ctx["net_of"](c["id"], "out"), "0")
        if gg == "0":
            amp_constraints.append(
                f"V_{{{go}}} = {sp.latex(k)}\\,V_{{{gi}}}"
            )
            amp_constraints.append(
                f"v_{{{go}}}(t) = {sp.latex(k)}\\,v_{{{gi}}}(t)"
            )
        else:
            amp_constraints.append(
                f"V_{{{go}}} - V_{{{gg}}} = {sp.latex(k)}\\left(V_{{{gi}}} - V_{{{gg}}}\\right)"
            )

    num_l, den_l = tf["num"], tf["den"]
    h_latex = f"\\dfrac{{{_poly_latex(num_l)}}}{{{_poly_latex(den_l)}}}"

    # 符号形式的 H(s)：与元件取值无关
    h_sym_latex = None
    if h_sym is not None:
        num_s, den_s = sp.fraction(sp.cancel(h_sym))
        h_sym_latex = f"\\dfrac{{{sp.latex(num_s)}}}{{{sp.latex(den_s)}}}"

    zeros = _roots(num_l)
    poles = _roots(den_l)
    zeros.sort(key=lambda z: (round(z.real, 9), round(z.imag, 9)))
    poles.sort(key=lambda z: (round(z.real, 9), round(z.imag, 9)))

    gain = (num_l[0] / den_l[0]) if (num_l and den_l and den_l[0] != 0) else 0.0

    imp_steps = [
        {
            "title": "① 把元件映射为 s 域复阻抗",
            "blocks": [
                {"type": "text", "text": "在零初始条件下，把电路从时域变换到复频域（s 域），三种无源元件的复阻抗如下："},
                {"type": "table", "columns": ["元件", "类型", "参数值", "复阻抗 Z(s) / 特性"], "rows": elem_rows, "latexColumns": [3]},
                {"type": "text", "text": "电感与电容的阻抗中出现了 s，这正是传递函数中出现 s 的来源。"},
            ],
        },
        {
            "title": "② 标定节点并选择参考节点",
            "blocks": [
                {"type": "text", "text": "把所有由导线连通的引脚合并为同一个节点；画了接地符号时以接地端为 0 V 参考节点，未画接地符号时以电压源负端为参考节点。"},
                {"type": "table", "columns": ["节点", "类型", "所连引脚"], "rows": node_rows, "latexColumns": []},
            ],
        },
        {
            "title": "③ 用复阻抗直接列写节点 KCL 方程",
            "blocks": [
                {"type": "text", "text": "对每个独立节点列写「流出电流代数和为零」，元件用第一步得到的复阻抗表示：电压差除以阻抗即为电流。"},
                {"type": "latex_display", "latex": imp_eq_latex},
            ] + ([
                {"type": "text", "text": "放大器为理想电压控制电压源，补充约束方程："},
                {"type": "latex_display", "latex": "\\\\[6pt] ".join(amp_constraints)},
            ] if amp_constraints else []),
        },
        {
            "title": "④ 解方程组，得到符号形式的 H(s)",
            "blocks": [
                {"type": "text", "text": "方程中的 R₁、C₁、L₁、K 等全部保持符号，按线性方程组消元解出输出端电压 V_out(s)，再取比值。这一步的结果只与网络结构有关，与该元件具体取值无关。"},
                {"type": "latex_display", "latex": f"H(s)=\\dfrac{{V_{{out}}(s)}}{{V_{{in}}(s)}} = {h_sym_latex or h_latex}"},
            ] + ([
                {"type": "text", "text": "若需要数值形式，把各元件参数代入上式即可（见下一步）。"},
            ] if h_sym_latex else []),
        },
        {
            "title": "⑤ 代入参数值，写成数值形式并求极点零点",
            "blocks": [
                {"type": "text", "text": "把 R₁、C₁、L₁、K 的具体数值代入符号结果，得到用于仿真与性能分析的数值传递函数（分母最高次项系数归一化）："},
                {"type": "latex_display", "latex": f"H(s) = {h_latex}"},
                {"type": "text", "text": "将分子分母因式分解，可以直接读出零点与极点（极点即系统的特征根）："},
                {"type": "latex_display", "latex": _factored_latex(gain, zeros, poles)},
                {"type": "text", "text": f"零点：{'；'.join('s = ' + _comp_latex(z) for z in zeros) if zeros else '无'}"},
                {"type": "text", "text": f"极点：{'；'.join('s = ' + _comp_latex(p) for p in poles) if poles else '无'}"},
            ],
        },
    ]

    eq_steps = [
        {
            "title": "① 在时域列写节点电流方程（KCL）",
            "blocks": [
                {"type": "text", "text": "设各节点对地电压为 v_i(t)，对每个独立节点写出流出电流的代数和为零。电阻用欧姆定律，电容用电荷—电流关系，电感用积分形式："},
                {"type": "latex_display", "latex": "i_R=\\dfrac{u_R}{R},\\quad i_C=C\\dfrac{du_C}{dt},\\quad u_L=L\\dfrac{di_L}{dt}\\;\\Rightarrow\\;i_L=\\dfrac{1}{L}\\int u_L\\,dt"},
                {"type": "latex_display", "latex": time_eq_latex},
            ],
        },
        {
            "title": "② 处理储能元件，得到微分方程",
            "blocks": [
                {"type": "text", "text": "把上式中含导数和积分的项保留，得到以节点电压为变量的微分—积分方程组（这就是电路的动态方程）。"},
            ] + ([
                {"type": "text", "text": "放大器为代数约束："},
                {"type": "latex_display", "latex": amp_constraints[-1]},
            ] if amp_constraints else []),
        },
        {
            "title": "③ 零初始条件下做拉普拉斯变换",
            "blocks": [
                {"type": "text", "text": "设所有初始储能为零（v_C(0)=0，i_L(0)=0），利用拉氏变换的微分与积分性质："},
                {"type": "latex_display", "latex": "\\mathcal{L}\\left\\{\\dfrac{du}{dt}\\right\\}=sU(s),\\qquad \\mathcal{L}\\left\\{\\int u\\,dt\\right\\}=\\dfrac{U(s)}{s}"},
                {"type": "text", "text": "于是时域微分—积分方程变成 s 域的代数方程："},
                {"type": "latex_display", "latex": imp_eq_latex},
            ],
        },
        {
            "title": "④ 解 s 域代数方程组",
            "blocks": [
                {"type": "text", "text": "此时方程中只有 s 与各节点电压，各元件参数保持符号，按线性方程组消元求解，得到输出节点电压："},
                {"type": "latex_display", "latex": f"V_{{out}}(s) = {h_sym_latex or h_latex} \\cdot V_{{in}}(s)"},
            ],
        },
        {
            "title": "⑤ 得到符号形式与数值形式的传递函数",
            "blocks": [
                {"type": "text", "text": "按定义取输出与输入的比值（零初始条件），并约去公因式，得到只含符号的传递函数："},
                {"type": "latex_display", "latex": f"H(s)=\\dfrac{{V_{{out}}(s)}}{{V_{{in}}(s)}} = {h_sym_latex or h_latex}"},
            ] + ([
                {"type": "text", "text": "再代入各元件参数，得到仿真所用的数值形式："},
                {"type": "latex_display", "latex": f"H(s) = {h_latex}"},
            ] if h_sym_latex else []) + [
                {"type": "text", "text": "可见电路方程法与复阻抗法最终得到同一结果：拉氏变换把微分方程变成了复阻抗形式的代数方程。"},
            ],
        },
    ]

    return {
        "impedance": {"title": "复阻抗法", "subtitle": "s 域直接建模", "steps": imp_steps},
        "equations": {"title": "电路方程法", "subtitle": "时域微分方程 → 拉氏变换", "steps": eq_steps},
        "float_nodes": float_nodes,
    }


def _factored_latex(gain: float, zeros: list[complex], poles: list[complex]) -> str:
    """生成因式分解形式的 LaTeX。"""
    def block(roots: list[complex], is_zero: bool) -> str:
        if not roots:
            return ""
        parts = []
        for r in roots:
            if abs(r.imag) < 1e-9:
                re = r.real
                if abs(re) < 1e-12:
                    parts.append("s")
                else:
                    sign = "+" if re < 0 else "-"
                    parts.append(f"\\left(s {sign} {_num_latex(abs(re))}\\right)")
            else:
                parts.append(f"\\left(s - ({_comp_latex(r)})\\right)")
        return "".join(parts)

    num_part = block(zeros, True)
    den_part = block(poles, False)
    g = _num_latex(gain)
    if not den_part:
        return f"H(s) = {g}" if not num_part else f"H(s) = {g}\\,{num_part}"
    if not num_part:
        return f"H(s) = \\dfrac{{{g}}}{{{den_part}}}"
    return f"H(s) = {g}\\,\\dfrac{{{num_part}}}{{{den_part}}}"


# --------------------------------------------------------------------------
# 对外接口
# --------------------------------------------------------------------------
def analyze(payload: dict) -> dict:
    """分析电路，返回传递函数与推导步骤。"""
    ctx = _prepare(payload)

    h_num, _ = _solve_tf(ctx, symbolic=False)
    tf = _tf_numbers(h_num)

    # 符号解：传递函数的符号形式（只含 R1、C1、L1、K 等符号，与具体取值无关）
    symbol_tf = None
    h_sym = None
    element_count = sum(1 for c in ctx["comps"] if c["type"] in ("R", "C", "L", "AMP"))
    if element_count <= 8:
        try:
            h_sym_candidate, _ = _solve_tf(ctx, symbolic=True)
            if sp.count_ops(h_sym_candidate) < 900:
                num, den = sp.fraction(sp.cancel(h_sym_candidate))
                h_sym = h_sym_candidate
                symbol_tf = {
                    "latex": f"\\dfrac{{{sp.latex(num)}}}{{{sp.latex(den)}}}",
                    "numLatex": sp.latex(num),
                    "denLatex": sp.latex(den),
                    "plain": str(h_sym_candidate),
                }
        except Exception:  # noqa: BLE001
            symbol_tf = None
            h_sym = None

    steps = _build_steps(ctx, h_num, tf, h_sym)

    warnings: list[str] = []
    if steps["float_nodes"]:
        warnings.append("存在悬空节点：" + "、".join(steps["float_nodes"]) + "，请检查引脚是否漏接。")
    if len(tf["num"]) > len(tf["den"]):
        warnings.append("该网络为非真系统（分子阶次高于分母），物理上含理想微分环节，仿真时将附加高频极点近似。")
    if tf["den"][0] == 0:
        warnings.append("分母首项系数为 0，系统阶次判定可能异常。")

    poles = _roots(tf["den"])
    unstable = [p for p in poles if p.real > 1e-9]

    notes: list[str] = []
    if symbol_tf is None:
        notes.append("未能给出符号形式的解析解（电路规模较大或解析式过于复杂），下方只展示代入参数后的数值传递函数，仿真同样基于数值形式。")
    if ctx.get("auto_ground"):
        notes.append(
            "电路中没有接地符号，已自动把电压源 U1 的负端作为参考节点（0 V），"
            "输出 u_o 以该参考点为基准，符合教材中只标 u_i、u_o 的两端网络画法。"
        )

    return {
        "ok": True,
        "netlist": {
            "elements": [
                {
                    "name": c["name"],
                    "type": c["type"],
                    "typeName": TYPE_NAME[c["type"]],
                    "value": c.get("value"),
                    "gain": c.get("gain"),
                    "symbol": sp.latex(_val(c, True)) if c["type"] in ("R", "C", "L", "AMP") else "",
                }
                for c in ctx["comps"]
            ],
            "nodes": [
                {
                    "label": ctx["node_label"][r],
                    "ground": r in ctx["ground"],
                }
                for r in ctx["order"]
            ],
        },
        "tf": {
            "num": tf["num"],
            "den": tf["den"],
            "latex": f"\\dfrac{{{_poly_latex(tf['num'])}}}{{{_poly_latex(tf['den'])}}}",
            "numText": _poly_latex(tf["num"]),
            "denText": _poly_latex(tf["den"]),
            "order": len(tf["den"]) - 1,
            "dcGain": _dc_gain(tf),
            "poles": [_comp_latex(p) for p in poles],
            "zeros": [_comp_latex(z) for z in _roots(tf["num"])],
            "symbolic": symbol_tf,
        },
        "steps": steps,
        "warnings": warnings,
        "notes": notes,
        "stable": len(unstable) == 0,
    }


def _dc_gain(tf: dict) -> float | None:
    """求 s=0 处的增益（若为纯积分环节则返回 None）。"""
    try:
        den0 = tf["den"][-1]
        num0 = tf["num"][-1]
        if abs(den0) < 1e-15:
            return None
        return num0 / den0
    except Exception:  # noqa: BLE001
        return None
