/**
 * Difficulty heuristic regression — guards the LOW-reasoning-effort routing.
 *
 * The asymmetry is the whole point: a false "hard" only costs a little speed,
 * but a false "easy" under-thinks a real problem. So a task drops to low ONLY
 * when it POSITIVELY looks like recall/lookup/choice — never merely because it
 * lacks math markers. Two families must stay full-effort:
 *   - STEM (math/physics/chemistry), and
 *   - non-STEM REASONING (history/literature analysis, essays, cause-effect).
 */
import assert from 'node:assert/strict';
import {
  isEasyTask, hasHardMarkers, testPageEffort, classifyTask, isChatty, isLightFollowup
} from '../src/lib/task-classifier.js';

// --- Cyrillic word edges ----------------------------------------------------
// JS \b only fires next to [A-Za-z0-9_]; between a space and a Cyrillic letter
// it never matches, so \b-wrapped Russian markers («сила», «эссе», «роль»,
// «анализ», «огэ») silently matched NOTHING. These markers use explicit
// lookarounds now — each case below is one that the \b version missed.
const cyrillicEdgeHard = [
  'Какая сила удерживает планеты на орбите? Укажите верный вариант.', // физика
  'Напиши эссе на тему «Мой любимый герой» объёмом 150 слов.',
  'Какова роль личности в истории? Разверни мысль подробно.',
  'Сделай анализ стихотворения Лермонтова «Парус» по плану.'
];
for (const t of cyrillicEdgeHard) {
  assert.equal(hasHardMarkers(t), true, `Cyrillic-edge marker must fire: ${t}`);
  assert.equal(isEasyTask(t), false, `must stay full effort: ${t}`);
  assert.equal(testPageEffort(t), 'medium', `page with this text must stay medium: ${t}`);
}
// …while the lookarounds still keep the old \b's intent of not firing inside
// longer words: «пароль» is not «роль», «усилие» is not «сила».
assert.equal(hasHardMarkers('Как переводится слово «пароль»?'), false, '«пароль» must not trigger «роль»');
assert.equal(isEasyTask('Как переводится слово «пароль»?'), true);
assert.equal(hasHardMarkers('Соотнесите слова: усилие, старание, попытка.'), false, '«усилие» must not trigger «сила»');
// Same family in the attachment heuristic: «вариант ОГЭ/ЕГЭ» is distributed as
// a file, and «впрочем» must not read as «впр».
assert.equal(classifyTask('Решить пробный вариант ОГЭ до пятницы.').needsFile, true, '«ОГЭ» must flag an attachment');
assert.equal(classifyTask('Подготовить пересказ текста, впрочем можно кратко.').needsFile, false, '«впрочем» must not trigger «впр»');

// --- clearly EASY: short recall/lookup/choice with a positive cue ----------
const easy = [
  'Столица Франции?',
  'Кто написал «Войну и мир»?',
  'Выберите правильный вариант: he go / he goes to school.',
  'В каком году началась Вторая мировая война?',
  'Соотнесите страны и их столицы.',
  'Переведите слово «apple» на русский.',
  'Как называется столица Австралии?'
];
for (const t of easy) {
  assert.equal(hasHardMarkers(t), false, `should have NO hard markers: ${t}`);
  assert.equal(isEasyTask(t), true, `should be easy: ${t}`);
}

// --- STEM: math / physics / chemistry / proofs → full effort ---------------
const stem = [
  'Решите уравнение x^2 - 5x + 6 = 0.',
  'Вычислите производную функции f(x) = 3x^2.',
  'Найдите площадь под графиком функции.',
  'Упростите выражение 2a + 3a - a.',
  'Тело движется со скоростью 5 м/с. Найдите ускорение за 2 c.',
  'Составьте уравнение реакции горения метана.',
  'Solve the equation 2x + 3 = 7.',
  'Найдите корень уравнения √(x+1) = 3.',
  'Вычислите 15 + 27 * 3.'
];
for (const t of stem) {
  assert.equal(hasHardMarkers(t), true, `STEM should have hard markers: ${t}`);
  assert.equal(isEasyTask(t), false, `STEM should NOT be easy: ${t}`);
}

// --- non-STEM REASONING → full effort (the gap the first cut missed) --------
// None of these have math markers, yet all need real thinking. They must NOT
// be "easy" AND must register as hard (so a test page carrying them stays at
// medium effort, not low).
const reasoning = [
  'Объясните причины Февральской революции 1917 года.',
  'В чём смысл финала романа «Отцы и дети»?',
  'Сравните героев рассказа и обоснуйте вывод.',
  'Проанализируйте роль Петра I в истории России.',
  'Почему началась Первая мировая война?',
  'Опишите подробно причины и последствия события.',
  'Interpret the meaning of the poem and explain your view.'
];
for (const t of reasoning) {
  assert.equal(hasHardMarkers(t), true, `reasoning should register as hard: ${t}`);
  assert.equal(isEasyTask(t), false, `reasoning should NOT be easy: ${t}`);
}

// --- no positive cue → NOT easy, even when short and non-STEM --------------
// "not obviously math" is not "easy": without a recall/choice cue we keep the
// default effort rather than guessing.
const noCue = [
  'Расскажи о берёзе.',
  'Напиши три предложения о лете.',
  'Составь план ответа.'
];
for (const t of noCue) {
  assert.equal(isEasyTask(t), false, `no positive cue → not easy: ${t}`);
}

// --- length gate: a long task is never "easy" even with a cue --------------
const longWithCue = 'Как называется ' + 'этот предмет на рисунке? '.repeat(12);
assert.ok(longWithCue.length > 240);
assert.equal(hasHardMarkers(longWithCue), false, 'no hard markers in the long lookup text');
assert.equal(isEasyTask(longWithCue), false, 'long tasks are never easy (real work)');

// --- empty / junk ----------------------------------------------------------
assert.equal(isEasyTask(''), false);
assert.equal(isEasyTask(null), false);
assert.equal(hasHardMarkers(''), false);

// --- testPageEffort: the SAFE default when we can't judge the page ---------
// Empty / failed extraction / short placeholder must NOT drop to low — a
// screenshot-only hard-math page would otherwise be under-thought.
assert.equal(testPageEffort(''), 'medium', 'no text → safe default medium');
assert.equal(testPageEffort(null), 'medium', 'null → safe default medium');
assert.equal(testPageEffort('(текст не извлечён, смотри скриншот)'), 'medium', 'placeholder → medium');
assert.equal(testPageEffort('Столица?'), 'medium', 'too little text to trust → medium');
// A hard page stays medium; a genuine vocabulary/lookup page drops to low.
assert.equal(
  testPageEffort('Решите уравнение и вычислите значение x. Найдите производную функции.'),
  'medium', 'math page → medium');
assert.equal(
  testPageEffort('Выберите правильную форму глагола. Соотнесите слова и их переводы. Вставьте пропущенные буквы в предложения.'),
  'low', 'long vocabulary/choice page with no hard markers → low');

// --- isChatty: small talk / meta → nothing to solve → low effort ------------
const chatty = [
  'Привет!',
  'привет, что ты умеешь?',
  'Кто ты и как ты работаешь?',
  'Здравствуйте! Чем можешь помочь?',
  'Расскажи о себе',
  'hi, what can you do?',
  'спасибо, круто!',
  'как дела?'
];
for (const t of chatty) {
  assert.equal(isChatty(t), true, `should be chatty: ${t}`);
}

// A greeting bolted onto REAL work must never read as chat: the task part is
// what the model answers. Residual/marker/ref gates each catch one of these.
const greetingPlusWork = [
  'Привет! Помоги мне с домашним заданием по физике, пожалуйста.',  // residual text
  'Привет, реши уравнение x^2 - 4 = 0.',                            // STEM marker
  'Здравствуйте, напишите сочинение о лете.',                       // reasoning marker
  'привет, сделай упр. 25 пожалуйста',                              // textbook ref
  'Привет! Реши вариант ОГЭ из файла.'                              // attachment talk
];
for (const t of greetingPlusWork) {
  assert.equal(isChatty(t), false, `greeting + work must NOT be chatty: ${t}`);
}
assert.equal(isChatty(''), false);
assert.equal(isChatty(null), false);

// --- isLightFollowup: clarifications of an already-solved task → low --------
// The worked answer is replayed in history; re-explaining it is rewording.
// Note «объясни»/«почему» are REASONING (hard) markers for FRESH tasks but the
// canonical clarification vocabulary on follow-ups — that asymmetry is the
// whole reason this is a separate function from isEasyTask.
const lightFollowups = [
  'объясни, пожалуйста, я не понял',
  'не понял, можешь попроще?',
  'объясни подробнее шаг 2',
  'а почему именно так?',
  'откуда взялось это число?',
  'как ты это решил?',        // past «решил» = question about the answer, not a new solve
  'объясни ещё раз, помедленнее',
  'что значит «дискриминант»?'.replace('дискриминант', 'метафора'), // no STEM word
  'спасибо, понял!',
  'explain please i didnt understand',
  'can you explain step by step?'
];
for (const t of lightFollowups) {
  assert.equal(isLightFollowup(t), true, `clarification should be light: ${t}`);
}

// Disputes mean the previous answer may be WRONG → full-effort re-solve.
const disputes = [
  'неправильно, ответ должен быть 12',
  'это неверный ответ',
  'ты ошибся',
  'не сходится с ответом в учебнике',
  'у учителя другой ответ',
  'перереши пожалуйста',
  'реши заново',
  'ты уверен?',
  'это точно?',
  'проверь ещё раз',
  'объясни, почему у тебя не так, как в ответах',  // clarify verb + dispute → dispute wins
  'wrong answer',
  'are you sure about this?'
];
for (const t of disputes) {
  assert.equal(isLightFollowup(t), false, `dispute must stay full effort: ${t}`);
}

// New work in a follow-up is a fresh task, not a clarification.
const newWork = [
  'а теперь реши №5',
  'теперь сделай упр 3',
  'реши ещё вот это',
  'и ещё одно задание: перескажи текст',
  'а если x = 5, что получится?',   // what-if = fresh reasoning
  'что если бы Наполеон победил?',
  'объясни, как решить 2x + 4 = 8', // fresh math pasted into the follow-up
  'напиши сочинение по этой теме',
  'не понял задание 2 из файла',    // attachment/variant talk → context may not cover it
  'now solve number 3'
];
for (const t of newWork) {
  assert.equal(isLightFollowup(t), false, `new work must stay full effort: ${t}`);
}

// No positive cue → full effort even when short and harmless-looking, and a
// long follow-up is assumed to embed new work.
assert.equal(isLightFollowup('расскажи про глаголы'), false, 'no clarify cue → full');
assert.equal(isLightFollowup('объясни ' + 'очень подробно каждый шаг '.repeat(10)), false, 'long follow-up → full');
assert.equal(isLightFollowup(''), false);
assert.equal(isLightFollowup(null), false);

console.log('task difficulty regression passed');
