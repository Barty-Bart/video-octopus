// Resources: the creator's photos, logos, shapes, reference thumbnails, fonts and style notes, at three levels
// (All channels · Channel · This video). Shown in a channel's Brand tab (every level, the channel's videos included) and
// in a video's Packaging panel (its own chain only). Server: /api/resources (server/packaging.mjs, resource-store.mjs).
import { $, esc, h, api, toast, confirmBox } from './ui.js';

const KINDS = { photo: 'Photo', logo: 'Logo', image: 'Image or shape', reference: 'Reference thumbnail', font: 'Font', note: 'Style note' };
const WHO = { self: 'Me', permission: 'Someone who agreed', other: 'Someone else (never sent)', nobody: 'No people' };
const kb = (n) => (n >= 1024 * 1024 ? `${Math.round(n / 1024 / 102.4) / 10} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const options = (map, selected) => Object.entries(map).map(([k, v]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${esc(v)}</option>`).join('');
const isImage = (r) => r.hash && /\.(png|jpe?g|webp|gif|svg)$/i.test(r.ext || r.name || '');

// One resource as a row: picture, name, what it is, who is in it, and its actions.
function row(r) {
  const chips = [
    KINDS[r.kind] || r.kind,
    r.kind === 'note' ? null : `Who: ${WHO[r.likeness] || 'not said'}`,
    r.use === 'always' ? 'Every thumbnail' : r.use === 'never' ? 'Not used' : null,
    r.kind !== 'note' && r.hash && !r.attachable && r.likeness === 'other' ? 'Never sent' : null,
    r.from ? `From ${r.from.split(':')[0]}` : null,
  ].filter(Boolean);
  const pic = isImage(r)
    ? `<img src="/api/resources/${encodeURIComponent(r.id)}/file" alt="" loading="lazy">`
    : `<span class="rs-glyph" aria-hidden="true">${r.kind === 'note' ? '¶' : r.kind === 'font' ? 'Aa' : '·'}</span>`;
  return `<li class="rs-row" data-id="${esc(r.id)}">
    <span class="rs-pic">${pic}</span>
    <span class="rs-tx"><b>${esc(r.name)}</b>${r.note ? `<small>${esc(r.note)}</small>` : ''}${r.kind === 'note' ? `<small>${esc(r.text || '')}</small>` : ''}
      <span class="rs-chips">${chips.map((c) => `<span class="rs-chip">${esc(c)}</span>`).join('')}${r.size ? `<span class="rs-chip quiet">${kb(r.size)}</span>` : ''}</span></span>
    <span class="rs-acts"><button type="button" class="btn ghost small" data-act="edit" aria-label="${esc(`Edit ${r.name}`)}">Edit</button><button type="button" class="btn ghost small" data-act="archive" aria-label="${esc(`Remove ${r.name}`)}">Remove</button></span>
  </li>`;
}

// The add form for one level (a file, or a style note).
function addForm(scope, label) {
  return `<form class="rs-add" data-scope="${esc(scope)}">
    <div class="rs-add-row">
      <label>What it is<select name="kind">${options(KINDS, 'photo')}</select></label>
      <label class="rs-who">Who is in it<select name="likeness">${options(WHO, 'self')}</select></label>
      <label class="learn-check rs-always"><input type="checkbox" name="always">Use in every thumbnail</label>
    </div>
    <label class="rs-file">File<input type="file" name="file" accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.ttf,.otf,.woff,.woff2" multiple></label>
    <label class="rs-text" hidden>Style note<textarea name="text" rows="2" placeholder="Bold yellow words, my face on the right, no gradients"></textarea></label>
    <label>Note (optional)<input type="text" name="note" maxlength="2000" placeholder="Where or how to use it"></label>
    <div class="learn-actions"><button class="btn small primary">Add to ${esc(label)}</button></div>
  </form>`;
}

// Wire one add form: files are uploaded one by one; a style note is saved as text.
function wireAdd(form, done) {
  const kind = form.elements.kind, who = $('.rs-who', form), file = $('.rs-file', form), text = $('.rs-text', form);
  const sync = () => {
    const note = kind.value === 'note';
    file.hidden = note;
    text.hidden = !note;
    who.hidden = note || kind.value === 'font';
  };
  kind.onchange = sync;
  sync();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const b = form.querySelector('button');
    b.disabled = true;
    try {
      const scope = form.dataset.scope, use = form.elements.always.checked ? 'always' : 'ask', note = form.elements.note.value;
      if (kind.value === 'note') {
        const words = form.elements.text.value.trim();
        if (!words) throw new Error('Write the style note.');
        await api('/api/resources/note', { scope, name: words.split(/\s+/).slice(0, 5).join(' '), text: words, note, use });
      } else {
        const files = [...form.elements.file.files];
        if (!files.length) throw new Error('Choose a file.');
        for (const f of files) {
          const q = new URLSearchParams({ scope, name: f.name, kind: kind.value, use, note });
          if (!who.hidden) q.set('likeness', form.elements.likeness.value);
          const r = await fetch(`/api/resources/upload?${q}`, { method: 'POST', headers: { 'X-Studio': '1' }, body: f });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `Could not add ${f.name}.`);
        }
      }
      form.reset();
      sync();
      toast('Added. Videos in progress see it the next time Packaging opens.');
      await done();
    } catch (err) { toast(err.message); } finally { b.disabled = false; }
  };
}

// Edit one resource in a dialog: name, note, kind, who is in it, when to use it, and its level (a move).
async function edit(r, levels, done) {
  const body = h(`<form class="rs-edit">
    <label>Name<input name="name" value="${esc(r.name)}" maxlength="180"></label>
    <label>Note<input name="note" value="${esc(r.note || '')}" maxlength="2000"></label>
    ${r.kind === 'note' ? `<label>Style note<textarea name="text" rows="3">${esc(r.text || '')}</textarea></label>` : `<label>What it is<select name="kind">${options(Object.fromEntries(Object.entries(KINDS).filter(([k]) => k !== 'note')), r.kind)}</select></label>
    <label>Who is in it<select name="likeness">${options(WHO, r.likeness || 'nobody')}</select></label>`}
    <label>When to use it<select name="use">${options({ always: 'In every thumbnail', ask: 'When it fits', never: 'Never' }, r.use)}</select></label>
    ${levels.length > 1 ? `<label>Level<select name="scope">${levels.map((l) => `<option value="${esc(l.scope)}"${l.scope === r.scope ? ' selected' : ''}>${esc(l.label)}</option>`).join('')}</select></label>` : ''}
  </form>`);
  await confirmBox({ title: `Edit ${r.name}`, ok: 'Save', body, onOk: async (form) => {
    const v = Object.fromEntries(new FormData(form));
    try {
      await api(`/api/resources/${encodeURIComponent(r.id)}`, { expected: r.revision, ...v });
      await done();
      return true;
    } catch (e) { toast(e.message); return false; }
  } });
}

// mount(root, { profileId } | { project }): renders and keeps itself current. onChange runs after any change.
export function mountResources(root, { profileId = null, project = null, onChange = null, compact = false } = {}) {
  let live = true;
  root.teardown = () => { live = false; };
  async function paint() {
    const q = project ? `project=${encodeURIComponent(project)}` : `profile=${encodeURIComponent(profileId)}`;
    const data = await api(`/api/resources?${q}`);
    if (!live) return;
    const all = [];
    const levels = [];
    const section = (l, scope, label, items, depth = 2) => {
      all.push(...items);
      levels.push({ scope, label });
      const open = !compact || items.length > 0;
      return `<details class="rs-level"${open ? ' open' : ''}><summary><h${depth + 1}>${esc(label)}</h${depth + 1}><span class="rs-n">${items.length}</span></summary>
        ${items.length ? `<ul class="rs-list">${items.map(row).join('')}</ul>` : '<p class="sub">Nothing here yet.</p>'}
        <details class="rs-add-wrap"><summary class="btn ghost small">Add</summary>${addForm(scope, label)}</details></details>`;
    };
    const html = data.levels.map((l) => {
      if (l.videos) {
        if (!l.videos.length) return `<div class="rs-level"><h3>${esc(l.label)}</h3><p class="sub">No videos in this channel yet. A video’s own resources are added in its Packaging tab, or here.</p></div>`;
        return `<div class="rs-videos"><h3>${esc(l.label)}</h3>${l.videos.map((v) => section(v, v.scope, v.name, v.items, 3)).join('')}</div>`;
      }
      return section(l, l.scope, l.label, l.items);
    }).join('');
    root.innerHTML = `<p class="sub rs-lead">${project ? 'What Codex may use for this video. Changes reach it straight away.' : 'Photos of you, logos, shapes, reference thumbnails and style notes for Packaging. All channels reaches every video; this channel reaches its videos; a video’s own stay with it.'} Pictures marked “Someone else” are never sent to an image model.</p>${html}`;
    root.querySelectorAll('form.rs-add').forEach((f) => wireAdd(f, changed));
    root.querySelectorAll('.rs-row').forEach((li) => {
      const r = all.find((x) => x.id === li.dataset.id);
      li.querySelector('[data-act=edit]').onclick = () => edit(r, levels.filter((l) => !project || l.scope), changed);
      li.querySelector('[data-act=archive]').onclick = async () => {
        if (!(await confirmBox({ title: `Remove ${r.name}?`, text: 'It stops reaching new thumbnails. Its file stays in the studio, and cards already made keep a record of it.', ok: 'Remove' }))) return;
        try { await api(`/api/resources/${encodeURIComponent(r.id)}/archive`, { expected: r.revision }); await changed(); } catch (e) { toast(e.message); }
      };
    });
  }
  async function changed() { await paint(); await onChange?.(); }
  paint().catch((e) => { if (live) root.innerHTML = `<p class="learn-error">${esc(e.message)}</p>`; });
  return { refresh: () => paint().catch((e) => toast(e.message)) };
}
