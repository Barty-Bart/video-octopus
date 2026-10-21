# Reviewed memories

Memories help the selected agent reuse creator preferences across chats. They do
not train the model or demonstrate that its output quality improves. Everything
here uses the studio's existing SQLite database; no service, embeddings provider,
background model job or new download is required.

## Creator workflow

- **Remember this** beside a chat message opens an editable proposal with a scope
  and topic. It goes to **Memories → Review inbox** first.
- **Review lessons** in a chat saves a checkpoint and asks the selected agent for
  a recap using a normal agent turn. Mark **This project is complete** when
  finishing. Evidence quotes remain available beside each proposal.
- Review, edit, approve or reject candidates. Approval makes a memory available
  on the next turn in its scope. A replacement with the same topic requires an
  explicit review of the existing approved preference.
- **Edit** and **Restore for review** create pending revisions and take that entry
  out of active use until reapproved. Superseded entries retain history. **Expire**
  retires an approved entry without erasing its history; there is no expiry timer.
- **Forget** removes that entry's text and revision text from the active catalog,
  invalidates generated memory files, and excludes its original evidence from
  generating more proposals. It is not secure erasure of all copies.

Scopes are **All my work**, **Profile**, **Format**, and **Project**. Project chats
inherit their pinned profile and format; research chats inherit only their own
profile/format. Unscoped assistant/library chats receive global memories only.
Scheduled runs do not collect or receive this memory context. More specific
scopes win for the same topic. Current user requests and pinned brand, format,
instruction and skill contracts take precedence. Memories never rewrite these
contracts; guide changes still use the existing study/review/approval workflow.

Topics provide deterministic conflict detection, not semantic understanding of
all contradictory statements. Review differently worded duplicates and conflicts
before approval. Explicit correction phrases also produce quoted candidates at
manual compaction, reported automatic compaction, successful export and completion
checkpoints. These do not invoke a model. Automatic compaction is best effort:
only provider notifications exposed to the adapter can trigger that checkpoint.

## Storage and recall

The additive memory schema (version 1) shares `.studio/studio.sqlite`:

- `memory_entries` / `memory_revisions`: scope, topic, text, status, creator or
  unverified-agent provenance, source event IDs, timestamps, revisions and supersession.
- `memory_chats`: stable app chat-to-scope relationships.
- `memory_events` / `memory_search`: newly recorded user/assistant messages and
  bounded tool outcomes, conversation identifiers and SQLite FTS5 search.
- `memory_checkpoints` and `memory_tombstones`: checkpoint evidence and exclusions.

Normal chat events keep their app log and gain stable event IDs. App-generated
briefs do not become creator evidence; tool/assistant text cannot be cited as an
original user correction. Model proposals must cite 1–8 available original user
messages from that same app chat and can only target its most specific scope.
This verifies provenance and shape, not the truth of a model's interpretation.
Malformed proposals do not stop the chat.

Approved memory selection uses a 6,500-character allowance, plus a bounded source
window of eight user messages (up to 1,600 characters each) for explicit recaps.
Normal turns carry their event ID without reinjecting all instructions or recent history. Selection prefers
specific scopes, recent revisions and stable IDs. `.studio/memory-context/<opaque
chat key>/MEMORY.md` is regenerated from accepted SQLite records. It is a reference
projection: edit in the UI, not the generated file. File edits are overwritten;
no file edits are silently imported. Claude, Codex and Pi share this context path
and the next-turn instruction refresh mechanism.

Search chat history is limited to the selected scope. The read-only agent command
`node bin/octopus.mjs memory search "words" --chat <app-chat-id> --json` retrieves
up to 12 bounded matches for that chat's scope. Results are marked as recalled
historical quotes, never new instructions or new evidence. Search does not activate
memories. The UI can show up to 40 matches. FTS queries use literal token matching;
there is no embedding or semantic retrieval service.

Earlier **Video Octopus** logs can be explicitly imported from Search chat history:
choose a known app chat, preview the sample/scope, then back up and import. This
reads only this installation's `local/chats/<chat>.jsonl` and its archives (or the
configured app-local directory), never Claude/Codex/Pi private session stores.
Older logs may lack studio bindings: confirm they belong to the displayed scope.
Imports use deterministic identities, retain provider conversation IDs when
recorded, preserve exclusions, and never generate proposals from old assistant
answers. Limits: 5 MB and 10,000 messages per chat import. A changed preview must
be reviewed again. Retrying an interrupted import deduplicates completed rows.

## Migration, recovery and limitations

Before introducing the tables, the app makes a consistent database copy under
`.studio/memory-migration-backups/`. No creator media folders are moved. The
migration marker rejects a missing or downgraded canonical database; it does not
reconstruct memories from generated files. Unsupported memory schema versions
are rejected. A memory failure reports an in-chat notice and leaves the ordinary
chat message and adapter compaction usable.

Normal studio backups include memories, history and exclusions. Restore refuses
backups predating the memory schema once migrated. Current forget/reject markers
are carried forward into a staged restore and remove excluded restored content
before activation. Generated memory files are invalidated. The displaced database
and older backups remain available for recovery and may contain forgotten text.

**Forget history result** removes that message from active SQLite search, forgets
memories citing it and prevents its deterministic reimport. Existing app JSONL
logs, provider conversations, external copies and backups are retained. Forgetting
an entry does not erase a prompt the provider already received: start a new chat
to leave already-loaded context behind. Provider-native memory/settings are not
read, migrated or controlled by this feature; ordinary provider permissions still
apply. This is not an OS or API sandbox against an agent with write access.

No scheduled consolidation, automatic skill rewrite, cross-profile inference or
background paid-model call is enabled. Real-provider memory quality, long-term
retrieval quality, crash/power-loss behavior and large-history performance still
need user testing. Automatic recall is bounded preference context; the full
searchable transcript is not injected into each turn.
