/**
 * Russian noun pluralisation. Russian picks one of three forms by the count:
 *   1, 21, 31…      → `one`   («1 файл»)
 *   2–4, 22–24…     → `few`   («3 файла»)
 *   0, 5–20, 25…    → `many`  («5 файлов»)
 * (11–14 are `many` despite ending in 1–4 — the classic exception.)
 */
export function pluralRu(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
}

/** «1 файл» / «3 файла» / «5 файлов». */
export function filesLabel(n) {
  return `${n} ${pluralRu(n, 'файл', 'файла', 'файлов')}`;
}
