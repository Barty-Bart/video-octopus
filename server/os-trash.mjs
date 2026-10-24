// The computer's own Bin: Delete recording (the editor's Media section) and the Recordings page's Delete send what they
// delete there, so it is gone from Video Octopus and from the studio, and the creator gets it back the way they get any
// file back. Nothing is ever deleted outright: when no Bin can take it, it stays in the studio's trash (.trash) instead.
//
// What goes: one folder of the studio's trash (<studio>/.trash/<when>-<item>/, with its manifest.json), so the Bin holds
// one item per delete and Finder's Put Back returns it to the studio's trash, where Settings › Storage › Trash can put it
// back into its video.
//
// - macOS: Finder ("tell application Finder to delete", so Put Back works), which asks the creator once whether Video
//   Octopus may control Finder; refused or not answering → /usr/bin/trash (macOS 15+); else a rename into ~/.Trash.
//   Only for a folder on the home folder's disk: Finder empties a network or external disk's items at once, so those
//   stay in the studio's trash.
// - Windows: the Recycle Bin through PowerShell and .NET (Microsoft.VisualBasic.FileIO.FileSystem, SendToRecycleBin),
//   only on a fixed drive: a network or removable drive has no Recycle Bin and would delete for good.
// - Anything else: the studio's trash.
//
// sendToBin(path) → { where, how, path, putBack } or null (it's still where it was). Tests pass a fake with setBinMover.
import { execFile } from 'node:child_process';
import { existsSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec = (bin, args, opts = {}) => new Promise((done) => {
  execFile(bin, args, { timeout: 45000, windowsHide: true, ...opts }, (err, stdout, stderr) => done({ err, out: String(stdout || ''), errOut: String(stderr || '') }));
});

// Finder's delete, one path per argument (never pasted into the script): it prints where each one went in the Trash.
export const FINDER_SCRIPT = ['on run argv', 'set out to ""', 'repeat with p in argv', 'set f to POSIX file (contents of p) as alias',
  'tell application "Finder" to set r to delete f', 'set out to out & POSIX path of (r as alias) & linefeed', 'end repeat', 'return out', 'end run'];
// The Recycle Bin: the path comes in an environment variable, so nothing in it is ever read as PowerShell.
// Exit 3: not a fixed drive (no Recycle Bin there).
export const RECYCLE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$p = $env:VO_BIN_PATH',
  "$d = New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($p))",
  "if ($p.StartsWith('\\\\') -or $d.DriveType -ne 'Fixed') { exit 3 }",
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  "if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
].join('; ');

const WHERE = { darwin: 'the Trash', win32: 'the Recycle Bin' };
export const binName = (platform = process.platform) => WHERE[platform] || null;

let mover = null;
// Tests: a fake Bin (path → result or null). null puts the real one back.
export function setBinMover(fn) { mover = fn; }

let finderRefused = false; // the creator said no to Finder once: don't ask again until Video Octopus restarts

// A free name in ~/.Trash, as Finder would pick: "name", "name 2", "name 3"…
function freeName(dir, name) {
  let n = name;
  for (let i = 2; existsSync(join(dir, n)); i++) n = `${name} ${i}`;
  return join(dir, n);
}

export async function sendToBin(path, { platform = process.platform, home = homedir(), run = exec } = {}) {
  if (mover) return mover(path);
  if (!existsSync(path)) return null;
  // Disposable test studios (browser checks): a folder stands in for the Bin, so a real Trash is never touched.
  if (process.env.OCTOPUS_FAKE_BIN) {
    const to = freeName(process.env.OCTOPUS_FAKE_BIN, basename(path));
    renameSync(path, to);
    return { where: 'the test Bin', how: 'fake', path: to, putBack: false };
  }
  if (platform === 'darwin') return macBin(path, { home, run });
  if (platform === 'win32') return windowsBin(path, { run });
  return null;
}

async function macBin(path, { home, run }) {
  let same = false;
  try { same = statSync(path).dev === statSync(home).dev; } catch {}
  if (!same) return null;
  if (!finderRefused) {
    const r = await run('/usr/bin/osascript', [...FINDER_SCRIPT.flatMap((l) => ['-e', l]), path]);
    if (!r.err && !existsSync(path)) return { where: WHERE.darwin, how: 'finder', path: r.out.trim().split('\n')[0] || null, putBack: true };
    // -1743: not allowed to control Finder (Privacy & Security › Automation).
    if (/-1743|not authori[sz]ed|not allowed/i.test(r.errOut + (r.err?.message || ''))) finderRefused = true;
  }
  if (existsSync('/usr/bin/trash')) {
    const r = await run('/usr/bin/trash', [path]);
    if (!r.err && !existsSync(path)) return { where: WHERE.darwin, how: 'trash', path: null, putBack: false };
  }
  const bin = join(home, '.Trash');
  if (!existsSync(bin)) return null;
  const to = freeName(bin, basename(path));
  try { renameSync(path, to); } catch { return null; }
  return { where: WHERE.darwin, how: 'rename', path: to, putBack: false };
}

async function windowsBin(path, { run }) {
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', RECYCLE_SCRIPT], { env: { ...process.env, VO_BIN_PATH: path } });
  if (!r.err && !existsSync(path)) return { where: WHERE.win32, how: 'recycle', path: null, putBack: true };
  return null;
}

// ---- Undo for a few minutes, when the Bin said where the item went (Finder's answer, or the rename) ----
const undos = new Map(); // token -> { from: where it is in the Bin, to: where it was, at }
const UNDO_MS = 10 * 60000;
export function rememberUndo(result, back) {
  if (!result?.path) return null;
  for (const [k, v] of undos) if (Date.now() - v.at > UNDO_MS) undos.delete(k);
  const token = randomUUID();
  undos.set(token, { from: result.path, to: back, at: Date.now() });
  return token;
}
// Brings it back where it was (the studio's trash), or throws in plain words. Then the caller puts it back as usual.
export function undoFromBin(token, where = 'the Bin') {
  const u = undos.get(String(token || ''));
  if (!u || Date.now() - u.at > UNDO_MS) throw new Error(`Too late for Undo: open ${where} and put it back from there.`);
  if (!existsSync(u.from)) throw new Error(`It isn’t in ${where} any more.`);
  if (existsSync(u.to)) throw new Error('Something with that name is back already.');
  renameSync(u.from, u.to);
  undos.delete(token);
  return u.to;
}
