/**
 * Pure matching helpers shared by the service worker, settings and dashboard
 * (no chrome/network deps, so any context can import it).
 *
 *  - mapSubjectToId: a Mesh diary subject string → gdz-ru.com subject_id.
 *  - EXERCISE_SUBJECTS: the subjects worth pinning a book for (the picker list).
 *  - parseRefs: pull page/exercise numbers out of a homework task, split by
 *    textbook vs. workbook (Р.т.) context.
 */

// gdz-ru.com subject ids (from /full-book-list). Matched loosely because Mesh
// labels are messy and often truncated ("Иностранный (английский)…", "Вероятность
// и ст…"). Order matters: more specific stems first.
const SUBJECT_RULES = [
  [/алгебр/, 4],
  [/геометр/, 5],
  [/вероятн|статистик/, 1],   // "Вероятность и статистика" → Математика catalog
  [/матем/, 1],
  [/англ/, 2],
  [/немецк/, 8],
  [/французск/, 11],
  [/испанск/, 36],
  [/китайск/, 38],
  [/литератур/, 23],
  [/русск/, 3],
  [/информат/, 14],
  [/физик/, 6],               // "физическая культура" has no "к" after "физи" → won't match
  [/хими/, 7],
  [/биолог/, 12],
  [/географ/, 16],
  [/обществозн/, 24],
  [/истори/, 13],
  [/обж|безопасн/, 15]
];

/** Mesh subject label → catalog subject_id, or null when there's no useful
 *  GDZ subject (e.g. физкультура, ИЗО, музыка). */
export function mapSubjectToId(subject) {
  const s = (subject || '').toLowerCase().replace(/ё/g, 'е');
  for (const [re, id] of SUBJECT_RULES) if (re.test(s)) return id;
  return null;
}

// Curated picker list (id + display title). Covers the subjects that actually
// carry textbook/workbook exercises; skips no-exercise subjects.
export const EXERCISE_SUBJECTS = [
  { id: 4, title: 'Алгебра' },
  { id: 5, title: 'Геометрия' },
  { id: 1, title: 'Математика / Вероятность' },
  { id: 3, title: 'Русский язык' },
  { id: 23, title: 'Литература' },
  { id: 2, title: 'Английский язык' },
  { id: 8, title: 'Немецкий язык' },
  { id: 11, title: 'Французский язык' },
  { id: 6, title: 'Физика' },
  { id: 7, title: 'Химия' },
  { id: 12, title: 'Биология' },
  { id: 16, title: 'География' },
  { id: 13, title: 'История' },
  { id: 24, title: 'Обществознание' },
  { id: 14, title: 'Информатика' }
];

// Workbook signal — "Р.т.", "рабочая тетрадь", "р/т", English "workbook/activity book".
const WB_MARKER = /(р\.?\s*т\.?|рабоч\w*\s+тетрад\w*|р\/т|activity\s*book|workbook)/i;
// Page refs: "с. 112", "стр 74", "страница 108-109" (с. has no period sometimes).
// Cyrillic-aware left boundary — JS \b is ASCII-only and would miss "с".
const PAGE_RE = /(?<![а-яёa-z])(?:стр|страниц[аеуы]?|с)\.?\s*(\d+)\s*(?:[-–—]\s*(\d+))?/gi;
// Exercise refs: "упр. 2", "упражнение 5", "№ 25", "задание 3", "задача 5",
// "номер 7", plus lists and ranges: "1, 2", "1-3", "1 и 2".
const EX_RE = /(?:упр(?:ажнени[еяй])?|задани[еяй]|задач[аиу]|номер|№)\.?\s*№?\s*(\d+(?:\s*[-–—,\sи]+\s*\d+)*)/gi;

// Expand a captured number span into individual numbers: "1, 2" → [1,2];
// "1-3" / "1 – 3" → [1,2,3] (ranges, spaced or not).
function expandNums(str) {
  const out = [];
  const norm = str.replace(/\s*[-–—]\s*/g, '-');
  for (const part of norm.split(/[,\sи]+/).map((x) => x.trim()).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = +range[1], b = +range[2];
      if (b >= a && b - a < 50) for (let n = a; n <= b; n++) out.push(n);
    } else if (/^\d+$/.test(part)) {
      out.push(+part);
    }
  }
  return out;
}

/**
 * Parse a homework task into page/exercise numbers, grouped by book context.
 * Sentences are split on a period followed by an uppercase letter (so the
 * abbreviation dots in "Р.т.", "с.", "упр." don't split mid-reference), and a
 * sentence mentioning a workbook marker contributes to the workbook bucket.
 *
 * @returns {{textbook:{pages:number[],exercises:number[]}, workbook:{pages:number[],exercises:number[]}}}
 */
export function parseRefs(text = '') {
  const ctx = {
    textbook: { pages: new Set(), exercises: new Set() },
    workbook: { pages: new Set(), exercises: new Set() }
  };
  // Split on newlines (homework is often one task per line) AND on a period
  // followed by an uppercase letter — the abbreviation dots in "Р.т."/"с."/"упр."
  // are followed by lowercase or a digit, so they don't split mid-reference.
  for (const sentence of String(text).split(/\n+|(?<=\.)\s+(?=[А-ЯЁA-Za-z])/)) {
    const bucket = WB_MARKER.test(sentence) ? ctx.workbook : ctx.textbook;
    let m;
    PAGE_RE.lastIndex = 0;
    while ((m = PAGE_RE.exec(sentence))) {
      const a = +m[1];
      bucket.pages.add(a);
      if (m[2]) for (let p = a + 1; p <= +m[2] && p - a < 20; p++) bucket.pages.add(p);
    }
    EX_RE.lastIndex = 0;
    while ((m = EX_RE.exec(sentence))) for (const n of expandNums(m[1])) bucket.exercises.add(n);
  }
  const arr = (o) => ({ pages: [...o.pages], exercises: [...o.exercises] });
  return { textbook: arr(ctx.textbook), workbook: arr(ctx.workbook) };
}
