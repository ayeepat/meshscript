import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const pillSource = readFileSync(new URL('../src/content/test-pill.js', import.meta.url), 'utf8');

function detectorFor(rawUrl, iframeSources = []) {
  const url = new URL(rawUrl);
  let storageReads = 0;
  const window = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    addEventListener() {}
  };
  const context = {
    window,
    location: {
      href: url.href,
      pathname: url.pathname,
      search: url.search
    },
    document: {
      fonts: null,
      querySelectorAll(selector) {
        assert.equal(selector, 'iframe[src]');
        return iframeSources.map((src) => ({ getAttribute: () => src }));
      }
    },
    chrome: {
      storage: {
        session: {
          // Keep the async build suspended: this test exercises detection only.
          get() { storageReads += 1; }
        }
      }
    },
    setInterval() {},
    clearInterval() {},
    setTimeout() {},
    clearTimeout() {},
    console
  };
  window.window = window;

  vm.runInNewContext(pillSource, context, { filename: 'test-pill.js' });
  return {
    looksLikeTest: window.__smeshPill.looksLikeTest,
    buildStarted: () => storageReads === 3
  };
}

const reportedRoute = detectorFor('https://school.mos.ru/01math/maths/test?subcategory_id=1062');
assert.equal(
  reportedRoute.looksLikeTest(),
  true,
  'the current Digital Teacher maths test route must show the solve pill'
);
assert.equal(
  reportedRoute.buildStarted(),
  true,
  'detecting the reported route must start mounting the pill'
);

// «Цифровой учитель» / Фундаментальные науки — the 2026 inline task route. The
// task renders directly in the page (no xAPI iframe), so route detection is the
// only signal; the pill must still appear.
const dtTaskRoute = detectorFor('https://school.mos.ru/dt/fundamental/maths/go?subcategory_id=2172');
assert.equal(
  dtTaskRoute.looksLikeTest(),
  true,
  'the Digital Teacher /dt task route must show the solve pill'
);
assert.equal(
  dtTaskRoute.buildStarted(),
  true,
  'detecting the /dt task route must start mounting the pill'
);

// A /dt task view identified by subcategory_id alone (no /go segment) still counts.
assert.equal(
  detectorFor('https://school.mos.ru/dt/fundamental/physics/task?subcategory_id=88').looksLikeTest(),
  true,
  'a /dt task view carrying subcategory_id is detected even without a /go segment'
);

// …but a bare /dt catalog/landing page (no /go, no subcategory_id) stays quiet.
assert.equal(
  detectorFor('https://school.mos.ru/dt/fundamental/maths').looksLikeTest(),
  false,
  'the /dt topic catalog (no task markers) must not trip the pill'
);

assert.equal(
  detectorFor('https://school.mos.ru/library/test').looksLikeTest(),
  false,
  'an unrelated page containing only a generic /test segment stays excluded'
);

assert.equal(
  detectorFor('https://school.mos.ru/lesson?lesson_id=42').looksLikeTest(),
  false,
  'a lesson id by itself stays excluded'
);

assert.equal(
  detectorFor('https://school.mos.ru/course/cwork').looksLikeTest(),
  true,
  'existing strong test routes remain detected'
);

console.log('test-pill detection regression passed');
