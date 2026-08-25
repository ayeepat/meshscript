import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {RELEASE_ASSETS} from '../src/release-assets.mjs';
import {assertSoundtrackFreshness} from '../scripts/audio_freshness.mjs';
import {validateReleaseAssetFiles} from '../scripts/release_asset_validation.mjs';
import {validateRenderedSceneFrames} from '../scripts/scene_render_validation.mjs';

test('a missing later test-scan asset is rejected without touching repository files', async () => {
  const emptyMotionRoot = await mkdtemp(
    path.join(os.tmpdir(), 'smesh-missing-test-scan-')
  );
  await assert.rejects(
    validateReleaseAssetFiles({
      motionRoot: emptyMotionRoot,
      releaseAssets: {testScan: RELEASE_ASSETS.testScan},
      fps: 60,
    }),
    /testScan \(assets\/v3\/test-scan\.mp4\): file is missing/
  );
});

test('a valid-format but wrong video cannot replace a pinned release asset', async () => {
  const temporaryMotionRoot = await mkdtemp(
    path.join(os.tmpdir(), 'smesh-wrong-test-scan-')
  );
  const targetDirectory = path.join(temporaryMotionRoot, 'public', 'assets', 'v3');
  await mkdir(targetDirectory, {recursive: true});
  await copyFile(
    new URL('../public/assets/finding-1920-60fps.mp4', import.meta.url),
    path.join(targetDirectory, 'test-scan.mp4')
  );
  await assert.rejects(
    validateReleaseAssetFiles({
      motionRoot: temporaryMotionRoot,
      releaseAssets: {testScan: RELEASE_ASSETS.testScan},
      fps: 60,
    }),
    /testScan \(assets\/v3\/test-scan\.mp4\): SHA-256 mismatch/
  );
});

test('a stale repository soundtrack is rejected after deterministic generations', () => {
  const generated = Buffer.from('fresh deterministic soundtrack');
  assert.throws(
    () => assertSoundtrackFreshness({
      checkedIn: Buffer.from('stale soundtrack'),
      generations: [generated, Buffer.from(generated)],
    }),
    /soundtrack\.wav is stale/
  );
});

test('two identical fresh generations matching the repository soundtrack pass', () => {
  const generated = Buffer.from('fresh deterministic soundtrack');
  assert.doesNotThrow(() => assertSoundtrackFreshness({
    checkedIn: Buffer.from(generated),
    generations: [generated, Buffer.from(generated)],
  }));
});

test('byte-identical scene outputs cannot masquerade as distinct frame probes', async () => {
  const png = await readFile(new URL('../public/assets/logo-mark.png', import.meta.url));
  assert.throws(
    () => validateRenderedSceneFrames({
      renders: [
        {filename: 'scene-00.png', buffer: png},
        {filename: 'scene-01.png', buffer: Buffer.from(png)},
      ],
      sceneProbes: [
        {id: 'opening', frame: 60},
        {id: 'later-scene', frame: 960},
      ],
      expectedWidth: 1024,
      expectedHeight: 1024,
    }),
    /later-scene@960 is byte-identical to another scene render/
  );
});
