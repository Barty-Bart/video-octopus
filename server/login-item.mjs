// Open Video Octopus when I log in (Settings → Updates): one file the system reads at log-in, which runs this copy's
// start.sh / start.cmd with STUDIO_NO_OPEN=1, so Video Octopus starts in the background without opening the browser.
//   Mac:     ~/Library/LaunchAgents/local.video-octopus.plist (RunAtLoad; output in local/login.log)
//   Windows: Video Octopus.cmd in the Startup folder (starts start.cmd minimised; output in local\login.log)
//   Linux:   ~/.config/autostart/video-octopus.desktop (output in local/login.log)
// The switch shows whether that file is there, and off removes it. Video Octopus never turns it on by itself, and nothing is
// loaded or started now: the file only counts at the next log-in. STUDIO_LOGIN_DIR puts the file elsewhere (tests).
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { APP_DIR, LOCAL_DIR, shellPath, tildePath } from './util.mjs';

const LABEL = 'local.video-octopus';
const NAMES = { darwin: `${LABEL}.plist`, win32: 'Video Octopus.cmd' };

// Where the file goes on this system (read each time, so a test can point HOME or APPDATA elsewhere).
export function loginFile(platform = process.platform) {
  const dir = process.env.STUDIO_LOGIN_DIR
    || (platform === 'darwin' ? join(homedir(), 'Library', 'LaunchAgents')
      : platform === 'win32' ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
        : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'autostart'));
  return join(dir, NAMES[platform] || 'video-octopus.desktop');
}
const startScript = (platform = process.platform) => join(APP_DIR, platform === 'win32' ? 'start.cmd' : 'start.sh');
const logFile = () => join(LOCAL_DIR, 'login.log');

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// One argument of a .desktop Exec line: quoted when needed, then escaped again as a desktop-file string.
const desktopArg = (a) => (/[\s"'\\><~|&;$*?#()`]/.test(a) ? `"${a.replace(/(["`$\\])/g, '\\$1')}"` : a).replace(/\\/g, '\\\\');

// The file's contents for this copy of Video Octopus.
export async function loginContent(platform = process.platform) {
  const script = startScript(platform), log = logFile();
  if (platform === 'darwin') {
    // launchd starts agents with a bare PATH: give it the login shell's, so start.sh finds Node (nvm, Homebrew…).
    const env = { STUDIO_NO_OPEN: '1', PATH: await shellPath(), ...(process.env.STUDIO_LOCAL_DIR ? { STUDIO_LOCAL_DIR: LOCAL_DIR } : {}) };
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Opens Video Octopus when you log in (Video Octopus: Settings > Updates > Open Video Octopus when I log in). Switch it off there, or delete this file. -->
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${xml(script)}</string></array>
  <key>WorkingDirectory</key><string>${xml(APP_DIR)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
  }
  if (platform === 'win32') {
    return [
      '@echo off',
      'rem Opens Video Octopus when you log in (in Video Octopus: Settings, Updates, Open Video Octopus when I log in). Switch it off there, or delete this file.',
      'set STUDIO_NO_OPEN=1',
      ...(process.env.STUDIO_LOCAL_DIR ? [`set "STUDIO_LOCAL_DIR=${LOCAL_DIR}"`] : []),
      `start "Video Octopus" /min cmd /c ""${script}" >> "${log}" 2>&1"`,
      '',
    ].join('\r\n');
  }
  const env = ['STUDIO_NO_OPEN=1', `STUDIO_LOG=${log}`, ...(process.env.STUDIO_LOCAL_DIR ? [`STUDIO_LOCAL_DIR=${LOCAL_DIR}`] : [])];
  return `[Desktop Entry]
Type=Application
Name=Video Octopus
Comment=Opens Video Octopus when you log in (Video Octopus: Settings > Updates > Open Video Octopus when I log in)
Exec=${['env', ...env, '/bin/bash', script].map(desktopArg).join(' ')}
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

// The switch's real state: is the file there, and does it start this copy (another clone may have written it)?
export function loginState() {
  const file = loginFile();
  const on = existsSync(file);
  let here = false;
  if (on) { try { const t = readFileSync(file, 'utf8'); here = t.includes(startScript()) || t.includes(xml(startScript())); } catch {} }
  return { on, here, file, shown: tildePath(file), log: tildePath(logFile()), platform: process.platform };
}

// On writes the file (replacing one another copy wrote); off removes it.
export async function setLogin(on) {
  const file = loginFile();
  if (!on) { rmSync(file, { force: true }); return loginState(); }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await loginContent());
  return loginState();
}
