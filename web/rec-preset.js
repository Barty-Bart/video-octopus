// What the record panel's sources start with, from the style's setup (the video type it is built on: core/pipelines.json
// formats), so Record on a faceless style doesn't start with the camera on. Pure: the server (browser-recorder.mjs
// recorderChoices) and the tests use it; the creator's own change in the panel is remembered per style over it.
// - Long-form · on camera (tutorial): the screen and the camera.
// - Long-form · voiceover (faceless): the screen, no camera.
// - Short / Reel (short): the camera alone, no screen.
// - Product explainer (explainer): the screen and the camera.
// A format's own "record" ({ "camera": false } or { "screen": false }) goes over its setup's.
export const SETUP_SOURCES = {
  tutorial: { screen: true, camera: true, words: 'screen and camera' },
  faceless: { screen: true, camera: false, words: 'screen and voice, no camera' },
  short: { screen: false, camera: true, words: 'camera only, no screen' },
  explainer: { screen: true, camera: true, words: 'screen and camera' },
};

export function presetSources(type, record = null) {
  const out = { ...(SETUP_SOURCES[type] || SETUP_SOURCES.tutorial) };
  if (record && typeof record === 'object') {
    if (typeof record.camera === 'boolean') out.camera = record.camera;
    if (typeof record.screen === 'boolean') out.screen = record.screen;
  }
  if (!SETUP_SOURCES[type] || record) {
    out.words = out.screen && out.camera ? 'screen and camera' : out.screen ? 'screen and voice, no camera' : out.camera ? 'camera only, no screen' : 'microphone only';
  }
  return out;
}

// The panel's start: the preset, or what was remembered for this style ({ screen: 'screen' | 'none', camera: id | 'none' }).
// device: the camera Settings › Recording remembers (used when the preset turns the camera on).
export function startSources(preset, remembered = null, device = 'default') {
  if (remembered && ['screen', 'none'].includes(remembered.screen) && typeof remembered.camera === 'string') {
    return { screen: remembered.screen, camera: remembered.camera || 'none', remembered: true };
  }
  return { screen: preset.screen ? 'screen' : 'none', camera: preset.camera ? (device && device !== 'none' ? device : 'default') : 'none', remembered: false };
}
