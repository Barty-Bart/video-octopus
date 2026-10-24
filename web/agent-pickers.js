// The chat panel's Model and Effort pickers, next to its permission mode (server/agent-choices.mjs has the rules and the
// CLI flags). They are this video's own; "Default" follows Settings › Agent & model. A pick applies from the next message.
// For Claude Code: model and effort. Codex: model and reasoning. pi: model and thinking. A picker an agent can't use
// here (another model source, a local model, an endpoint) stays hidden.
import { esc, h, api, toast } from './ui.js';

export function agentPickers(id) {
  const url = `/api/projects/${encodeURIComponent(id)}/agent-choice`;
  const el = h('<span class="agent-picks"></span>');
  let view = null, gone = false;

  const select = (cls, label, title, opts, value, key) => {
    const l = h(`<label class="mode ${cls}" title="${esc(title)}"><span class="vh">${esc(label)}</span><select>${opts.map(([k, v]) => `<option value="${esc(k)}"${k === value ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`);
    const s = l.querySelector('select');
    s.onchange = async () => {
      s.disabled = true;
      try {
        view = await api(url, { [key]: s.value });
        toast(view.applies);
      } catch (e) { toast(e.message); }
      paint();
    };
    return l;
  };

  function paint() {
    if (gone) return;
    if (!view) { el.replaceChildren(); return; }
    const parts = [];
    if (view.models.length) parts.push(select('pick-model', 'Model', `Which model ${view.agent} uses in this video’s chat. Default follows Settings › Agent & model.`, view.models.map(([k, v]) => [k, k === 'studio' || k === '' ? `Model: ${v}` : v]), view.model, 'model'));
    if (view.efforts.length) parts.push(select('pick-effort', view.effortLabel, `How hard ${view.agent} thinks before it answers. Default follows Settings › Agent & model.`, view.efforts.map(([k, v]) => [k, `${view.effortLabel}: ${v}`]), view.effort, 'effort'));
    el.replaceChildren(...parts);
  }

  api(url).then((v) => { view = v; paint(); }).catch(() => {});
  return { el, destroy: () => { gone = true; }, reload: () => api(url).then((v) => { view = v; paint(); }).catch(() => {}) };
}
