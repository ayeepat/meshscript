export function assertSoundtrackFreshness({checkedIn, generations}) {
  if (!Buffer.isBuffer(checkedIn) || !Array.isArray(generations) ||
      generations.length !== 2 || generations.some((value) => !Buffer.isBuffer(value))) {
    throw new TypeError('soundtrack freshness requires one repository file and two generations');
  }
  if (!generations[0].equals(generations[1])) {
    throw new Error('identical soundtrack generations produced different bytes');
  }
  if (!generations[0].equals(checkedIn)) {
    throw new Error('public/assets/soundtrack.wav is stale; run npm run audio');
  }
}
