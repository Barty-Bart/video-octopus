// Already-edited footage (B9, board WireJ3): a file dropped or imported as a new video's take gets one question,
// "Is this video already edited?". Yes: the whole file is the cut, Clean up and Lock the cut are done by import, and
// Claude only transcribes it (server: POST /already-edited); Split into sections and then Plan come next. No (or
// closing the question): the recording path, Clean up next. Never asked for a recording made in Video Octopus.
import { api, confirmBox, toast } from './ui.js';

export const EDITED_QUESTION = {
  title: 'Is this video already edited?',
  text: 'Yes: your edit is the cut. Claude only transcribes it (for the plan, captions and the post), and Clean up and Lock the cut are done. No: Claude tidies it up like a recording. You can change this later in the Cut stage’s steps.',
  ok: 'Yes, it’s my edit', cancel: 'No, tidy it up',
};

export async function askAlreadyEdited(id, { ask = confirmBox, call = api, say = toast } = {}) {
  if (!(await ask(EDITED_QUESTION))) return false;
  try {
    const r = await call(`/api/projects/${encodeURIComponent(id)}/already-edited`, {});
    say(r?.transcribing === false ? 'Your edit is the cut. Transcribing didn’t start: see the chat.' : 'Your edit is the cut. Claude is transcribing it.');
    return true;
  } catch (e) { say(e.message); return false; }
}
