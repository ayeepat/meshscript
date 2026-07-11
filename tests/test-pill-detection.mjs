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
