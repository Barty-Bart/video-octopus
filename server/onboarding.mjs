// Routes for the smarter onboarding: the brand kit (server/brand.mjs) and skills from GitHub (server/skills-gh.mjs).
// Answers before /api/app/* in general (setup.mjs reads every POST body as JSON, and uploads stream). Returns true
// when it answered.
import { brandView, brandUpload, brandRemove, serveBrandFile, writeBrand } from './brand.mjs';
import { recommendedView, repoView, installSkills } from './skills-gh.mjs';

export async function onboardingRoute(req, res, url, { send, body }) {
  const p = url.pathname;
  if (!/^\/api\/app\/(brand|skills)(\/|$)/.test(p)) return false;
  const post = req.method === 'POST';
  const q = (k) => url.searchParams.get(k) || '';
  try {
    if (p === '/api/app/brand' && !post) return send(res, 200, brandView()), true;
    // The file itself is the body (streamed to disk); kind, name and an optional note ride in the query.
    if (p === '/api/app/brand/upload' && post) return send(res, 200, { ...(await brandUpload(req, { kind: q('kind'), name: q('name'), note: q('note') })), view: brandView() }), true;
    if (p === '/api/app/brand/file' && !post) return serveBrandFile(req, res, q('f')), true;
    if (p === '/api/app/brand/remove' && post) { const b = await body(req); return send(res, 200, { ...brandRemove(String(b.file || '')), view: brandView() }), true; }
    // Write BRAND.md now (after the answers or the colours changed).
    if (p === '/api/app/brand/write' && post) { await body(req); return send(res, 200, { ...writeBrand(), view: brandView() }), true; }
    if (p === '/api/app/skills/recommended' && !post) return send(res, 200, recommendedView()), true;
    if (p === '/api/app/skills/repo' && !post) return send(res, 200, await repoView(q('repo'))), true;
    if (p === '/api/app/skills/install' && post) { const b = await body(req); return send(res, 200, await installSkills(String(b.repo || ''), b.skills)), true; }
  } catch (e) { return send(res, e.status || 400, { error: e.message }), true; }
  return false;
}
