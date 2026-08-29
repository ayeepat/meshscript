/**
 * Routes a detected subject to a prompt category, and assembles the final
 * system prompt exclusively from trusted, packaged instructions.
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
  { category: PROMPT_CATEGORIES.RUSSIAN_FULL,      test: (s) => /русск[а-яё]*[)\s]+язык/.test(s) },
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

/** Get the packaged base prompt for a subject. Stored text is never consulted. */
export async function basePromptForSubject(subject) {
  const category = categoryForSubject(subject);
  return DEFAULT_PROMPTS[category];
}

// Universal guard appended to every solve. Rides along in the same call —
// zero extra cost. Two jobs: (1) stop the model from fabricating a plausible
// but invented "solution" to material it cannot actually see, and (2) hard-stop
// on audio, which this tool can NEVER process (no transcription). Audio is the
// dangerous case: the model otherwise confidently makes up listening answers.
// The guard allows PARTIAL solving — do the parts whose material is present
// (e.g. reading/grammar from an attached PDF), refuse only the missing parts.
const CONTEXT_GUARD =
  'КРИТИЧЕСКИ ВАЖНО — НЕ ВЫДУМЫВАЙ. Решай ТОЛЬКО то, что реально видишь в этом сообщении: ' +
  'в тексте задания или в приложенных файлах/фото. Если для выполнения нужен исходный материал, ' +
  'которого здесь НЕТ (текст задания, страница учебника, рабочий лист, документ, картинка, таблица), — ' +
  'НЕ придумывай его содержание и НЕ выдавай правдоподобные, но выдуманные ответы. ' +
  'Сначала выполни те части, материал которых действительно приложен, а для остального честно напиши, ' +
  'чего конкретно не хватает, и попроси это прислать (фото страницы / файл / текст).\n' +
  // Asking for an audio FILE here used to be a dead end: transcription runs on a
  // BYO Groq key (lib/transcribe.js) that the shipped UI can no longer collect,
  // so a student who complied got the identical refusal back. Ask only for what
  // can actually be acted on. The transcript branch stays because a marker file
  // still appears whenever Whisper does run.
  'АУДИО. Сам звук ты слушать не умеешь. Если в этом сообщении есть текст с пометкой ' +
  '«Расшифровка аудиозаписи …» — это и есть содержание записи: реши задание на аудирование по этой ' +
  'расшифровке как по обычному тексту (учитывай, что в авто-распознавании возможны мелкие ошибки в ' +
  'словах/именах). Если же ни расшифровки, ни иного текста записи в сообщении НЕТ (только ссылка на ' +
  'аудио — Google Drive, Яндекс.Диск, .mp3 — сам аудиофайл или вообще ничего), аудирование ' +
  'выполнить нельзя: НЕ выдумывай ответы, а напиши «Не могу прослушать аудио — пришлите расшифровку ' +
  '(текст) записи или скриншот задания с текстом, тогда решу эту часть». ' +
  'И НИКОГДА не утверждай, что ты «прослушал запись», и не выдумывай её содержание, если его нет в сообщении. ' +
  'Остальные части (чтение, лексика, грамматика, письмо) решай как обычно, если их материал приложен.\n' +
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
 * Build the system prompt for a subject from packaged, allowlisted values only.
 * @param {string} subject
 * @param {string} [mode] one of ANSWER_MODES (defaults to brief)
 */
export async function buildSystemPrompt(subject, mode = ANSWER_MODES.BRIEF) {
  const base = await basePromptForSubject(subject);
  const modeText = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS[ANSWER_MODES.BRIEF];
  // `subject` selects a category but is deliberately not interpolated here:
  // it originates on the page and therefore belongs in user-role task data.
  return `${base}\n\n${CONTEXT_GUARD}\n\n${modeText}`;
}
