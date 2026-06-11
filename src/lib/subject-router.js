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
  { category: PROMPT_CATEGORIES.RUSSIAN_FULL,      test: (s) => /русск\w*\s+язык/.test(s) },
  { category: PROMPT_CATEGORIES.LITERATURE,        test: (s) => /литератур/.test(s) },
  { category: PROMPT_CATEGORIES.DIRECT_ANSWER,     test: (s) => /иностран|англ|немец|франц|испан|китайск|итальянск/.test(s) },
  { category: PROMPT_CATEGORIES.WORKED_SOLUTION,   test: (s) => /алгебр|геометр|матем|вероятн|статистик|физик|хими|информатик|астроном/.test(s) },
  { category: PROMPT_CATEGORIES.PARAGRAPH_SUMMARY, test: (s) => /истори|общество|географ|биолог|обж|основы\s+безопас|технолог|физкультур|физическ\w*\s+культур|музык|изо|искусств|мхк|экономик|право/.test(s) }
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

/** Build the system prompt for a subject, using overrides if available. */
export async function buildSystemPrompt(subject) {
  const base = await basePromptForSubject(subject);
  return `${base}\n\nПредмет: ${subject}.`;
}
