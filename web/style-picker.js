// The editor's style picker (design V2 §6, board "New video B"): a button in the top bar with the style's colour, the
// format's name and "· <style>", opening a listbox grouped by style → formats, then "No style · decide as I go" and
// "+ New style from this video". Picking one calls POST /api/project-context/<id>/select, which re-pins the brand,
// instructions, skills and format as New video does. Before a Build step that just happens; after one the server asks
// for confirmation first (Videos keep the style they were built with).
import { esc, h, api, toast, confirmBox } from './ui.js';
import { icon } from './icons.js';
import { newChannelDialog } from './learning.js';
import { TERMS } from './terms.js';

const COLOR = /^#[0-9a-f]{6}$/i;
const swatch = (color, size = '') => `<span class="sp-sw${size ? ` ${size}` : ''}${COLOR.test(color || '') ? ' branded' : ''}" aria-hidden="true"${COLOR.test(color || '') ? ` style="background:${color}"` : ''}></span>`;

// POST select; a 409 with needsConfirm comes back as { needsConfirm, error } instead of throwing.
async function select(id, body) {
  const r = await fetch(`/api/project-context/${encodeURIComponent(id)}/select`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 409 && j.needsConfirm) return { needsConfirm: true, error: j.error };
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ctx: { id, getP, formatInfo (STATUS.formatInfo), onChanged() }. Returns { el, update(), destroy() }.
export function makeStylePicker({ id, getP, formatInfo = {}, onChanged }) {
  const el = h(`<div class="sp">
    <button type="button" class="sp-btn" aria-haspopup="listbox" aria-expanded="false" title="The style and format this video uses"></button>
    <div class="sp-pop" role="listbox" aria-label="Style for this video" hidden></div>
  </div>`);
  const btn = el.querySelector('.sp-btn'), pop = el.querySelector('.sp-pop');
  let colors = new Map(), busy = false;

  const current = () => getP().context || {};
  const paint = () => {
    const c = current();
    const color = colors.get(c.profileId);
    const main = c.formatName || c.profileName || TERMS.noStyle;
    const sub = c.formatName && c.profileName ? `· ${c.profileName}` : c.profileName ? '· no format' : '· decide as I go';
    btn.innerHTML = `${swatch(color)}<span class="sp-main">${esc(main)}</span><span class="sp-sub">${esc(sub)}</span><span class="sp-caret">${icon('chevron', 14)}</span>`;
  };

  const optionsOf = () => [...pop.querySelectorAll('[role="option"], .sp-new')];
  const close = (focus = false) => {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (focus) btn.focus();
  };
  const outside = (e) => { if (!el.contains(e.target)) close(); };

  async function open() {
    const [data, counts] = await Promise.all([api('/api/profiles'), api('/api/app/counts').catch(() => ({}))]);
    colors = new Map((counts.channels || []).map((c) => [c.id, c.color]));
    const c = current();
    const styles = data.profiles.filter((p) => !p.archived || p.id === c.profileId);
    const option = ({ profileId, formatId, label, kind = '', glyph = '', locked = false }) => {
      const on = (profileId || null) === (c.profileId || null) && (formatId || null) === (c.formatId || null);
      return `<button type="button" role="option" class="sp-opt${formatId ? ' fmt' : ''}" aria-selected="${on}"${locked ? ' aria-disabled="true" title="This video was built with another video setup. Pick a format with its setup, or No style."' : ''} data-profile="${esc(profileId || '')}" data-format="${esc(formatId || '')}">
        ${glyph}<span class="sp-opt-t">${esc(label)}</span>${kind ? `<span class="sp-kind">${esc(kind)}</span>` : ''}${on ? icon('check', 14) : ''}</button>`;
    };
    // After a Build step only formats with the video's own setup can be picked (the server refuses the others).
    const built = getP().pipeline?.steps?.some((x) => x.stage === 'Build' && x.done);
    const groups = styles.map((p) => {
      const formats = data.formats.filter((f) => f.profileId === p.id && (!f.archived || f.id === c.formatId));
      const color = colors.get(p.id) || p.brand?.brand?.colors?.[0] || null;
      const rows = formats.map((f) => {
        const tall = formatInfo[f.type]?.aspect === '9:16';
        const locked = built && f.type !== getP().type;
        return option({ profileId: p.id, formatId: f.id, label: f.name, kind: locked ? 'Other setup' : tall ? 'Short' : 'Long', locked,
          glyph: `<span class="sp-orient ${tall ? 'tall' : 'wide'}" aria-hidden="true"></span>` });
      }).join('');
      // A style without formats can still be used on its own (its brand, research and memories).
      const plain = formats.length ? '' : option({ profileId: p.id, formatId: null, label: 'This style, no format yet', glyph: '<span class="sp-orient none" aria-hidden="true"></span>' });
      return `<div class="sp-group" role="group" aria-label="${esc(p.name)}"><div class="sp-gh">${swatch(color, 'small')}${esc(p.name)}</div>${rows}${plain}</div>`;
    }).join('');
    pop.innerHTML = `<p class="sp-hint">Style for this video. Change it any time${getP().pipeline?.steps?.some((s) => s.stage === 'Build' && s.done) ? '; after Build it affects only new steps' : ''}.</p>
      ${groups || `<p class="sp-hint">No styles yet.</p>`}
      <hr class="sp-sep">
      ${option({ profileId: null, formatId: null, label: `${TERMS.noStyle} · decide as I go` })}
      <button type="button" class="sp-new">+ New style from this video</button>`;
    pop.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    // Keep the list on screen on a narrow window (it opens under the button, which may sit far right).
    pop.style.left = '';
    const box = pop.getBoundingClientRect();
    const shift = Math.min(0, innerWidth - 8 - box.right) || Math.max(0, 8 - box.left);
    if (shift) pop.style.left = `${shift}px`;
    document.addEventListener('pointerdown', outside, true);
    (pop.querySelector('[aria-selected="true"]') || optionsOf()[0])?.focus();
  }

  async function choose(profileId, formatId) {
    const c = current();
    if ((profileId || null) === (c.profileId || null) && (formatId || null) === (c.formatId || null)) return close(true);
    if (busy) return;
    busy = true;
    close(true);
    try {
      const body = { profileId: profileId || null, formatId: formatId || null };
      let r = await select(id, body);
      if (r.needsConfirm) {
        const ok = await confirmBox({ title: 'Change the style after Build?', text: r.error, ok: 'Change style' });
        if (!ok) return;
        r = await select(id, { ...body, confirm: true });
      }
      const name = r.context.formatName || r.context.profileName || TERMS.noStyle;
      toast(r.typeChanged ? `This video now uses ${name}, with its video setup.` : `This video now uses ${name}.`);
      await onChanged?.(r);
    } catch (e) {
      toast(e.message);
    } finally {
      busy = false;
    }
  }

  btn.onclick = () => (pop.hidden ? open().catch((e) => toast(e.message)) : close());
  pop.addEventListener('click', (e) => {
    const o = e.target.closest('[role="option"]');
    if (o?.getAttribute('aria-disabled') === 'true') return;
    if (o) return choose(o.dataset.profile, o.dataset.format);
    if (e.target.closest('.sp-new')) {
      close();
      // Prefilled from the video's name; it learns nothing by itself. The video then uses the new style.
      const P = getP();
      newChannelDialog({ name: P.nameSource === 'auto' && !P.autoNamedBy ? '' : P.name, onCreated: (p) => choose(p.id, null) });
    }
  });
  pop.addEventListener('keydown', (e) => {
    const list = optionsOf(), i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list.at(-1)?.focus(); }
  });
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && pop.hidden) { e.preventDefault(); open().catch((err) => toast(err.message)); } });

  // The style's colour for the button, without opening the list.
  api('/api/app/counts').then((counts) => { colors = new Map((counts.channels || []).map((c) => [c.id, c.color])); paint(); }).catch(() => {});
  paint();
  return { el, update: paint, destroy: () => close() };
}

