#!/usr/bin/env python3
"""review_cuts.py: a review page for proposed rough-cut edits, so the creator can veto or approve each one.

  python3 review_cuts.py work/cuts.json [WORDS.json] --html work/cuts.html [--media ../source/raw.mp4] [--title "..."]

The page shows the transcript with every proposed cut struck through and colour-coded
(filler, pause, stutter, retake), a checkbox per cut (ticked = cut), a list of all cuts with
their reason and confidence, live before/after duration, and a player that jumps to each cut
when the video can be found. "Copy decisions" copies {"reject": [...], "accept": [...]}:
save it as work/decisions.json and pass it to apply_cuts.py --decisions.
Also prints a short text summary for the chat.
"""
import argparse, html, json, os, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cutlib import TERMINAL  # noqa: E402

LABEL = {"filler": "Filler", "silence": "Pause", "stutter": "Stutter", "retake": "Retake"}


def summary(data):
    items = data["items"]
    est = data.get("estimate", {})
    asks = [it for it in items if it["action"] == "ask"]
    lines = [f"Rough cut: {len(items)} proposed cuts, {len(items) - len(asks)} on by default, {len(asks)} need your call."]
    if est:
        lines.append(f"Length {est['before']:.1f}s -> about {est['after']:.1f}s (-{est['before'] - est['after']:.1f}s).")
        lines.append("Saved by default: " + ", ".join(f"{LABEL[k].lower()}s {v:.1f}s" for k, v in est["saved_by_reason"].items() if v > 0.04) + ".")
    for it in items:
        if it["reason"] == "retake":
            lines.append(f"Retake #{it['id']} at {it['start']:.1f}s ({'cut' if it['action'] == 'cut' else 'ASK'}, "
                         f"confidence {it['confidence']:.2f}): \"{it['text'][:70]}\"")
    for it in asks:
        if it["reason"] != "retake":
            lines.append(f"Ask #{it['id']} {it['reason']} at {it['start']:.1f}s: \"{it['text'][:50]}\" - {it['note']}")
    return "\n".join(lines)


def build(data, media, title):
    units, items = data["units"], data["items"]
    cover = {}                                   # unit index -> item ids
    for it in items:
        for u in it["units"]:
            cover.setdefault(u, []).append(it["id"])
    sil_after = {}                               # pause chip placed after unit index
    for it in items:
        if it["reason"] == "silence":
            sil_after.setdefault(it["gap"][0], []).append(it)
    first_of = {}
    for it in items:
        if it["units"]:
            first_of.setdefault(min(it["units"]), []).append(it)

    def chip(it):
        return (f'<label class="tick r-{it["reason"]}{" ask" if it["action"] == "ask" else ""}" title="{html.escape(it["note"])}">'
                f'<input type="checkbox" data-id="{it["id"]}"><span>#{it["id"]}</span></label>')

    def pause(it):
        return (f'<span class="pause item-{it["id"]}" data-items="{it["id"]}">{chip(it)}'
                f'<span class="pz">{it["end"] - it["start"]:.1f}s</span></span> ')

    out, para = [], []

    def flush(t0):
        if para:
            out.append(f'<p><button class="ts" data-t="{t0:.2f}">{int(t0 // 60)}:{t0 % 60:04.1f}</button> ' + "".join(para) + "</p>")
            para.clear()

    t0 = units[0][0] if units else 0
    for it in sil_after.get(-1, []):
        para.append(pause(it))
    for i, u in enumerate(units):
        for it in first_of.get(i, []):
            para.append(chip(it))
        ids = cover.get(i, [])
        text = html.escape(u[2])
        cls = "w" + (" snd" if u[3] != "word" else "")
        para.append(f'<span class="{cls}" data-items="{" ".join(map(str, ids))}" data-t="{u[0]:.2f}">{text}</span> ')
        for it in sil_after.get(i, []):
            para.append(pause(it))
        nxt = units[i + 1][0] if i + 1 < len(units) else None
        if nxt is not None and (nxt - u[1] > 1.2 or (u[2][-1:] in TERMINAL and nxt - u[1] > 0.6)):
            flush(t0)
            t0 = nxt
    flush(t0)

    rows = []
    for it in items:
        rows.append(
            f'<li class="row r-{it["reason"]}{" ask" if it["action"] == "ask" else ""}" data-row="{it["id"]}">'
            f'<label class="tick r-{it["reason"]}"><input type="checkbox" data-id="{it["id"]}"><span>#{it["id"]}</span></label>'
            f'<div class="rb"><div class="rt"><span class="tag r-{it["reason"]}">{LABEL[it["reason"]]}</span>'
            + ('<span class="tag askt">Your call</span>' if it["action"] == "ask" else "")
            + f'<button class="ts" data-t="{max(0, it["start"] - 1):.2f}" data-end="{it["end"] + 1:.2f}">{int(it["start"] // 60)}:{it["start"] % 60:04.1f}</button>'
            f'<span class="meta">{it["confidence"]:.0%} sure · {it["saved"]:.1f}s</span></div>'
            f'<div class="rx">{html.escape(it["text"][:160])}</div><div class="rn">{html.escape(it["note"])}</div></div></li>')

    payload = {"items": [{"id": it["id"], "reason": it["reason"], "action": it["action"], "saved": it["saved"]} for it in items],
               "before": data.get("estimate", {}).get("before", data["duration"]),
               "key": "rough-cut:" + data.get("source", "")}
    page = TEMPLATE
    for k, v in {"%TITLE%": html.escape(title), "%SRC%": html.escape(Path(data.get("source", "")).name),
                 "%TRANSCRIPT%": "\n".join(out), "%ROWS%": "\n".join(rows),
                 "%MEDIA%": (f'<video id="vid" src="{html.escape(media)}" controls playsinline preload="metadata"></video>' if media else
                             '<p class="nomedia">Video not linked. Re-run with --media to play each cut.</p>'),
                 "%SUMMARY%": html.escape(summary(data)),
                 "%DATA%": json.dumps(payload).replace("</", "<\\/")}.items():
        page = page.replace(k, v)
    return page


TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rough Cut Review</title>
<style>
:root{--bg:#f7f6f3;--panel:#fff;--ink:#1d1d1b;--mute:#6b6a66;--line:#e4e2dc;--accent:#2f5bd3;
--filler:#b26a00;--filler-bg:#fdf0d8;--silence:#5b6573;--silence-bg:#e9edf2;--stutter:#7a3fc4;--stutter-bg:#efe6fb;
--retake:#c0362c;--retake-bg:#fbe5e2;--ask:#0f7b6c}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--panel:#1f1f1d;--ink:#ecebe7;--mute:#a19f98;--line:#33322f;--accent:#7d9cff;
--filler:#f0b14a;--filler-bg:#3a2c12;--silence:#a8b3c2;--silence-bg:#262b33;--stutter:#c39bff;--stutter-bg:#2d2240;--retake:#ff8a7e;--retake-bg:#3d1f1c;--ask:#4fd1b9}}
:root[data-theme="dark"]{--bg:#151514;--panel:#1f1f1d;--ink:#ecebe7;--mute:#a19f98;--line:#33322f;--accent:#7d9cff;
--filler:#f0b14a;--filler-bg:#3a2c12;--silence:#a8b3c2;--silence-bg:#262b33;--stutter:#c39bff;--stutter-bg:#2d2240;--retake:#ff8a7e;--retake-bg:#3d1f1c;--ask:#4fd1b9}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:20px 16px 8px;max-width:1180px;margin:0 auto}
h1{font-size:22px;margin:0 0 2px;letter-spacing:-.01em}
.sub{color:var(--mute);font-size:14px}
.stats{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:baseline;margin:14px 0 4px}
.big{font-size:28px;font-weight:650;font-variant-numeric:tabular-nums}
.big small{font-size:15px;color:var(--mute);font-weight:500}
.legend{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.tag{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:99px;white-space:nowrap}
.tag.r-filler{color:var(--filler);background:var(--filler-bg)}.tag.r-silence{color:var(--silence);background:var(--silence-bg)}
.tag.r-stutter{color:var(--stutter);background:var(--stutter-bg)}.tag.r-retake{color:var(--retake);background:var(--retake-bg)}
.tag.askt{color:var(--ask);border:1px solid var(--ask);background:transparent}
main{max-width:1180px;margin:0 auto;padding:8px 16px 120px;display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:20px}
@media (max-width:900px){main{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}
.tx p{margin:0 0 14px;font-size:17px;line-height:1.9}
.w{border-radius:3px;cursor:pointer}
.w.on{text-decoration:line-through;text-decoration-thickness:2px}
.w.on.c-filler{color:var(--filler);background:var(--filler-bg)}
.w.on.c-stutter{color:var(--stutter);background:var(--stutter-bg)}
.w.on.c-retake{color:var(--retake);background:var(--retake-bg)}
.w.pend{text-decoration:underline dotted var(--ask);text-decoration-thickness:2px;text-underline-offset:4px}
.w.snd{font-style:italic;color:var(--mute);font-size:14px}
.pause{display:inline-flex;align-items:center;gap:2px;font-size:12px;color:var(--silence);background:var(--silence-bg);border-radius:6px;padding:0 6px 0 2px;vertical-align:1px}
.pause.off{background:transparent;border:1px dashed var(--line)}
.pause.on .pz{text-decoration:line-through}
.tick{display:inline-flex;align-items:center;gap:2px;font-size:11px;font-weight:600;color:var(--mute);vertical-align:2px;margin-right:2px;cursor:pointer;user-select:none}
.tick input{margin:0;width:14px;height:14px;accent-color:var(--accent)}
.tick.ask span{color:var(--ask)}
.ts{font:inherit;font-size:12px;color:var(--accent);background:none;border:0;padding:0 4px 0 0;cursor:pointer;font-variant-numeric:tabular-nums}
.ts:hover{text-decoration:underline}
aside{position:sticky;top:12px;align-self:start;display:flex;flex-direction:column;gap:14px;max-height:calc(100vh - 24px)}
@media (max-width:900px){aside{position:static;max-height:none}}
video{width:100%;border-radius:8px;background:#000;display:block}
.nomedia{color:var(--mute);font-size:13px;margin:0}
.list{overflow:auto;padding:4px 8px}
.list ul{list-style:none;margin:0;padding:0}
.row{display:flex;gap:8px;padding:10px 4px;border-bottom:1px solid var(--line)}
.row:last-child{border:0}
.row.dim{opacity:.55}
.rb{min-width:0;flex:1}
.rt{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.meta{font-size:12px;color:var(--mute);margin-left:auto;font-variant-numeric:tabular-nums}
.rx{font-size:14px;margin-top:3px;overflow-wrap:anywhere}
.rn{font-size:12px;color:var(--mute)}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.filters button,.bar button{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:8px;padding:5px 10px;cursor:pointer}
.filters button.sel{border-color:var(--accent);color:var(--accent)}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--panel);border-top:1px solid var(--line);padding:10px 16px}
.bar .in{max-width:1180px;margin:0 auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.bar .primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.bar .msg{font-size:13px;color:var(--mute);flex:1;min-width:180px}
textarea{width:100%;font:12px ui-monospace,Menlo,monospace;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px;margin-top:8px;display:none}
details{margin-top:6px}summary{cursor:pointer;color:var(--mute);font-size:13px}
pre.sum{white-space:pre-wrap;font:12px/1.5 ui-monospace,Menlo,monospace;color:var(--mute);margin:6px 0 0}
</style></head><body>
<header>
 <h1>%TITLE%</h1>
 <div class="sub">%SRC% · ticked = cut. Untick anything that should stay; tick a "Your call" item to cut it.</div>
 <div class="stats"><div class="big" id="after">–</div><div class="sub" id="detail"></div></div>
 <div class="legend"><span class="tag r-filler">Filler</span><span class="tag r-silence">Pause</span><span class="tag r-stutter">Stutter</span><span class="tag r-retake">Retake</span><span class="tag askt">Your call: not cut unless ticked</span></div>
 <details><summary>Text summary</summary><pre class="sum">%SUMMARY%</pre></details>
</header>
<main>
 <section class="card tx" id="tx">%TRANSCRIPT%</section>
 <aside>
  <div class="card">%MEDIA%</div>
  <div class="card list">
   <div class="filters" id="filters"><button class="sel" data-f="all">All</button><button data-f="ask">Your call</button><button data-f="retake">Retakes</button><button data-f="filler">Fillers</button><button data-f="stutter">Stutters</button><button data-f="silence">Pauses</button></div>
   <ul id="rows">%ROWS%</ul>
  </div>
 </aside>
</main>
<div class="bar"><div class="in">
 <button class="primary" id="copy">Copy decisions</button><button id="reset">Reset</button>
 <span class="msg" id="msg">Paste the decisions into the chat (or save as work/decisions.json).</span>
 <textarea id="out" rows="3" readonly></textarea>
</div></div>
<script>
const D=%DATA%;
const byId=Object.fromEntries(D.items.map(i=>[i.id,i]));
const state={};
function defaults(){D.items.forEach(i=>state[i.id]=i.action==="cut")}
defaults();
try{const s=JSON.parse(localStorage.getItem(D.key)||"null");if(s)Object.assign(state,s)}catch(e){}
const PRI={retake:3,stutter:2,filler:1,silence:0};
function render(){
  document.querySelectorAll('input[data-id]').forEach(c=>c.checked=!!state[c.dataset.id]);
  document.querySelectorAll('.w').forEach(w=>{
    const ids=(w.dataset.items||"").split(" ").filter(Boolean).map(Number);
    w.className=w.className.replace(/ ?(on|pend|c-\w+)/g,"");
    const on=ids.filter(i=>state[i]);
    if(on.length){const top=on.map(i=>byId[i].reason).sort((a,b)=>PRI[b]-PRI[a])[0];w.classList.add("on","c-"+top)}
    else if(ids.length)w.classList.add("pend");
  });
  document.querySelectorAll('.pause').forEach(p=>{const on=!!state[p.dataset.items];p.classList.toggle("on",on);p.classList.toggle("off",!on)});
  document.querySelectorAll('.row').forEach(r=>r.classList.toggle("dim",!state[r.dataset.row]));
  let saved=0,n=0;D.items.forEach(i=>{if(state[i.id]){saved+=i.saved;n++}});
  const after=Math.max(0,D.before-saved);
  document.getElementById("after").innerHTML=fmt(D.before)+' <small>→</small> '+fmt(after);
  const d=decisions();
  document.getElementById("detail").textContent=`about ${saved.toFixed(1)} s shorter · ${n} of ${D.items.length} cuts on · ${d.reject.length} vetoed · ${d.accept.length} extra approved`;
  try{localStorage.setItem(D.key,JSON.stringify(state))}catch(e){}
}
function fmt(s){const m=Math.floor(s/60);return m+":"+(s-60*m).toFixed(1).padStart(4,"0")}
function decisions(){
  return{reject:D.items.filter(i=>i.action==="cut"&&!state[i.id]).map(i=>i.id),
         accept:D.items.filter(i=>i.action==="ask"&&state[i.id]).map(i=>i.id)};
}
document.addEventListener("change",e=>{if(e.target.dataset.id){state[e.target.dataset.id]=e.target.checked;render()}});
const vid=document.getElementById("vid");let stopAt=null;
function play(t,end){if(!vid)return;vid.currentTime=t;stopAt=end||null;vid.play().catch(()=>{});vid.scrollIntoView({block:"nearest",behavior:"smooth"})}
if(vid)vid.addEventListener("timeupdate",()=>{if(stopAt&&vid.currentTime>=stopAt){vid.pause();stopAt=null}});
document.addEventListener("click",e=>{
  const b=e.target.closest(".ts");if(b){play(+b.dataset.t,b.dataset.end?+b.dataset.end:null);return}
  const w=e.target.closest(".w");if(w&&vid)play(Math.max(0,+w.dataset.t-0.5));
});
document.getElementById("filters").addEventListener("click",e=>{
  const f=e.target.dataset.f;if(!f)return;
  document.querySelectorAll("#filters button").forEach(b=>b.classList.toggle("sel",b===e.target));
  document.querySelectorAll(".row").forEach(r=>{r.style.display=(f==="all"||r.classList.contains(f==="ask"?"ask":"r-"+f))?"":"none"});
});
document.getElementById("copy").onclick=async()=>{
  const txt=JSON.stringify(decisions());const o=document.getElementById("out");o.value=txt;
  try{await navigator.clipboard.writeText(txt);document.getElementById("msg").textContent="Copied "+txt+" — paste it into the chat."}
  catch(e){o.style.display="block";o.select();document.getElementById("msg").textContent="Copy the text below and paste it into the chat."}
};
document.getElementById("reset").onclick=()=>{defaults();render()};
render();
</script></body></html>
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cuts")
    ap.add_argument("words", nargs="?", help="words.json (optional: the page uses the words stored in cuts.json)")
    ap.add_argument("--html", default="work/cuts.html")
    ap.add_argument("--media", default=None, help="video path or URL as the page should load it (default: relative path to the source)")
    ap.add_argument("--no-media", action="store_true")
    ap.add_argument("--title", default="Rough cut review")
    a = ap.parse_args()
    data = json.load(open(a.cuts, encoding="utf-8"))
    out = Path(a.html)
    out.parent.mkdir(parents=True, exist_ok=True)
    media = None
    if not a.no_media:
        if a.media:
            media = a.media
        elif data.get("source") and Path(data["source"]).exists():
            media = Path(os.path.relpath(data["source"], out.parent.resolve())).as_posix()
    out.write_text(build(data, media, a.title), encoding="utf-8")
    print(summary(data))
    print("wrote", out)


if __name__ == "__main__":
    main()
