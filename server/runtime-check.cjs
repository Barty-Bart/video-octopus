// Keep this preflight compatible with older Node releases: it runs before importing the app.
// Every Node version threshold Video Octopus uses lives in NODE_REQUIREMENT: package.json engines, this preflight,
// the launchers' messages (start.sh, start.cmd) and Setup's Node.js check (setup.mjs) follow it.
const NODE_REQUIREMENT = {
  // The oldest release of each supported line. Node 23 is unsupported: its built-in SQLite has no FTS5 (full-text
  // search), which Video Octopus's memories need. Node 22 has FTS5 from 22.16; Node 24 and newer always have it.
  minimum: { 22: '22.16.0', 24: '24.0.0' },
  engines: '>=22.16.0 <23 || >=24.0.0',
  label: '22.16 or newer on Node 22, or Node.js 24 or newer',
  // The latest security release of each line (October 2026: 22.23.4, 24.22.1 and 26.12.1). Older ones still run,
  // with a warning in Setup and Settings → Updates.
  patched: { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' },
  advisory: 'the October 2026 Node.js security release',
};
const DOWNLOAD = 'https://nodejs.org';

function parse(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  return match ? match.slice(1, 4).map(Number) : null;
}

function atLeast(version, floor) {
  const a = parse(version), b = parse(floor);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

function supportedNode(version) {
  const v = parse(version);
  if (!v) return false;
  if (v[0] === 22) return atLeast(version, NODE_REQUIREMENT.minimum[22]);
  return v[0] >= 24;
}

// Whether this Node has the latest security fixes for its line. Non-blocking: { version, patched, current, text }.
// A line without a known security release (a newer one) is reported as current: no false warnings.
function nodeSecurity(version) {
  const v = parse(version), patched = v ? NODE_REQUIREMENT.patched[v[0]] || null : null;
  const current = !patched || atLeast(version, patched);
  const text = current ? '' : `Node.js ${version} is older than ${patched}, ${NODE_REQUIREMENT.advisory} for Node ${v[0]}. `
    + `Video Octopus still runs, but update Node.js (${DOWNLOAD}) and restart Video Octopus to get its security fixes.`;
  return { version: String(version), patched, current, text };
}

// Opens an in-memory database and makes a full-text (FTS5) table, as the memories need. Null when that works,
// else the reason. Node 22 prints an experimental warning the first time node:sqlite loads; this probe keeps quiet.
function fts5Problem() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function quietSqlite(warning, ...rest) {
    if (/SQLite is an experimental feature/.test(String(warning && warning.message || warning))) return;
    return emitWarning.call(process, warning, ...rest);
  };
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    try { db.exec('CREATE VIRTUAL TABLE fts5_probe USING fts5(text)'); } finally { db.close(); }
    return null;
  } catch (error) {
    return error && error.message || String(error);
  } finally {
    process.emitWarning = emitWarning;
  }
}

function requirementMessage(version) {
  return `Video Octopus needs Node.js ${NODE_REQUIREMENT.label} (found ${version}): ${DOWNLOAD}`;
}

function fts5Message(version, problem) {
  return `Video Octopus needs SQLite full-text search (FTS5), which Node.js ${version} doesn't provide (${problem}). `
    + `Install Node.js 24 LTS, or Node.js 22.16 or newer on Node 22: ${DOWNLOAD}`;
}

const MIN_NODE_VERSION = NODE_REQUIREMENT.minimum[22];
module.exports = { NODE_REQUIREMENT, MIN_NODE_VERSION, supportedNode, nodeSecurity, fts5Problem, requirementMessage, fts5Message };

if (require.main === module) {
  const version = process.versions.node;
  if (!supportedNode(version)) {
    console.error(requirementMessage(version));
    process.exitCode = 1;
  } else {
    const problem = fts5Problem();
    if (problem) {
      console.error(fts5Message(version, problem));
      process.exitCode = 1;
    }
  }
}
