import {createHash} from 'node:crypto';
import {inspectPng} from './release_asset_validation.mjs';

export function validateRenderedSceneFrames({
  renders,
  sceneProbes,
  expectedWidth,
  expectedHeight,
}) {
  if (!Array.isArray(renders) || !Array.isArray(sceneProbes)) {
    throw new TypeError('scene renders and probes must be arrays');
  }
  if (renders.length !== sceneProbes.length) {
    throw new Error(
      `scene render emitted ${renders.length} PNGs; expected ${sceneProbes.length}`
    );
  }

  const hashes = new Set();
  const summaries = [];
  for (let index = 0; index < sceneProbes.length; index += 1) {
    const probe = sceneProbes[index];
    const render = renders[index];
    if (!Buffer.isBuffer(render?.buffer)) {
      throw new Error(`${probe.id}@${probe.frame} did not produce a PNG buffer`);
    }
    const dimensions = inspectPng(render.buffer);
    if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
      throw new Error(
        `${probe.id}@${probe.frame} is ${dimensions.width}x${dimensions.height}; ` +
        `expected ${expectedWidth}x${expectedHeight}`
      );
    }
    const sha256 = createHash('sha256').update(render.buffer).digest('hex');
    if (hashes.has(sha256)) {
      throw new Error(
        `${probe.id}@${probe.frame} is byte-identical to another scene render ` +
        `(sha256 ${sha256})`
      );
    }
    hashes.add(sha256);
    summaries.push({
      id: probe.id,
      frame: probe.frame,
      filename: render.filename,
      sha256,
    });
  }
  return summaries;
}
