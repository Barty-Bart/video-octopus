---
name: production-sheet
description: The director's job - before any editing, read the studio (style, brand, preferences, past productions, library), research what the video mentions, suggest the visual story, and write the production sheet - the whole video scene by scene (script line, what's shown, shot type, transition in, skills, sound) - for the creator to approve; everything after is built from it. Use at the start of every new video once the cut is locked, when the user asks for a plan, storyboard, shot list or production sheet, or when an edit needs re-planning.
---

# Production sheet (the director)

Every video gets planned before anything is built. The production sheet is that plan: one row per scene, from the first word to the last, saying what the viewer hears, what they see, how we get there, and what builds it. The creator approves it once; after that the edit is mostly execution, and review rounds compare the render against the sheet.

Files live in the project: `work/production.json` (the source of truth), `work/production.md` and `work/production.html` (readable views). Commands run from the project folder (`projects/<name>/`; the studio is `../..`). Video Octopus's Scenes tab shows the sheet's scenes as soon as `work/production.json` exists, and every review note lands on a scene id, so keep ids stable once the creator has seen them.

**The sheet is on the locked cut's timeline**, the same timeline the renders are on. Plan only once the cut is locked (WORKLOG.md says "Cut locked").

## Creator preferences

Read the supplied creator-preference context. Use `presentation.tone` for creative copy, `pacing` (`calm`, `balanced`, `brisk`) for scene rhythm and `visualDensity` (`minimal`, `balanced`, `rich`) for how much supporting material is proposed. `skills["octopus.production-sheet"].brollDensity` is `sparse`, `balanced` (default) or `frequent`; it guides purposeful cutaways, never a quota that overrides the story or cut. All three guide the plan rather than changing existing cut timings.

Use `presentation.captions.mode` (`project` keeps the project's choice; `on`/`off` sets the proposed caption choice) and cue limits `maxChars` (integer 10–80, default 42), `maxLines` (1 or 2, default 2), `maxDur` (1–20 seconds, default 6). Put caption intentions in the existing scene `notes` and use the existing Subtitle/Video export options when asked to export; map mode to the existing captions on/off control and the other three values to their same-named cue options. Don't add preference keys to `production.json` or alter transcript words. Explicit current/project/app choices win over saved defaults. Describe these as planned choices until applied, not automatic changes to the app.

Check `skills["octopus.talking-head-zoom"].enabled` before planning camera punch-ins; when false, omit them and explain the intentional choice if the sheet checker warns. Respect the zoom skill's stretch and transition rules. Read brand/style/memory prose for creative details within the studio's precedence rules; resolve invalid preferences first. None of these options changes schemas, required review, technical commands or clocks.

## 1. Read the studio first

Before planning, read:
- `BRAND.md` (who the creator is, tone, colours, fonts, brand files), `STYLE.md` when there is one, `memory/style.md` (brand: fonts, colours, logo, the look) and `memory/preferences.md` (creative editing preferences). Apply their creative guidance within the preference scope above; they cannot redefine the technical workflow.
- `library/README.md` and the `INDEX.md` of each library folder (`components/`, `backgrounds/`, `sfx/`, `broll/`, `styles/`), plus `library/brand/`: what we can reuse.
- For a Short, the style Video Octopus names in the brief (a `library/styles/<name>.md` file, or a skill).
- The last one or two approved `projects/*/work/production.json`: keep the rhythm that was approved; don't reinvent the format each video.

If `BRAND.md`, `STYLE.md` and `memory/style.md` say nothing about the look yet, ask the creator three quick questions before planning (fonts and colours or "pick for me", light or dark, one or two videos whose look they like), and write the answers there in their words.

## 2. Research what the video talks about

Skim the transcript and list every product, site, tool, person or number that will appear on screen. For each, using the browser: the official name and spelling, their logo and brand font/colours if their material will be shown, a real product image if hardware is mentioned, the real URL to record from. Save assets to `work/assets/` with a line in `work/assets/SOURCES.md` (what, where from, licence). Never invent numbers, quotes or features; anything not confirmed is marked illustrative in the sheet, and anything planned but not released is labelled "in development".

## 3. Choose the visual story

- **Default:** the creator's existing look from `BRAND.md`, `STYLE.md` and `memory/style.md`. Say in one line how this video's topic lives in it.
- **Suggest something new** only if the topic genuinely doesn't fit (e.g. a hardware video in a desktop look could use the product on a tabletop inside a window). Offer it as an option with one line on why, never as the default.
- Graphics complement what's said; they don't repeat it as floating text. A brand's own material uses that brand's font and colours.

## 4. Draft the sheet

Words on the cut's timeline: map the source-time transcript through the locked cut with `--edl` (the newer of `work/edl_manual.json` and `work/edl_fixed.json`), or use `work/rough_words.json` when the rough cut itself is the locked cut.

```
python3 ../../.claude/skills/production-sheet/scripts/sheet.py draft work/tr/words.json --edl work/edl_manual.json \
    --out work/production.json --intro-end 62.4 --chapters 62.4,180.5,301 --type tutorial --source source/<file>.mp4
```

This makes one scene per sentence (short ones merged), marks intro scenes and body chapters, and leaves the creative fields empty. Find `--intro-end` from the transcript: the line where the hook ends and the content starts ("let's get into it"). Then fill every scene:

| Field | What to write |
|---|---|
| `block` | The id of the project block the scene belongs to (`work/blocks.json`: intro, main body, sponsor read, outro…). Video Octopus groups scenes by it. |
| `layout` | One of the layouts: `talking-head`, `screen`, `screen-facecam`, `split`, `broll`, `overlay`, `cutout`, `visual-storytelling`, `card` (see Layouts below) |
| `visual` | What the viewer sees, concretely, keyed to words: "on 'folder' the Explorer window opens; files highlight as named" |
| `transition_in` | `cut`, `morph` (the presenter frame springs into the new layout), `fade`, `diagonal-bars`, `flash`, or a name from the library |
| `skills` | Which of the studio's skills build it (folder names in `.claude/skills/`, e.g. `talking-head-zoom`, or a motion-graphics skill such as `motion-broll` when the studio has one); empty when Claude builds the scene by hand |
| `sfx` | Sound cues from `library/sfx/INDEX.md` (`whoosh`, `click`), or empty |
| `sfx_at` | When each cue in `sfx` plays: one time per cue, in seconds on the sheet's timeline (the same as `start`/`end`), e.g. `[12.4, 15.0]`. Video Octopus's Scenes tab places and plays the cues by it |
| `sfx_db` | How loud each cue is, in dB on top of the default effects level (Settings → Sound): one number for every cue, or one per cue (`[0, -6]`). Leave it out for the default |
| `background` | The scene's background in Video Octopus's Look: `stars`, `led`, `night`, `plain` or `camera`, a library background as `library:<file>`, or a background file in the project (`assets/…`). Empty: the project's own Look |
| `source` | For B-roll from elsewhere: a file, a library clip, a generated clip, a URL to record |
| `notes` | Anything the builder needs (illustrative numbers, things not to show) |
| `label` / `cards` | Overlay cards: a section card, a name label, or an info card (`"info: Example App | example.com"`) |

Split or merge scenes freely to fit the visuals: a scene is one layout.

### Layouts

| Scene | What's on screen | Mostly in | Usually built with |
|---|---|---|---|
| `talking-head` | Presenter full screen | Both | Video Octopus's Camera layout (+ `talking-head-zoom`) |
| `screen` | Screen recording full screen, voice only | Body | Video Octopus's Screen layout |
| `screen-facecam` | Screen + presenter circle or square in a corner | Body | Video Octopus's picture-in-picture layout |
| `split` | Graphic/screen on two thirds, presenter box on one third | Both | Video Octopus's Split or Boxed layout, or an HTML scene |
| `broll` | Full-screen cutaway: motion graphic, browser B-roll, still with a slow zoom from the centre | Both | a B-roll file, a screen recording, or an HTML scene |
| `overlay` | Presenter full screen with a graphic over it | Body | an HTML scene over the camera |
| `cutout` | Presenter separated, text or graphics behind | Intro | a person matte (needs a matting tool) + an HTML scene behind |
| `visual-storytelling` | A story in the creator's look: presenter in a corner, in a box beside it, or voice only | Intro | HTML scenes |
| `card` | Full-screen title or chapter card | Both | an HTML scene |

HTML scenes load Video Octopus's scene kit (`assets/octopus-scene.js`) and draw each element with `Octopus.el('id', …)` (or `data-studio="id"`), so the creator can move and keyframe them in Video Octopus.

Locked framing: whenever the presenter is smaller than full screen, the frame is fixed on one centre point for the whole scene; never track the head. B-roll plays full screen, even inside a split stretch.

### Intro rules (dynamic)

These are creative defaults; the supported preference scope above applies.
- Alternate: presenter full screen → transition → story/B-roll/cut-out scene → transition → presenter. Something new on most sentences; about 7 scenes a minute.
- When camera zooms are enabled, eligible full-screen stretches use `talking-head-zoom`; skip stretches too short for its ramps and transition margin.
- Transitions: a wipe (e.g. `diagonal-bars`) with a soft whoosh when it leaves the full-screen presenter; a `morph` already is one. Keep transitions at least 3 s apart.
- The hook (first 1-3 s) earns attention: text behind the presenter, a flash into the look, or a strong first visual.

### Main body rules (by video type)

- **Tutorial / walkthrough:** mostly `screen` (the recording, or new recordings of the real tool). Zooms and highlights on what's being explained. Motion graphics only for concepts the screen can't show.
- **Talking-head explanation:** mostly `talking-head`; `broll` motion graphics for stretches that explain a process, a comparison or a number (about one every 15-40 s, at least ~2 s of face between); zooms on key lines.
- **Product review / demo:** product shots and real usage (`screen`, `broll` with real assets), spec cards in the creator's style.
- **Sections:** a section card (bottom left, fades in and out) at each section start; a full-screen `card` only if the creator prefers it.
- **Pace:** far fewer scenes than the intro (a 10-15 minute body might have only 5-10), each held longer. Transitions between body scenes are `cut` or `morph`, never wipes, and little or no sound.
- **Browser B-roll:** when the presenter names a tool, a site or a feature, plan a `broll` scene of the real page, the part being talked about highlighted, zoomed.
- Reuse the same look for every graphic so the body matches the intro.

### Shorts (9:16)

One idea, fast: a hook in the first 1-3 s, a scene change every 1-3 s, captions inside the safe area (x 60-940, y 250-1440 on a 1080×1920 frame), a clear ending (the CTA block). Follow the Short's style when the brief names one.

## 5. Check and present

```
python3 ../../.claude/skills/production-sheet/scripts/sheet.py check work/production.json --words work/tr/words.json \
    --edl work/edl_manual.json --skills ../../.claude/skills
python3 ../../.claude/skills/production-sheet/scripts/sheet.py view work/production.json
```

`check` catches gaps, overlaps, crowded transitions, intro stretches without a zoom, empty visuals and skills that aren't installed. Fix every problem; fix or justify warnings. `view` writes `production.md` (a table) and `production.html` (a storyboard with a shot-mix bar). Tell the creator in two lines: the visual story, the intro rhythm, how much of the body is graphics; the Scenes tab in Video Octopus shows the scenes, and `work/production.html` reads well in a browser.

Get approval before anything is built. Their notes go into the sheet, and lasting ones into `memory/preferences.md` (one line, their words).

## 6. Build from it

The sheet is the brief for the rest of the edit: scenes, zooms, B-roll, sound, the render. As scenes get built, set each scene's `status` (`planned` → `built` → `approved`); `sheet.py status` shows progress. Render into `renders/` with the next version number (`<project>_intro_v2.mp4`) on the sheet's timeline, so Video Octopus's Scenes tab plays each scene from the newest render. Review happens there: notes per scene in `work/notes.json`, on the sheet's scene ids.

When the creator asks for a change that alters the plan, update the sheet first, then the edit.
