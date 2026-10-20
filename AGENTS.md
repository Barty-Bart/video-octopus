# Working on Video Octopus

Read `README.md`, `docs/managed-skills.md`, `docs/skill-preferences.md` and
`docs/managed-skills-verification.md` before changing their contracts. Keep durable
technical decisions, behavior changes and verification in this repository's
Markdown documents so another coding agent can continue without account memory.
Do not use an internal memory service as the project's source of truth.

## Boundaries

This repository distributes the app and generic feature skills. A creator's
studio is separate: original media in `source/`, intermediates in `work/`,
versioned outputs in `renders/`. Never commit recordings, transcripts, actual
creator projects, brand/style files, private reference skills, credentials,
chat histories, local settings or personal handoffs. Ignore rules are not an
audit; inspect the exact staged files and diff before pushing.

Use disposable app/studio copies for integration tests, with isolated HOME,
local settings, ports and fake agents. Never run destructive tests against the
creator's studio, reuse its credentials or invoke paid providers. Stop only
processes started by the test. Model downloads and physical device capture need
a deliberate test setup; existing smoke tests may otherwise fetch model weights.

## Product contracts

- App-owned defaults are in `starter/.claude/skills/` and `core/skills.json`.
  Ship both together, keep stable IDs and update versions/API compatibility.
- Supported preferences live in the studio's `preferences/skills.json`.
  Creator forks/custom skills are retained separately; `.claude/skills/` is the
  publication used by agents. Never overwrite modified creator files during an
  app update or silently merge free-form skill instructions.
- Workflow: Record, Clean up, edit/lock the cut, plan, build, review, export.
  Source-take time, locked-cut time and final block-order time are distinct.
  Preserve stable scene element IDs, overrides and keyframes.
- Generated scenes/backgrounds use opaque sandboxes with scoped local assets.
  Do not restore same-origin execution, file-URL privileges or arbitrary network
  access. Preserve fail-closed navigation and owned-process cleanup.
- Setup stays skippable. Do not silently select providers or install/download
  dependencies. Fake-provider tests do not prove real model compatibility.
- Do not use Descript AI or spend its credits.

## Source map

`server/index.mjs` owns the API; `web/` owns the browser editor. `server/updates.mjs`,
`managed-skills.mjs`, `skill-preferences.mjs` and `starter-sync.mjs` own updates and
studio ownership. `server/claude.mjs`, `codex.mjs` and `pi.mjs` are the adapters.
`server/export*.mjs`, `scene-frames.mjs` and `backgrounds.mjs` render media;
`generated-sandbox.mjs` implements the generated-code boundary.

Use Node 22.2 or newer; verified versions and platform limits are documented.
Run `node --test test/*.test.mjs` for isolated unit/adapter tests. Browser suites
need an existing Playwright installation and Chromium; commands are in the
verification document. `test/fresh-install.mjs` is restricted to disposable
GitHub Actions runners. Do not run the broad smoke suite against a live studio.

Preserve unrelated work. Update user documentation when behavior changes and
record exact test scope, failures, skips and tested revision. Follow the current
user request for release/merge authority; repository access alone is not it.
