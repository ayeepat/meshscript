/** Mark clipped source text explicitly so the model never mistakes an incomplete file for complete material. */
export function clipText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const readableLimit = maxChars.toLocaleString('ru-RU').replace(/\s/g, ' ');
  return text.slice(0, maxChars) +
    `\n[…текст обрезан: файл длиннее ${readableLimit} символов, показано начало]`;
}
