# Core skills, preferences and custom workflows

This implementation is included in v0.1.0-beta.1. Nine Node test files passed on macOS: 142 tests with zero failures or skips. Separate browser tests passed 11 managed-skill update/restart scenarios, and fake CLIs exercised all three actual adapters. Generated-code isolation passed 11 app-preview checks, nine headless-rendering groups and 12 independent security checks. Seven software-decoding/export tests now pass on both Mac and native Windows after correcting Windows decoder arguments. The Windows hosted check also passed first launch, app-offered FFmpeg installation and the original failing MP4 fixture. See [isolated verification](managed-skills-verification.md).

## Ownership

| Owner | Location | Update policy |
| --- | --- | --- |
| Application | `core/skills.json`, `starter/.claude/skills/` | Core code and matching instructions ship together. |
| Creator | `<studio>/preferences/skills.json` | Validated supported options; never rewritten by an updater. |
| Creator | `<studio>/memory/`, `BRAND.md`, `STYLE.md` | Creative notes; excluded from starter updates, even when unchanged or deleted. |
| Creator | `<studio>/skills/overrides/<id>/` | Saved custom version of a core workflow; never automatically merged. |
| Creator | `<studio>/skills/custom/<folder>/` | Independent skill; use a unique discovery name. |
| Manager | `<studio>/.claude/skills/` | Exactly one active copy per selected identity/name. |
| Manager | `<studio>/.studio/skill-manager/` | Choices, hashes, revision tokens, journal and backups. |

Preferences are the default customization path. All harnesses inject current validated options, bounded creative prose and selection availability into their context, including resumed turns. The six core skills document their supported inputs. See [the preference contract](skill-preferences.md). This guides agents; it does not sandbox tools or prove editing results.

Generated visual code has a separate rendering boundary: scoped local assets, no external network or workers, and no privileged editor access. Existing scene kits, seeking and creator overrides remain supported. Agent tools and third-party skills are outside that boundary.

`server/managed-skills.mjs` and `server/skill-preferences.mjs` perform no I/O on import. Callers supply a studio path; manager tests also supply a synthetic application catalog. Preference reads never save, migrate or normalize user files on disk.

## Core selection and saved forks

The internal modes `default`, `override` and `custom` mean selected core, selected core fork, and independent custom skill. A `default` entry may still own a saved fork. Presence of that folder never silently selects it.

**Make a custom version** copies core once and selects it. Existing fork sources are reused, never overwritten by that action. **Use latest core** switches selection while retaining the editable fork. **Use my custom version** selects that saved copy again. **Keep my version** acknowledges the available update; it does not merge or establish compatibility. **Compare with core** shows bounded text differences, with binary/large files left for external inspection.

`forkVersion` is the original core baseline; `version` is the incoming core version. A publication carries its own version. Legacy baselines are unknown rather than mislabeled as the new core version. `.octopus-skill.json` markers preserve identity across folder moves. Do not copy a core identity into an unrelated skill.

Core discovery names are reserved. New independent collisions are preserved but withheld; pre-existing legacy collisions remain visible for explicit reconciliation. The external installer reserves catalog names, aliases, disabled choices and saved fork names, checking both folder and declared skill names. Sources and backups are never additional skill roots.

## API compatibility

The catalog's positive integer `apiVersion` declares the skill-facing app contract. It defaults to 1 for older catalogs. Maintainers must increment it for breaking command, schema or timeline-contract changes and document how to adapt custom workflows.

A new fork records the current API version. Old unversioned forks and mismatched forks are preserved but omitted from the active publication. No core fallback is silently selected. Other compatible skills and chat remain usable; per-turn context identifies unavailable workflows so an agent can help review without running them.

After adapting the source, **I reviewed compatibility** records explicit acknowledgement of the current API. It neither tests nor rewrites the fork and does not select an inactive fork. **Keep my version** cannot bypass this check. Independent custom skills have no verified app-API compatibility declaration; their owners must review them.

This is a declared compatibility gate, not an automatic verifier. An unchanged API number cannot detect an undocumented breaking release. Preferences cannot override the technical contract.

## Legacy migration

A legacy core copy becomes managed core only when every original starter-manifest file proves ownership and unchanged content. Edited, extra, incomplete or unproven copies are preserved in personal storage. Their baseline/compatibility stays unknown until reviewed. Missing/deleted legacy identities remain disabled; uncertain history never proves permission to replace content.

Direct edits to active copies are preserved on refresh. If both the active core copy and an existing saved fork differ, refresh stops and keeps both for reconciliation. The manager does not extract guessed style preferences from old skills or merge instructions automatically.

## Activation and recovery

Startup reconciles core skills before agent work. An app update waits for idle work, uses the fast-forward Git updater and requests a supervised restart. The restarted process activates the new catalog. Changed Node/package requirements require a manual installation step. Core requirements are notices, not automatic dependency/model installs.

Unchanged owned helper scripts in `tools/` use the separate preserving starter updater. Modified helpers remain, and incoming copies wait in `.studio/updates/`; deleted helpers stay deleted. Other studio instructions/library templates remain optional. Creator-owned preference and brand files are excluded from all starter update plans.

Manager changes stage copies and recheck current fingerprints before committing. A journal covers active publication, saved forks, independent sources and state. Original roots move into `backups/<transaction>/before/`; state is the final commit point. After interruption, a completed state finishes bookkeeping; otherwise the previous roots return and displaced files remain in `interrupted/`. No backup is automatically pruned.

Restore validates snapshot metadata, backs up current choices and holds the restored snapshot until resume. It cannot activate incompatible/unknown core publications; incompatible restored forks stay saved but unpublished. Restoring skills does not roll back app code. First-migration backups and malformed states may need manual recovery. Full power-loss durability remains unverified.

## Release discipline and limits

- Ship core code, skill content, catalog and preference-contract documentation together. Increment each changed skill's version. Reusing a skill version with changed content is refused; dependency-only version bumps remain a maintainer rule.
- Increase the API version for breaking interfaces. Keep creative preferences out of core instructions and preserve older supported option meanings.
- Review helper conflicts separately: helper synchronization and skill publication are separate transactions.
- Global, plugin and nested project skills discovered by each CLI remain outside this manager. Use distinct names. Per-turn instructions discourage stale cached skills, but real CLI behavior still needs testing.
- Publication identity/content checks reject symlinks and nested/unregistered managed skills. Recovery backups can grow without limit; the UI lists the newest 20.
- The manager's scan limit is 10,000 files / 128 MB per scanned tree. An external installation with assets can exceed publication limits even when its download succeeds; resolve the saved source before continuing.
- Never commit generated manager state, creator preferences, recordings, references, learned styles or private handoffs to the application repository.
