/**
 * Minimal LaTeX -> HTML renderer (no external libs) for the math subset that
 * AI answers actually use: \frac, \sqrt, ^/_ scripts, \text, common symbols
 * and Greek letters. Produces styled spans; see the `.math` rules in
 * dashboard.css. Unknown commands degrade to their plain name, never crash.
 */

const SYMBOLS = {
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', sim: '∼', equiv: '≡', propto: '∝', infty: '∞',
  to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←', leftrightarrow: '↔',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε',
  varepsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ',
  sigma: 'σ', Sigma: 'Σ', phi: 'φ', varphi: 'φ', omega: 'ω', Omega: 'Ω',
  circ: '°', degree: '°', bullet: '•', ast: '∗',
  ldots: '…', dots: '…', cdots: '⋯',
  angle: '∠', triangle: '△', parallel: '∥', perp: '⊥',
  sum: 'Σ', prod: '∏', int: '∫',
  in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩', emptyset: '∅',
  forall: '∀', exists: '∃', neg: '¬',
  quad: ' ', qquad: '  '
};

// Function names rendered upright: sin x, log_2 n, ...
const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'tg', 'ctg', 'cot', 'sec', 'csc',
  'log', 'ln', 'lg', 'exp', 'lim', 'min', 'max', 'mod', 'gcd',
  'arcsin', 'arccos', 'arctan', 'arctg', 'arcctg'
]);

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function texToHtml(tex) {
  const s = String(tex);
  let i = 0;

  /** Read a balanced {...} group; `i` is on the opening brace. */
  function readGroup() {
    i++; // skip {
    let depth = 1;
    const start = i;
    while (i < s.length && depth > 0) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') depth--;
      if (depth > 0) i++;
    }
    const content = s.slice(start, i);
    i++; // skip }
    return content;
  }

  /** Read one argument: a {group}, a \command, or a single character. */
  function readArg() {
    while (s[i] === ' ') i++;
    if (s[i] === '{') return readGroup();
    if (s[i] === '\\') {
      let j = i + 1;
      while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      const cmd = s.slice(i, j === i + 1 ? j + 1 : j); // symbol or named command
      i += cmd.length;
      return cmd;
    }
    return s[i++] || '';
  }

  let out = '';
  while (i < s.length) {
    const c = s[i];

    if (c === '\\') {
      i++;
      let j = i;
      while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      const name = s.slice(i, j);

      if (!name) {
        // Escaped single char: \{ \} \$ \% \, \\ ...
        const sym = s[i] || '';
        i++;
        if (sym === '\\') out += '<br>';
        else if (sym === ',' || sym === ';' || sym === ':') out += ' ';
        else out += esc(sym);
        continue;
      }
      i = j;

      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const num = readArg(), den = readArg();
        out += `<span class="frac"><span class="num">${texToHtml(num)}</span><span class="den">${texToHtml(den)}</span></span>`;
      } else if (name === 'sqrt') {
        while (s[i] === ' ') i++;
        let index = '';
        if (s[i] === '[') {
          const end = s.indexOf(']', i);
          if (end !== -1) { index = s.slice(i + 1, end); i = end + 1; }
        }
        const arg = readArg();
        out += (index ? `<sup>${texToHtml(index)}</sup>` : '') +
          `<span class="sqrt">√<span class="sqrt-arg">${texToHtml(arg)}</span></span>`;
      } else if (name === 'text' || name === 'textrm' || name === 'mathrm' || name === 'mbox' || name === 'operatorname') {
        out += `<span class="up">${esc(readArg())}</span>`;
      } else if (FUNCTIONS.has(name)) {
        out += `<span class="up">${name}</span>`;
      } else if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
        out += SYMBOLS[name];
      } else if (name === 'left' || name === 'right' || name === 'displaystyle' || name === 'limits' || name === 'big' || name === 'Big') {
        if (s[i] === '.') i++; // \left. / \right. -> nothing
      } else {
        out += esc(name); // unknown command: degrade to its name
      }
    } else if (c === '^' || c === '_') {
      i++;
      const inner = texToHtml(readArg());
      if (c === '^' && inner === '°') out += '°'; // 30^\circ — ° is already raised
      else out += c === '^' ? `<sup>${inner}</sup>` : `<sub>${inner}</sub>`;
    } else if (c === '{') {
      out += texToHtml(readGroup());
    } else if (c === '}') {
      i++; // stray brace
    } else if (c === '-') {
      out += '−'; // proper minus sign
      i++;
    } else if (c === '~') {
      out += ' ';
      i++;
    } else if (/[a-zA-Z]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z]/.test(s[j])) j++;
      out += `<i>${esc(s.slice(i, j))}</i>`; // latin letters = variables, italic
      i = j;
    } else {
      out += esc(c);
      i++;
    }
  }
  return out;
}

/**
 * Replace $...$, $$...$$, \(...\), \[...\] in markdown source with
 * placeholders, returning rendered math chunks to splice back in AFTER
 * markdown processing (so *, _ inside formulas survive).
 */
export function extractMath(md) {
  const chunks = [];
  const put = (tex, display) => {
    const cls = display ? 'math display' : 'math';
    chunks.push(`<span class="${cls}">${texToHtml(tex.trim())}</span>`);
    return `\uE000${chunks.length - 1}\uE001`;
  };
  const text = md
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => put(t, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => put(t, true))
    .replace(/\\\((.+?)\\\)/g, (_, t) => put(t, false))
    .replace(/\$([^$\n]+?)\$/g, (_, t) => put(t, false));
  return { text, chunks };
}

export function restoreMath(html, chunks) {
  return html.replace(/\uE000(\d+)\uE001/g, (_, n) => chunks[+n] || '');
}
