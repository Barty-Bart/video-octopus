// Card copy is UI metadata, not agent instructions. No model call is needed.
const core = {
  'octopus.transcribe': 'Turns recordings into a transcript, subtitles and word-by-word timings using a local Whisper model.',
  'octopus.rough-cut': 'Proposes cuts for fillers, long pauses and retakes, then lets you review what stays.',
  'octopus.join-check': 'Checks edit joins for clipped words and awkward audio, and proposes boundary repairs.',
  'octopus.production-sheet': 'Plans each scene’s script, visuals, transitions and sound for approval before building.',
  'octopus.talking-head-zoom': 'Plans timed punch-ins and zoom-outs for presenter footage as editable proposals.',
  'octopus.object-separation': 'Tracks a person or object and creates masks for graphics or backgrounds behind it. Requires SAM model setup.',
};
export function validateSkillSummary(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 320) throw Error('Short explanation must be 1–320 characters.');
  return value.trim().replace(/\s+/g, ' ');
}
export function defaultSkillSummary(text, coreId) {
  if (core[coreId]) return core[coreId];
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const description = front?.[1].match(/^description:\s*(.*)((?:\r?\n[ \t]+.*)*)/m);
  let prose = description ? [description[1].replace(/^[>|][-+]?$/, ''), description[2]].join(' ') : text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '').split(/\r?\n\s*\r?\n/).find(p => p.trim() && !p.trim().startsWith('#'));
  prose = (prose || 'Saved workflow instructions and supporting files. Open Read / edit to inspect its contents.').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
  const firstSentence = prose.match(/^(.{20,200}?[.!?])(?:\s|$)/);
  if (firstSentence) prose = firstSentence[1];
  return prose.length > 320 ? prose.slice(0, 317).trimEnd() + '…' : prose;
}
