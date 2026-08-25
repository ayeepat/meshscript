import React from 'react';
import {Freeze, useCurrentFrame} from 'remotion';
import {RELEASE_SCENE_PROBES} from './release-assets.mjs';
import {SmeshAd} from './SmeshAd.jsx';

export const SmeshAdSceneProbe = () => {
  const probeIndex = useCurrentFrame();
  const probe = RELEASE_SCENE_PROBES[probeIndex];
  if (!probe) {
    throw new Error(`Scene probe frame ${probeIndex} is not declared`);
  }

  return (
    <Freeze frame={probe.frame}>
      <SmeshAd />
    </Freeze>
  );
};
