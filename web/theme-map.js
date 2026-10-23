// Design V2 (23 Oct 2026): Video Octopus's ten looks became Light, Dark or Match system plus an accent.
// The old look ids map to a theme here for the browser's cached look (localStorage `studio.look`); the server maps the
// saved setting with the same table (server/settings.mjs THEME_OF_LOOK) and index.html's early script repeats it
// (test/appearance-theme.test.mjs keeps the three in step).
export const THEMES = ['light', 'dark', 'system'];
export const ACCENTS = ['orange', 'blue', 'green', 'violet'];
export const SIDEBARS = ['icons', 'labels'];

const DARK_LOOKS = ['night', 'frost', 'control', 'cinema', 'split'];
const LIGHT_LOOKS = ['paper', 'swiss', 'clay', 'atelier'];

// The old looks' names, for the one-time note in Settings › General.
export const OLD_LOOK_NAMES = {
  editbay: 'Edit Bay', night: 'Night Desk', paper: 'Paper Desk', frost: 'Frosted', swiss: 'Swiss', clay: 'Clay',
  atelier: 'Atelier', control: 'Control room', cinema: 'Cinema', split: 'Magenta & Blue',
};

export function themeOfLook(look) {
  if (DARK_LOOKS.includes(look)) return 'dark';
  if (LIGHT_LOOKS.includes(look)) return 'light';
  return 'system';
}

// The page's own background per theme, for the browser's theme-color.
export const GROUND = { light: '#f3f3f1', dark: '#0b0b0d' };
