import React from 'react';
import {Composition} from 'remotion';
import {SmeshAd} from './SmeshAd.jsx';
import {
  SMESH_AD_COMPOSITION,
  SMESH_AD_COMPOSITION_ID,
} from './composition.mjs';
import './style.css';

export const RemotionRoot = () => (
  <Composition
    id={SMESH_AD_COMPOSITION_ID}
    component={SmeshAd}
    {...SMESH_AD_COMPOSITION}
  />
);
