/** Serialized GDZ book mutations owned by the service worker. */

import { normalizeGdzApiUrl } from './gdz-api.js';

let mutationQueue = Promise.resolve();

function subjectKey(value) {
  const text = String(value ?? '');
  if (text.length > 32 || !/^\d+$/.test(text)) return '';
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 0 ? String(number) : '';
}

export function normalizeGdzBooks(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized = {};
  for (const [rawSubjectId, raw] of Object.entries(value)) {
    const subjectId = subjectKey(rawSubjectId);
    if (!subjectId) continue;
    const seen = new Set();
    const books = [];
    for (const book of (Array.isArray(raw) ? raw : (raw ? [raw] : []))) {
      if (!book || typeof book !== 'object' || Array.isArray(book)) continue;
      const url = normalizeGdzApiUrl(book.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      books.push({
        ...book,
        url,
        subjectId: Number(subjectId),
        subject_id: Number(subjectId),
      });
    }
    if (books.length) normalized[subjectId] = books;
  }
  return normalized;
}

function mutateGdzBooks(mutator) {
  const run = mutationQueue.then(async () => {
    const { gdzBooks: stored = {} } = await chrome.storage.local.get('gdzBooks');
    const books = normalizeGdzBooks(stored);
    mutator(books);
    await chrome.storage.local.set({ gdzBooks: books });
    return books;
  });
  mutationQueue = run.catch(() => {});
  return run;
}

export function addGdzBook(book) {
  const subjectId = subjectKey(book?.subject_id ?? book?.subjectId);
  const url = normalizeGdzApiUrl(book?.url);
  if (!subjectId || !url) return Promise.reject(new Error('invalid GDZ book'));
  const storedBook = {
    ...book,
    url,
    subjectId: Number(subjectId),
    subject_id: Number(subjectId)
  };
  return mutateGdzBooks((books) => {
    const subjectBooks = books[subjectId] || [];
    if (!subjectBooks.some((item) => item.url === storedBook.url)) subjectBooks.push(storedBook);
    books[subjectId] = subjectBooks;
  });
}

export function removeGdzBook(subjectId, url) {
  const key = subjectKey(subjectId);
  const canonicalUrl = normalizeGdzApiUrl(url);
  if (!key || !canonicalUrl) return Promise.reject(new Error('invalid GDZ book removal'));
  return mutateGdzBooks((books) => {
    const remaining = (books[key] || [])
      .filter((book) => normalizeGdzApiUrl(book.url) !== canonicalUrl);
    if (remaining.length) books[key] = remaining;
    else delete books[key];
  });
}
