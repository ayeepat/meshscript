/**
 * Lightweight task classifier — pure regex heuristics, no network.
 *
 * Decides what a homework card needs from the user BEFORE solving:
 *  - 'attachment': the teacher references a file/worksheet distributed via
 *    Mesh (PDF, Word, презентация, карточки, раздатка…). The AI can't see
 *    it — the user must download it from Mesh and attach it here.
 *  - 'textbook': the task is only a reference («Упр. 25», «№ 354, 358»,
 *    «стр. 102 з. 4») with no actual task text. A photo of the textbook
 *    page turns a guessed answer into an exact one.
 *
 * Deliberately NOT an LLM call: a per-card Groq round-trip would add latency
 * to every popup open and a hard dependency on a configured key. The solver
 * model already performs the deep "what is actually needed" check at solve
 * time (see CONTEXT_GUARD in subject-router.js); these heuristics only
 * decide how to present the upload button in the popup.
 */

// Word edges around Cyrillic need explicit lookarounds: JS \b only fires next
// to [A-Za-z0-9_], so \bсила\b matches NOTHING in Russian text. CYR_L / CYR_R
// are \b's equivalents for markers that must not fire inside longer words
// («усилие» is not «сила», «пароль» is not «роль», «впрочем» is not «впр»).
const CYR_L = '(?<![а-яёa-z])';
const CYR_R = '(?![а-яёa-z])';

// The many ways teachers say "the task is in an attached file".
const ATTACHMENT_RE = new RegExp(
  [
    'файл', 'пдф', '\\bpdf\\b', 'ворд', '\\bword\\b', '\\bdocx?\\b',
    'презентаци', '\\bpptx?\\b', '\\bxlsx?\\b', '\\btxt\\b', 'таблиц',
    'документ', 'приложен', 'прикреп', 'вложен',
    'скан', 'распечат', 'раздат', 'карточк', 'бланк',
    // [а-яё]* not \w*: \w is ASCII-only in JS and never matches Cyrillic.
    'рабоч[а-яё]*\\s+лист', 'лист[а-яё]*\\s+с\\s+задани',
    'тест\\s+мэш', 'мэш[\\s-]*тест', 'по\\s+ссылке', 'доделать\\s+упр',
    // OGE/EGE/VPR variants are distributed as an attached file; listening
    // (аудирование) and audio links also imply external material.
    'вариант\\s*\\d', `${CYR_L}огэ${CYR_R}`, `${CYR_L}егэ${CYR_R}`, `${CYR_L}впр${CYR_R}`,
    'аудир', 'аудиозап', 'drive\\.google', 'disk\\.yandex'
  ].join('|'),
  'i'
);

// Detects whether a task needs AUDIO — listening sections or audio links.
// This tool can never solve those, so callers can warn the user up front.
const AUDIO_RE = /(аудир|аудиозап|на\s+слух|listening|\.mp3|\.m4a|\.wav|drive\.google|disk\.yandex)/i;
export function needsAudio(task) {
  return AUDIO_RE.test(task || '');
}

// Reference to a numbered item in a textbook: упр./№/стр./задание/§ + digit.
const REF_RE = /(№|упр[а-яё]*|стр[а-яё]*|задани[а-яё]*|задач[а-яё]*|номер[а-яё]*|параграф[а-яё]*|§|пункт[а-яё]*|п\.|зад\.|ex\.?\s*|p\.|page\s*)\s*\.?\s*\d/i;

/**
 * True when the task is essentially just textbook references — the actual
 * exercise text lives on a page the AI can't see.
 */
export function isBareTextbookRef(task) {
  const t = (task || '').trim();
  if (!t || !REF_RE.test(t)) return false;
  // Strip the references themselves plus digits/punctuation. If almost no
  // descriptive text remains («Упр. 25», «№ 354, 358 стр. 80»), it's bare.
  // Short imperatives like «вставьте буквы» also count as bare: the
  // sentences to work on are still in the book.
  const residual = t
    .replace(new RegExp(REF_RE.source, 'gi'), ' ')
    .replace(/[\d\s.,;:№§()\-–—/+«»"']+/g, ' ')
    .trim();
  return residual.length < 40;
}

/**
 * @param {string} task homework text as scraped from Mesh
 * @returns {{needsFile: boolean, kind: 'attachment'|'textbook'|null}}
 */
export function classifyTask(task) {
  if (ATTACHMENT_RE.test(task || '')) return { needsFile: true, kind: 'attachment' };
  if (isBareTextbookRef(task)) return { needsFile: true, kind: 'textbook' };
  return { needsFile: false, kind: null };
}

// ---------------------------------------------------------------------------
// Difficulty heuristic — decides when a task can safely run at LOW reasoning
// effort (less model thinking → faster first answer AND fewer thinking tokens
// billed). Pure regex, same rationale as the rest of this file: an LLM call to
// classify difficulty would add the very latency we're trying to remove.
//
// IMPORTANT: this only changes the `reasoning_effort` knob, which is honored
// ONLY on the DeepSeek and OpenRouter/Gemini paths — Qwen (qwen3.7-plus, the
// keyless proxy default for vision) thinks by default and ignores it, so this
// is a no-op there, never a regression. See the effort comments in qwen.js /
// deepseek.js / smesh-proxy.js.
//
// The gate is deliberately ASYMMETRIC: a false "hard" costs only a little speed
// (we keep the current default effort), while a false "easy" could under-think
// a real problem. Two independent failure modes are guarded:
//   1. STEM work (math/physics/chemistry) — the obvious "needs thinking" case.
//   2. Non-STEM REASONING (analysis, interpretation, argument, essay, cause-
//      and-effect). This is the trap the first cut fell into: a short history
//      or literature prompt has NO math markers, so "no STEM" wrongly read as
//      "easy" and under-thought real analytical work.
// And easiness is decided by a POSITIVE cue (recall / lookup / choice /
// translation), never merely by the absence of hard markers.

// STEM: algebra, calculus, physics, chemistry, and formula/equation typography.
const STEM_MARKERS = new RegExp([
  'уравнени', 'неравенств', 'производн', 'интеграл', 'логарифм', 'синус',
  'косинус', 'тангенс', 'вектор', 'матриц', 'многочлен', 'дискриминант',
  'упрост', 'вычисл', 'формул', 'функци', 'график', 'парабол',
  'корень\\s+уравнени', 'систем\\w*\\s+уравнени',
  'скорост', 'ускорени', `${CYR_L}сил[аеуы]${CYR_R}`, 'энерги', 'импульс', 'молярн',
  'реакци', 'валентност', 'концентраци', 'молекул', 'ньютон',
  'solve\\b', 'equation', 'integral', 'derivative', 'calculate',
  '[=≥≤√∫∑∛π∆]', '\\^\\s*\\d', '\\d\\s*[+\\-*/×÷]\\s*\\d'
].join('|'), 'i');

// Non-STEM reasoning/essay work — analysis, argument, interpretation. Also
// needs full effort; absence of math says nothing about these.
const REASONING_MARKERS = new RegExp([
  'объясни', 'поясни', 'сравни', 'сопостав', 'проанализир', `${CYR_L}анализ`,
  'обоснуй', 'аргумент', 'докаж', 'доказа', 'обсуди', 'оцени', 'охарактеризуй',
  'раскрой', 'рассужд', 'сочинени', `${CYR_L}эссе`, 'изложени', 'причин',
  'последстви', 'в\\s+чём\\s+(смысл|суть|различи|особенност)', `${CYR_L}смысл`,
  `${CYR_L}роль${CYR_R}`, 'значени', 'почему', 'зачем', 'как\\s+повлия', 'сформулируй',
  'сделай\\s+вывод', 'interpret', 'analy[sz]e', 'compare', 'contrast',
  'explain', 'discuss', '\\bessay', 'argue', 'evaluate', 'why\\s+(did|is|are|was)'
].join('|'), 'i');

// Positive "easy" cues — recall / lookup / choice / matching / translation.
// A task must MATCH one of these (and no hard marker) to drop to low effort.
const EASY_CUES = new RegExp([
  'выбер', 'отметь', 'подчеркн', 'соотнес', 'вставь', 'заполни\\s+пропуск',
  'укажите\\s+верн', 'верный\\s+вариант', 'правильный\\s+вариант', 'из\\s+списка',
  'сколько', 'в\\s+каком\\s+году', 'в\\s+каком\\s+веке', 'кто\\s+написал',
  'кто\\s+автор', 'кто\\s+такой', 'как\\s+называется', 'как\\s+звали', 'столиц',
  'переведи', 'перевод\\s+слова', 'как\\s+переводится',
  'true\\s+or\\s+false', 'which\\s+of', 'choose\\s+the', 'select\\s+the',
  'fill\\s+in', 'match\\s+the', 'translate'
].join('|'), 'i');

/**
 * True when the text shows any marker of work that benefits from deeper
 * thinking — STEM OR non-STEM reasoning/analysis. Used for the whole-TEST-page
 * effort choice (page text is long and junk-laden, so this marker check is the
 * signal there — see solveTest). ANY match keeps full effort.
 */
export function hasHardMarkers(text) {
  const t = text || '';
  return STEM_MARKERS.test(t) || REASONING_MARKERS.test(t);
}

/**
 * A single homework task simple enough to answer at LOW reasoning effort. Must
 * be ALL of: short, free of any hard (STEM/reasoning) marker, AND positively a
 * recall/lookup/choice/translation task. Requiring the positive cue is what
 * keeps short analytical prompts (history, literature) at full effort — "not
 * obviously math" is NOT "easy".
 */
export function isEasyTask(task) {
  const t = (task || '').trim();
  if (!t || t.length > 240) return false;   // length itself signals real work
  if (hasHardMarkers(t)) return false;       // math OR analysis → not easy
  return EASY_CUES.test(t);                   // require positive evidence of triviality
}

// ---------------------------------------------------------------------------
// Chatty first-turn messages — greetings, "who are you / what can you do",
// thanks. There is no problem to solve, so model thinking buys nothing; these
// were the most visible "why did 'привет' take 30 seconds" complaints. Same
// asymmetric rule as isEasyTask: the message must POSITIVELY look like chat,
// AND carry nothing that looks like work (hard markers, task references,
// attachment talk), AND be almost nothing BUT the chat phrases — a greeting
// bolted onto a real task («привет, помоги с домашкой по физике…») must keep
// full effort because the task part is what the model actually answers.
const CHATTY_RE = new RegExp([
  `${CYR_L}привет`, 'здравствуй', 'здрасьте', 'здрасте', 'добр[а-яё]*\\s+(день|утр|вечер)',
  '\\bhi\\b', '\\bhello\\b', '\\bhey\\b',
  'кто\\s+ты', 'что\\s+ты\\s+(умеешь|такое|делаешь)', 'что\\s+умеешь',
  'как\\s+ты\\s+работаешь', 'как\\s+(это|тут|здесь)\\s+работает',
  'чем\\s+(ты\\s+)?можешь\\s+помочь', 'чем\\s+поможешь',
  'как\\s+(тобой|этим|расширением)?\\s*пользоваться', 'расскажи\\s+о\\s+себе',
  'что\\s+это\\s+за\\s+(бот|программа|расширение|штука)', 'на\\s+что\\s+ты\\s+способ',
  'who\\s+are\\s+you', 'what\\s+(are|can)\\s+you', 'how\\s+do\\s+you\\s+work',
  'спасибо', 'благодар', `${CYR_L}спс${CYR_R}`, 'понятно', `${CYR_L}понял`,
  `${CYR_L}ясно${CYR_R}`, `${CYR_L}ок${CYR_R}`, 'окей', 'th(anks|ank\\s+you)',
  'круто', 'здорово', 'отлично', `${CYR_L}пока${CYR_R}`, 'до\\s+свидания',
  'как\\s+дела'
].join('|'), 'i');

/**
 * True when the message is small talk / meta questions about the assistant —
 * nothing to solve. Requires: short, no hard markers, no task reference or
 * attachment talk, a positive chat cue, AND near-zero residual text once the
 * chat phrases are stripped (so a greeting prefix never drags a real task
 * down to low effort).
 */
export function isChatty(text) {
  const t = (text || '').trim();
  if (!t || t.length > 160) return false;
  if (hasHardMarkers(t)) return false;
  if (REF_RE.test(t) || ATTACHMENT_RE.test(t)) return false;
  if (!CHATTY_RE.test(t)) return false;
  const residual = t
    .replace(new RegExp(CHATTY_RE.source, 'gi'), ' ')
    .replace(/[^a-zа-яё]+/gi, ' ')
    .trim();
  return residual.length <= 16;
}

// ---------------------------------------------------------------------------
// Follow-up effort — a clarification of an ALREADY-SOLVED task («объясни, я не
// понял») can run at LOW effort: the thinking model's worked answer is replayed
// in history, and re-explaining it is a rewording job, not fresh solving. But
// the caller must distinguish that from follow-ups that need REAL thinking:
//   - disputes («неправильно», «ты уверен?», «в учебнике другой ответ») mean
//     the previous answer may be WRONG — re-solve at full effort;
//   - new work («а теперь реши №5», «что если…», fresh math) is a fresh task;
//   - anything referencing files/variants might not be covered by the context.
// Note the deliberate difference from isEasyTask: hasHardMarkers is NOT used
// here, because its REASONING markers («объясни», «почему», «поясни») are the
// exact vocabulary of a clarification — hard for a fresh task, light when the
// worked answer is already in the conversation. Only STEM markers stay a
// blocker: fresh math pasted into a follow-up must never be under-thought.

// Signals the student doubts or rejects the previous answer → re-solve fully.
const DISPUTE_RE = new RegExp([
  'неправильн', 'не\\s+правильн', 'неверн', 'не\\s+верн', 'ошиб', 'не\\s+так',
  'не\\s+сходится', 'не\\s+совпада', 'должн[оаы]?\\s+быть', 'друго[йе]\\s+ответ',
  'ответ\\s+друг', 'в\\s+ответах', 'в\\s+учебнике', 'учител',
  'перереш', 'заново', 'по-другому', 'друг(им|ой)\\s+способ',
  'провер', 'пересчит', 'уверен', 'сомнева', `${CYR_L}точно${CYR_R}`,
  '\\bwrong\\b', 'incorrect', 'mistake', 'not\\s+right', 'are\\s+you\\s+sure',
  'try\\s+again', '\\bredo\\b'
].join('|'), 'i');

// Signals a NEW task rather than a question about the previous one.
const NEW_WORK_RE = new RegExp([
  // Imperative/infinitive «реши(те)/решить», but NOT past «решил(а)» — «как ты
  // решил…» is the canonical clarification and must stay light.
  `${CYR_L}реши(?![лв])`, 'выполни', 'сделай', 'составь', 'придумай',
  'сочинени', `${CYR_L}эссе`, 'доклад', 'реферат', 'изложени',
  'следующ', 'ещ[её]\\s+(одн|задан|задач|номер|вопрос|пример|упражнени)',
  'а\\s+теперь', 'теперь\\s+(реши|сделай|задани|номер|упр)',
  'а\\s+если', 'что\\s+если', 'what\\s+if', '\\bsolve\\b', 'now\\s+(solve|do)'
].join('|'), 'i');

// Positive clarification cues — questions about the answer that's already
// on screen, requests to re-explain, plus plain acknowledgements/thanks.
const CLARIFY_RE = new RegExp([
  'не\\s+пон(ял|яла|ятно|имаю)', 'непонятно', 'объясни', 'поясни', 'подробн',
  'попроще', `${CYR_L}проще${CYR_R}`, 'помедленн', 'по\\s+шагам', 'пошагово',
  'поэтапно', 'распиши', 'разжуй', 'растолкуй', 'что\\s+значит', 'что\\s+такое',
  'почему', 'зачем\\s+ты', 'откуда',
  // Up to two words may sit between «как ты» and the verb («как ты ЭТО решил»).
  'как\\s+ты(\\s+[а-яё]+){0,2}\\s+(получил|нашёл|нашел|посчитал|решил|вычислил|определил)',
  'ещ[её]\\s+раз', 'повтори', 'кратко', 'короче', 'своими\\s+словами',
  'explain', "(do|did)n?'?t\\s+underst", 'not\\s+underst', 'confus', 'clarify',
  'simpler', 'in\\s+more\\s+detail', 'step\\s+by\\s+step'
].join('|'), 'i');

/**
 * True when a FOLLOW-UP message (there is a prior assistant answer in history —
 * the caller checks that) is safe to answer at LOW reasoning effort: it only
 * asks to re-explain / rephrase the existing answer, or is chat/thanks, or is
 * a genuinely easy standalone question. Blockers run first — ANY sign of
 * dispute, new work, fresh math, task references or attachments keeps full
 * effort, because a wrong «low» here under-thinks a real re-solve while a
 * wrong «full» only costs a little speed.
 */
export function isLightFollowup(task) {
  const t = (task || '').trim();
  if (!t || t.length > 200) return false;   // long follow-ups usually embed new work
  if (DISPUTE_RE.test(t) || NEW_WORK_RE.test(t)) return false;
  if (REF_RE.test(t) || ATTACHMENT_RE.test(t)) return false;
  if (STEM_MARKERS.test(t)) return false;    // fresh math in the follow-up → full
  return CLARIFY_RE.test(t) || isEasyTask(t) || isChatty(t);
}

/**
 * Reasoning effort for a whole TEST page. Returns 'low' ONLY when there is
 * enough page text to actually judge AND it shows no hard marker; otherwise
 * 'medium' (the safe default). The length floor matters: a screenshot-only
 * page whose text extraction failed arrives as '' or a short placeholder, and
 * must NOT be under-thought just because an empty string has no hard markers.
 * Never returns 'high' — that is the per-question «перерешать» retry's job.
 */
export function testPageEffort(text) {
  const t = (text || '').trim();
  return (t.length >= 40 && !hasHardMarkers(t)) ? 'low' : 'medium';
}
