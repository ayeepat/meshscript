/**
 * Minimal, dependency-free markdown → HTML renderer shared by the dashboard
 * chat and the Settings history view, so a saved answer renders identically in
 * both surfaces (bold / italic / lists / headings + LaTeX via tex.js) instead
 * of leaking raw markdown and LaTeX source at the reader. Escapes first, so
 * model output is never injected as live HTML.
 *
 * Callers that render the output must load ../common/math.css for the LaTeX
 * spans (.math/.frac/.sqrt) to display as real fractions/roots.
 */
import { createPlaceholderCodec, extractMath, restoreMath } from './tex.js';

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMd(s) {
  // Code spans are already parked by mdToHtml, so a `*` inside one cannot be
  // read as emphasis here. ***…*** runs before **…** — the greedy-star passes
  // would otherwise split it as <strong><em>…</strong></em>, mis-nested HTML.
  return s
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

export function mdToHtml(md) {
  const source = String(md ?? '');
  // Park inline code BEFORE the math scanner runs. Extracting math first meant
  // the scanner saw the `$` inside a code span: ``$x$`` rendered as a math
  // <span> nested inside <code>, contradicting the verbatim promise. Code is
  // the outermost verbatim construct, so it has to be parked first.
  const codes = [];
  const codePlaceholders = createPlaceholderCodec(source, 'CODE');
  const parked = source.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(code);
    return codePlaceholders.token(codes.length - 1);
  });
  // Then pull LaTeX out so markdown processing can't mangle *, _ inside it.
  const math = extractMath(parked);
  const lines = escapeHtml(math.text).split(/\r?\n/);
  let html = '';
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    // Preserve the model's heading LEVEL (1-6) instead of flattening every
    // heading to <h4>: screen readers and document structure rely on it. The
    // chat surfaces keep the rendering compact via their .msg/.md CSS.
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      html += `<h${level}>${inlineMd(h[2])}</h${level}>`;
      continue;
    }
    const ul = line.match(/^[*\-•]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inlineMd(ul[1])}</li>`; continue;
    }
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inlineMd(ol[1])}</li>`; continue;
    }
    closeList();
    html += `<p>${inlineMd(line)}</p>`;
  }
  closeList();
  // Code content was parked before escaping, so escape it now — it must reach
  // the DOM as literal text, never as live markup.
  return codePlaceholders.restore(
    restoreMath(html, math),
    codes.map((code) => `<code>${escapeHtml(code)}</code>`)
  );
}
