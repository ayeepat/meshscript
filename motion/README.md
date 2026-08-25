# СМЭШ AI motion ad

The `SmeshAd` composition is 20 seconds at 1920×1080 and 60 fps. Its soundtrack is generated from code, then embedded in the Remotion composition and preserved through the final FFmpeg transcode.

## Prerequisites

- Node.js 24 or newer
- Python 3.13
- NumPy at the exact version pinned in `requirements.txt`
- FFmpeg and FFprobe 6.1 or newer

Install the locked JavaScript and Python dependencies:

```sh
npm ci
python3 -m pip install --require-hashes -r requirements.txt
```

Regenerate the deterministic 20-second soundtrack when its generator changes:

```sh
npm run audio
```

Run the complete release gate:

```sh
npm run check
```

The gate compares the repository soundtrack with two fresh generations, validates
every referenced image, font, WAV, and MP4, fully decodes all five H.264 source
videos, and renders representative reduced-scale frames from every scene. It
therefore fails on stale audio and on missing, corrupt, undersized, short, or
wrongly encoded later-scene media.

Render the release file with:

```sh
npm run render
```

The render command re-runs release-asset and soundtrack-freshness checks before
rendering. It requires an audio stream in the Remotion output and maps it
explicitly into the final MP4, so missing or stale audio cannot silently ship.
