/**
 * Routes a detected subject to a prompt category, and assembles the final
 * system prompt (preferring user overrides stored in chrome.storage.local).
 *
 * Routing is keyword/substring-based, not exact-match. Mesh exposes subject
 * names in several forms ("Английский язык" vs "Иностранный (английский)
 * язык", "Математика" vs "Вероятность и статистика", "ОБЖ" vs "Основы
 * безопасности и защиты Родины"). An exact-match map drops anything it
 * hasn't seen; keyword matching degrades to WORKED_SOLUTION instead.
 */
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from './prompts.js';

// Russian must be checked BEFORE literature so "Русский язык" never collides
// with anything else, and BEFORE the foreign-language rule so "иностранный
// (русский)" wouldn't be misrouted in some edge case.
const ROUTES = [
  // NOTE: \w is ASCII-only in JS regex and silently never matches Cyrillic —
  // use [а-яё]* for Russian word endings.
  { category: PROMPT_CATEGORIES.RUSSIAN_FULL,      test: (s) => /русск[а-яё]*\s+язык/.test(s) },
  { category: PROMPT_CATEGORIES.LITERATURE,        test: (s) => /литератур/.test(s) },
  { category: PROMPT_CATEGORIES.DIRECT_ANSWER,     test: (s) => /иностран|англ|немец|франц|испан|китайск|итальянск/.test(s) },
  { category: PROMPT_CATEGORIES.WORKED_SOLUTION,   test: (s) => /алгебр|геометр|матем|вероятн|статистик|физик|хими|информатик|астроном/.test(s) },
  { category: PROMPT_CATEGORIES.PARAGRAPH_SUMMARY, test: (s) => /истори|общество|географ|биолог|обж|основы\s+безопас|технолог|физкультур|физическ[а-яё]*\s+культур|музык|изо|искусств|мхк|экономик|право/.test(s) }
];

export function categoryForSubject(subject) {
  const s = (subject || '').toLowerCase();
  for (const r of ROUTES) if (r.test(s)) return r.category;
  return PROMPT_CATEGORIES.WORKED_SOLUTION;
}

/** Get the base prompt text for a subject (override-aware). */
export async function basePromptForSubject(subject) {
  const category = categoryForSubject(subject);
  const { promptOverrides = {} } = await chrome.storage.local.get('promptOverrides');
  return promptOverrides[category] || DEFAULT_PROMPTS[category];
}

// Universal guard appended to every solve. Rides along in the same call —
// zero extra cost — and stops the model from burning tokens on a long
// hallucinated "solution" to an exercise it has never seen.
const CONTEXT_GUARD =
  'Если задание состоит только из ссылки на учебник (номер упражнения, задачи, страницы, параграфа) ' +
  'или упоминает приложенный файл, а сам текст задания, фото страницы или файл тебе НЕ переданы — ' +
  'НЕ выдумывай условие. Вместо решения кратко попроси прислать фото страницы учебника или файл. ' +
  'Исключение: задания по классическим литературным произведениям, которые ты знаешь, решай сразу.';

// Answer-mode suffix. BOTH modes keep the worked steps — a teacher needs to
// see the reasoning either way; the difference is how much teaching there is.
export const ANSWER_MODES = { BRIEF: 'brief', EXPLAIN: 'explain' };
const MODE_INSTRUCTIONS = {
  [ANSWER_MODES.BRIEF]:
    'Режим «кратко»: дай решение и пошаговый ход (чтобы было видно рассуждения), ' +
    'но по делу — без разбора теории и лишних объяснений.',
  [ANSWER_MODES.EXPLAIN]:
    'Режим «объяснить»: реши задание И подробно объясни, как репетитор — ' +
    'разбери понятия и почему делаешь именно так, чтобы ученик понял тему и решил похожее сам.'
};

/**
 * Build the system prompt for a subject, using overrides if available.
 * @param {string} subject
 * @param {string} [mode] one of ANSWER_MODES (defaults to brief)
 */
export async function buildSystemPrompt(subject, mode = ANSWER_MODES.BRIEF) {
  const base = await basePromptForSubject(subject);
  const modeText = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS[ANSWER_MODES.BRIEF];
  return `${base}\n\n${CONTEXT_GUARD}\n\n${modeText}\n\nПредмет: ${subject}.`;
}
