// Keep this preflight compatible with older Node releases: it runs before importing the app.
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 2; // node:zlib crc32, used by scene export, arrived in 22.2.
const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

function supportedNode(version) {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(String(version));
  return Boolean(match && (Number(match[1]) > MIN_NODE_MAJOR || (Number(match[1]) === MIN_NODE_MAJOR && Number(match[2]) >= MIN_NODE_MINOR)));
}

module.exports = { MIN_NODE_VERSION, supportedNode };

if (require.main === module && !supportedNode(process.versions.node)) {
  console.error(`Video Octopus needs Node.js ${MIN_NODE_VERSION} or newer (found ${process.versions.node}): https://nodejs.org`);
  process.exitCode = 1;
}
