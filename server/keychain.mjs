// API keys, kept by the operating system, one item per key name:
// - Mac: the login Keychain (service "Video Octopus"), through Apple's `security` tool. A value goes in on stdin
//   (`security -i`), so it never shows in the process list, a file or a log.
// - Windows: a file per key in Video Octopus's local/keys, encrypted with DPAPI for the signed-in Windows user (PowerShell's
//   ConvertFrom-SecureString): only that user on that PC can read it back. The value goes in on stdin here too.
// - Linux: the desktop keyring through `secret-tool` (libsecret) when it's there; otherwise a file per key in
//   local/keys that only this user may read (0600), and Settings says so.
// A key only comes back out to be passed to a child process as an environment variable. The app never shows it.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { IS_MAC, IS_WIN, LOCAL_DIR } from './util.mjs';

const SERVICE = process.env.STUDIO_KEYCHAIN_SERVICE || 'Video Octopus';
const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
// API keys are printable ASCII without spaces; quotes and backslashes would break `security -i`'s quoting.
const VALUE = /^[\x21-\x7e]{1,4096}$/;

const SECRET_TOOL = !IS_MAC && !IS_WIN ? ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool'].find((p) => existsSync(p)) || null : null;
// What the Settings page says keeps the keys.
export const KEY_STORE = IS_MAC ? 'the Keychain' : IS_WIN ? 'Windows (encrypted for your user)' : SECRET_TOOL ? 'the system keyring' : 'a private file on this computer (not encrypted)';

const checkName = (name) => { if (!NAME.test(name || '')) throw new Error('Bad key name.'); };

// ---- Mac: the Keychain ----
const sec = (args) => new Promise((done) => {
  execFile('/usr/bin/security', args, { timeout: 8000 }, (err, stdout, stderr) => done({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') }));
});

const mac = {
  // Reads the item's attributes only, not the secret.
  has: async (name) => (await sec(['find-generic-password', '-s', SERVICE, '-a', name])).code === 0,
  read: async (name) => {
    const r = await sec(['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
    return r.code === 0 ? r.stdout.replace(/\n$/, '') : null;
  },
  save: (name, value) => new Promise((done, fail) => {
    const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', fail);
    p.on('exit', () => done(err));
    // -U updates the item if it's there already.
    p.stdin.end(`add-generic-password -U -s "${SERVICE}" -a "${name}" -l "Video Octopus: ${name}" -w "${value}"\n`);
  }),
  remove: (name) => sec(['delete-generic-password', '-s', SERVICE, '-a', name]),
};

// ---- Windows (DPAPI) and Linux: one file per key ----
const KEY_DIR = join(LOCAL_DIR, 'keys');
const keyFile = (name) => join(KEY_DIR, `${name}.key`);

// PowerShell with the script as its command and `input` on stdin; the file path goes in an environment variable,
// so nothing needs quoting.
const ps = (script, input = '', env = {}) => new Promise((done) => {
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', (e) => done({ code: 1, out: '', err: String(e) }));
  p.on('exit', (code) => done({ code, out, err }));
  p.stdin.end(input);
});
const ENCRYPT = '$v = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $v -AsPlainText -Force | ConvertFrom-SecureString';
const DECRYPT = '$s = ConvertTo-SecureString ((Get-Content -Raw -LiteralPath $env:STUDIO_KEY_FILE).Trim()); '
  + '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))';

const files = {
  has: async (name) => existsSync(keyFile(name)),
  read: async (name) => {
    if (!existsSync(keyFile(name))) return null;
    if (!IS_WIN) return readFileSync(keyFile(name), 'utf8').trim() || null;
    const r = await ps(DECRYPT, '', { STUDIO_KEY_FILE: keyFile(name) });
    return r.code === 0 ? r.out.trim() || null : null;
  },
  save: async (name, value) => {
    mkdirSync(KEY_DIR, { recursive: true });
    let text = value;
    if (IS_WIN) {
      const r = await ps(ENCRYPT, value);
      if (r.code !== 0 || !r.out.trim()) throw new Error('Windows couldn’t encrypt the key.');
      text = r.out.trim();
    }
    writeFileSync(keyFile(name), text + '\n', { mode: 0o600 });
  },
  remove: async (name) => { try { unlinkSync(keyFile(name)); } catch {} },
};

// ---- Linux: the keyring (secret-tool); the value goes in on stdin ----
const st = (args, input) => new Promise((done) => {
  const p = spawn(SECRET_TOOL, args, { stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', () => done({ code: 1, out: '' }));
  p.on('exit', (code) => done({ code, out }));
  p.stdin.end(input || '');
});
const keyring = {
  has: async (name) => Boolean((await st(['lookup', 'service', SERVICE, 'account', name])).out),
  read: async (name) => (await st(['lookup', 'service', SERVICE, 'account', name])).out.trim() || null,
  save: (name, value) => st(['store', `--label=Video Octopus: ${name}`, 'service', SERVICE, 'account', name], value),
  remove: (name) => st(['clear', 'service', SERVICE, 'account', name]),
};

const store = IS_MAC ? mac : SECRET_TOOL ? keyring : files;

// Is the key saved?
export async function hasKey(name) {
  checkName(name);
  return store.has(name);
}

// The secret itself, for a child process's environment only. null when not saved.
export async function readKey(name) {
  checkName(name);
  return store.read(name);
}

export async function saveKey(name, value) {
  checkName(name);
  value = String(value ?? '').trim();
  if (!VALUE.test(value) || /["\\]/.test(value)) throw new Error('That doesn’t look like an API key (no spaces, quotes or backslashes).');
  await store.save(name, value);
  if (IS_MAC && !(await hasKey(name))) throw new Error('The Keychain didn’t take the key. Is the login keychain locked?');
  if (!IS_MAC && (await readKey(name)) !== value) throw new Error('The key didn’t save. Try again.');
}

export async function removeKey(name) {
  checkName(name);
  await store.remove(name);
  return !(await hasKey(name));
}
