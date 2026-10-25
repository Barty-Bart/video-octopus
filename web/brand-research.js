// Brand research in one press (B12): the Brand tab's Research button makes the research session and runs it. The server
// keeps its two routes (POST /api/profiles/<id>/research makes a draft session, POST /api/profile-research/<id>/run
// starts it); this is the page's one action over both. No DOM, so test/flow-b.test.mjs can call it with a stand-in api.

// call(path, body) → the JSON reply (web/ui.js api). onCreated(session) runs as soon as the session exists, so a run
// that fails to start still leaves the page on its (draft) session, where Resume research tries again.
export async function startResearch(call, profileId, { url, direction = '' } = {}, onCreated = null) {
  const r = await call(`/api/profiles/${encodeURIComponent(profileId)}/research`, { url, direction });
  onCreated?.(r);
  await call(`/api/profile-research/${encodeURIComponent(r.id)}/run`, { revision: r.revision });
  return r;
}

// The session's buttons for its status (draft → running → review, or failed / interrupted / cancelled; approved has
// none): Stop while it runs, Resume when it stopped before its proposal, Review proposal once it may have one.
export function researchActions(status) {
  return {
    resume: ['draft', 'failed', 'interrupted', 'cancelled'].includes(status),
    stop: status === 'running',
    review: ['review', 'failed', 'interrupted', 'cancelled'].includes(status),
  };
}
