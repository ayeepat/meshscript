#!/usr/bin/env node

import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SMESH_AD_COMPOSITION} from '../src/composition.mjs';
import {
  RELEASE_ASSETS,
  RELEASE_FONT_ASSETS,
  RELEASE_SCENE_PROBES,
} from '../src/release-assets.mjs';
import {
  validateReleaseAssetFiles,
  validateReleaseManifest,
  validateSourceAssetCoverage,
} from './release_asset_validation.mjs';

const motionRoot = fileURLToPath(new URL('..', import.meta.url));
const javascriptFiles = [
  'src/SmeshAd.jsx',
  'src/SceneProbe.jsx',
  'src/Root.jsx',
  'src/composition.mjs',
  'src/release-assets.mjs',
];
const javascriptSources = Object.fromEntries(
  await Promise.all(
    javascriptFiles.map(async (relativePath) => [
      relativePath,
      await readFile(path.join(motionRoot, relativePath), 'utf8'),
    ])
  )
);
const stylesheetSource = await readFile(
  path.join(motionRoot, 'src', 'style.css'),
  'utf8'
);

validateReleaseManifest({
  releaseAssets: RELEASE_ASSETS,
  fontAssets: RELEASE_FONT_ASSETS,
  sceneProbes: RELEASE_SCENE_PROBES,
  composition: SMESH_AD_COMPOSITION,
});
validateSourceAssetCoverage({
  javascriptSources,
  stylesheetSource,
  releaseAssets: RELEASE_ASSETS,
  fontAssets: RELEASE_FONT_ASSETS,
});
const summaries = await validateReleaseAssetFiles({
  motionRoot,
  releaseAssets: RELEASE_ASSETS,
  fontAssets: RELEASE_FONT_ASSETS,
  fps: SMESH_AD_COMPOSITION.fps,
});

const videoCount = Object.values(RELEASE_ASSETS)
  .filter((asset) => asset.type === 'video')
  .length;
console.log(
  `motion release assets passed (${Object.keys(summaries).length} files, ` +
  `${videoCount} full MP4 decodes, ${RELEASE_SCENE_PROBES.length} scene probes declared)`
);
