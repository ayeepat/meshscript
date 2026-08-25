import assert from 'node:assert/strict';
import { parseRefs } from '../src/lib/gdz-match.js';

assert.deepEqual(parseRefs('Р.т. Упр. 1'), {
  textbook: { pages: [], exercises: [] },
  workbook: { pages: [], exercises: [1] }
});

assert.deepEqual(parseRefs('Р.т. упр. 1. Упр. 2'), {
  textbook: { pages: [], exercises: [] },
  workbook: { pages: [], exercises: [1, 2] }
});

assert.deepEqual(parseRefs('Упр. 3\nР.т. упр. 1'), {
  textbook: { pages: [], exercises: [3] },
  workbook: { pages: [], exercises: [1] }
});

assert.deepEqual(parseRefs('Р.т. с. 5. Учебник упр. 2'), {
  textbook: { pages: [], exercises: [2] },
  workbook: { pages: [5], exercises: [] }
});

assert.deepEqual(parseRefs('Р.т. упр. 1\nУпр. 2'), {
  textbook: { pages: [], exercises: [2] },
  workbook: { pages: [], exercises: [1] }
});

assert.deepEqual(parseRefs('Учебник и Р.т. упр. 4'), {
  textbook: { pages: [], exercises: [] },
  workbook: { pages: [], exercises: [4] }
}, 'a fragment containing both explicit markers must stay in workbook context');

assert.deepEqual(parseRefs('Р.т. упр. 1, учебник упр. 2'), {
  textbook: { pages: [], exercises: [2] },
  workbook: { pages: [], exercises: [1] }
}, 'same-sentence references must follow the most recent book marker');

assert.deepEqual(parseRefs('Учебник упр. 3, затем Р.т. упр. 4, учебник с. 8'), {
  textbook: { pages: [8], exercises: [3] },
  workbook: { pages: [], exercises: [4] }
}, 'book context must be allowed to switch more than once within one line');

assert.deepEqual(parseRefs('Р.т. и учебник упр. 5'), {
  textbook: { pages: [], exercises: [5] },
  workbook: { pages: [], exercises: [] }
}, 'the last explicit marker before a reference wins regardless of marker type');

assert.deepEqual(parseRefs('Контурная карта. Упр. 3'), {
  textbook: { pages: [], exercises: [3] },
  workbook: { pages: [], exercises: [] }
});

assert.deepEqual(parseRefs('Повторить четверть. Задание 2'), {
  textbook: { pages: [], exercises: [2] },
  workbook: { pages: [], exercises: [] }
});

assert.deepEqual(parseRefs('р. т. упр. 4'), {
  textbook: { pages: [], exercises: [] },
  workbook: { pages: [], exercises: [4] }
});

console.log('GDZ match context regression passed');
