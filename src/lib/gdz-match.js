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
  { id: 36, title: 'Испанский язык' },
  { id: 38, title: 'Китайский язык' },
  { id: 6, title: 'Физика' },
  { id: 7, title: 'Химия' },
  { id: 12, title: 'Биология' },
  { id: 16, title: 'География' },
  { id: 13, title: 'История' },
  { id: 24, title: 'Обществознание' },
  { id: 14, title: 'Информатика' },
  { id: 15, title: 'ОБЖ' }
];

// Workbook signal — "Р.т.", "рабочая тетрадь", "р/т", English "workbook/activity book".
// The short abbreviation needs Cyrillic-aware letter boundaries because its
// dots are optional: bare «рт» must not match inside «карта» or «четверть».
// JS \b/\w are ASCII-only; [а-яё]* still covers inflected spelled-out forms.
const WB_MARKER = /((?<![а-яёa-z])р\.?\s*т\.?(?![а-яёa-z])|рабоч[а-яё]*\s+тетрад[а-яё]*|р\/т|activity\s*book|workbook)/i;
// An explicit «учебник» marker hands a sticky line context back to the textbook.
const TEXTBOOK_MARKER = /учебник/i;
// Page refs: "с. 112", "стр 74", "страница 108-109". The single-letter "с" form
// REQUIRES its period: bare "с" + number is the Russian preposition «с» ("начни
// с 5 примера"), and matching that injects a wrong page → a confidently wrong
// answer image. A miss falls back to AI, which is the safe failure here.
// Cyrillic-aware left boundary — JS \b is ASCII-only and would miss "с".
const PAGE_RE = /(?<![а-яёa-z])(?:(?:стр|страниц[аеуы]?)\.?|с\.)\s*(\d+)\s*(?:[-–—]\s*(\d+))?/gi;
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
 * Each Mesh task line starts in textbook context. Within that line a workbook
 * marker makes the context sticky for following sentence fragments until an
 * explicit «учебник» marker hands it back; the context resets at the newline.
 *
 * @returns {{textbook:{pages:number[],exercises:number[]}, workbook:{pages:number[],exercises:number[]}}}
 */
export function parseRefs(text = '') {
  const ctx = {
    textbook: { pages: new Set(), exercises: new Set() },
    workbook: { pages: new Set(), exercises: new Set() }
  };
  for (const line of String(text).split(/\n+/)) {
    let wbActive = false;
    // Context markers and references can share one sentence (for example,
    // «Р.т. упр. 1, учебник упр. 2»). Process every event in document order;
    // assigning one bucket to a whole sentence would put at least one of those
    // references in the wrong book. Context remains sticky until the opposite
    // marker and resets only at the next line, as the homework UI intends.
    const events = [];
    const collect = (re, type) => {
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      let match;
      while ((match = global.exec(line))) {
        events.push({ index: match.index, type, match });
        if (match[0] === '') global.lastIndex++;
      }
    };
    collect(WB_MARKER, 'workbook');
    collect(TEXTBOOK_MARKER, 'textbook');
    collect(PAGE_RE, 'page');
    collect(EX_RE, 'exercise');
    const priority = (event) => (event.type === 'workbook' || event.type === 'textbook') ? 0 : 1;
    events.sort((a, b) => a.index - b.index || priority(a) - priority(b));

    for (const event of events) {
      if (event.type === 'workbook') { wbActive = true; continue; }
      if (event.type === 'textbook') { wbActive = false; continue; }
      const bucket = wbActive ? ctx.workbook : ctx.textbook;
      if (event.type === 'page') {
        const a = +event.match[1];
        bucket.pages.add(a);
        if (event.match[2]) {
          for (let p = a + 1; p <= +event.match[2] && p - a < 20; p++) bucket.pages.add(p);
        }
      } else {
        for (const n of expandNums(event.match[1])) bucket.exercises.add(n);
      }
    }
  }
  const arr = (o) => ({ pages: [...o.pages], exercises: [...o.exercises] });
  return { textbook: arr(ctx.textbook), workbook: arr(ctx.workbook) };
}
