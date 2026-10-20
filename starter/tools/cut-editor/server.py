"""Cut editor: a local, transcript-based editor for a talking-head take.

  python server.py --video source/raw.mp4 --words work/editor_words.json --edl work/edl.json \
                   --out work/edl_manual.json [--port 8792]

Serves index.html, the source video (with Range support so seeking works), the words, a waveform peak
list and the current kept segments. "Save" in the page POSTs the kept segments (source seconds) to --out.
Nothing leaves this machine; it binds to 127.0.0.1.
"""
import argparse, json, os, re, shutil, subprocess, sys, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument('--video', required=True)
ap.add_argument('--words', required=True)
ap.add_argument('--edl', required=True, help='json with segments_sec: [[start, end], ...] in source seconds (kept parts)')
ap.add_argument('--out', required=True)
ap.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8792)))
ap.add_argument('--pps', type=int, default=200, help='waveform peaks per second')
ap.add_argument('--notes', default=None, help='json file for timecoded comments (default: next to --out, notes.json)')
ap.add_argument('--joins', default=None, help='joins.json from tools/join-check: flagged joins are marked on the waveform (N jumps to the next)')
a = ap.parse_args()

VIDEO = Path(a.video).resolve()
NOTES = Path(a.notes) if a.notes else Path(a.out).with_name('editor_notes.json')


def load_notes():
    try: return json.loads(NOTES.read_text(encoding='utf-8'))
    except Exception: return []
ff = os.environ.get('FFMPEG') or shutil.which('ffmpeg') or 'ffmpeg'   # Video Octopus passes FFMPEG
# ffprobe: $FFPROBE, else next to that ffmpeg (same folder, same .exe ending on Windows), else the PATH
_probe_next = Path(ff).with_name('ffprobe' + Path(ff).suffix) if os.path.dirname(ff) else None
fp = os.environ.get('FFPROBE') or (str(_probe_next) if _probe_next and _probe_next.exists() else None) or shutil.which('ffprobe') or 'ffprobe'
SR = 8000
raw = subprocess.run([ff, '-v', 'error', '-i', str(VIDEO), '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                     capture_output=True, check=True).stdout
x = np.abs(np.frombuffer(raw, np.int16).astype(np.float32) / 32768)
hop = SR // a.pps
n = len(x) // hop
pk = x[:n * hop].reshape(n, hop).max(1)
rms = np.sqrt((x[:n * hop].reshape(n, hop) ** 2).mean(1))
norm = float(np.percentile(pk, 99.5)) or 1.0
fps = 30.0
try:
    r = subprocess.run([fp, '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=r_frame_rate',
                        '-of', 'csv=p=0', str(VIDEO)], capture_output=True, text=True).stdout.strip()
    nn, dd = r.split('/'); fps = float(nn) / float(dd)
except Exception:
    pass


def ver():
    return Path(a.out).stat().st_mtime if Path(a.out).exists() else 0


def data():
    edl = json.load(open(a.out if Path(a.out).exists() else a.edl, encoding='utf-8'))
    return {'duration': len(x) / SR, 'fps': fps, 'pps': a.pps,
            'peaks': [round(min(1.0, float(v) / norm), 3) for v in pk],
            'rms': [round(min(1.0, float(v) / norm * 2.2), 3) for v in rms],
            'words': json.load(open(a.words, encoding='utf-8')), 'segments': edl['segments_sec'],
            'source': VIDEO.name, 'out': str(a.out), 'saved': Path(a.out).exists(),
            'joins': json.load(open(a.joins, encoding='utf-8'))['joins'] if a.joins and Path(a.joins).exists() else [],
            'version': ver()}


class H(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_bytes(self, body, ctype, code=200):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split('?')[0]
        if p in ('/', '/index.html'):
            return self.send_bytes((HERE / 'index.html').read_bytes(), 'text/html; charset=utf-8')
        if p in ('/studio.css', '/studio.js'):  # Video Octopus's look for its Cut tab: only index.html?theme=studio asks
            return self.send_bytes((HERE / p[1:]).read_bytes(), ('text/css' if p.endswith('.css') else 'text/javascript') + '; charset=utf-8')
        if p == '/version':
            return self.send_bytes(json.dumps({'version': ver()}).encode(), 'application/json')
        if p == '/notes':
            return self.send_bytes(json.dumps(load_notes()).encode(), 'application/json')
        if p == '/data.json':
            return self.send_bytes(json.dumps(data()).encode(), 'application/json')
        if p == '/video':
            size = VIDEO.stat().st_size
            rng = self.headers.get('Range')
            s, e = 0, size - 1
            m = re.match(r'bytes=(\d*)-(\d*)', rng or '')
            if m:
                if m.group(1): s = int(m.group(1))
                if m.group(2): e = min(int(m.group(2)), size - 1)
                elif m.group(1): e = min(s + 8 * 1024 * 1024, size - 1)
            self.send_response(206 if m else 200)
            self.send_header('Content-Type', 'video/mp4')
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Length', str(e - s + 1))
            if m: self.send_header('Content-Range', f'bytes {s}-{e}/{size}')
            self.end_headers()
            with open(VIDEO, 'rb') as f:
                f.seek(s); left = e - s + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk: break
                    try: self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError): return
                    left -= len(chunk)
            return
        self.send_bytes(b'not found', 'text/plain', 404)

    def do_POST(self):
        if self.path in ('/notes', '/notes/delete'):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            notes = load_notes()
            if self.path == '/notes':
                n = {'id': int(time.time() * 1000), 'at': time.strftime('%Y-%m-%d %H:%M:%S'), 't': round(float(body.get('t', 0)), 2),
                     'edited_t': round(float(body.get('edited_t', 0)), 2), 'text': str(body.get('text', ''))[:5000]}
                notes.append(n)
            else:
                n = {'ok': True}; notes = [x for x in notes if x['id'] != body.get('id')]
            NOTES.write_text(json.dumps(sorted(notes, key=lambda x: x['t']), indent=1), encoding='utf-8')
            return self.send_bytes(json.dumps(n).encode(), 'application/json')
        if self.path != '/save':
            return self.send_bytes(b'not found', 'text/plain', 404)
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        if not body.get('force') and (body.get('version') is None or abs(float(body['version']) - ver()) > 1e-6):
            return self.send_bytes(json.dumps({'ok': False, 'conflict': True}).encode(), 'application/json', 409)
        segs = [[round(float(s), 4), round(float(e), 4)] for s, e in body['segments'] if float(e) - float(s) > 0.02]
        out = {'source': str(VIDEO), 'fps': fps, 'segments_sec': segs, 'saved_at': time.strftime('%Y-%m-%d %H:%M:%S'),
               'edited_length': round(sum(e - s for s, e in segs), 3)}
        Path(a.out).write_text(json.dumps(out, indent=1), encoding='utf-8')
        print(f"saved {len(segs)} segments, {out['edited_length']:.2f}s -> {a.out}", flush=True)
        self.send_bytes(json.dumps({'ok': True, 'length': out['edited_length'], 'version': ver()}).encode(), 'application/json')


print(f'cut editor on http://127.0.0.1:{a.port}  ({VIDEO.name}, {len(x) / SR:.1f}s)', flush=True)
ThreadingHTTPServer(('127.0.0.1', a.port), H).serve_forever()
