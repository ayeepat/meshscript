import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { awaitStablePendingRead } from '../src/lib/pending-read.js';

let releaseA;
let releaseB;
const fileA = new Promise((resolve) => { releaseA = resolve; });
const fileB = new Promise((resolve) => { releaseB = resolve; });
let current = fileA;
let settled = false;
const wait = awaitStablePendingRead(() => current).then(() => { settled = true; });

// The user replaces A with B while the send/launch click is waiting for A.
current = fileB;
releaseA();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(settled, false, 'resolving stale file A must not release a send that now owns file B');

current = null;
releaseB();
await wait;
assert.equal(settled, true, 'the stable replacement read must eventually release the action');

const dashboard = readFileSync(new URL('../src/dashboard/dashboard.js', import.meta.url), 'utf8');
const composer = dashboard.slice(
  dashboard.indexOf('async function sendFromComposer()'),
  dashboard.indexOf("document.getElementById('send').onclick")
);
assert.match(composer, /const draftAtClick = inputEl\.value;/,
  'composer must snapshot the draft before awaiting a file');
assert.match(composer, /activeChat\(\) !== chat[\s\S]*?fileReadGen !== fileGenAtClick[\s\S]*?inputEl\.value !== draftAtClick/,
  'composer must abort if lesson, attachment intent, or draft changes while awaiting');

const popup = readFileSync(new URL('../src/popup/popup.js', import.meta.url), 'utf8');
assert.match(popup, /await awaitStablePendingRead\(\(\) => cardObj\.readPromise\)/,
  'popup launch must await the stable per-card file read');
assert.match(popup, /cardObj\.launching = true;[\s\S]*?input\.disabled = true;/,
  'popup must lock replacement file selection while a row launch is being assembled');

console.log('pending read race regressions passed');
