# Format research and conversations

Video formats has three entry points for the selected profile and format:

- **View approved guide & history** reads the reusable guide and earlier versions.
- **Study examples** starts a study where you can supply URLs, files or notes.
- **Research a format** starts a study with the assistant in view. Describe what
  you want, ask for references, or discuss a channel before supplying examples.

Both research and example intake belong to the same study. The assistant can use
available web/search tools with normal permissions. It must report inaccessible
sources or unavailable tools, not claim it inspected them. No new paid provider,
model download or unattended channel crawl is configured by this feature.

The assistant writes a shortlist to `work/suggested-examples.json`. Choose
**Review suggested examples**, inspect the links and add the ones you want.
Suggestions are not evidence until registered. Each registered example receives
an ID used by the proposal's evidence. A channel link is a starting point, not
proof that its videos were inspected. Study these examples requires at least
one registered reference; discussion does not. Review and approval are still
required before a guide becomes active for new videos.

## How a thread works

A study is an app record in `<studio>/.studio/studio.sqlite`. Its reference files
and research outputs live in `<studio>/.studio/learning/sessions/<study-id>/`,
with originals in `intake/` and scratch work in `work/`.

The backend starts the installed Claude Code subprocess with that study folder
as its working directory, structured streaming input/output and the selected
profile/format context. It records the returned conversation ID. On a later
process start it uses `--resume <id>` for that exact conversation; it does not
use `-c` to pick the directory's most recent conversation. A live process can
handle successive messages. New session archives the current app transcript;
Earlier sessions can resume a chosen conversation. A reload replays saved chat
messages and reconnects to the running study.

App transcripts and their archive index currently remain ordinary files under
`<app>/local/chats/`, with provider IDs in `<app>/local/state.json` (or the
configured `STUDIO_LOCAL_DIR`). They are **not** in the studio database. Preserve
that local directory when moving an installation. Claude Code also manages its
own conversation persistence; the app does not create a Claude web Project.

Conversation history and reusable knowledge are different. SQLite stores the
profile brand, instructions, approved guides and skills used in future work.
A conversation does not automatically rewrite those records. The assistant
receives current scoped app context; a changed context is sent on the next turn.
Claude Code can also have its own instruction/auto-memory behavior, depending
on CLI version and configuration. That is not the app's approved guide store
and is not a cross-profile source of truth.

See [Claude's memory documentation](https://code.claude.com/docs/en/memory).
No user memory files are inspected or migrated by this feature.

## Usage readings

The plan card is an **agent-reported snapshot**, not a live account query.
Current Claude single-window rate-limit events and legacy unified-window events
are supported. Codex reports are provider-tagged and never shown as Claude usage.
Unknown windows are omitted rather than displayed as zero. Model-specific weekly
limits are not relabelled as the whole-plan weekly limit.

New events refresh the display; a lightweight local poll every 30 seconds and
on window focus picks up reports from other app chats. Neither poll calls the
provider. Readings show their report time and “not live”, expire after five
minutes, and are not restored from disk when the app server restarts. Other
terminal/browser sessions can change account usage between reports. No agent
turn is launched merely to refresh a meter.

The current event fields follow the [official SDK types](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py).
