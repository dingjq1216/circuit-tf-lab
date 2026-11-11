/* =========================================================
   轻量 LaTeX 渲染器（离线可用）
   支持本项目用到的子集：分式、上下标、希腊字母、常用符号、
   定界符、文本块、换行。
   ========================================================= */
(function (global) {
  'use strict';

  const SYMBOLS = {
    times: '×', cdot: '·', div: '÷',
    Omega: 'Ω', mu: 'μ', omega: 'ω', tau: 'τ', zeta: 'ζ', alpha: 'α',
    beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', theta: 'θ', pi: 'π',
    sigma: 'σ', phi: 'φ', lambda: 'λ',
    int: '∫', oint: '∮', sum: '∑',
    to: '→', rightarrow: '→', longrightarrow: '⟶', Rightarrow: '⇒',
    leftarrow: '←', Leftrightarrow: '⇔', approx: '≈', equiv: '≡',
    infty: '∞', pm: '±', mp: '∓', neq: '≠', leq: '≤', geq: '≥',
    ll: '≪', gg: '≫', propto: '∝', partial: '∂', nabla: '∇',
    quad: '\u2003', qquad: '\u2003\u2003', ',': '\u2009', ';': '\u2009',
    ':': '\u2005', '!': '', ' ': ' ', '%': '%', '&': '',
    langle: '⟨', rangle: '⟩', circ: '∘', prime: '′',
  };

  const OPS = new Set(['+', '−', '=', '≈', '⇒', '→', '≡', '≠', '≤', '≥', '±', '∓']);
  const FUNCS = new Set(['sin', 'cos', 'tan', 'ln', 'log', 'exp', 'lim', 'max', 'min', 'arg']);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /** 单个字符转 HTML：数字与标点用正体，字母保持斜体 */
  function charSpan(ch) {
    if (ch === '-') return '<span class="op">−</span>';
    if (ch === '*') return '<span class="op">×</span>';
    if (ch === ' ') return ' ';
    if (/[0-9.,]/.test(ch)) return `<span class="mn">${escapeHtml(ch)}</span>`;
    if (/[=+\-<>]/.test(ch)) return `<span class="op">${escapeHtml(ch)}</span>`;
    return escapeHtml(ch);
  }

  function parse(src, i, stop) {
    let html = '';
    while (i < src.length) {
      const ch = src[i];
      if (stop && ch === stop) return { html, i: i + 1 };

      // 换行 \\ 或 \\[6pt]
      if (ch === '\\' && src[i + 1] === '\\') {
        i += 2;
        if (src[i] === '[') {
          const close = src.indexOf(']', i);
          if (close > -1) i = close + 1;
        }
        html += '<br>';
        continue;
      }

      if (ch === '\\') {
        const m = /^\\([a-zA-Z]+|[\s\S])/.exec(src.slice(i));
        const name = m ? m[1] : '';
        i += m ? m[0].length : 1;

        if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
          const a = readGroup(src, i); i = a.i;
          const b = readGroup(src, i); i = b.i;
          html += `<span class="frac"><span class="fnum">${a.html}</span>`
                + `<span class="fden">${b.html}</span></span>`;
        } else if (name === 'text' || name === 'mathrm' || name === 'operatorname') {
          const g = readRawGroup(src, i); i = g.i;
          html += `<span class="txt">${escapeHtml(g.text)}</span>`;
        } else if (name === 'mathcal') {
          const g = readRawGroup(src, i); i = g.i;
          html += `<span class="cal">${escapeHtml(g.text)}</span>`;
        } else if (name === 'left' || name === 'right') {
          let d = src[i];
          if (d === '\\') { d = src[i + 1]; i += 2; } else { i += 1; }
          if (d === '.') continue;
          html += `<span class="delim">${escapeHtml(d)}</span>`;
        } else if (name === 'begin' || name === 'end') {
          const g = readRawGroup(src, i); i = g.i;
        } else if (FUNCS.has(name)) {
          html += `<span class="fn">${name}</span>`;
        } else if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
          const sym = SYMBOLS[name];
          html += OPS.has(sym)
            ? `<span class="op">${sym}</span>`
            : `<span class="sym">${sym}</span>`;
        } else {
          html += `<span class="txt">${escapeHtml(name)}</span>`;
        }
        continue;
      }

      if (ch === '^' || ch === '_') {
        i += 1;
        const g = readGroup(src, i);
        i = g.i;
        html += ch === '^' ? `<sup>${g.html}</sup>` : `<sub>${g.html}</sub>`;
        continue;
      }

      if (ch === '{') {
        const g = parse(src, i + 1, '}');
        html += g.html;
        i = g.i;
        continue;
      }

      if (ch === '}') { i += 1; continue; }
      html += charSpan(ch);
      i += 1;
    }
    return { html, i };
  }

  /** 读取一个参数组：{...} 或单个字符 */
  function readGroup(src, i) {
    while (src[i] === ' ') i += 1;
    if (i >= src.length) return { html: '', i };
    if (src[i] === '{') return parse(src, i + 1, '}');
    if (src[i] === '\\') {
      const m = /^\\([a-zA-Z]+|[\s\S])/.exec(src.slice(i));
      if (m) {
        const name = m[1];
        const sym = SYMBOLS[name];
        return { html: sym ? `<span class="sym">${sym}</span>` : escapeHtml(name), i: i + m[0].length };
      }
    }
    const ch = src[i];
    return { html: charSpan(ch), i: i + 1 };
  }

  /** 读取原样文本组（用于 \text{} \mathrm{}） */
  function readRawGroup(src, i) {
    while (src[i] === ' ') i += 1;
    if (src[i] !== '{') {
      return { text: src[i] || '', i: i + 1 };
    }
    let depth = 0;
    let start = i + 1;
    for (let j = i; j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}') {
        depth -= 1;
        if (depth === 0) return { text: src.slice(start, j), i: j + 1 };
      }
    }
    return { text: src.slice(start), i: src.length };
  }

  /** 渲染 LaTeX 字符串为 HTML */
  function render(tex) {
    if (!tex) return '';
    const body = parse(String(tex), 0, null).html;
    return `<span class="math">${body}</span>`;
  }

  /** 渲染为块级公式（支持 \\ 换行） */
  function renderBlock(tex) {
    return `<div class="math-display">${render(tex)}</div>`;
  }

  global.LaTeX = { render, renderBlock };
})(window);
