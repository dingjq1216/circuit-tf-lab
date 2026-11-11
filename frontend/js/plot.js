/* =========================================================
   波形绘制：Canvas 折线图（带网格、坐标刻度、自适应量程）
   ========================================================= */
(function (global) {
  'use strict';

  const PAD = { left: 52, right: 14, top: 12, bottom: 26 };

  /** 生成「好看」的刻度间隔 */
  function niceStep(span, target = 4) {
    if (!isFinite(span) || span <= 0) return 1;
    const raw = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    let step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }

  function fmtTick(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    if (a >= 1e4 || a < 1e-3) return v.toExponential(1).replace('e', 'e');
    const digits = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
    return String(parseFloat(v.toFixed(digits)));
  }

  function draw(canvas, opts) {
    if (!canvas || !opts || !opts.t || opts.t.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 360;
    const cssH = parseInt(canvas.getAttribute('height'), 10) || 150;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = `${cssH}px`;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const W = cssW - PAD.left - PAD.right;
    const H = cssH - PAD.top - PAD.bottom;
    if (W <= 10 || H <= 10) return;

    const t = opts.t;
    const y = opts.y;
    const t0 = t[0];
    const t1 = t[t.length - 1];
    let ymin = Infinity;
    let ymax = -Infinity;
    for (let i = 0; i < y.length; i += 1) {
      if (y[i] < ymin) ymin = y[i];
      if (y[i] > ymax) ymax = y[i];
    }
    if (!isFinite(ymin) || !isFinite(ymax)) { ymin = -1; ymax = 1; }
    if (ymax - ymin < 1e-12) { ymin -= 1; ymax += 1; }
    const padY = (ymax - ymin) * 0.12;
    ymin -= padY;
    ymax += padY;

    const X = (v) => PAD.left + ((v - t0) / (t1 - t0 || 1)) * W;
    const Y = (v) => PAD.top + H - ((v - ymin) / (ymax - ymin || 1)) * H;

    // 网格
    ctx.strokeStyle = '#e8eef7';
    ctx.lineWidth = 1;
    const yStep = niceStep(ymax - ymin, 4);
    ctx.font = '10px Consolas, monospace';
    ctx.fillStyle = '#8797ad';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yStart = Math.ceil(ymin / yStep) * yStep;
    for (let v = yStart; v <= ymax + 1e-9; v += yStep) {
      const py = Math.round(Y(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(PAD.left + W, py);
      ctx.stroke();
      ctx.fillText(fmtTick(v), PAD.left - 8, py);
    }

    // x 轴刻度
    const tStep = niceStep(t1 - t0, 4);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const tStart = Math.ceil(t0 / tStep) * tStep;
    for (let v = tStart; v <= t1 + 1e-12; v += tStep) {
      const px = X(v);
      ctx.beginPath();
      ctx.moveTo(Math.round(px) + 0.5, PAD.top);
      ctx.lineTo(Math.round(px) + 0.5, PAD.top + H);
      ctx.strokeStyle = '#f0f4fa';
      ctx.stroke();
      ctx.fillStyle = '#8797ad';
      ctx.fillText(fmtTick(v), px, PAD.top + H + 6);
    }

    // 坐标轴
    ctx.strokeStyle = '#c6d3e4';
    ctx.beginPath();
    ctx.moveTo(PAD.left, PAD.top);
    ctx.lineTo(PAD.left, PAD.top + H);
    ctx.lineTo(PAD.left + W, PAD.top + H);
    ctx.stroke();

    // 零线
    if (ymin < 0 && ymax > 0) {
      ctx.strokeStyle = '#b9c6d8';
      ctx.setLineDash([4, 3]);
      const py = Math.round(Y(0)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.left, py);
      ctx.lineTo(PAD.left + W, py);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 曲线
    const color = opts.color || '#2563eb';
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + H);
    grad.addColorStop(0, `${color}22`);
    grad.addColorStop(1, `${color}00`);

    ctx.beginPath();
    ctx.moveTo(X(t[0]), Y(y[0]));
    for (let i = 1; i < t.length; i += 1) ctx.lineTo(X(t[i]), Y(y[i]));
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = color;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 填充
    ctx.lineTo(X(t[t.length - 1]), PAD.top + H);
    ctx.lineTo(X(t[0]), PAD.top + H);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // 轴标签
    ctx.fillStyle = '#8797ad';
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('t / s', PAD.left + W - 26, PAD.top + H + 7);
  }

  global.Chart = { draw };
})(window);
