/* =========================================================
   主应用：元件库、属性面板、求解与结果展示、信号仿真
   ========================================================= */
(function () {
  'use strict';

  const svg = document.getElementById('board');
  const inspector = document.getElementById('inspector');
  const statusbar = document.getElementById('statusbar');
  const statusText = document.getElementById('statusText');
  const emptyHint = document.getElementById('boardEmpty');

  const editor = new CircuitEditor(svg, {});
  const state = {
    result: null,
    sim: null,
    tab: 'tf',
    solving: false,
    solveToken: 0,
    solveTimer: null,
    signal: 'step',
  };

  /* ---------------- 元件库 ---------------- */
  const STROKE = 'stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    SRC: `<svg viewBox="0 0 92 40"><line x1="46" y1="3" x2="46" y2="11" ${STROKE}/><circle cx="46" cy="16" r="4.5" ${STROKE}/><circle cx="46" cy="27" r="4.5" ${STROKE}/><line x1="46" y1="32" x2="46" y2="37" ${STROKE}/><text x="58" y="24" font-size="11" fill="currentColor">u</text><text x="34" y="14" font-size="10" fill="currentColor">+</text></svg>`,
    R: `<svg viewBox="0 0 92 40"><line x1="14" y1="20" x2="31" y2="20" ${STROKE}/><rect x="31" y="13" width="30" height="14" rx="2" ${STROKE}/><line x1="61" y1="20" x2="78" y2="20" ${STROKE}/></svg>`,
    C: `<svg viewBox="0 0 92 40"><line x1="14" y1="20" x2="42" y2="20" ${STROKE}/><line x1="50" y1="20" x2="78" y2="20" ${STROKE}/><line x1="42" y1="8" x2="42" y2="32" ${STROKE}/><line x1="50" y1="8" x2="50" y2="32" ${STROKE}/></svg>`,
    L: `<svg viewBox="0 0 92 40"><line x1="14" y1="22" x2="30" y2="22" ${STROKE}/><path d="M30 22 A 5 5 0 0 0 40 22 A 5 5 0 0 0 50 22 A 5 5 0 0 0 60 22" ${STROKE}/><line x1="60" y1="22" x2="78" y2="22" ${STROKE}/></svg>`,
    AMP: `<svg viewBox="0 0 92 40"><polygon points="32,8 32,32 62,20" ${STROKE}/><line x1="14" y1="20" x2="32" y2="20" ${STROKE}/><line x1="62" y1="20" x2="78" y2="20" ${STROKE}/><line x1="46" y1="25" x2="46" y2="35" ${STROKE}/></svg>`,
    OPAMP: `<svg viewBox="0 0 92 40"><polygon points="34,5 34,35 64,20" ${STROKE}/><line x1="14" y1="12" x2="34" y2="12" ${STROKE}/><line x1="14" y1="28" x2="34" y2="28" ${STROKE}/><line x1="64" y1="20" x2="78" y2="20" ${STROKE}/><text x="37" y="16" font-size="9" fill="currentColor">+</text><text x="37" y="32" font-size="9" fill="currentColor">−</text></svg>`,
    OUT: `<svg viewBox="0 0 92 40"><line x1="46" y1="4" x2="46" y2="13" ${STROKE}/><circle cx="46" cy="20" r="7" ${STROKE}/><line x1="46" y1="27" x2="46" y2="36" ${STROKE}/><text x="58" y="24" font-size="11" fill="currentColor">u</text><text x="34" y="10" font-size="10" fill="currentColor">+</text><text x="34" y="38" font-size="10" fill="currentColor">-</text></svg>`,
    GND: `<svg viewBox="0 0 92 40"><line x1="46" y1="8" x2="46" y2="18" ${STROKE}/><line x1="31" y1="18" x2="61" y2="18" ${STROKE}/><line x1="36" y1="23" x2="56" y2="23" ${STROKE}/><line x1="41" y1="28" x2="51" y2="28" ${STROKE}/></svg>`,
  };
  const PALETTE = [
    ['SRC', '输入端口'], ['OUT', '输出端口'], ['R', '电阻'],
    ['C', '电容'], ['L', '电感'], ['AMP', '放大器'], ['OPAMP', '理想运放'], ['GND', '接地'],
  ];

  function buildPalette() {
    const box = document.getElementById('palette');
    box.innerHTML = PALETTE.map(([type, name]) => `
      <div class="pal-item" draggable="true" data-type="${type}" title="点击添加 ${name}">
        ${ICONS[type]}<span>${name}</span>
      </div>`).join('');

    box.querySelectorAll('.pal-item').forEach((item) => {
      item.addEventListener('click', () => {
        const vb = svg.viewBox.baseVal;
        const jitter = (Math.random() - 0.5) * 120;
        editor.addComponent(item.dataset.type, vb.x + vb.width / 2 + jitter, vb.y + vb.height / 2 + jitter);
        scheduleSolve(500);
      });
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', item.dataset.type);
        e.dataTransfer.effectAllowed = 'copy';
      });
    });

    const shell = document.getElementById('boardShell');
    shell.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    shell.addEventListener('drop', (e) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('text/plain');
      if (!type) return;
      const p = editor.toSvg(e.clientX, e.clientY);
      editor.addComponent(type, p.x, p.y);
      scheduleSolve(500);
    });
  }

  /* ---------------- 属性面板 ---------------- */
  const UNITS = {
    R: [['Ω', 1], ['kΩ', 1e3], ['MΩ', 1e6]],
    C: [['pF', 1e-12], ['nF', 1e-9], ['μF', 1e-6], ['mF', 1e-3], ['F', 1]],
    L: [['μH', 1e-6], ['mH', 1e-3], ['H', 1]],
  };
  const PARAM_LABEL = { R: '阻值 R', C: '容值 C', L: '感值 L' };
  const TYPE_NAME = {
    R: '电阻', C: '电容', L: '电感', SRC: '输入端口（电压源 u_i）',
    AMP: '放大器', OPAMP: '理想运放', OUT: '输出端口（测量 u_o）', GND: '接地',
  };

  function pickUnit(type, value) {
    const list = UNITS[type] || [];
    for (const [label, factor] of list) {
      const v = value / factor;
      if (v >= 0.999 && v < 1000) return [label, factor];
    }
    return list[list.length - 1] || ['', 1];
  }

  function renderInspector(sel) {
    if (!sel || sel.kind !== 'comp') {
      inspector.innerHTML = '<div class="empty">未选中元件<br><small>单击元件选中，双击可直接改参数</small></div>';
      return;
    }
    const comp = editor.findComp(sel.id);
    if (!comp) return;
    const typeName = TYPE_NAME[comp.type] || comp.type;
    let body = '';

    if (UNITS[comp.type]) {
      const [unitLabel, factor] = pickUnit(comp.type, comp.value);
      const shown = parseFloat((comp.value / factor).toPrecision(4));
      body = `
        <div class="field">
          <span>${PARAM_LABEL[comp.type]}</span>
          <div class="inline">
            <input type="number" id="inspValue" step="any" min="0" value="${shown}">
            <select id="inspUnit">
              ${UNITS[comp.type].map(([l]) => `<option value="${l}"${l === unitLabel ? ' selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="param-hint">数值会换算为国际单位后参与计算（当前 ${formatSI(comp.value, '')}）。</div>`;
    } else if (comp.type === 'AMP') {
      body = `
        <div class="field">
          <span>电压放大倍数 K</span>
          <input type="number" id="inspGain" step="any" value="${comp.gain}">
        </div>
        <div class="param-hint">理想电压控制电压源：u_o = K · u_i，输入阻抗无穷大、输出阻抗为零。</div>`;
    } else if (comp.type === 'OPAMP') {
      body = '<div class="param-hint">理想运放（虚短）：V+ = V−，输入端不取电流，输出电流由外部电路决定。可用于搭接反相/同相放大、积分、微分、PID 调节等电路；未接线的输入端请接到参考节点。</div>';
    } else if (comp.type === 'SRC') {
      body = '<div class="param-hint">输入端口（理想电压源 u_i = V上 − V下）。两个端子都可接线，构成浮地二端口输入；下端子悬空时自动接参考节点。波形、幅值、频率由「波形仿真」面板的信号发生器设置。</div>';
    } else if (comp.type === 'OUT') {
      body = '<div class="param-hint">输出端口（二端口输出），u_o 取 + 端对 − 端的电压：接成上正下负即可测量输出端电压；− 端悬空时自动接到参考节点。</div>';
    } else if (comp.type === 'GND') {
      body = '<div class="param-hint">参考地（0 V）。所有接地符号在电气上等电位。</div>';
    }

    inspector.innerHTML = `
      <div class="insp-title">
        <span class="badge">${comp.name}</span>
        <span class="kind">${typeName}</span>
      </div>
      ${body}
      <div class="insp-actions">
        <button class="btn btn-ghost" id="btnRotate">旋转 90°</button>
        <button class="btn btn-danger" id="btnDelete">删除</button>
      </div>`;

    const valInput = inspector.querySelector('#inspValue');
    const unitSel = inspector.querySelector('#inspUnit');
    if (valInput && unitSel) {
      const apply = () => {
        const v = parseFloat(valInput.value);
        const f = parseFloat(unitSel.value);
        if (!isFinite(v) || v <= 0) return;
        comp.value = v * f;
        editor.render();
        scheduleSolve();
      };
      valInput.addEventListener('input', apply);
      unitSel.addEventListener('change', () => {
        const [label] = pickUnit(comp.type, comp.value);
        const factor = parseFloat(unitSel.value);
        valInput.value = parseFloat((comp.value / factor).toPrecision(4));
        void label;
        apply();
      });
    }
    const gainInput = inspector.querySelector('#inspGain');
    if (gainInput) {
      gainInput.addEventListener('input', () => {
        const v = parseFloat(gainInput.value);
        if (!isFinite(v)) return;
        comp.gain = v;
        editor.render();
        scheduleSolve();
      });
    }
    const btnRotate = inspector.querySelector('#btnRotate');
    if (btnRotate) btnRotate.addEventListener('click', () => editor.rotateSelected());
    const btnDelete = inspector.querySelector('#btnDelete');
    if (btnDelete) btnDelete.addEventListener('click', () => {
      editor.removeSelected();
      scheduleSolve(0);
    });
  }

  /* ---------------- 状态与提示 ---------------- */
  function setStatus(kind, text) {
    statusbar.className = `statusbar ${kind || ''}`;
    statusText.textContent = text;
  }

  let toastTimer = null;
  function toast(msg, kind = '') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  /* ---------------- 求解 ---------------- */
  function scheduleSolve(delay = 500) {
    if (!document.getElementById('autoSolve').checked) return;
    clearTimeout(state.solveTimer);
    state.solveTimer = setTimeout(solve, delay);
  }

  async function solve() {
    const circuit = editor.getCircuit();
    emptyHint.classList.toggle('hide', circuit.components.length > 0);

    if (!circuit.components.length) {
      state.result = null;
      setStatus('', '等待搭建电路');
      renderEmptyTF();
      return;
    }

    const token = ++state.solveToken;
    state.solving = true;
    setStatus('warn', '正在求解传递函数…');

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(circuit),
      });
      const data = await res.json();
      if (token !== state.solveToken) return;

      if (!data.ok) {
        state.result = null;
        renderError(data.error || '求解失败');
        setStatus('error', data.error || '求解失败');
        return;
      }

      state.result = data;
      renderTF(data);
      renderSteps(document.getElementById('impContent'), data.steps.impedance, 'impedance');
      renderSteps(document.getElementById('eqContent'), data.steps.equations, 'equations');
      const order = data.tf.order;
      const warn = data.warnings.length ? `　⚠ ${data.warnings.length} 条提示` : '';
      setStatus('ok', `求解完成：H(s) 为 ${order} 阶有理函数，共 ${data.tf.poles.length} 个极点${warn}`);
      if (state.tab === 'sim' && state.sim) runSimulation();
    } catch (err) {
      if (token !== state.solveToken) return;
      setStatus('error', '无法连接后端服务，请确认服务已启动');
      renderError('无法连接后端服务，请确认服务已启动。');
    } finally {
      if (token === state.solveToken) state.solving = false;
    }
  }

  /* ---------------- 结果渲染 ---------------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function renderEmptyTF() {
    document.getElementById('tfContent').innerHTML = `
      <div class="placeholder"><p>尚未求解</p><small>搭好电路后点击「计算传递函数」</small></div>`;
    document.getElementById('impContent').innerHTML = '<div class="placeholder"><p>等待求解</p></div>';
    document.getElementById('eqContent').innerHTML = '<div class="placeholder"><p>等待求解</p></div>';
  }

  function renderError(msg) {
    const html = `<div class="warn-box error"><span class="ico">!</span><div>${esc(msg)}</div></div>`;
    document.getElementById('tfContent').innerHTML = html;
    document.getElementById('impContent').innerHTML = html;
    document.getElementById('eqContent').innerHTML = html;
  }

  function renderTF(data) {
    const tf = data.tf;
    const notes = (data.notes || []).map((n) => `
      <div class="note-box"><span class="ico">ⓘ</span><div>${esc(n)}</div></div>`).join('');
    const warns = (data.warnings || []).map((w) => `
      <div class="warn-box"><span class="ico">⚠</span><div>${esc(w)}</div></div>`).join('');

    const poleRows = tf.poles.length
      ? tf.poles.map((p, i) => `<div class="kv"><span class="k">极点 p${i + 1}</span><span class="v">s = ${esc(p)}</span></div>`).join('')
      : '<div class="kv"><span class="k">极点</span><span class="v">无</span></div>';
    const zeroRows = tf.zeros.length
      ? tf.zeros.map((z, i) => `<div class="kv"><span class="k">零点 z${i + 1}</span><span class="v">s = ${esc(z)}</span></div>`).join('')
      : '<div class="kv"><span class="k">零点</span><span class="v">无</span></div>';

    const dc = tf.dcGain == null
      ? '—（含积分环节）'
      : String(parseFloat(tf.dcGain.toPrecision(4)));

    const chips = [
      `<span class="chip">阶次 <b>${tf.order}</b></span>`,
      `<span class="chip ${data.stable ? 'ok' : 'warn'}">${data.stable ? '稳定' : '不稳定'}</span>`,
      `<span class="chip">直流增益 <b>${esc(dc)}</b></span>`,
      `<span class="chip">${
        tf.num.length > tf.den.length ? '非真系统' : (tf.num.length === tf.den.length ? '真分式（含直通项）' : '严格真分式')
      }</span>`,
    ].join('');

    const heroLabel = tf.symbolic ? '传递函数 · 符号形式（与元件取值无关）' : '传递函数';
    const heroFormula = tf.symbolic ? tf.symbolic.latex : tf.latex;

    const numericBlock = tf.symbolic
      ? `<div class="section-title">代入参数值后的数值形式（仿真使用）</div>
         <div class="math-display">${LaTeX.render('H(s) = ' + tf.latex)}</div>`
      : '';

    const netList = data.netlist.elements.map((e) => {
      const val = e.type === 'AMP' ? `K = ${e.gain}`
        : (e.value != null ? formatSI(e.value, { R: 'Ω', C: 'F', L: 'H' }[e.type] || '') : '—');
      return `<div class="kv"><span class="k">${esc(e.name)} · ${esc(e.typeName)}</span><span class="v">${esc(val)}</span></div>`;
    }).join('');

    document.getElementById('tfContent').innerHTML = `
      ${notes}
      ${warns}
      <div class="tf-hero">
        <div class="label">${esc(heroLabel)}</div>
        <div class="formula">${LaTeX.render(`H(s) = ${heroFormula}`)}</div>
        <div class="tf-meta">${chips}</div>
      </div>
      ${numericBlock}
      <div class="section-title">极点与零点</div>
      <div class="kv-list">${poleRows}${zeroRows}</div>
      <div class="section-title">元件网表</div>
      <div class="kv-list">${netList}</div>
    `;
  }

  function renderSteps(box, method, key) {
    if (!method) { box.innerHTML = ''; return; }
    const steps = method.steps.map((step, idx) => {
      const blocks = step.blocks.map((b) => {
        if (b.type === 'text') return `<p>${esc(b.text)}</p>`;
        if (b.type === 'latex_display') return LaTeX.renderBlock(b.latex);
        if (b.type === 'table') {
          const cols = b.latexColumns || [];
          const head = b.columns.map((c) => `<th>${esc(c)}</th>`).join('');
          const rows = b.rows.map((row) => `<tr>${row.map((cell, i) => (
            cols.includes(i)
              ? `<td class="formula">${LaTeX.render(cell)}</td>`
              : `<td>${esc(cell)}</td>`
          )).join('')}</tr>`).join('');
          return `<div class="table-wrap"><table class="mini"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
        }
        return '';
      }).join('');
      return `<div class="step">
        <div class="step-head"><span class="no">${idx + 1}</span><span>${esc(step.title)}</span></div>
        ${blocks}
      </div>`;
    }).join('');

    box.innerHTML = `
      <div class="section-title">${esc(method.title)} · ${esc(method.subtitle || '')}</div>
      ${steps}`;
    void key;
  }

  /* ---------------- 标签页 ---------------- */
  function bindTabs() {
    const tabs = document.getElementById('tabs');
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      switchTab(btn.dataset.tab);
    });
  }

  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
    if (name === 'sim') {
      if (state.sim) drawSim(state.sim);
      else if (state.result) runSimulation();
    }
  }

  /* ---------------- 仿真 ---------------- */
  function bindSignalPanel() {
    const types = document.getElementById('signalTypes');
    types.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-item');
      if (!btn) return;
      state.signal = btn.dataset.signal;
      types.querySelectorAll('.seg-item').forEach((b) => b.classList.toggle('active', b === btn));
      updateSignalFields();
      if (state.result) runSimulation();
    });

    document.getElementById('btnSim').addEventListener('click', () => runSimulation());
    ['sigAmp', 'sigFreq', 'sigDuty', 'sigEnd'].forEach((id) => {
      document.getElementById(id).addEventListener('change', () => {
        if (state.result) runSimulation();
      });
    });
    updateSignalFields();
  }

  function updateSignalFields() {
    const t = state.signal;
    document.getElementById('fieldFreq').style.display = (t === 'square' || t === 'sine') ? '' : 'none';
    document.getElementById('fieldDuty').style.display = (t === 'square') ? '' : 'none';
    const unit = { step: '(V)', square: '(V)', sine: '(V)', ramp: '(V/s)', accel: '(V/s²)' }[t];
    document.getElementById('ampUnit').textContent = unit;
  }

  function collectSignal() {
    const tEnd = parseFloat(document.getElementById('sigEnd').value) || 0;
    return {
      type: state.signal,
      amplitude: parseFloat(document.getElementById('sigAmp').value) || 1,
      frequency: parseFloat(document.getElementById('sigFreq').value) || 1,
      duty: parseFloat(document.getElementById('sigDuty').value) || 50,
      tEnd: tEnd > 0 ? tEnd : 5,
      autoTime: !(tEnd > 0),
    };
  }

  async function runSimulation() {
    if (!state.result) {
      toast('请先求解传递函数', 'error');
      return;
    }
    const btn = document.getElementById('btnSim');
    btn.disabled = true;
    try {
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tf: state.result.tf, signal: collectSignal() }),
      });
      const data = await res.json();
      if (!data.ok) {
        toast(data.error || '仿真失败', 'error');
        return;
      }
      state.sim = data;
      drawSim(data);
      renderMetrics(data.metrics);
    } catch (err) {
      toast('仿真请求失败，请确认后端服务运行中', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  function drawSim(data) {
    Chart.draw(document.getElementById('chartU'), {
      t: data.t, y: data.u, color: '#3b5bdb',
    });
    Chart.draw(document.getElementById('chartY'), {
      t: data.t, y: data.y, color: '#16a34a',
    });
  }

  function renderMetrics(m) {
    const box = document.getElementById('metrics');
    if (!m || !Object.keys(m).length) {
      box.innerHTML = '<div class="metric" style="grid-column:1/-1"><div class="mk">提示</div>'
        + '<div class="mv" style="font-size:12px">性能指标仅对阶跃响应给出</div></div>';
      return;
    }
    const items = [
      ['终值', m.steady != null ? parseFloat(m.steady.toPrecision(4)) : '—', ''],
      ['超调量', m.overshoot != null ? parseFloat(m.overshoot.toPrecision(3)) : '—', '%'],
      ['峰值时间', m.peakTime != null ? parseFloat((m.peakTime * 1000).toPrecision(3)) : '—', 'ms'],
      ['上升时间', m.riseTime != null ? parseFloat((m.riseTime * 1000).toPrecision(3)) : '—', 'ms'],
      ['调节时间 (±2%)', m.settleTime != null ? parseFloat((m.settleTime * 1000).toPrecision(3)) : '—', 'ms'],
      ['峰值', m.peak != null ? parseFloat(m.peak.toPrecision(4)) : '—', ''],
    ];
    box.innerHTML = items.map(([k, v, u]) => `
      <div class="metric"><div class="mk">${k}</div><div class="mv">${v}${u ? ` <small>${u}</small>` : ''}</div></div>`).join('');
  }

  /* ---------------- 初始化 ---------------- */
  function buildExamples() {
    const sel = document.getElementById('exampleSelect');
    Examples.forEach((ex) => {
      const opt = document.createElement('option');
      opt.value = ex.id;
      opt.textContent = ex.title;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      const ex = Examples.find((x) => x.id === sel.value);
      if (!ex) return;
      editor.setCircuit(ex);
      state.sim = null;
      scheduleSolve(0);
      toast(`已载入示例：${ex.title}`, 'ok');
      sel.value = '';
    });
  }

  function bindToolbar() {
    document.getElementById('btnSolve').addEventListener('click', () => solve());
    document.getElementById('btnClear').addEventListener('click', () => {
      editor.clear();
      state.result = null;
      state.sim = null;
      renderEmptyTF();
      setStatus('', '已清空画布');
      emptyHint.classList.remove('hide');
    });
    document.getElementById('btnFit').addEventListener('click', () => editor.fit());
    document.getElementById('btnZoomIn').addEventListener('click', () => editor.zoomBy(1.25));
    document.getElementById('btnZoomOut').addEventListener('click', () => editor.zoomBy(1 / 1.25));
    const zoomLevel = document.getElementById('zoomLevel');
    editor.on('view', (v) => { if (zoomLevel) zoomLevel.textContent = `${v.percent}%`; });
    document.getElementById('autoSolve').addEventListener('change', (e) => {
      if (e.target.checked && editor.components.length) solve();
    });
  }

  function init() {
    buildPalette();
    buildExamples();
    bindTabs();
    bindSignalPanel();
    bindToolbar();

    editor.on('select', (sel) => renderInspector(sel));
    // 双击元件：参数面板常驻，并直接聚焦输入框，方便马上改数值
    editor.on('activate', (sel) => {
      renderInspector(sel);
      const input = inspector.querySelector('input');
      if (input) {
        input.focus();
        input.select();
      }
    });
    editor.on('change', () => {
      emptyHint.classList.toggle('hide', !editor.isEmpty());
      scheduleSolve();
    });
    editor.resize();
    editor.render();
    renderEmptyTF();

    // 默认载入一个示例，便于直接体验
    const first = Examples[0];
    editor.setCircuit(first);
    document.getElementById('exampleSelect').value = '';
    setTimeout(() => solve(), 120);

    window.addEventListener('resize', () => {
      editor.resize();
      editor.render();
      if (state.sim) drawSim(state.sim);
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
