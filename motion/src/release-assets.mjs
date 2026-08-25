const image = (path, width, height, sha256) =>
  Object.freeze({
    type: 'image',
    path,
    width,
    height,
    sha256,
  });

const video = ({
  path,
  sha256,
  minimumWidth,
  minimumHeight,
  startFrame,
  endFrame,
  trimBefore = 0,
  playbackRate = 1,
}) =>
  Object.freeze({
    type: 'video',
    path,
    sha256,
    minimumWidth,
    minimumHeight,
    scene: Object.freeze({
      startFrame,
      endFrame,
      durationInFrames: endFrame - startFrame,
      trimBefore,
      playbackRate,
    }),
  });

export const RELEASE_ASSETS = Object.freeze({
  logo: image(
    'assets/logo-mark.png', 1024, 1024,
    'a00d03a5042952bf9bc0bb99aef6288e84ca23b286d045a77318052633402260'
  ),
  store: image(
    'assets/v3/store.png', 3344, 1882,
    'e6874c114d479020e330637eedeb9294da1b6ed208af8eb90ce775ce7b537b69'
  ),
  soundtrack: Object.freeze({
    type: 'audio',
    path: 'assets/soundtrack.wav',
    sha256: 'fd876124d5e65eba6affe595d3a48c4fdf79999da0d0d34be9cdfb724512f331',
    codec: 'pcm_s16le',
    channels: 2,
    sampleRate: 48_000,
    bitsPerSample: 16,
    durationSeconds: 20,
  }),
  testScan: video({
    path: 'assets/v3/test-scan.mp4',
    sha256: '41980068397d382721222e8a3b88064663bf13e37bec53f783c54bc726cb26cb',
    minimumWidth: 1320,
    minimumHeight: 714,
    startFrame: 170,
    endFrame: 352,
  }),
  testAnswers: video({
    path: 'assets/v3/test-answers.mp4',
    sha256: '6cc796ec65d2e8d63249c1f70447fdb1d6802e8f78978017545c40d49b4633b7',
    minimumWidth: 1710,
    minimumHeight: 925,
    startFrame: 346,
    endFrame: 526,
  }),
  testFill: video({
    path: 'assets/v3/test-fill.mp4',
    sha256: '1d3ace9e8789d69e8844720c6f3c9b063ef7a5ffa099d2182784c3fd2db65b4b',
    minimumWidth: 1720,
    minimumHeight: 929,
    startFrame: 510,
    endFrame: 715,
  }),
  homeworkPopup: video({
    path: 'assets/v3/homework-popup.mp4',
    sha256: 'c3cf12745bd0919892d1e3611f2f1aa0bd11d95e8fa15d034a0e2a3267088e9c',
    minimumWidth: 1325,
    minimumHeight: 717,
    startFrame: 702,
    endFrame: 888,
  }),
  pdfDone: image(
    'assets/v3/pdf-done.png', 2880, 1558,
    'fcb35db114dc55086a2fb8e16442e101c2dc3419138dbe1a51e6da734be68ec3'
  ),
  gdzResult: video({
    path: 'assets/v3/gdz-result.mp4',
    sha256: '986ad49e9633c8c57318e3c216315472cd219170bb58aa0f3163ffbacadd504e',
    minimumWidth: 1325,
    minimumHeight: 756,
    startFrame: 882,
    endFrame: 1074,
  }),
});

export const RELEASE_FONT_ASSETS = Object.freeze({
  manropeCyrillic: Object.freeze({
    path: 'src/assets/manrope-cyrillic.woff2',
    cssUrl: './assets/manrope-cyrillic.woff2',
    sha256: '95a493061fe0a8d0d027c2892747134ba747141112d3be4d5022e70ab7d3a1a6',
  }),
  manropeLatin: Object.freeze({
    path: 'src/assets/manrope-latin.woff2',
    cssUrl: './assets/manrope-latin.woff2',
    sha256: 'e310b55a7fd9677f5e3555e6c6c4d064fa1f1d24393f0ddbe217cea12a8c432f',
  }),
  unboundedCyrillic: Object.freeze({
    path: 'src/assets/unbounded-cyrillic.woff2',
    cssUrl: './assets/unbounded-cyrillic.woff2',
    sha256: 'c3880f0c5afb7890a102bc4b9c8257703664388f708b4be880ec5f5f68e8ea9d',
  }),
  unboundedLatin: Object.freeze({
    path: 'src/assets/unbounded-latin.woff2',
    cssUrl: './assets/unbounded-latin.woff2',
    sha256: 'd7f07f8a308ce0a7287d79a65a85cfbc0f4741ef426bf1a3902d24392cc71723',
  }),
});

const sceneProbe = (id, frame, assetKeys) =>
  Object.freeze({
    id,
    frame,
    assetKeys: Object.freeze(assetKeys),
  });

// Each probe frame is intentionally inside visible content. The release gate
// renders these evenly spaced frames directly from the production SmeshAd
// composition in one image-sequence/browser session.
export const RELEASE_SCENE_PROBES = Object.freeze([
  sceneProbe('opening', 0, ['store']),
  sceneProbe('connect', 155, ['logo']),
  sceneProbe('test-scan', 310, ['testScan']),
  sceneProbe('answers', 465, ['testAnswers']),
  sceneProbe('autofill', 620, ['testFill']),
  sceneProbe('pdf', 775, ['homeworkPopup', 'pdfDone']),
  sceneProbe('gdz', 930, ['gdzResult']),
  sceneProbe('end-card', 1085, ['logo']),
]);
