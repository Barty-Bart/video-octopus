#!/usr/bin/env python3
"""sheet.py: the production sheet, the plan of the whole video, scene by scene.

  python3 sheet.py draft    WORDS.json --out work/production.json [--edl work/edl_manual.json] [--intro-end 62.4]
                            [--type tutorial] [--chapters 62.4,180,301] [--fps 30000/1001] [--source source/x.mp4]
  python3 sheet.py check    work/production.json [--words WORDS.json [--edl EDL]] [--skills ../../.claude/skills]
  python3 sheet.py view     work/production.json [--md work/production.md] [--html work/production.html]
  python3 sheet.py status   work/production.json            # what's planned / built / approved per crew role
  python3 sheet.py mark     work/production.json building 3  # set scene 3's status (planned/cutting/building/built/approved)
  python3 sheet.py cutouts  work/production.json            # the scenes that need a cutout, with their time ranges
  python3 sheet.py cutout   work/production.json done 3 --masks work/objsep/scene3-speaker   # or: skipped 3 --why no-model

draft   splits the transcript into sentences and makes one scene per sentence (short ones merge), with
        intro scenes marked "dynamic" and body scenes "calm". Layouts, visuals and transitions start empty
        (layout "talking-head") for the director to fill in. With --edl (a cut: {"segments_sec": [[start, end], ...]}
        in source seconds), source-time words are mapped onto the cut's timeline first and cut words dropped,
        so the sheet is on the same timeline as the renders.
check   flags gaps and overlaps, scenes outside the words, transitions closer than 3 s, full-screen intro
        talking-head stretches without a zoom, B-roll without a source, skills not installed, and unfilled fields.
view    writes a readable table (Markdown) and a storyboard page (HTML, light/dark) to approve.
mark    sets the status of one or more scenes (by id) while building: "building" when you start a scene, "built"
        when it is done. Video Octopus watches it and shows the build's progress per scene. Only the scenes' status
        changes; the file is replaced in one step, so it is never read half written. "cutting" while a scene's subject
        is being cut out (object separation, before the scene is built).
cutouts lists the scenes that need their subject cut out of the background ("cutout": true, or the cutout layout):
        id, time range and what to cut out ("cutout_subject", "speaker" when left out). --json for a machine-readable list.
cutout  records what came of a scene's cutout during Build: "done" (with --masks, the object-separation folder its masks
        are in) or "skipped" (built with the plain layout; --why no-python / no-packages / no-model / failed). Only those
        scenes' cutout_result, cutout_masks and cutout_why change, replaced in one step like mark.
"""
import argparse, html, json, os, re, sys, tempfile
from collections import Counter, defaultdict
from fractions import Fraction
from pathlib import Path

SHOTS = {
    "talking-head": "presenter full screen (zoom in within the first second of each stretch)",
    "screen": "screen recording full screen, voice only",
    "screen-facecam": "screen recording + presenter in a circle or rounded square in a corner",
    "split": "two floating boxes: graphic/screen on two thirds, presenter on one third (locked framing)",
    "broll": "full-screen cutaway: motion graphic, browser B-roll, a still with a slow zoom, a generated clip",
    "overlay": "presenter full screen with a motion graphic or card over it",
    "cutout": "presenter separated from the background, text or graphics behind (intro)",
    "visual-storytelling": "a story in the creator's theme, presenter cut out in a corner, in a box beside it, or voice only (intro)",
    "card": "full-screen title or chapter card",
}
ALIASES = {"full": "talking-head", "pip": "visual-storytelling", "world": "visual-storytelling"}
TRANSITIONS = {"cut", "none", "morph", "smart", "pip-shrink", "pip-grow", "fade", "dissolve", "diagonal-bars", "flash", "zoom-through"}
ROLE_OF = {"talking-head": "animator", "visual-storytelling": "animator", "split": "animator", "cutout": "animator",
           "overlay": "animator", "card": "animator", "screen-facecam": "animator",
           "broll": "b-roll", "screen": "b-roll"}


CUTOUT_WHY = ("no-python", "no-packages", "no-model", "failed")


def needs_cutout(s):
    """A scene that needs its subject cut out of the background: "cutout": true, or the cutout layout."""
    return s.get("cutout") is True or s.get("layout", s.get("shot")) == "cutout"


def subject_of(s):
    return str(s.get("cutout_subject") or "").strip() or "speaker"


def fmt(t):
    m, s = divmod(max(t, 0), 60)
    return f"{int(m)}:{s:05.2f}"


def sentences(words):
    out, cur = [], []
    for w in words:
        cur.append(w)
        if re.search(r"[.?!]$", w[2]) or (len(cur) > 1 and w[0] - cur[-2][1] > 0.8):
            out.append(cur); cur = []
    if cur:
        out.append(cur)
    merged = []                                # merge very short sentences into the next one
    for s in out:
        if merged and (merged[-1][-1][1] - merged[-1][0][0] < 1.6):
            merged[-1] = merged[-1] + s
        else:
            merged.append(s)
    return merged


def on_cut(words, edl):
    """Source-time words -> the cut's timeline (kept segments played in order); words in cut material drop out."""
    if not edl:
        return words
    segs = json.load(open(edl, encoding="utf-8"))["segments_sec"]
    out, at = [], 0.0
    for s0, s1 in segs:
        for w0, w1, w in words:
            if s0 <= (w0 + w1) / 2 < s1:
                out.append([round(at + max(w0, s0) - s0, 3), round(at + min(w1, s1) - s0, 3), w])
        at += s1 - s0
    return out


def cmd_draft(a):
    words = on_cut(json.load(open(a.words, encoding="utf-8")), a.edl)
    chapters = [float(x) for x in a.chapters.split(",")] if a.chapters else []
    intro_end = a.intro_end if a.intro_end is not None else (chapters[0] if chapters else min(60.0, words[-1][1]))
    scenes = []
    for i, s in enumerate(sentences(words), 1):
        st, en = s[0][0], s[-1][1]
        sec = "intro" if st < intro_end else "body"
        scenes.append({"id": i, "section": sec, "start": round(st, 2), "end": round(en, 2),
                       "line": " ".join(w[2] for w in s), "layout": "talking-head", "visual": "", "skills": [],
                       "transition_in": "cut" if i > 1 else "none", "sfx": [], "notes": "", "status": "planned"})
    for a_, b in zip(scenes, scenes[1:]):        # close the small gaps between sentences
        b["start"] = a_["end"] = round((a_["end"] + b["start"]) / 2, 2)
    secs = [{"id": "intro", "start": 0.0, "end": round(intro_end, 2), "mode": "dynamic"}]
    edges = [intro_end] + [c for c in chapters if c > intro_end] + [words[-1][1]]
    for k, (x, y) in enumerate(zip(edges, edges[1:]), 1):
        secs.append({"id": f"body-{k}", "start": round(x, 2), "end": round(y, 2), "mode": "calm"})
    sheet = {"project": a.project or Path(a.out).resolve().parents[1].name, "video_type": a.type,
             "source": a.source, "fps": a.fps, "theme": "", "sections": secs, "scenes": scenes}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(sheet, open(a.out, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    n_i = sum(s["section"] == "intro" for s in scenes)
    print(f"wrote {a.out}: {len(scenes)} scenes ({n_i} intro, {len(scenes) - n_i} body), intro ends {fmt(intro_end)}")


def installed_skills(path):
    """The skill names in a skills folder (.claude/skills: one folder with a SKILL.md per skill), or in a
    Markdown list whose table rows start with the skill name."""
    if not path or not Path(path).exists():
        return None
    if Path(path).is_dir():
        return {d.name for d in Path(path).iterdir() if (d / "SKILL.md").exists()}
    return set(re.findall(r"^\|\s*([a-z][a-z0-9-]+)", Path(path).read_text(encoding="utf-8"), re.M))


def scenes_of(sh):
    """The sheet's scenes, sorted; older sheets used "shot" for the layout, so that still works."""
    sc = sorted(sh["scenes"], key=lambda s: s["start"])
    for s in sc:
        if "layout" not in s and "shot" in s:
            s["layout"] = s.pop("shot")
    return sc


def cmd_check(a):
    sh = json.load(open(a.sheet, encoding="utf-8"))
    sc = scenes_of(sh)
    for s in sc:
        s["layout"] = ALIASES.get(s.get("layout"), s.get("layout"))
    issues, warns = [], []
    skills = installed_skills(a.skills)
    last_tr = -99
    for p, s in zip([None] + sc[:-1], sc):
        tag = f"scene {s['id']} ({fmt(s['start'])})"
        if s["end"] <= s["start"]:
            issues.append(f"{tag}: ends before it starts")
        if p and s["start"] > p["end"] + 0.05:
            issues.append(f"{tag}: gap of {s['start'] - p['end']:.2f}s after scene {p['id']}")
        if p and s["start"] < p["end"] - 0.05:
            issues.append(f"{tag}: overlaps scene {p['id']} by {p['end'] - s['start']:.2f}s")
        if s.get("layout") not in SHOTS:
            issues.append(f"{tag}: unknown layout '{s.get('layout')}' (use {', '.join(SHOTS)})")
        tr = s.get("transition_in", "cut")
        if tr not in TRANSITIONS and not tr.startswith("custom:"):
            warns.append(f"{tag}: transition '{tr}' isn't a known one (fine if it's in the transitions library)")
        if tr not in ("cut", "none", "pip-shrink", "pip-grow", "morph", "smart", "fade", "dissolve"):
            if s["start"] - last_tr < 3:
                warns.append(f"{tag}: transition only {s['start'] - last_tr:.1f}s after the previous one (keep 3 s apart)")
            last_tr = s["start"]
        starts_stretch = s.get("layout") == "talking-head" and (p is None or p.get("layout") not in ("talking-head", "overlay"))
        if s["section"] == "intro" and starts_stretch and "talking-head-zoom" not in s.get("skills", []):
            warns.append(f"{tag}: full-screen intro stretch starts without talking-head-zoom (zoom in within the first second)")
        if s.get("layout") in ("broll", "split", "visual-storytelling", "card", "overlay", "cutout") and not s.get("visual"):
            issues.append(f"{tag}: layout '{s['layout']}' but nothing in 'visual'")
        if "cutout" in s and not isinstance(s["cutout"], bool):
            issues.append(f"{tag}: 'cutout' must be true or false")
        if s.get("layout") == "cutout" and s.get("cutout") is False:
            issues.append(f"{tag}: layout 'cutout' but 'cutout' is false")
        if needs_cutout(s) and not s.get("cutout_subject"):
            warns.append(f"{tag}: needs a cutout but no 'cutout_subject' (the speaker is cut out)")
        if s.get("cutout_subject") and not needs_cutout(s):
            warns.append(f"{tag}: 'cutout_subject' without 'cutout': true (nothing is cut out)")
        if s.get("layout") == "broll" and not s.get("skills") and not s.get("source") and not s.get("visual"):
            warns.append(f"{tag}: B-roll without a 'source' (a file, a library clip, a generated clip, a URL to record) or a 'visual'")
        if skills is not None:
            for k in s.get("skills", []):
                if k not in skills:
                    warns.append(f"{tag}: skill '{k}' isn't installed in this studio")
    if a.words:
        w = on_cut(json.load(open(a.words, encoding="utf-8")), a.edl)
        if sc and w and (sc[0]["start"] > w[0][0] + 0.5 or sc[-1]["end"] < w[-1][1] - 0.5):
            warns.append(f"scenes cover {fmt(sc[0]['start'])}-{fmt(sc[-1]['end'])}, words run {fmt(w[0][0])}-{fmt(w[-1][1])}")
    intro = [s for s in sc if s["section"] == "intro"]
    if intro and all(s["layout"] == "talking-head" for s in intro):
        warns.append("the intro is all full-screen presenter: plan visual-storytelling scenes, B-roll or cards (dynamic intro)")
    n_cut = sum(needs_cutout(s) for s in sc)
    print(f"{len(sc)} scenes, {len(issues)} problem(s), {len(warns)} warning(s)" + (f", {n_cut} with a cutout" if n_cut else ""))
    for x in issues:
        print("  PROBLEM ", x)
    for x in warns:
        print("  warning ", x)
    sys.exit(1 if issues else 0)


def cmd_view(a):
    sh = json.load(open(a.sheet, encoding="utf-8"))
    sc = scenes_of(sh)
    md = [f"# Production sheet: {sh.get('project', '')}", "",
          f"Type: {sh.get('video_type', '')} · Theme: {sh.get('theme') or sh.get('world') or 'not set'} · Source: {sh.get('source', '')}", ""]
    for sec in sh.get("sections", []):
        rows = [s for s in sc if s["section"] == sec["id"] or (sec["id"].startswith("body") and s["section"] == "body"
                                                               and sec["start"] <= s["start"] < sec["end"])]
        if not rows:
            continue
        md += [f"## {sec['id']} ({fmt(sec['start'])}-{fmt(sec['end'])}, {sec.get('mode', '')})", "",
               "| # | Time | Line | Layout | What's shown | Transition in | Skills | SFX |", "|---|---|---|---|---|---|---|---|"]
        for s in rows:
            cell = lambda x: str(x).replace("|", "/").replace("\n", " ")
            md.append(f"| {s['id']} | {fmt(s['start'])}-{fmt(s['end'])} | {cell(s['line'])} | {s['layout']} | "
                      f"{cell(s.get('visual', ''))}{(' (cutout: ' + cell(subject_of(s)) + ')') if needs_cutout(s) else ''} | {s.get('transition_in', '')} | {', '.join(s.get('skills', []))} | "
                      f"{', '.join(s.get('sfx', []))} |")
        md.append("")
    mdp = Path(a.md or Path(a.sheet).with_suffix(".md"))
    mdp.write_text("\n".join(md), encoding="utf-8")
    shots = Counter(s["layout"] for s in sc)
    dur = defaultdict(float)
    for s in sc:
        dur[s["layout"]] += s["end"] - s["start"]
    total = sum(dur.values()) or 1
    bar = "".join(f'<span class="seg {s["layout"]}" style="flex:{s["end"] - s["start"]:.2f}" title="{s["id"]}: {html.escape(s["layout"])}"></span>' for s in sc)
    legend = " ".join(f'<span class="key {k}"></span>{k} {dur[k] / total:.0%}' for k in SHOTS if dur[k])
    cards = []
    for s in sc:
        cards.append(f'''<article class="scene {s["section"]}"><header><span class="n">{s["id"]}</span>
<span class="t">{fmt(s["start"])} – {fmt(s["end"])}</span><span class="shot {s["layout"]}">{html.escape(s["layout"])}</span>
<span class="tr">in: {html.escape(s.get("transition_in", ""))}</span></header>
<p class="line">“{html.escape(s["line"])}”</p><p class="vis">{html.escape(s.get("visual", "") or "—")}</p>
<footer>{("cutout: " + html.escape(subject_of(s)) + " · ") if needs_cutout(s) else ""}{html.escape(", ".join(s.get("skills", [])))}{(" · sfx: " + html.escape(", ".join(s["sfx"]))) if s.get("sfx") else ""}{(" · " + html.escape(s["notes"])) if s.get("notes") else ""}</footer></article>''')
    page = f'''<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Production sheet</title><style>
:root{{--bg:#f6f5f2;--card:#fff;--ink:#141414;--mute:#6b6b6b;--line:#e3e1dc;--acc:#ff5a1f}}
@media (prefers-color-scheme:dark){{:root{{--bg:#111;--card:#1b1b1b;--ink:#eee;--mute:#999;--line:#2b2b2b}}}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif}}
main{{max-width:1100px;margin:0 auto;padding:24px 16px 60px}} h1{{font-size:26px;margin:0 0 4px}}
.meta{{color:var(--mute);margin-bottom:16px}} .bar{{display:flex;height:14px;border-radius:7px;overflow:hidden;margin:8px 0}}
.seg,.key{{display:inline-block}} .key{{width:10px;height:10px;border-radius:3px;margin:0 4px 0 12px}}
.talking-head{{background:#9aa0a6}} .visual-storytelling{{background:#c2410c}} .cutout{{background:#ff5a1f}} .split{{background:#ff9b6b}}
.screen-facecam{{background:#4f8df5}} .broll{{background:#2f6fde}} .screen{{background:#6aa2ff}} .overlay{{background:#14b8a6}} .card{{background:#8b5cf6}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;margin-top:18px}}
.scene{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}}
.scene.intro{{border-left:4px solid var(--acc)}} header{{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}}
.n{{font-weight:700}} .t,.tr{{color:var(--mute)}} .shot{{color:#fff;border-radius:6px;padding:1px 7px;font-size:12px}}
.line{{margin:8px 0 6px;font-style:italic}} .vis{{margin:0 0 8px}} footer{{color:var(--mute);font-size:12px}}
</style></head><body><main><h1>Production sheet: {html.escape(str(sh.get("project", "")))}</h1>
<div class="meta">{html.escape(str(sh.get("video_type", "")))} · theme: {html.escape(sh.get("theme") or sh.get("world") or "not set")} · {len(sc)} scenes</div>
<div class="bar">{bar}</div><div class="meta">{legend}</div><div class="grid">{"".join(cards)}</div></main></body></html>'''
    hp = Path(a.html or Path(a.sheet).with_suffix(".html"))
    hp.write_text(page, encoding="utf-8")
    print("wrote", mdp, "and", hp, "| layouts:", dict(shots))


def cmd_status(a):
    sh = json.load(open(a.sheet, encoding="utf-8"))
    by = defaultdict(Counter)
    for s in scenes_of(sh):
        by[ROLE_OF.get(s["layout"], "animator")][s.get("status", "planned")] += 1
    for role, c in by.items():
        print(f"{role:10s} " + ", ".join(f"{k}: {v}" for k, v in c.items() if v))
    cut = Counter(s.get("cutout_result") or "to do" for s in scenes_of(sh) if needs_cutout(s))
    if cut:
        print("cutouts    " + ", ".join(f"{k}: {v}" for k, v in cut.items()))


STATUSES = ("planned", "cutting", "building", "built", "approved")


def replace_sheet(path, sh):
    """Write the sheet next to itself and swap it in, so it is never read half written."""
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".production-", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(sh, f, indent=1, ensure_ascii=False)
    os.chmod(tmp, os.stat(path).st_mode & 0o777)
    os.replace(tmp, path)


def pick(sh, ids, path):
    want = {str(x) for x in ids}
    found = [s for s in sh.get("scenes", []) if str(s.get("id")) in want]
    missing = sorted(want - {str(s.get("id")) for s in found})
    if missing:
        sys.exit(f"no scene with id {', '.join(missing)} in {path} (nothing changed)")
    return found


def id_list(found):
    return ", ".join(sorted({str(s.get("id")) for s in found}, key=lambda x: (len(x), x)))


def cmd_mark(a):
    path = Path(a.sheet)
    sh = json.load(open(path, encoding="utf-8"))
    found = pick(sh, a.ids, path)
    for s in found:
        s["status"] = a.status
    replace_sheet(path, sh)
    print(f"scene{'s' if len(found) > 1 else ''} {id_list(found)}: {a.status}")


def cmd_cutouts(a):
    sh = json.load(open(a.sheet, encoding="utf-8"))
    rows = [{"id": s["id"], "start": s["start"], "end": s["end"], "subject": subject_of(s), "layout": s.get("layout", ""),
             "result": s.get("cutout_result") or ""} for s in scenes_of(sh) if needs_cutout(s)]
    if a.json:
        print(json.dumps(rows, ensure_ascii=False))
        return
    if not rows:
        print("no scene needs a cutout")
    for r in rows:
        print(f"scene {r['id']}: {r['start']:.2f}-{r['end']:.2f} s, cut out {r['subject']}" + (f" ({r['result']})" if r["result"] else ""))


def cmd_cutout(a):
    path = Path(a.sheet)
    sh = json.load(open(path, encoding="utf-8"))
    found = pick(sh, a.ids, path)
    flat = [s for s in found if not needs_cutout(s)]
    if flat:
        sys.exit(f"scene {id_list(flat)} has no cutout planned (\"cutout\": true): nothing changed")
    if a.result == "done" and not a.masks:
        sys.exit("cutout done needs --masks (the object-separation folder, e.g. work/objsep/scene3-speaker)")
    for s in found:
        s["cutout_result"] = a.result
        s.pop("cutout_why", None); s.pop("cutout_masks", None)
        if a.result == "done":
            s["cutout_masks"] = a.masks
        else:
            s["cutout_why"] = a.why or "failed"
    replace_sheet(path, sh)
    print(f"scene{'s' if len(found) > 1 else ''} {id_list(found)}: cutout {a.result}" + (f" ({a.why or 'failed'})" if a.result == "skipped" else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("draft"); p.add_argument("words"); p.add_argument("--out", required=True)
    p.add_argument("--intro-end", type=float); p.add_argument("--chapters"); p.add_argument("--type", default="talking-head")
    p.add_argument("--fps", default="30000/1001"); p.add_argument("--source", default=""); p.add_argument("--project")
    p.add_argument("--edl", help="the locked cut (segments_sec in source seconds): map the words onto its timeline")
    p = sub.add_parser("check"); p.add_argument("sheet"); p.add_argument("--words"); p.add_argument("--skills")
    p.add_argument("--edl", help="with --words: the cut the sheet is on (source-time words are mapped onto it)")
    p = sub.add_parser("view"); p.add_argument("sheet"); p.add_argument("--md"); p.add_argument("--html")
    p = sub.add_parser("status"); p.add_argument("sheet")
    p = sub.add_parser("mark"); p.add_argument("sheet"); p.add_argument("status", choices=STATUSES)
    p.add_argument("ids", nargs="+", help="scene ids")
    p = sub.add_parser("cutouts"); p.add_argument("sheet"); p.add_argument("--json", action="store_true")
    p = sub.add_parser("cutout"); p.add_argument("sheet"); p.add_argument("result", choices=("done", "skipped"))
    p.add_argument("ids", nargs="+", help="scene ids"); p.add_argument("--masks", help="done: the folder the masks are in")
    p.add_argument("--why", choices=CUTOUT_WHY, help="skipped: why (no-python, no-packages, no-model, failed)")
    a = ap.parse_args()
    {"draft": cmd_draft, "check": cmd_check, "view": cmd_view, "status": cmd_status, "mark": cmd_mark,
     "cutouts": cmd_cutouts, "cutout": cmd_cutout}[a.cmd](a)


if __name__ == "__main__":
    main()
