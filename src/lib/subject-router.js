/**
 * Routes a detected subject to a prompt category, and assembles the final
 * system prompt (preferring user overrides stored in chrome.storage.local).
 */
import { DEFAULT_PROMPTS, PROMPT_CATEGORIES } from './prompts.js';

const SUBJECT_TO_CATEGORY = {
  'Алгебра': PROMPT_CATEGORIES.WORKED_SOLUTION,
  'Геометрия': PROMPT_CATEGORIES.WORKED_SOLUTION,
  'Математика': PROMPT_CATEGORIES.WORKED_SOLUTION,
  'Физика': PROMPT_CATEGORIES.WORKED_SOLUTION,
  'Химия': PROMPT_CATEGORIES.WORKED_SOLUTION,
  'Английский язык': PROMPT_CATEGORIES.DIRECT_ANSWER,
  'История': PROMPT_CATEGORIES.PARAGRAPH_SUMMARY,
  'Обществознание': PROMPT_CATEGORIES.PARAGRAPH_SUMMARY,
  'География': PROMPT_CATEGORIES.PARAGRAPH_SUMMARY,
  'Биология': PROMPT_CATEGORIES.PARAGRAPH_SUMMARY,
  'Русский язык': PROMPT_CATEGORIES.RUSSIAN_FULL,
  'Литература': PROMPT_CATEGORIES.PARAGRAPH_SUMMARY
};

export function categoryForSubject(subject) {
  return SUBJECT_TO_CATEGORY[subject] || PROMPT_CATEGORIES.WORKED_SOLUTION;
}

/** Build the system prompt for a subject, using overrides if available. */
export async function buildSystemPrompt(subject) {
  const category = categoryForSubject(subject);
  const { promptOverrides = {} } = await chrome.storage.local.get('promptOverrides');
  const base = promptOverrides[category] || DEFAULT_PROMPTS[category];
  return `${base}\n\nПредмет: ${subject}.`;
}
