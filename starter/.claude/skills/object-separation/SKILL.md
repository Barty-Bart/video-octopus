---
name: object-separation
description: Separate a person, a product or a hand from the background of a video, on this computer, with Meta's SAM 2.1 (through transformers). Gives a mask for every frame in the project's work/ folder, a check sheet and a check video, and puts graphics or a new background between the background and the subject. Use when someone wants to separate, isolate, cut out or rotoscope something in a video, put text or graphics behind a person, swap a background, or highlight a subject or product.
---

# Object separation (on-device)

Separate one subject from the background of a video. Everything runs on this computer and nothing is uploaded. The result is a mask for every frame (white = the subject), which a scene then uses: text or a graphic behind the speaker, a new background, a highlight or outline round a product.

The script is in this skill's folder. Commands below run from the project folder (`projects/<name>/`), where the studio is `../..`. Run it with the studio's Python (`../../.venv/bin/python` on Mac and Linux, `..\..\.venv\Scripts\python.exe` on Windows), else `python3`:

```bash
python3 ../../.claude/skills/object-separation/scripts/objsep.py check
```

## 1. The model (never downloaded here)

SAM 2.1 comes in three sizes. The script loads the one picked from the Hugging Face cache and **never downloads a model itself**.

| Machine | Recommended | Download | Speed |
|---|---|---|---|
| NVIDIA card with 12 GB or more | `large` (facebook/sam2.1-hiera-large) | 898 MB | about 2.3× tiny's time per frame; the most exact |
| NVIDIA under 12 GB, or Apple Silicon | `base-plus` (facebook/sam2.1-hiera-base-plus) | 323 MB | about 1.4× tiny's time; clean edges |
| No GPU (the CPU) | `tiny` (facebook/sam2.1-hiera-tiny) | 156 MB | the fastest, but on the CPU still seconds a frame |

- **Video Octopus's settings:** the creator's pick reaches you as `STUDIO_OBJSEP_MODEL` (tiny, base-plus or large; Settings → Rendering → Object separation). Not set means "the recommended one", which the script works out the same way. `--model` overrides both; use it only when the creator asks.
- `check` says the device, the recommended model, the one in use, what's downloaded and what's missing. Tell the creator in plain words: the model, the device, and what speed to expect.
- **Model not downloaded:** never fetch it silently. Ask in the chat first ("Can I download SAM 2.1 <size>, <size> MB, from Hugging Face? Once, for every project."). On a yes, run Video Octopus's own Download, the same one Setup's Object separation row has (its progress shows there too): `node "$STUDIO_OCTOPUS" models download sam2 <size>`. The creator can also press Download in Setup themselves. Outside Video Octopus, after the yes, download only the five files the script needs (`check` prints the command).
- **Packages missing** (torch, torchvision, transformers 4.56+, numpy, Pillow): they're in the studio's `requirements.txt`. Ask before installing anything. With an NVIDIA card on Windows or Linux, install the CUDA build of torch from pytorch.org first.
- **On the CPU** it works but it's slow. Separate only the part that needs it, and say how long it will take after a short test.

## 2. Which video

Separate **the video the effect is built on**, because mask *n* is that video's frame at *n* / fps seconds:
- an effect on the edited video (the usual case): the locked cut's render (`tools/cut/apply_edit.py` renders a saved cut), so the masks are on the cut's timeline, like the production sheet;
- an effect on the raw take: the take in `source/` (masks on the take's own clock; the cut's `segments_sec` map cut time to take time).

Never write into `source/`. A variable-frame-rate recording (some screen recorders) gets a note: make a constant-rate copy in `work/` first (`ffmpeg -i in.mov -vf fps=30 -c:a copy work/take_cfr.mp4`) and separate that.

## 3. Pick the subject

```bash
python3 ../../.claude/skills/object-separation/scripts/objsep.py preview VIDEO --at 12.4
```
writes `work/objsep/preview.jpg`: the frame at that time with a labelled pixel grid. Look at it and choose:
- two or three `--point X,Y` on the subject (face, chest, the product's body), in the video's own pixels;
- `--point X,Y,0` on anything that touches the subject but must be left out (a hand holding a product, packaging, the desk);
- or a `--box X0,Y0,X1,Y1` round an object (alone or with points).

Pick a start frame where the subject is clearly visible. Show the creator the points when it isn't obvious what counts as the subject.

## 4. Separate

```bash
python3 ../../.claude/skills/object-separation/scripts/objsep.py separate VIDEO --name speaker \
        --point 960,420 --point 980,820 --point 1500,950,0 --start 12.4 --end 18
```
- `--name`: one short name per subject (`speaker`, `product`, `hand`). Everything goes into `work/objsep/<name>/`; running the same name again replaces it.
- Try about a second first (`--end` = start + 1), check it (step 5), then run the whole range.
- It works in chunks of 60 frames (`--chunk`), each starting from the last mask of the one before, so memory stays low on long ranges. It prints the speed per frame: tell the creator the estimate for the full range.
- Output: `work/objsep/<name>/masks/NNNNNN.png` (8-bit, soft edges, the video's size, about 50 KB a frame at 1080p) and `meta.json` (video, fps, frame range, the points, model, device, seconds per frame, frames where the subject was lost).

## 5. Check it, then show the creator

```bash
python3 ../../.claude/skills/object-separation/scripts/objsep.py sheet VIDEO --name speaker
```
writes `work/objsep/<name>/sheet.jpg`: six frames across the range, background dimmed, the subject outlined. **Look at it** before going on:
- something that isn't the subject is included → add a `--point X,Y,0` on it and separate again;
- part of the subject is missing → add a point there;
- "the subject is (nearly) gone" on some frames while it's still in the picture → separate again from there (`--start` at that frame) with points on it.

For the creator, `overlay` makes `work/objsep/<name>/check.mp4` (the same look, moving, with the sound). Pass `--color` with the brand's accent from `BRAND.md` (else the outline is white).

Masks are very clean on people, objects and hands; fine hair and motion blur are softer. Anything attached to the subject counts as part of it (a cable, packaging, peel-off film): exclude it with a label-0 point.

## 6. Use the masks in a scene

**Behind the subject** (a title, a graphic, a new background between the background and the person):
```bash
python3 ../../.claude/skills/object-separation/scripts/objsep.py behind VIDEO --name speaker \
        --layer work/scene/title.png --out work/objsep/speaker/title_behind.mp4
```
`--layer` is an image with transparency, a folder of numbered PNG frames (a scene rendered frame by frame, its first frame lined up with the masks' first frame, or with `--start`), or a video (ProRes 4444 keeps its transparency). An opaque layer replaces the background. `--start` / `--end` pick a part of the masks' range. The result has the video's sound for that part.

**In your own compositing** (canvas or HTML scenes rendered frame by frame, Python, ffmpeg): frame *n* of the video goes with `masks/{n:06d}.png`; in ffmpeg, `alphamerge` the video with the mask sequence (`-framerate <fps> -start_number <first frame> -i masks/%06d.png`) to get the subject alone with transparency, and overlay it on top of whatever goes behind it. An outline or glow comes from the mask's edge (grow it, subtract it). Colours and fonts come from `BRAND.md` and `STYLE.md`; with no brand colours, keep it neutral.

The scene's render goes into `renders/` with a version number like any other build (never over an existing render), so Video Octopus's Scenes tab and Export pick it up. Log one line in the project's `WORKLOG.md` ("Separated speaker 12.4–18 s with base-plus on MPS: 168 masks → work/objsep/speaker/").

## Cleaning up

The masks are plain files in `work/objsep/<name>/`; once a project is finished they can go. The models stay in the Hugging Face cache (`~/.cache/huggingface/hub/models--facebook--sam2.1-hiera-*`) for every project; deleting those folders frees the space (Setup can download them again).
