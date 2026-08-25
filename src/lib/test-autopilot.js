/** Autopilot decisions: whether a page is filled, and how it may be left. */

/**
 * Resolve what to do with a page from every captured frame's read-only
 * pagination discovery (scraper.js __smeshNextDiscovery). Pure, so the decision
 * is testable without a browser; the worker keeps only the injection plumbing.
 *
 *  'next'      — exactly one frame offers exactly one safely-activatable
 *                control; `documentId` names the frame to inject the click into
 *  'blocked'   — a real forward control exists that we refuse to activate,
 *                because its activation has no provable non-submission contract
 *  'finish'    — only submit/finish controls remain; the test is over
 *  'ambiguous' — several forward candidates; we will not guess between them
 *  'none'      — nothing forward-looking on the page at all
 *
 * @returns {{outcome: string, documentId: string|null}}
 */
export function resolvePaginationTarget(discovery) {
  const results = Array.isArray(discovery) ? discovery : [];
  const exact = results.filter((entry) => entry?.result?.enabledCount === 1);
  // A frame that also reports a question signature is the test player itself;
  // prefer it over a chrome frame that happens to expose one forward control.
  const withSignature = exact.filter((entry) => !!entry.result?.signature);
  const eligible = withSignature.length ? withSignature : exact;
  if (eligible.length === 1) return { outcome: 'next', documentId: eligible[0].documentId };

  const total = (field) =>
    results.reduce((sum, entry) => sum + (Number(entry?.result?.[field]) || 0), 0);
  // A forward control we refuse to press outranks a finish control: the page can
  // still advance, so answering 'finish' here would tell the student the test is
  // over when the autopilot merely declined to press «Далее».
  if (total('blockedCount')) return { outcome: 'blocked', documentId: null };
  if (!total('candidateCount') && total('finishCount')) return { outcome: 'finish', documentId: null };
  const forward = total('enabledCount') || total('candidateCount');
  return { outcome: forward ? 'ambiguous' : 'none', documentId: null };
}

/** Decide whether a test page is safe to leave after autofill. */
export function classifyAutopilotFill(questions, summary) {
  if (!Array.isArray(questions) || questions.length === 0) return 'unrecognized';

  const idFor = (question, index) =>
    question && question.index != null && String(question.index).trim() !== ''
      ? String(question.index).trim()
      : String(index + 1);
  const expected = new Set(questions.map(idFor));
  if (!Array.isArray(summary?.filled) || !Array.isArray(summary?.skipped)) return 'partial';
  const filledIds = summary.filled.map((id) => String(id).trim());
  const filled = new Set(filledIds);

  // Prove every MODEL answer was filled exactly once. This is not sufficient
  // by itself: a truncated model response can omit a visible page question, so
  // page-side coverage below is an independent mandatory witness.
  if (expected.size !== questions.length || summary.skipped.length ||
      filled.size !== expected.size || filledIds.length !== expected.size) return 'partial';
  for (const id of expected) if (!filled.has(id)) return 'partial';

  const coverage = summary.coverage;
  const units = coverage?.units;
  if (coverage?.exact !== true || !Array.isArray(units) || units.length === 0) return 'partial';

  // DOM-controlled values cannot weaken a destructive pagination decision
  // through malformed or duplicate unit records.
  const unitKeys = new Set();
  for (const unit of units) {
    if (!unit || typeof unit !== 'object' ||
        typeof unit.documentId !== 'string' || !unit.documentId ||
        !['native', 'interactive', 'mathquill'].includes(unit.source) ||
        typeof unit.type !== 'string' || !unit.type ||
        !Number.isInteger(unit.ordinal) || unit.ordinal < 0 ||
        !(unit.id == null || (typeof unit.id === 'string' && /^\d{1,3}$/.test(unit.id)))) {
      return 'partial';
    }
    const key = `${unit.documentId}\u0000${unit.source}\u0000${unit.ordinal}`;
    if (unitKeys.has(key)) return 'partial';
    unitKeys.add(key);
  }

  const numbered = units.filter((unit) => unit.id != null);
  if (numbered.length === units.length) {
    // Unique numbered units remain provable across frames. A duplicate page id
    // cannot be certified by the service worker's single filled-id union.
    const pageIds = new Set(numbered.map((unit) => unit.id));
    if (pageIds.size !== numbered.length || pageIds.size !== expected.size) return 'partial';
    for (const id of pageIds) if (!expected.has(id)) return 'partial';
    return 'complete';
  }

  // Mixed numbered/positional ownership is ambiguous. Purely unnumbered pages
  // are safe only when one captured document and one fill mechanism own the
  // complete ordered list; independent frame/pass position 1s must not prove
  // one another filled.
  if (numbered.length !== 0 || units.length !== questions.length) return 'partial';
  const documents = new Set(units.map((unit) => unit.documentId));
  const sources = new Set(units.map((unit) => unit.source));
  if (documents.size !== 1 || sources.size !== 1) return 'partial';
  const ordinals = units.map((unit) => unit.ordinal).sort((a, b) => a - b);
  if (ordinals.some((ordinal, index) => ordinal !== index)) return 'partial';
  return 'complete';
}
