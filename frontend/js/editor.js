/* =========================================================
   电路编辑器：SVG 画布上的元件拖拽、引脚连线、参数编辑
   ========================================================= */
(function (global) {
  'use strict';

  const GRID = 10;

  // 元件规格：引脚局部坐标、包围盒、默认参数
  const SPEC = {
    R: {
      title: '电阻', pins: { a: [-48, 0], b: [48, 0] },
      bbox: [-56, -26, 56, 26], unit: 'Ω', def: 1000,
    },
    C: {
      title: '电容', pins: { a: [-44, 0], b: [44, 0] },
      bbox: [-50, -26, 50, 26], unit: 'F', def: 1e-6,
    },
    L: {
      title: '电感', pins: { a: [-48, 0], b: [48, 0] },
      bbox: [-56, -18, 56, 18], unit: 'H', def: 10e-3,
    },
    SRC: {
      title: '输入端口', pins: { a: [0, -44], b: [0, 44] },
      bbox: [-34, -52, 34, 52], def: null,
    },
    AMP: {
      title: '放大器', pins: { in: [-52, 0], out: [52, 0], gnd: [2, 40] },
      bbox: [-60, -34, 60, 48], def: 10,
    },
    OPAMP: {
      title: '理想运放', pins: { p: [-52, -15], n: [-52, 15], out: [52, 0] },
      bbox: [-60, -40, 60, 40], def: null,
    },
    OUT: {
      title: '输出端口', pins: { a: [0, -44], b: [0, 44] },
      bbox: [-32, -52, 32, 52], def: null,
    },
    GND: {
      title: '接地', pins: { g: [0, -20] },
      bbox: [-18, -26, 18, 18], def: null,
    },
  };

  const NAME_PREFIX = { R: 'R', C: 'C', L: 'L', AMP: 'A', OPAMP: 'OP', SRC: 'U', OUT: 'OUT', GND: 'GND' };

  let uid = 1;

  function snap(v) { return Math.round(v / GRID) * GRID; }

  /** 数值 → 带 SI 词头的显示文本 */
  function formatSI(value, unit) {
    if (!isFinite(value)) return '—';
    if (value === 0) return '0';
    const abs = Math.abs(value);
    const table = [
      [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'],
      [1e-6, 'μ'], [1e-9, 'n'], [1e-12, 'p'],
    ];
    for (const [scale, prefix] of table) {
      if (abs >= scale * 0.999) {
        const n = value / scale;
        return `${parseFloat(n.toPrecision(3))} ${prefix}${unit || ''}`.trim();
      }
    }
    return `${value} ${unit || ''}`.trim();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  class CircuitEditor {
    constructor(svg, options = {}) {
      this.svg = svg;
      this.options = options;
      this.components = [];
      this.wires = [];
      this.selection = null;       // {kind:'comp'|'wire', id}
      this.pending = null;         // {comp, pin} 连线起点
      this.mouse = { x: 0, y: 0 };
      this.drag = null;
      this.pan = null;             // 画布平移
      this.view = null;            // {x,y,w,h} 当前 viewBox
      this.fitView = null;         // 内容自适应的 viewBox
      this.manualView = false;     // 用户是否手动缩放/平移过
      this.listeners = {};
      this._bind();
      this.resize();
    }

    /* ---------------- 事件系统 ---------------- */
    on(evt, fn) {
      (this.listeners[evt] = this.listeners[evt] || []).push(fn);
      return this;
    }

    emit(evt, payload) {
      (this.listeners[evt] || []).forEach((fn) => fn(payload));
    }

    /* ---------------- 坐标 / 视图 ---------------- */
    _shellSize() {
      const shell = this.svg.parentElement;
      return {
        W: Math.max(320, (shell && shell.clientWidth) || 900),
        H: Math.max(260, (shell && shell.clientHeight) || 600),
      };
    }

    /** 根据元件包围盒计算「适应窗口」的 viewBox */
    _computeFit(W, H) {
      if (!this.components.length) return { x: 0, y: 0, w: W, h: H };

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      this.components.forEach((c) => {
        const [x0, y0, x1, y1] = SPEC[c.type].bbox;
        const rad = ((c.rot || 0) * Math.PI) / 180;
        const cs = Math.cos(rad);
        const sn = Math.sin(rad);
        [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].forEach(([x, y]) => {
          const px = c.x + x * cs - y * sn;
          const py = c.y + x * sn + y * cs;
          minX = Math.min(minX, px);
          maxX = Math.max(maxX, px);
          minY = Math.min(minY, py);
          maxY = Math.max(maxY, py);
        });
      });

      const pad = 70;
      let bw = maxX - minX + pad * 2;
      let bh = maxY - minY + pad * 2;
      const ratio = W / H;
      if (bw / bh < ratio) bw = bh * ratio;
      else bh = bw / ratio;

      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      return { x: cx - bw / 2, y: cy - bh / 2, w: bw, h: bh };
    }

    /** 应用 viewBox，并同步底纹网格 */
    applyView() {
      if (!this.view) return;
      const v = this.view;
      this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
      this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

      const shell = this.svg.parentElement;
      if (shell) {
        const rect = this.svg.getBoundingClientRect();
        const k = (rect.width || v.w) / v.w;
        const ox = -v.x * k;
        const oy = -v.y * k;
        shell.style.backgroundSize = `${20 * k}px ${20 * k}px, ${100 * k}px ${100 * k}px`;
        shell.style.backgroundPosition = `${ox}px ${oy}px, ${ox}px ${oy}px`;
      }

      const pct = this.fitView ? Math.round((this.fitView.w / v.w) * 100) : 100;
      this.emit('view', { percent: pct });
    }

    resize(force = false) {
      const { W, H } = this._shellSize();
      this.fitView = this._computeFit(W, H);

      if (force || !this.view || !this.components.length) {
        // 无内容时直接用画布的像素坐标，方便元件落点
        this.view = Object.assign({}, this.fitView);
        this.manualView = false;
      } else if (!this.manualView) {
        const cur = this.view;
        const fit = this.fitView;
        const same = Math.abs(cur.w - fit.w) / fit.w < 0.02
          && Math.abs(cur.h - fit.h) / fit.h < 0.02
          && Math.abs((cur.x + cur.w / 2) - (fit.x + fit.w / 2)) < 2
          && Math.abs((cur.y + cur.h / 2) - (fit.y + fit.h / 2)) < 2;
        if (!same) this.view = Object.assign({}, fit);
      } else {
        // 手动缩放后窗口尺寸变化：保持缩放级别，修正宽高比
        const cx = this.view.x + this.view.w / 2;
        const cy = this.view.y + this.view.h / 2;
        this.view.h = this.view.w * (H / W);
        this.view.x = cx - this.view.w / 2;
        this.view.y = cy - this.view.h / 2;
      }
      this.applyView();
    }

    /** 以屏幕坐标为中心缩放 */
    zoomAt(factor, clientX, clientY) {
      if (!this.view) return;
      const p = this.toSvg(clientX, clientY);
      const nw = this.view.w / factor;
      const nh = this.view.h / factor;
      const floor = this.fitView ? this.fitView.w : this.view.w;
      const scale = floor / nw;
      if (scale < 0.25 || scale > 8) return;

      const k = nw / this.view.w;
      this.view.x = p.x - (p.x - this.view.x) * k;
      this.view.y = p.y - (p.y - this.view.y) * k;
      this.view.w = nw;
      this.view.h = nh;
      this.manualView = true;
      this.applyView();
    }

    /** 以画布中心缩放（工具栏按钮） */
    zoomBy(factor) {
      const rect = this.svg.getBoundingClientRect();
      this.zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    }

    /** 适应窗口 */
    fit() {
      this.resize(true);
    }

    panByPixels(dx, dy) {
      if (!this.view) return;
      const rect = this.svg.getBoundingClientRect();
      const k = this.view.w / (rect.width || this.view.w);
      this.view.x -= dx * k;
      this.view.y -= dy * k;
      this.manualView = true;
      this.applyView();
    }

    toSvg(clientX, clientY) {
      const pt = this.svg.createSVGPoint();
      pt.x = clientX;
      pt.y = clientY;
      const ctm = this.svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const p = pt.matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    }

    /* ---------------- 数据 ---------------- */
    findComp(id) { return this.components.find((c) => c.id === id); }

    pinPos(ref) {
      const comp = this.findComp(ref.comp);
      if (!comp) return { x: 0, y: 0 };
      const spec = SPEC[comp.type];
      const local = spec.pins[ref.pin];
      if (!local) return { x: comp.x, y: comp.y };
      const rad = ((comp.rot || 0) * Math.PI) / 180;
      return {
        x: comp.x + local[0] * Math.cos(rad) - local[1] * Math.sin(rad),
        y: comp.y + local[0] * Math.sin(rad) + local[1] * Math.cos(rad),
      };
    }

    nextName(type) {
      const prefix = NAME_PREFIX[type] || type;
      if (type === 'GND') return 'GND';
      let max = 0;
      this.components.forEach((c) => {
        if (c.type !== type) return;
        const m = new RegExp(`^${prefix}(\\d+)$`).exec(c.name || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      return `${prefix}${max + 1}`;
    }

    /* ---------------- 增删改 ---------------- */
    addComponent(type, x, y) {
      const spec = SPEC[type];
      if (!spec) return null;
      const comp = {
        id: `c${uid++}`,
        type,
        name: this.nextName(type),
        x: snap(x), y: snap(y),
        rot: 0,
      };
      if (type === 'AMP') comp.gain = spec.def;
      if (spec.def != null && type !== 'AMP') comp.value = spec.def;
      this.components.push(comp);
      this.select({ kind: 'comp', id: comp.id });
      this.render();
      this.emit('change');
      return comp;
    }

    removeSelected() {
      if (!this.selection) return;
      const { kind, id } = this.selection;
      if (kind === 'comp') {
        this.components = this.components.filter((c) => c.id !== id);
        this.wires = this.wires.filter((w) => w.a.comp !== id && w.b.comp !== id);
      } else {
        this.wires = this.wires.filter((w) => w.id !== id);
      }
      this.selection = null;
      this.pending = null;
      this.render();
      this.emit('select', null);
      this.emit('change');
    }

    clear() {
      this.components = [];
      this.wires = [];
      this.selection = null;
      this.pending = null;
      this.render();
      this.resize();
      this.emit('select', null);
      this.emit('change');
    }

    select(sel) {
      this.selection = sel;
      this.render();
      this.emit('select', sel);
    }

    rotateSelected() {
      if (!this.selection || this.selection.kind !== 'comp') return;
      const comp = this.findComp(this.selection.id);
      if (!comp) return;
      comp.rot = ((comp.rot || 0) + 90) % 360;
      this.render();
      this.emit('change');
    }

    addWire(a, b) {
      if (a.comp === b.comp && a.pin === b.pin) return;
      const exists = this.wires.some((w) => (
        (w.a.comp === a.comp && w.a.pin === a.pin && w.b.comp === b.comp && w.b.pin === b.pin)
        || (w.a.comp === b.comp && w.a.pin === b.pin && w.b.comp === a.comp && w.b.pin === a.pin)
      ));
      if (exists) return;
      this.wires.push({ id: `w${uid++}`, a: { ...a }, b: { ...b } });
      this.render();
      this.emit('change');
    }

    getCircuit() {
      return {
        components: this.components.map((c) => ({
          id: c.id,
          type: c.type,
          name: c.name,
          x: c.x,
          y: c.y,
          rot: c.rot || 0,
          value: c.value,
          gain: c.gain,
        })),
        wires: this.wires.map((w) => ({
          a: [w.a.comp, w.a.pin],
          b: [w.b.comp, w.b.pin],
        })),
      };
    }

    setCircuit(data) {
      const idMap = {};
      this.components = (data.components || []).map((c) => {
        const id = `c${uid++}`;
        idMap[c.id] = id;
        return {
          id,
          type: c.type,
          name: c.name,
          x: c.x,
          y: c.y,
          rot: c.rot || 0,
          value: c.value,
          gain: c.gain,
        };
      });
      this.wires = (data.wires || []).map((w) => ({
        id: `w${uid++}`,
        a: { comp: idMap[w.a[0]], pin: w.a[1] },
        b: { comp: idMap[w.b[0]], pin: w.b[1] },
      })).filter((w) => w.a.comp && w.b.comp);
      this.selection = null;
      this.pending = null;
      this.render();
      this.resize(true);
      this.emit('select', null);
      this.emit('change');
    }

    isEmpty() { return this.components.length === 0; }

    /* ---------------- 绘制 ---------------- */
    symbolSvg(c) {
      switch (c.type) {
        case 'R':
          return `
            <line class="lead" x1="-48" y1="0" x2="-30" y2="0"/>
            <rect class="body" x="-30" y="-12" width="60" height="24" rx="3"/>
            <line class="lead" x1="30" y1="0" x2="48" y2="0"/>`;
        case 'C':
          return `
            <line class="lead" x1="-44" y1="0" x2="-6" y2="0"/>
            <line class="lead" x1="6" y1="0" x2="44" y2="0"/>
            <line class="body" x1="-6" y1="-20" x2="-6" y2="20"/>
            <line class="body" x1="6" y1="-20" x2="6" y2="20"/>`;
        case 'L':
          return `
            <line class="lead" x1="-48" y1="0" x2="-24" y2="0"/>
            <path class="lead" d="M -24 0 A 6 6 0 0 0 -12 0 A 6 6 0 0 0 0 0 A 6 6 0 0 0 12 0 A 6 6 0 0 0 24 0"/>
            <line class="lead" x1="24" y1="0" x2="48" y2="0"/>`;
        case 'SRC':
          return `
            <line class="lead" x1="0" y1="-44" x2="0" y2="-23"/>
            <circle class="body" cx="0" cy="-16" r="7"/>
            <circle class="body" cx="0" cy="16" r="7"/>
            <line class="lead" x1="0" y1="23" x2="0" y2="44"/>
            <text class="pol" x="-16" y="-24" text-anchor="middle">+</text>
            <text class="pol" x="-16" y="30" text-anchor="middle">−</text>`;
        case 'OPAMP':
          return `
            <polygon class="body" points="-30,-30 -30,30 34,0"/>
            <line class="lead" x1="-52" y1="-15" x2="-30" y2="-15"/>
            <line class="lead" x1="-52" y1="15" x2="-30" y2="15"/>
            <line class="lead" x1="34" y1="0" x2="52" y2="0"/>
            <text class="pol" x="-22" y="-8" text-anchor="middle">+</text>
            <text class="pol" x="-22" y="21" text-anchor="middle">−</text>`;
        case 'AMP':
          return `
            <polygon class="body" points="-30,-26 -30,26 34,0"/>
            <line class="lead" x1="-52" y1="0" x2="-30" y2="0"/>
            <line class="lead" x1="34" y1="0" x2="52" y2="0"/>
            <line class="lead" x1="2" y1="13" x2="2" y2="40"/>`;
        case 'OUT':
          return `
            <line class="lead" x1="0" y1="-44" x2="0" y2="-13"/>
            <circle class="body" cx="0" cy="0" r="9"/>
            <line class="lead" x1="0" y1="9" x2="0" y2="44"/>
            <text class="pol" x="-14" y="-26" text-anchor="middle">+</text>
            <text class="pol" x="-14" y="32" text-anchor="middle">−</text>`;
        case 'GND':
          return `
            <line class="lead" x1="0" y1="-20" x2="0" y2="0"/>
            <line class="gnd-sym" x1="-14" y1="0" x2="14" y2="0"/>
            <line class="gnd-sym" x1="-9" y1="6" x2="9" y2="6"/>
            <line class="gnd-sym" x1="-4" y1="12" x2="4" y2="12"/>`;
        default:
          return '';
      }
    }

    valueText(c) {
      if (c.type === 'R' || c.type === 'C' || c.type === 'L') {
        return formatSI(c.value, SPEC[c.type].unit);
      }
      if (c.type === 'AMP') return `K = ${c.gain}`;
      if (c.type === 'SRC') return 'u_i';
      if (c.type === 'OUT') return 'u_o';
      return '';
    }

    labelsSvg(c) {
      const spec = SPEC[c.type];
      const top = spec.bbox[1];
      const bottom = spec.bbox[3];
      const name = `<text class="lbl" x="0" y="${top - 9}" text-anchor="middle">${escapeHtml(c.name)}</text>`;
      const val = this.valueText(c);
      const valEl = val
        ? `<text class="val" x="0" y="${bottom + 16}" text-anchor="middle">${escapeHtml(val)}</text>`
        : '';
      return name + valEl;
    }

    pinsSvg(c) {
      const spec = SPEC[c.type];
      const rad = ((c.rot || 0) * Math.PI) / 180;
      return Object.keys(spec.pins).map((pin) => {
        const local = spec.pins[pin];
        const px = local[0] * Math.cos(rad) - local[1] * Math.sin(rad);
        const py = local[0] * Math.sin(rad) + local[1] * Math.cos(rad);
        const isPending = this.pending && this.pending.comp === c.id && this.pending.pin === pin;
        return `<g data-pin="${pin}" data-comp="${c.id}">
          <circle class="pin-hit" cx="${px}" cy="${py}" r="11"/>
          <circle class="pin-dot${isPending ? ' pending' : ''}" cx="${px}" cy="${py}" r="3.6"/>
        </g>`;
      }).join('');
    }

    compSvg(c) {
      const spec = SPEC[c.type];
      const sel = this.selection && this.selection.kind === 'comp' && this.selection.id === c.id;
      const [x0, y0, x1, y1] = spec.bbox;
      return `<g class="comp${sel ? ' selected' : ''}" data-comp="${c.id}" transform="translate(${c.x},${c.y})">
        <rect class="sel-ring" x="${x0 - 6}" y="${y0 - 6}" width="${x1 - x0 + 12}" height="${y1 - y0 + 12}" rx="8"/>
        <g transform="rotate(${c.rot || 0})">${this.symbolSvg(c)}</g>
        ${this.labelsSvg(c)}
        ${this.pinsSvg(c)}
      </g>`;
    }

    /** 引脚出线方向：'h' 水平 / 'v' 垂直 */
    pinDir(ref) {
      const comp = this.findComp(ref.comp);
      if (!comp) return 'h';
      const local = SPEC[comp.type].pins[ref.pin];
      if (!local) return 'h';
      const rad = ((comp.rot || 0) * Math.PI) / 180;
      const rx = local[0] * Math.cos(rad) - local[1] * Math.sin(rad);
      const ry = local[0] * Math.sin(rad) + local[1] * Math.cos(rad);
      return Math.abs(ry) > Math.abs(rx) ? 'v' : 'h';
    }

    /** 正交布线：只产生水平/垂直线段 */
    routePoints(p1, p2, dir1, dir2) {
      const EPS = 0.6;
      if (Math.abs(p2.x - p1.x) < EPS) {
        return [{ x: p1.x, y: p1.y }, { x: p1.x, y: p2.y }];
      }
      if (Math.abs(p2.y - p1.y) < EPS) {
        return [{ x: p1.x, y: p1.y }, { x: p2.x, y: p1.y }];
      }
      if (dir1 === 'v' && dir2 === 'v') {
        const my = (p1.y + p2.y) / 2;
        return [{ x: p1.x, y: p1.y }, { x: p1.x, y: my }, { x: p2.x, y: my }, { x: p2.x, y: p2.y }];
      }
      if (dir1 === 'h' && dir2 === 'h') {
        const mx = (p1.x + p2.x) / 2;
        return [{ x: p1.x, y: p1.y }, { x: mx, y: p1.y }, { x: mx, y: p2.y }, { x: p2.x, y: p2.y }];
      }
      if (dir1 === 'v') {
        return [{ x: p1.x, y: p1.y }, { x: p1.x, y: p2.y }, { x: p2.x, y: p2.y }];
      }
      return [{ x: p1.x, y: p1.y }, { x: p2.x, y: p1.y }, { x: p2.x, y: p2.y }];
    }

    /** 折线 → 带小圆角的路径（圆角不改变横平竖直的走向） */
    roundedPath(pts, r = 8) {
      if (pts.length < 3) {
        return `M ${pts[0].x} ${pts[0].y} L ${pts[pts.length - 1].x} ${pts[pts.length - 1].y}`;
      }
      let d = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length - 1; i += 1) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const v1x = p0.x - p1.x;
        const v1y = p0.y - p1.y;
        const v2x = p2.x - p1.x;
        const v2y = p2.y - p1.y;
        const l1 = Math.hypot(v1x, v1y);
        const l2 = Math.hypot(v2x, v2y);
        if (l1 < 0.5 || l2 < 0.5) continue;
        const rr = Math.min(r, l1 / 2, l2 / 2);
        const ax = p1.x + (v1x / l1) * rr;
        const ay = p1.y + (v1y / l1) * rr;
        const bx = p1.x + (v2x / l2) * rr;
        const by = p1.y + (v2y / l2) * rr;
        d += ` L ${ax} ${ay} Q ${p1.x} ${p1.y} ${bx} ${by}`;
      }
      const last = pts[pts.length - 1];
      d += ` L ${last.x} ${last.y}`;
      return d;
    }

    wirePoints(w) {
      const p1 = this.pinPos(w.a);
      const p2 = this.pinPos(w.b);
      return this.routePoints(p1, p2, this.pinDir(w.a), this.pinDir(w.b));
    }

    routePath(p1, p2, dir1 = 'h', dir2 = 'h') {
      return this.roundedPath(this.routePoints(p1, p2, dir1, dir2));
    }

    wireSvg(w) {
      const d = this.roundedPath(this.wirePoints(w));
      const sel = this.selection && this.selection.kind === 'wire' && this.selection.id === w.id;
      return `<g class="wire-group" data-wire="${w.id}">
        <path class="wire-hit" d="${d}"/>
        <path class="wire${sel ? ' selected' : ''}" d="${d}"/>
      </g>`;
    }

    /** 三线交汇处画接点圆点 */
    junctionSvg() {
      if (this.wires.length < 2) return '';
      const lines = this.wires.map((w) => ({ id: w.id, pts: this.wirePoints(w) }));
      const ends = [];
      lines.forEach((l) => {
        const first = l.pts[0];
        const last = l.pts[l.pts.length - 1];
        ends.push({ x: first.x, y: first.y, wire: l.id });
        ends.push({ x: last.x, y: last.y, wire: l.id });
      });

      const near = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 1.5;
      const onInterior = (pts, p) => {
        for (let i = 0; i < pts.length - 1; i += 1) {
          const a = pts[i];
          const b = pts[i + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len < 1) continue;
          const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (len * len);
          if (t <= 0.05 || t >= 0.95) continue;
          const px = a.x + dx * t;
          const py = a.y + dy * t;
          if (Math.hypot(px - p.x, py - p.y) < 1.2) return true;
        }
        return false;
      };

      const dots = [];
      ends.forEach((e) => {
        let deg = 0;
        ends.forEach((o) => { if (near(o, e)) deg += 1; });
        if (deg < 2) return;
        if (deg < 3 && !lines.some((l) => l.id !== e.wire && onInterior(l.pts, e))) return;
        if (!dots.some((d) => near(d, e))) dots.push({ x: e.x, y: e.y });
      });
      return dots.map((d) => `<circle class="junction" cx="${d.x}" cy="${d.y}" r="3.8"/>`).join('');
    }

    previewSvg() {
      if (!this.pending) return '';
      const p1 = this.pinPos(this.pending);
      const d1 = this.pinDir(this.pending);
      const d = this.routePath(p1, this.mouse, d1, d1 === 'v' ? 'h' : 'v');
      return `<path class="preview-wire" d="${d}"/>`;
    }

    render() {
      const parts = [];
      this.wires.forEach((w) => parts.push(this.wireSvg(w)));
      if (this.wires.length > 1) parts.push(this.junctionSvg());
      if (this.pending) parts.push(this.previewSvg());
      this.components.forEach((c) => parts.push(this.compSvg(c)));
      this.svg.innerHTML = parts.join('');
    }

    /* ---------------- 交互 ---------------- */
    _bind() {
      this.svg.addEventListener('pointerdown', (e) => this._onDown(e));
      this.svg.addEventListener('click', (e) => this._onClick(e));
      window.addEventListener('pointermove', (e) => this._onMove(e));
      window.addEventListener('pointerup', (e) => this._onUp(e));
      this.svg.addEventListener('wheel', (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 100 : 1);
        const factor = Math.min(2, Math.max(0.5, Math.exp(-e.deltaY * unit * 0.0016)));
        this.zoomAt(factor, e.clientX, e.clientY);
      }, { passive: false });
      this.svg.addEventListener('dblclick', (e) => {
        const compEl = e.target.closest('.comp');
        if (compEl) {
          const comp = this.findComp(compEl.dataset.comp);
          if (comp && (comp.type === 'AMP' || comp.type === 'OPAMP')) this.rotateSelected();
        }
      });
      document.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (this.selection) {
            e.preventDefault();
            this.removeSelected();
          }
        } else if (e.key === 'Escape') {
          this.pending = null;
          this.selection = null;
          this.render();
          this.emit('select', null);
        } else if (e.key === 'r' || e.key === 'R') {
          this.rotateSelected();
        }
      });
    }

    _onDown(e) {
      const middle = e.button === 1;
      if (e.button !== 0 && !middle) return;
      // 引脚点击交给 click 处理，避免 pointerdown 时重建 DOM
      if (!middle && e.target.closest('[data-pin]')) return;

      const compEl = e.target.closest('.comp');
      if (compEl && !middle) {
        const comp = this.findComp(compEl.dataset.comp);
        if (!comp) return;

        this._markSelection({ kind: 'comp', id: comp.id });
        const p = this.toSvg(e.clientX, e.clientY);
        this.drag = { id: comp.id, dx: comp.x - p.x, dy: comp.y - p.y, moved: false };
        try { this.svg.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
        this.emit('select', this.selection);
        return;
      }

      // 空白处（或中键）：平移画布
      if (!middle && e.target.closest('[data-wire]')) return;
      e.preventDefault();
      this.pan = { sx: e.clientX, sy: e.clientY, moved: false };
      this.svg.classList.add('panning');
      try { this.svg.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    }

    /** 只更新选中态与 DOM 高亮，不重建整棵树 */
    _markSelection(sel) {
      this.selection = sel;
      this.svg.querySelectorAll('.comp.selected').forEach((el) => el.classList.remove('selected'));
      if (sel && sel.kind === 'comp') {
        const el = this.svg.querySelector(`.comp[data-comp="${sel.id}"]`);
        if (el) el.classList.add('selected');
      }
    }

    _onClick(e) {
      if (this._suppressClick) {
        this._suppressClick = false;
        return;
      }
      const pinEl = e.target.closest('[data-pin]');
      if (pinEl) {
        const ref = { comp: pinEl.dataset.comp, pin: pinEl.dataset.pin };
        if (!this.pending) {
          this.pending = ref;
          this.mouse = this.toSvg(e.clientX, e.clientY);
          this.render();
        } else if (this.pending.comp === ref.comp && this.pending.pin === ref.pin) {
          this.pending = null;
          this.render();
        } else {
          const from = this.pending;
          this.pending = null;
          this.addWire(from, ref);
          this.render();
        }
        return;
      }

      const wireEl = e.target.closest('[data-wire]');
      if (wireEl) {
        this.selection = { kind: 'wire', id: wireEl.dataset.wire };
        this.render();
        this.emit('select', this.selection);
        return;
      }

      if (e.target.closest('.comp')) return;

      // 点击空白处：取消连线与选中
      if (this.pending || this.selection) {
        this.pending = null;
        this.selection = null;
        this.render();
        this.emit('select', null);
      }
    }

    _onMove(e) {
      if (this.pan) {
        const dx = e.clientX - this.pan.sx;
        const dy = e.clientY - this.pan.sy;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.pan.moved = true;
        if (this.pan.moved) this.panByPixels(dx, dy);
        this.pan.sx = e.clientX;
        this.pan.sy = e.clientY;
        return;
      }

      const p = this.toSvg(e.clientX, e.clientY);
      this.mouse = p;
      if (this.drag) {
        const comp = this.findComp(this.drag.id);
        if (comp) {
          const nx = snap(p.x + this.drag.dx);
          const ny = snap(p.y + this.drag.dy);
          if (nx !== comp.x || ny !== comp.y) {
            comp.x = nx;
            comp.y = ny;
            this.drag.moved = true;
            this.render();
          }
        }
      } else if (this.pending) {
        this.render();
      }
    }

    _onUp() {
      if (this.pan) {
        if (this.pan.moved) this._suppressClick = true;
        this.pan = null;
        this.svg.classList.remove('panning');
      }
      if (this.drag) {
        if (this.drag.moved) {
          this._suppressClick = true;
          this.emit('change');
        }
        this.drag = null;
      }
    }
  }

  global.CircuitEditor = CircuitEditor;
  global.ComponentSpec = SPEC;
  global.formatSI = formatSI;
})(window);
