#!/usr/bin/env python3
"""objsep.py: separate a person or an object from the background of a video with SAM 2.1, on this computer.

Run from the project folder (projects/<name>/). Everything goes into work/objsep/<name>/:

  python objsep.py check                                   # device, the recommended model, what's downloaded
  python objsep.py preview VIDEO --at 2.0                  # that frame with a coordinate grid (work/objsep/preview.jpg)
  python objsep.py separate VIDEO --name subject --point 960,420 --point 1700,980,0 --start 2 --end 6
  python objsep.py sheet VIDEO --name subject              # a few frames with the mask over them (sheet.jpg)
  python objsep.py overlay VIDEO --name subject            # the check video: background dimmed, subject outlined
  python objsep.py behind VIDEO --name subject --layer work/title.png --out work/objsep/subject/title_behind.mp4

Masks: work/objsep/<name>/masks/NNNNNN.png, 8-bit, white = the subject, the video's own size. Mask n is the frame at
n / fps seconds of VIDEO (fps and the range are in meta.json), so a mask always lines up with the video it came from.

The model: Meta's SAM 2.1 in Hugging Face's format, loaded with transformers from the Hugging Face cache only (it never
downloads). Recommended: NVIDIA 12 GB+ large, a smaller NVIDIA card or Apple Silicon base-plus, no GPU tiny (slow:
seconds a frame). The creator's pick comes in STUDIO_OBJSEP_MODEL (Video Octopus's Settings → Rendering); --model wins.
Needs torch, torchvision, transformers 4.56+, numpy, Pillow (the studio's requirements.txt) and ffmpeg.
"""
import argparse, datetime, json, math, os, re, shutil, subprocess, sys, time

os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')  # an op MPS lacks runs on the CPU instead of failing
os.environ.setdefault('TRANSFORMERS_VERBOSITY', 'error')
os.environ.setdefault('HF_HUB_DISABLE_PROGRESS_BARS', '1')

FFMPEG = os.environ.get('FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'
FFPROBE = os.environ.get('FFPROBE') or shutil.which('ffprobe') or 'ffprobe'

# SAM 2.1 on Hugging Face (weights' download size), and the files transformers reads.
MODELS = {
    'tiny': ('facebook/sam2.1-hiera-tiny', '156 MB'),
    'base-plus': ('facebook/sam2.1-hiera-base-plus', '323 MB'),
    'large': ('facebook/sam2.1-hiera-large', '898 MB'),
}
FILES = ['config.json', 'preprocessor_config.json', 'processor_config.json', 'video_preprocessor_config.json', 'model.safetensors']


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def have(size):
    """Whether the model is in the Hugging Face cache, every file of it."""
    try:
        from huggingface_hub import try_to_load_from_cache
    except Exception:
        return False
    return all(isinstance(try_to_load_from_cache(MODELS[size][0], f), str) for f in FILES)


def device_info():
    import torch
    if torch.cuda.is_available():
        p = torch.cuda.get_device_properties(0)
        return 'cuda', p.name, p.total_memory / 2**30
    if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
        return 'mps', 'Apple Silicon', 0.0
    return 'cpu', 'the CPU', 0.0


def recommend(device, vram):
    """The model for this computer (the same table as Video Octopus's Setup)."""
    if device == 'cuda':
        return 'large' if vram >= 12 else 'base-plus'
    return 'base-plus' if device == 'mps' else 'tiny'


def choose_model(arg, device, vram):
    """--model, else the creator's pick (STUDIO_OBJSEP_MODEL), else the recommended one. A model someone picked must be
    downloaded; the recommended one falls back to a downloaded one, with a note."""
    env = os.environ.get('STUDIO_OBJSEP_MODEL', '').strip()
    want = arg or (env if env in MODELS else None)
    size = want or recommend(device, vram)
    if have(size):
        return size, None
    if want:
        die(missing_text(size))
    for s in sorted((s for s in MODELS if have(s)), key=lambda s: abs(list(MODELS).index(s) - list(MODELS).index(size))):
        return s, f'The recommended {size} model is not downloaded, so this runs on {s}.'
    die(missing_text(size))


def missing_text(size):
    repo, mb = MODELS[size]
    return (f'The SAM 2.1 {size} model ({repo}, {mb}) is not downloaded on this computer.\n'
            "In Video Octopus: Setup -> Object separation (SAM 2) -> pick it and press Download (once; it goes in the Hugging Face cache).\n"
            'Without Video Octopus, ask the creator first, then: python -c "from huggingface_hub import snapshot_download; '
            f"snapshot_download('{repo}', allow_patterns={FILES!r})\"")


# ---- video ----
def probe(video):
    if not os.path.isfile(video):
        die(f'No such video: {video}')
    r = subprocess.run([FFPROBE, '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_format', '-of', 'json', video],
                       capture_output=True, text=True)
    if r.returncode:
        die(f'ffprobe could not read {video}: {r.stderr.strip()}')
    j = json.loads(r.stdout)
    if not j.get('streams'):
        die(f'{video} has no picture.')
    st = j['streams'][0]

    def rate(s):
        try:
            a, b = (float(x) for x in str(s).split('/'))
            return a / b if b else 0.0
        except Exception:
            return 0.0
    fps_str = st.get('r_frame_rate') or '30/1'
    fps = rate(fps_str) or 30.0
    if fps > 120:  # a timebase rather than a frame rate: use the average
        fps_str, fps = st.get('avg_frame_rate'), rate(st.get('avg_frame_rate'))
    avg = rate(st.get('avg_frame_rate'))
    rot = 0
    for sd in st.get('side_data_list') or []:
        if 'rotation' in sd:
            rot = int(sd['rotation'])
    rot = rot or int((st.get('tags') or {}).get('rotate', 0) or 0)
    w, h = int(st['width']), int(st['height'])
    if abs(rot) % 180 == 90:
        w, h = h, w
    return {'w': w, 'h': h, 'fps': fps, 'fps_str': fps_str, 'duration': float((j.get('format') or {}).get('duration') or 0),
            'vfr': bool(avg) and abs(avg - fps) / fps > 0.01}


def seek(n, fps):
    # A quarter frame early, then fps=: frame n comes out first, on the grid of the video's own frame rate.
    return f'{max(0.0, (n - 0.25) / fps):.6f}'


def read_frames(video, info, n, count, size=None):
    """Frames n..n+count-1 as RGB numpy arrays, at the video's own size (or `size`, (w, h))."""
    import numpy as np
    w, h = size or (info['w'], info['h'])
    vf = f"fps={info['fps_str']}" + (f',scale={w}:{h}:flags=area' if size else '')
    p = subprocess.Popen([FFMPEG, '-v', 'error', '-ss', seek(n, info['fps']), '-i', video, '-vf', vf,
                          '-frames:v', str(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
    nbytes = w * h * 3
    try:
        for _ in range(count):
            buf = p.stdout.read(nbytes)
            if len(buf) < nbytes:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        p.stdout.close(); p.wait()


def project_dir(name):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}', name or ''):
        die('--name is a short name like "subject", "me" or "product" (letters, digits, - _ .).')
    return os.path.join('work', 'objsep', name)


def load_meta(name):
    d = project_dir(name)
    try:
        return d, json.load(open(os.path.join(d, 'meta.json'), encoding='utf-8'))
    except FileNotFoundError:
        die(f'No separation called "{name}" here yet ({d}/meta.json): run separate first.')


def mask_at(d, n, info):
    from PIL import Image
    import numpy as np
    p = os.path.join(d, 'masks', f'{n:06d}.png')
    if not os.path.isfile(p):
        return None
    m = Image.open(p).convert('L')
    if m.size != (info['w'], info['h']):
        m = m.resize((info['w'], info['h']), Image.BILINEAR)
    return np.asarray(m, np.float32) / 255.0


def hex_rgb(c):
    c = (c or '').lstrip('#')
    if not re.fullmatch(r'[0-9a-fA-F]{6}', c):
        die('--color is a hex colour like #FFFFFF.')
    return [int(c[i:i + 2], 16) for i in (0, 2, 4)]


def look(img, m, color, dim=0.35):
    """The check look: the background dimmed, the subject as it is, a thin outline round it in `color`."""
    import numpy as np
    from PIL import Image, ImageFilter
    if m is None:
        return (img.astype(np.float32) * dim).astype(np.uint8)
    k = 3 if max(img.shape[:2]) <= 1280 else 5
    hard = Image.fromarray(((m > 0.5) * 255).astype(np.uint8), 'L')
    edge = (np.asarray(hard.filter(ImageFilter.MaxFilter(k)), np.float32) - np.asarray(hard.filter(ImageFilter.MinFilter(k)), np.float32)) / 255.0
    a = m[..., None]
    out = img.astype(np.float32) * (a + (1 - a) * dim)
    e = edge[..., None]
    out = out * (1 - e) + np.array(color, np.float32) * e
    return np.clip(out, 0, 255).astype(np.uint8)


# ---- commands ----
def cmd_check(a):
    from importlib import metadata
    info = {'python': sys.version.split()[0], 'downloaded': [m for m in MODELS if have(m)]}
    problems = []
    try:
        import torch
        info['torch'] = torch.__version__
        dev, name, vram = device_info()
        info.update(device=dev, gpu=name, vram_gb=round(vram, 1))
    except Exception as e:
        problems.append(f'torch is not installed for this Python ({sys.executable}): {e}')
        dev, vram = 'cpu', 0.0
    try:
        from transformers import Sam2VideoModel, Sam2VideoProcessor  # noqa: F401
        info['transformers'] = metadata.version('transformers')
    except Exception as e:
        problems.append(f'transformers 4.56 or newer (SAM 2\'s video model) is not installed for this Python: {e}')
    for mod, pkg in (('torchvision', 'torchvision (transformers\' SAM 2 image processor needs it)'), ('numpy', 'numpy'), ('PIL', 'Pillow')):
        try:
            __import__(mod)
        except Exception:
            problems.append(f'{pkg} is not installed for this Python.')
    rec = recommend(dev, vram)
    env = os.environ.get('STUDIO_OBJSEP_MODEL', '').strip()
    size = a.model or (env if env in MODELS else rec)
    info.update(recommended=rec, model=size, ready=have(size))
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
        info['cache'] = HF_HUB_CACHE
    except Exception:
        pass
    if not have(size):
        problems.append(missing_text(size))
    if not shutil.which(FFMPEG) and not os.path.isfile(FFMPEG):
        problems.append('ffmpeg is not on the PATH (or set FFMPEG).')
    print(json.dumps(info, indent=1))
    where = {'cuda': f'the NVIDIA card ({info.get("gpu")}, {vram:.0f} GB)', 'mps': 'Apple Silicon (MPS)', 'cpu': 'the CPU'}[dev]
    print(f'\nRecommended for this computer: SAM 2.1 {rec}. Using: {size}{" (picked)" if size != rec else ""}, on {where}.')
    if dev == 'cpu':
        print('No GPU it can use: it runs on the CPU, which takes seconds a frame. Separate only the part that needs it.')
    for p in problems:
        print(f'- {p}')
    sys.exit(1 if problems else 0)


def font(size):
    from PIL import ImageFont
    try:
        return ImageFont.load_default(size=size)  # Pillow 10.1+: a readable size
    except TypeError:
        return ImageFont.load_default()


def cmd_preview(a):
    from PIL import Image, ImageDraw
    info = probe(a.video)
    n = round(a.at * info['fps'])
    img = next(read_frames(a.video, info, n, 1), None)
    if img is None:
        die(f'No frame at {a.at} s.')
    im = Image.fromarray(img)
    d = ImageDraw.Draw(im)
    w, h = im.size
    step = max(40, int(round(max(w, h) / 16 / 20.0)) * 20)  # about 16 lines across, on round numbers
    f = font(max(14, step // 6))
    for x in range(0, w, step):
        d.line([(x, 0), (x, h)], fill=(255, 220, 0), width=1)
        d.text((x + 3, 3), str(x), fill=(255, 220, 0), font=f, stroke_width=2, stroke_fill=(0, 0, 0))
    for y in range(step, h, step):
        d.line([(0, y), (w, y)], fill=(255, 220, 0), width=1)
        d.text((3, y + 3), str(y), fill=(255, 220, 0), font=f, stroke_width=2, stroke_fill=(0, 0, 0))
    out = a.out or os.path.join('work', 'objsep', 'preview.jpg')
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    im.save(out, quality=88)
    print(f'{out}: frame {n} ({n / info["fps"]:.3f} s), {w}x{h}, grid every {step} px. Click points are in these pixels.')


def parse_points(a, info):
    pts, lbl = [], []
    for p in a.point or []:
        v = [x.strip() for x in p.split(',')]
        if len(v) not in (2, 3):
            die(f'--point is X,Y (the subject) or X,Y,0 (not the subject): {p}')
        x, y = float(v[0]), float(v[1])
        if not (0 <= x < info['w'] and 0 <= y < info['h']):
            die(f'--point {p} is outside the {info["w"]}x{info["h"]} frame.')
        pts.append([x, y]); lbl.append(1 if len(v) == 2 else int(float(v[2]) > 0))
    box = None
    if a.box:
        box = [float(x) for x in a.box.split(',')]
        if len(box) != 4 or box[2] <= box[0] or box[3] <= box[1]:
            die('--box is X0,Y0,X1,Y1 (top left, bottom right), in the video\'s pixels.')
    if not pts and not box:
        die('Give the subject: one or more --point X,Y on it (and X,Y,0 on what is not it), or a --box.')
    if pts and not any(lbl):
        die('At least one --point must be on the subject (X,Y with no ,0).')
    return pts, lbl, box


def cmd_separate(a):
    import numpy as np
    import torch
    from PIL import Image
    info = probe(a.video)
    fps = info['fps']
    last = max(0, math.ceil(info['duration'] * fps - 1e-6) - 1)   # the video's last frame
    n0 = round((a.start or 0) * fps)
    n1 = min(last, round(a.end * fps) - 1) if a.end else last      # inclusive
    if n0 > n1:
        die(f'Nothing to separate between {a.start} and {a.end} s (the video is {info["duration"]:.2f} s).')
    pts, lbl, box = parse_points(a, info)
    dev, gpu, vram = device_info()
    size, note = choose_model(a.model, dev, vram)
    if note:
        print(note)
    if info['vfr']:
        print('Note: this video has a variable frame rate. Masks follow its nominal rate; for exact frames use a constant-rate copy '
              '(ffmpeg -i in.mov -vf fps=30 -c:a copy out.mp4) and separate that.')
    if dev == 'cpu':
        print('No GPU: running on the CPU, which takes seconds a frame.')
    # SAM 2 works at 1024 px; frames bigger than about 2K go in at 1920 wide and the masks come back at full size.
    long_side = max(info['w'], info['h'])
    work = None
    if long_side > 2048:
        k = 1920 / long_side
        work = (int(round(info['w'] * k / 2)) * 2, int(round(info['h'] * k / 2)) * 2)
    sx = (work[0] / info['w']) if work else 1.0
    sy = (work[1] / info['h']) if work else 1.0

    d = project_dir(a.name)
    masks = os.path.join(d, 'masks')
    shutil.rmtree(masks, ignore_errors=True)  # one name = one separation: a new run replaces it
    os.makedirs(masks)
    from transformers import Sam2VideoModel, Sam2VideoProcessor
    repo = MODELS[size][0]
    t_load = time.time()
    # From the Hugging Face cache only: Setup's Download put it there; nothing is downloaded here.
    model = Sam2VideoModel.from_pretrained(repo, local_files_only=True).to(dev).eval()
    proc = Sam2VideoProcessor.from_pretrained(repo, local_files_only=True)
    print(f'SAM 2.1 {size} on {dev} (loaded in {time.time() - t_load:.1f} s). Frames {n0}-{n1} ({n0 / fps:.2f}-{(n1 + 1) / fps:.2f} s).')
    H, W = info['h'], info['w']

    def track(frames, start=0, reverse=False, points=None, labels=None, box=None, mask=None):
        """Yield (frame index in `frames`, logits at the video's size), from the inputs on frame `start`."""
        s = proc.init_video_session(video=frames, inference_device=dev, video_storage_device='cpu',
                                    inference_state_device='cpu', dtype=torch.float32)
        if mask is not None:
            proc.add_inputs_to_inference_session(inference_session=s, frame_idx=start, obj_ids=1, input_masks=mask.astype(np.uint8))
        else:
            proc.add_inputs_to_inference_session(inference_session=s, frame_idx=start, obj_ids=1,
                                                 input_points=[[points]] if points else None, input_labels=[[labels]] if points else None,
                                                 input_boxes=[[box]] if box else None)
        model(inference_session=s, frame_idx=start)
        for o in model.propagate_in_video_iterator(s, start_frame_idx=start, reverse=reverse):
            lg = proc.post_process_masks([o.pred_masks], original_sizes=[[H, W]], binarize=False)[0].reshape(-1, H, W)[0].float()
            # The outermost few pixels of SAM's masks fade out (a broken line where the subject meets the frame's
            # edge): carry the mask straight on from just inside.
            k = max(2, round(max(H, W) / 480))
            lg[:k], lg[-k:] = lg[k].clone(), lg[-k - 1].clone()
            lg[:, :k], lg[:, -k:] = lg[:, k:k + 1].clone(), lg[:, -k - 1:-k].clone()
            yield o.frame_idx, lg

    lost, written = set(), set()

    def save(lg, n):
        """One mask: SAM 2's logits at the video's size → soft 8-bit alpha (white = the subject)."""
        arr = (torch.sigmoid(lg) * 255).round().clamp(0, 255).to(torch.uint8).cpu().numpy()
        Image.fromarray(arr, 'L').save(os.path.join(masks, f'{n:06d}.png'), compress_level=1)
        (lost.add if (lg > 0).float().mean().item() < 0.0005 else lost.discard)(n)
        written.add(n)

    small = lambda lg: (torch.nn.functional.interpolate(lg[None, None], size=(work[1], work[0]), mode='bilinear', align_corners=False)[0, 0] if work else lg) > 0
    P = [[x * sx, y * sy] for x, y in pts]
    B = [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy] if box else None
    seed, a_, t0 = None, n0, time.time()
    # Chunks of --chunk frames keep the memory low; each one starts from the last mask of the one before.
    with torch.inference_mode():
        while True:
            b_ = min(n1, a_ + a.chunk)
            frames = list(read_frames(a.video, info, a_, b_ - a_ + 1, work))
            got = len(frames)
            if not got:
                break
            ended = got < b_ - a_ + 1  # the video ends sooner than its stated length
            b_ = a_ + got - 1
            second = None
            run = track(frames, points=P, labels=lbl, box=B) if seed is None else track(frames, mask=seed)
            for fi, lg in run:
                if fi == got - 1:
                    seed = small(lg).cpu().numpy()
                if fi == 1 and a_ == n0:
                    second = small(lg).cpu().numpy()
                if fi == 0 and a_ != n0:
                    continue  # the frame this chunk starts from: written by the chunk before
                save(lg, a_ + fi)
            # The clicked frame comes straight from the clicks, without SAM 2's memory, so it can be less sure of itself
            # (speckles, a grey inside) than the frames after it. Track it once more, backwards from the next frame.
            if second is not None:
                for fi, lg in track(frames[:2], start=1, reverse=True, mask=second):
                    if fi == 0:
                        save(lg, n0)
            done = len(written)
            print(f'  frames {a_}-{b_}: {done} masks, {(time.time() - t0) / max(1, done):.2f} s a frame')
            if b_ >= n1 or got < 2 or ended:
                break
            a_ = b_
    done, lost = len(written), sorted(lost)
    if not done:
        die('No frames were read from the video.')
    end = n0 + done - 1
    spf = (time.time() - t0) / done
    meta = {
        'video': a.video.replace('\\', '/'), 'name': a.name, 'fps': info['fps_str'], 'fps_value': fps, 'width': info['w'], 'height': info['h'],
        'start_frame': n0, 'end_frame': end, 'frames': done, 'start': round(n0 / fps, 4), 'end': round((end + 1) / fps, 4),
        'points': [[x, y, l] for (x, y), l in zip(pts, lbl)], 'box': box, 'model': size, 'repo': repo, 'device': dev,
        'seconds_per_frame': round(spf, 3), 'lost': lost, 'made': datetime.datetime.now().isoformat(timespec='seconds'),
        'masks': 'masks/%06d.png',
        'about': 'One 8-bit PNG per frame, white = the subject, at the video\'s size. Mask n is the frame at n / fps seconds of the video.',
    }
    json.dump(meta, open(os.path.join(d, 'meta.json'), 'w', encoding='utf-8'), indent=1)
    print(f'{done} masks in {masks}/ ({spf:.2f} s a frame on {dev}, model {size}).')
    if lost:
        print(f'The subject is (nearly) gone on {len(lost)} frame(s), first {lost[0]}: if it is still in the picture there, '
              f'separate again from there (--start {lost[0] / fps:.2f}) with points on it.')
    print(f'Check it: python objsep.py sheet {a.video} --name {a.name}')


def cmd_sheet(a):
    from PIL import Image, ImageDraw
    d, meta = load_meta(a.name)
    info = probe(a.video)
    color = hex_rgb(a.color)
    n0, n1 = meta['start_frame'], meta['end_frame']
    k = max(1, min(a.count, n1 - n0 + 1))
    picks = sorted({round(n0 + i * (n1 - n0) / max(1, k - 1)) for i in range(k)})
    tw = 640
    th = int(round(info['h'] * tw / info['w']))
    cols = min(3, len(picks))
    rows = math.ceil(len(picks) / cols)
    sheet = Image.new('RGB', (cols * tw + (cols + 1) * 8, rows * (th + 26) + 8), (20, 20, 22))
    dr = ImageDraw.Draw(sheet)
    lbl_font = font(15)
    for i, n in enumerate(picks):
        img = next(read_frames(a.video, info, n, 1), None)
        if img is None:
            continue
        tile = Image.fromarray(look(img, mask_at(d, n, info), color)).resize((tw, th), Image.LANCZOS)
        x, y = 8 + (i % cols) * (tw + 8), 8 + (i // cols) * (th + 26)
        sheet.paste(tile, (x, y))
        dr.text((x, y + th + 4), f'frame {n} · {n / info["fps"]:.2f} s', fill=(230, 230, 230), font=lbl_font)
    out = a.out or os.path.join(d, 'sheet.jpg')
    sheet.save(out, quality=88)
    print(f'{out}: {len(picks)} frames ({", ".join(map(str, picks))}), the background dimmed and the subject outlined. Look at it.')


def encoder():
    return ['-c:v', 'h264_videotoolbox', '-b:v', '12M'] if sys.platform == 'darwin' else ['-c:v', 'libx264', '-crf', '18', '-preset', 'medium']


def guard_out(out):
    parts = os.path.normpath(out).split(os.sep)
    if 'renders' in parts and os.path.exists(out):
        die(f'{out} is there already: renders are never overwritten. Give the next version number.')
    if 'source' in parts:
        die('Nothing is ever written into source/.')
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)


def cmd_overlay(a):
    d, meta = load_meta(a.name)
    info = probe(a.video)
    color = hex_rgb(a.color)
    n0, n1 = meta['start_frame'], meta['end_frame']
    out = a.out or os.path.join(d, 'check.mp4')
    guard_out(out)
    count = n1 - n0 + 1
    enc = subprocess.Popen([FFMPEG, '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{info["w"]}x{info["h"]}', '-r', info['fps_str'], '-i', '-',
                            '-ss', seek(n0, info['fps']), '-i', a.video, '-map', '0:v', '-map', '1:a?', '-t', f'{count / info["fps"]:.6f}',
                            *encoder(), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', out], stdin=subprocess.PIPE)
    for i, img in enumerate(read_frames(a.video, info, n0, count)):
        enc.stdin.write(look(img, mask_at(d, n0 + i, info), color).tobytes())
    enc.stdin.close()
    if enc.wait():
        die('ffmpeg could not write the check video.')
    print(f'{out}: frames {n0}-{n1}, the background dimmed and the subject outlined, with the sound.')


def cmd_behind(a):
    d, meta = load_meta(a.name)
    info = probe(a.video)
    fps, W, H = info['fps'], info['w'], info['h']
    n0 = round(a.start * fps) if a.start is not None else meta['start_frame']
    n1 = round(a.end * fps) - 1 if a.end is not None else meta['end_frame']
    if n0 < meta['start_frame'] or n1 > meta['end_frame'] or n0 > n1:
        die(f'The masks cover {meta["start"]}-{meta["end"]} s: keep --start/--end inside that.')
    count = n1 - n0 + 1
    out = a.out or os.path.join(d, 'behind.mp4')
    guard_out(out)
    layer = a.layer
    if os.path.isdir(layer):
        files = sorted(p for p in os.listdir(layer) if re.fullmatch(r'\d+\.png', p))
        if not files:
            die(f'{layer} has no numbered PNG frames (00000.png, 00001.png, …).')
        digits = len(files[0]) - 4
        lin = ['-framerate', info['fps_str'], '-start_number', str(int(files[0][:-4])), '-i', os.path.join(layer, f'%0{digits}d.png')]
    elif re.search(r'\.(png|jpe?g|webp)$', layer, re.I):
        lin = ['-loop', '1', '-framerate', info['fps_str'], '-i', layer]
    elif os.path.isfile(layer):
        lin = ['-i', layer]
    else:
        die(f'No such layer: {layer}')
    # The video, the subject cut out of it by the masks, and the layer between the two.
    graph = (f"[0:v]fps={info['fps_str']},format=rgba[v];[1:v]format=gray,scale={W}:{H}[m];[2:v]scale={W}:{H},format=rgba[l];"
             f"[v]split[bg][s];[s][m]alphamerge[fg];[bg][l]overlay=eof_action=pass[mid];[mid][fg]overlay,format=yuv420p[o]")
    r = subprocess.run([FFMPEG, '-v', 'error', '-y', '-ss', seek(n0, fps), '-i', a.video,
                        '-framerate', info['fps_str'], '-start_number', str(n0), '-i', os.path.join(d, 'masks', '%06d.png'), *lin,
                        '-filter_complex', graph, '-map', '[o]', '-map', '0:a?', '-t', f'{count / fps:.6f}',
                        *encoder(), '-c:a', 'aac', '-b:a', '192k', out])
    if r.returncode:
        die('ffmpeg could not put the layer behind the subject.')
    print(f'{out}: {count} frames ({n0 / fps:.2f}-{(n1 + 1) / fps:.2f} s of the video) with {layer} between the background and the subject.')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('check'); c.add_argument('--model', choices=list(MODELS)); c.set_defaults(fn=cmd_check)
    c = sub.add_parser('preview'); c.add_argument('video'); c.add_argument('--at', type=float, default=0.0); c.add_argument('--out'); c.set_defaults(fn=cmd_preview)
    c = sub.add_parser('separate'); c.add_argument('video'); c.add_argument('--name', required=True)
    c.add_argument('--point', action='append', help='X,Y on the subject, or X,Y,0 on something that is not it (the video\'s pixels, on the --start frame)')
    c.add_argument('--box', help='X0,Y0,X1,Y1 round the subject on the --start frame')
    c.add_argument('--start', type=float, default=0.0); c.add_argument('--end', type=float)
    c.add_argument('--model', choices=list(MODELS)); c.add_argument('--chunk', type=int, default=60)
    c.set_defaults(fn=cmd_separate)
    for name, fn in (('sheet', cmd_sheet), ('overlay', cmd_overlay)):
        c = sub.add_parser(name); c.add_argument('video'); c.add_argument('--name', required=True)
        c.add_argument('--color', default='#FFFFFF', help='the outline colour (the brand\'s accent from BRAND.md, else white)')
        c.add_argument('--out')
        if name == 'sheet':
            c.add_argument('--count', type=int, default=6)
        c.set_defaults(fn=fn)
    c = sub.add_parser('behind'); c.add_argument('video'); c.add_argument('--name', required=True)
    c.add_argument('--layer', required=True, help='an image, a folder of numbered PNG frames, or a video (ProRes 4444 keeps its alpha)')
    c.add_argument('--start', type=float); c.add_argument('--end', type=float); c.add_argument('--out')
    c.set_defaults(fn=cmd_behind)
    a = ap.parse_args()
    if getattr(a, 'chunk', 60) < 2:
        die('--chunk is at least 2 frames.')
    a.fn(a)


if __name__ == '__main__':
    main()
