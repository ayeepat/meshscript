import {RELEASE_ASSETS} from './release-assets.mjs';

export const SMESH_AD_COMPOSITION_ID = 'SmeshAd';

export const SMESH_AD_COMPOSITION = Object.freeze({
  durationInFrames: 1200,
  fps: 60,
  width: 1920,
  height: 1080,
});

export const SMESH_AD_DURATION_SECONDS =
  SMESH_AD_COMPOSITION.durationInFrames / SMESH_AD_COMPOSITION.fps;

export const SMESH_AD_SOUNDTRACK = RELEASE_ASSETS.soundtrack.path;
