/**
 * Background service worker (MV3, type: module).
 * Orchestrates the AI provider call and Supabase persistence.
 * All API keys live here / in storage, never in content scripts.
 */
import { askAI } from '../lib/ai.js';
import { buildSystemPrompt, categoryForSubject } from '../lib/subject-router.js';
import { PROMPT_CATEGORIES } from '../lib/prompts.js';
import { createSession, addMessage, listSessions, listMessages } from '../lib/supabase.js';

// Open the full-window dashboard when the popup asks to "Solve".
async function openDashboard(payload) {
  const url = chrome.runtime.getURL(
    `src/dashboard/dashboard.html?subject=${encodeURIComponent(payload.subject)}` +
    `&task=${encodeURIComponent(payload.task || '')}` +
    `&day=${encodeURIComponent(payload.day || '')}`
  );
  await chrome.tabs.create({ url });
}

// NOTE: an earlier version attempted a GDZ (reshebnik) lookup before the AI
// call. GDZ sits behind Cloudflare's JS challenge, the fetch always failed,
// and its result was discarded — it only added latency to every solve. The
// AI provider is the solver.

/** Solve a task with the AI provider + chat history. Persist to Supabase. */
async function solve({ subject, task, files = [], sessionId = null, history = [] }) {
  const category = categoryForSubject(subject);

  // Russian-full guard: bare "Упр 25" with no image -> ask for a photo.
  if (category === PROMPT_CATEGORIES.RUSSIAN_FULL) {
    const bareExercise = /^(упр|упражнение|ex|exercise|№)\s*\.?\s*\d+/i.test((task || '').trim());
    if (bareExercise && files.length === 0) {
      const ask = 'Чтобы выписать упражнение без ошибок, загрузите, пожалуйста, фото страницы учебника с этим упражнением.';
      return { answer: ask, needsUpload: true, sessionId };
    }
  }

  const systemPrompt = await buildSystemPrompt(subject);
  const answer = await askAI(systemPrompt, task || '(см. вложение)', files, history);

  // Persist (non-fatal if Supabase not configured).
  try {
    let sid = sessionId;
    if (!sid) {
      const session = await createSession(subject, task);
      sid = session.id;
      await addMessage(sid, 'user', task || '(файл)');
    } else {
      await addMessage(sid, 'user', task || '(файл)');
    }
    await addMessage(sid, 'assistant', answer);
    return { answer, sessionId: sid };
  } catch (e) {
    return { answer, sessionId, storageError: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'OPEN_DASHBOARD':
          await openDashboard(msg.payload);
          sendResponse({ ok: true });
          break;
        case 'SOLVE':
          sendResponse({ ok: true, result: await solve(msg.payload) });
          break;
        case 'LIST_SESSIONS':
          sendResponse({ ok: true, sessions: await listSessions() });
          break;
        case 'LIST_MESSAGES':
          sendResponse({ ok: true, messages: await listMessages(msg.sessionId) });
          break;
        default:
          sendResponse({ ok: false, error: 'Unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // async
});
