// The empty project's start screen (design V2 §6, board "New video B"): while a video has no take yet, the editor's
// main area asks "How do you want to start?" with three large cards:
//   1. Record now: the existing record panel.
//   2. Drop footage: a drop zone and a file picker; the file becomes the take (the existing take upload).
//   3. Idea & thumbnail first: the optional Package stage (the Packaging tab).
// app.js shows it on the Canvas tab until the first take arrives.
import { $, h, toast } from './ui.js';
import { icon } from './icons.js';

const ACCEPT = 'video/*,audio/*,.mov,.mp4,.m4v,.mkv,.webm,.wav,.m4a,.mp3,.aif,.aiff,.caf,.flac';

// ctx: { hotkey, onRecord(), onFile(file) → Promise<boolean>, onPackage() }. Returns { el, show(on), destroy() }.
export function makeStartScreen({ hotkey = '', onRecord, onFile, onPackage }) {
  const el = h(`<section class="start" aria-labelledby="startTitle" hidden>
    <div class="start-head">
      <h2 id="startTitle">How do you want to start?</h2>
      <p>Everything else follows from here. You can switch styles later.</p>
    </div>
    <div class="start-cards">
      <button type="button" class="start-card" data-start="record">
        <span class="start-ic rec" aria-hidden="true"><i></i></span>
        <span class="start-t"><b>Record now</b><span>Screen, camera and mic, with an optional teleprompter.${hotkey ? ` ${hotkey} starts and stops.` : ''}</span></span>
      </button>
      <label class="start-card start-drop" data-start="drop">
        <span class="start-ic" aria-hidden="true">${icon('upload', 22)}</span>
        <span class="start-t"><b>Drop footage</b><span>Drop a take here, or click to pick a video or sound file.</span></span>
        <input type="file" class="vh" accept="${ACCEPT}">
      </label>
      <button type="button" class="start-card" data-start="package">
        <span class="start-ic grid" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
        <span class="start-t"><b>Idea &amp; thumbnail first</b><span>Thumbnail ideas and a working title, then record the winner.</span></span>
      </button>
    </div>
  </section>`);
  const drop = $('.start-drop', el), input = $('input[type=file]', el);
  let copying = false;
  const take = async (file) => {
    if (!file || copying) return;
    copying = true;
    drop.classList.add('busy');
    $('.start-t span', drop).textContent = `Copying ${file.name}…`;
    try {
      await onFile(file);
    } catch (e) {
      toast(e.message);
    } finally {
      copying = false;
      drop.classList.remove('busy');
      $('.start-t span', drop).textContent = 'Drop a take here, or click to pick a video or sound file.';
    }
  };
  $('[data-start=record]', el).onclick = () => onRecord();
  $('[data-start=package]', el).onclick = () => onPackage();
  input.onchange = () => { take(input.files[0]); input.value = ''; };
  // The whole screen takes a dropped file; the card lights up while one is over it.
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  el.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); drop.classList.add('over'); } });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) drop.classList.remove('over'); });
  el.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    drop.classList.remove('over');
    take(e.dataTransfer.files[0]);
  });
  return {
    el,
    show(on) { el.hidden = !on; },
    destroy() {},
  };
}
