---
name: talking-head-zoom
description: When and how to punch in and out on a full-screen talking head. Use whenever an edit has the presenter full frame talking to camera (intros, hooks, returns from B-roll or picture-in-picture), to place zoom keyframes from the word timestamps on the locked cut.
---

# Talking-head zoom

A full-screen talking head feels alive with a slow punch-in now and then, but zooms must never fight the graphics.

Work on the locked cut (WORKLOG.md says "Cut locked") and its timeline: the production sheet's scene times (`work/production.json`) and the words on the cut. Read the supplied creator-preference context and relevant creative notes in `memory/preferences.md` within the studio's precedence rules.

## Creator preferences

Use `skills["octopus.talking-head-zoom"]`: `enabled` (default true), `landscapeAmount` (1.01–1.35, default 1.10), `portraitAmount` (1.01–1.20, default 1.04), `inSeconds` (0.1–2, default 0.7), `outSeconds` (0.1–2, default 0.9) and `minimumStretchSeconds` (2–10, default 2.5). The minimum must leave at least 0.1 s of hold after both ramps. Current explicit task/project choices outrank saved options, then clear creative prose, then defaults; resolve invalid preferences before dependent work. These values replace only the creative numeric defaults below. `presentation.pacing` describes the feel; it does not silently replace explicit zoom numbers.

With `enabled: false`, make no new camera punch-ins. Follow the existing “Nothing to zoom” result path with reason “camera zooms disabled by creator preference”, replacing only your own proposed camera items and preserving all other zooms. With zooms enabled, skip any actual stretch where both ramps, hold and transition margin cannot fit. Preferences cannot remove those checks, change the v2 schema, move from take seconds to cut seconds, change ownership/status rules or auto-accept a proposal. Lasting supported changes go in `preferences/skills.json`; broader composition notes stay in memory, not this skill.

## The rule
1. **Find each full-screen talking-head stretch.** It runs from where the presenter is full frame and talking (video start, or the end of a picture-in-picture/box/B-roll grow-back) to where the next effect or transition starts. Effects include outline traces, colour effects, annotations, 3D turns, picture-in-picture shrinks and cards. In the production sheet these are the `talking-head` scenes in a row.
2. **Zoom in within the first 1–2 s of speech in that stretch.** Start on the first word (or within ~0.1 s of the stretch starting) and reach full zoom in about 0.7 s.
3. **Zoom back out before the next transition.** Finish the zoom-out *before* its first keyframe, leaving ~0.05–0.1 s of margin. A transition is a change of shot: picture-in-picture shrink, a desktop or screen scene, a 3D turn, boxes, a card.
   - **Short stretch before an in-place effect: hold the zoom.** If an effect that stays on the same shot (outline, colour effect, annotations) starts less than about 4 s after the stretch begins, don't zoom out before it. Keep the zoom through the effect and zoom out before the next real transition. Zooming in and straight back out within two seconds feels jumpy.
   - **Long stretch:** zoom out before the effect so it plays on a static, un-zoomed frame.
4. **Amount:** about 1.10–1.12× for a punch-in on 16:9 (on a 9:16 Short, gentler: about 1.03–1.05×, with wider framing). Ease in and out (a smooth curve such as quintic in-out), never a hard cut.
5. **Focal point:** one fixed point per edit, near the face (e.g. 950,420 on a 1920×1080 frame). Don't track the head frame by frame: the background stays still and the presenter moves naturally inside it.
6. **If a stretch is shorter than about 2.5 s**, skip the zoom; in-and-out that fast looks like a glitch.

## Worked example
An intro opens on the presenter (0–6.9 s). An outline effect starts at 1.9 s, only about 2 s in, and a picture-in-picture scene starts at 6.9 s.
- Zoom in 0.05 → 0.8 s, hold through the outline effect, zoom out 5.4 → 6.3 s, before the picture-in-picture at 6.9.
- Later the presenter is back full screen 17.75–25 s, a colour effect starts at 20.9 (about 3 s in) and a 3D turn at 25: zoom in 17.85 → 18.6, hold, zoom out 24.0 → 24.9.
- Two versions that didn't work: starting the zoom late (on the effect's word) made it overlap the effect; zooming in and back out before the effect, all within 2 s, felt too quick. The rule above is the result.

## Output: `work/zooms.json` (v2)
Video Octopus's Zooms lane, preview and export read `work/zooms.json` v2, in seconds of the take (the same clock as the words and `segments_sec`; Video Octopus maps them to the cut). Each punch-in is a camera zoom by Claude, proposed until the creator keeps it (Video Octopus shows it dashed with **Keep it · No thanks**; the preview and the export leave it out until it's kept):
```json
{ "v": 2,
  "items": [
    { "target": "camera", "a": 0.05, "b": 0.8, "c": 5.4, "d": 6.3, "amount": 1.1, "speed": "smooth",
      "why": "opening; hold through the outline at 1.9", "by": "claude", "status": "proposed" },
    { "id": "z2", "target": "screen", "a": 41.3, "b": 42.1, "c": 44.9, "d": 45.9, "box": { "x": 0.37, "y": 0.11, "w": 0.44, "h": 0.44 } }
  ] }
```
`a → b` eases in, `b → c` holds, `c → d` eases out (ramps 0.1–2 s); `amount` is how much closer than the shot's own framing (1.10–1.12 on 16:9, 1.03–1.05 on 9:16); `speed` is `smooth` (ease in-out), `even` or `snap`.

**Redo only your own punch-ins.** Every run replaces only the items with `"target": "camera"` and `"by": "claude"`. Keep every other item exactly as it is: screen zooms (from the plan or the creator), the creator's own zooms, anything you didn't make in this step. (Video Octopus puts back any other zoom an Add zooms run drops.) An older file in v1 form (`{"zooms": [{"in": [a, b], "out": [c, d], …}]}` on the cut's timeline) still reads as camera punch-ins; write v2.

Tell the creator in a line per zoom, and that they keep or turn each down on the Zooms lane (or Keep all in the chat). Log it in `WORKLOG.md` with a line that starts `Add zooms:` ("Add zooms: 3 punch-ins proposed").

**Nothing to zoom** (the presenter is never full frame, or every stretch is under 2.5 s): that's a result too. Add the reason in a few words to the creator to `work/zooms.json`, keeping its other zooms, and a `WORKLOG.md` line ("Add zooms: none needed, never full frame"), so Video Octopus counts the step as done and shows "No zooms needed: you're never full frame":
```json
{ "v": 2, "items": [ …the other zooms, unchanged… ], "reason": "you're never full frame" }
```

## Implementation notes
- Keep the zoom curve in one function and use the same one everywhere it's needed (the scene page that draws over the footage and the script that composites the footage), so graphics drawn over the presenter stay locked to the zoomed picture: map their points through the same zoom.
- Apply the zoom to the presenter frame *before* screen-edge frames and front-layer graphics, and zoom any matte with it if something is masked by the presenter.
- When the cut changes after zooms are placed, Video Octopus moves each zoom with its words (the times are the take's own seconds); check each one still starts on a word.
