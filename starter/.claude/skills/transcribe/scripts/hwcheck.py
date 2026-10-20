#!/usr/bin/env python3
"""hwcheck.py: look at this computer and say what it can run for AI video work.

  python3 hwcheck.py            # human-readable summary
  python3 hwcheck.py --json     # machine-readable (other skills read this)

Checks the OS, CPU, RAM, GPU (NVIDIA CUDA, Apple Metal/MPS), free disk, and whether
ffmpeg, Node, Python packages (torch, faster-whisper) and hardware video encoders are available.
Ends with a tier (strong / ok / weak / cloud-sandbox) and plain-English recommendations.
Uses only the standard library, so it runs before anything is installed.
"""
import json, os, platform, shutil, subprocess, sys


def run(cmd, timeout=8):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ""


def ram_gb():
    try:
        if sys.platform == "darwin":
            return int(run(["sysctl", "-n", "hw.memsize"])) / 2**30
        if sys.platform.startswith("linux"):
            for line in open("/proc/meminfo"):
                if line.startswith("MemTotal"):
                    return int(line.split()[1]) / 2**20
        if sys.platform == "win32":
            import ctypes

            class M(ctypes.Structure):
                _fields_ = [("l", ctypes.c_ulong), ("m", ctypes.c_ulong), ("t", ctypes.c_ulonglong)] + \
                           [(f"x{i}", ctypes.c_ulonglong) for i in range(6)]
            m = M(); m.l = ctypes.sizeof(M)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
            return m.t / 2**30
    except Exception:
        pass
    return 0.0


def cpu_name():
    if sys.platform == "darwin":
        return run(["sysctl", "-n", "machdep.cpu.brand_string"]) or platform.processor()
    if sys.platform.startswith("linux"):
        try:
            for line in open("/proc/cpuinfo"):
                if "model name" in line:
                    return line.split(":", 1)[1].strip()
        except Exception:
            pass
    return platform.processor() or platform.machine()


def gpu():
    g = {"kind": "none", "name": "", "vram_gb": 0.0}
    smi = shutil.which("nvidia-smi")
    if smi:
        out = run([smi, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        if out:
            name, mem = out.splitlines()[0].rsplit(",", 1)
            g.update(kind="cuda", name=name.strip(), vram_gb=round(float(mem) / 1024, 1))
            return g
    if sys.platform == "darwin" and platform.machine() == "arm64":
        chip = run(["sysctl", "-n", "machdep.cpu.brand_string"])
        cores = ""
        sp = run(["system_profiler", "SPDisplaysDataType"], timeout=15)
        for line in sp.splitlines():
            if "Total Number of Cores" in line:
                cores = line.split(":")[1].strip()
        g.update(kind="mps", name=f"{chip} GPU" + (f" ({cores} cores)" if cores else ""), vram_gb=0.0)
    return g


def in_sandbox():
    """Rough guess: a cloud/VM workspace (e.g. a hosted agent) rather than the user's own machine."""
    if os.path.exists("/.dockerenv") or os.environ.get("CLAUDE_CODE_REMOTE") or os.environ.get("CODESPACES"):
        return True
    try:
        return "docker" in open("/proc/1/cgroup").read() or "kubepods" in open("/proc/1/cgroup").read()
    except Exception:
        return False


def pymod(name):
    try:
        __import__(name)
        return True
    except Exception:
        return False


def encoders():
    ff = shutil.which("ffmpeg")
    if not ff:
        return []
    out = run([ff, "-hide_banner", "-encoders"], timeout=10)
    want = ["h264_videotoolbox", "hevc_videotoolbox", "prores_videotoolbox", "h264_nvenc", "hevc_nvenc",
            "h264_qsv", "h264_amf", "prores_ks", "libx264"]
    return [e for e in want if f" {e} " in out]


def main():
    r = {
        "os": f"{platform.system()} {platform.release()}",
        "arch": platform.machine(),
        "cpu": cpu_name(),
        "cpu_cores": os.cpu_count() or 1,
        "ram_gb": round(ram_gb(), 1),
        "gpu": gpu(),
        "disk_free_gb": round(shutil.disk_usage(os.getcwd()).free / 2**30, 1),
        "sandbox": in_sandbox(),
        "tools": {t: bool(shutil.which(t)) for t in ["ffmpeg", "ffprobe", "node", "npm", "git",
                                                 "python" if sys.platform == "win32" else "python3"]},
        "python": platform.python_version(),
        "py_packages": {m: pymod(m) for m in ["torch", "faster_whisper", "mlx_whisper", "cv2", "numpy"]},
        "encoders": encoders(),
    }
    g, ram = r["gpu"], r["ram_gb"]
    if r["sandbox"] and g["kind"] == "none":
        tier = "cloud-sandbox"
    elif g["kind"] == "cuda" and g["vram_gb"] >= 8 and ram >= 16:
        tier = "strong"
    elif g["kind"] == "mps" and ram >= 32:
        tier = "strong"
    elif g["kind"] in ("cuda", "mps") and ram >= 16:
        tier = "ok"
    else:
        tier = "weak"
    r["tier"] = tier

    whisper = {"strong": "large-v3 (or distil-large-v3 for speed)", "ok": "medium (English: medium.en)",
               "weak": "small (English: small.en); base if it is very slow", "cloud-sandbox": "small.en on CPU"}[tier]
    workers = max(1, min(8, (r["cpu_cores"] or 2) // 2, int(ram // 3) or 1))
    rec = [f"Transcription model: {whisper}."]
    rec.append(f"Parallel render workers: {workers} (about half the CPU cores, ~3 GB RAM each).")
    if g["kind"] == "mps":
        rec.append("Apple GPU found: PyTorch uses it through MPS (set PYTORCH_ENABLE_MPS_FALLBACK=1). "
                   "Hardware encoders: h264/hevc_videotoolbox.")
    if g["kind"] == "cuda":
        rec.append("NVIDIA GPU found: AI models run on CUDA; use h264_nvenc for fast encodes.")
    if tier == "weak":
        rec.append("This machine will work, just slowly: render previews at half size, track/transcribe short "
                   "ranges first, and leave long jobs running. For big jobs consider a stronger computer or a "
                   "rented cloud GPU.")
    if tier == "cloud-sandbox":
        rec.append("This looks like a cloud workspace with no GPU and limited time per command. Fine for planning, "
                   "stills and short tests. For AI models and full renders, run Claude Code on your own computer.")
    if r["disk_free_gb"] < 15:
        rec.append(f"Only {r['disk_free_gb']} GB free disk: frame sequences and model weights need 10-20 GB.")
    missing = [t for t in ("ffmpeg", "node", "git") if not r["tools"][t]]
    if missing:
        rec.append("Missing tools: " + ", ".join(missing) + " (macOS: brew install ...; Windows: winget install ..., "
                   "e.g. winget install Gyan.FFmpeg; or download from the official sites).")
    r["recommendations"] = rec

    if "--json" in sys.argv:
        print(json.dumps(r, indent=1))
        return
    print(f"OS        {r['os']} ({r['arch']})")
    print(f"CPU       {r['cpu']}, {r['cpu_cores']} cores")
    print(f"RAM       {ram} GB")
    print(f"GPU       {g['name'] or 'none'}" + (f", {g['vram_gb']} GB VRAM" if g['vram_gb'] else "") + f"  [{g['kind']}]")
    print(f"Disk free {r['disk_free_gb']} GB")
    print("Tools     " + ", ".join(f"{k}{'' if v else ' (missing)'}" for k, v in r["tools"].items()))
    print("Python    " + r["python"] + "  " + ", ".join(f"{k}{'' if v else ' -'}" for k, v in r["py_packages"].items()))
    print("Encoders  " + (", ".join(r["encoders"]) or "ffmpeg not found"))
    print(f"\nTier: {tier.upper()}")
    for x in rec:
        print(" - " + x)


if __name__ == "__main__":
    main()
