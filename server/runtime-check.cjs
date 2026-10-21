// Keep this preflight compatible with older Node releases: it runs before importing the app.
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 13; // Built-in SQLite is available without a flag from 22.13.
const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

function supportedNode(version) {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(String(version));
  return Boolean(match && !(Number(match[1]) === 23 && Number(match[2]) < 4) && (Number(match[1]) > MIN_NODE_MAJOR || (Number(match[1]) === MIN_NODE_MAJOR && Number(match[2]) >= MIN_NODE_MINOR)));
}

module.exports = { MIN_NODE_VERSION, supportedNode };

if (require.main === module && !supportedNode(process.versions.node)) {
  console.error(`Video Octopus needs Node.js ${MIN_NODE_VERSION} or newer (found ${process.versions.node}): https://nodejs.org`);
  process.exitCode = 1;
}
