"""Engramory D5 (navy + mint) animations: book opening, typing, and the two merged.

Each frame is an SVG string rendered by headless Chrome over CDP, then ffmpeg
turns the PNG frames into a looping GIF (plus an MP4 for video use).
usage: python brand/src/make_anim.py [book|typing|merged ...]
"""
import asyncio
import base64
import json
import math
import os
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.request

import websockets
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

SRC = pathlib.Path(__file__).resolve().parent
BRAND = SRC.parent
OUT = BRAND / "anim"
CACHE = SRC / ".cache"       # frames and the Chrome profile (gitignored)
FONTS = SRC / ".fonts"       # downloaded on first use (gitignored); SIL OFL 1.1
JETBRAINS = "https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/fonts/ttf/{}"


def font_file(name, url=None):
    """A font from FONTS, downloaded on first use (a curl user agent gets TTF from Google Fonts)."""
    path = FONTS / name
    if not path.exists():
        FONTS.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(url or JETBRAINS.format(name), headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            path.write_bytes(resp.read())
    return path


def find_chrome():
    """$CHROME, else the usual install places on Windows / macOS / Linux."""
    found = [os.environ.get("CHROME")]
    found += [os.path.expandvars(p) for p in (
        r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
        r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
        r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")]
    found += [shutil.which(n) for n in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser")]
    for path in found:
        if path and os.path.isfile(path):
            return path
    sys.exit("Chrome not found: set CHROME to its executable")


FONT = font_file("JetBrainsMono-Bold.ttf")

NAVY, MINT = "#0F1B2D", (0x6E, 0xE7, 0xC8)
SW = 4.0                     # D5 stroke width
CUR = (27.5, 23, 9, 18)      # cursor x, y, w, h in icon units
WORD = "engramory"
FS = 16 / 0.55               # font size so the x-height is 16 units
CELL = 0.6 * FS              # JetBrains Mono advance
BASE = 40.0                  # baseline y
FPS = 50                     # GIF delays are whole centiseconds: 50 fps = an exact 2 cs per frame
PERSPECTIVE = 110.0          # camera distance for the page flip

font = TTFont(FONT)
gs, cmap = font.getGlyphSet(), font.getBestCmap()
GLYPH = {}
for ch in set(WORD):
    pen = SVGPathPen(gs)
    gs[cmap[ord(ch)]].draw(pen)
    GLYPH[ch] = pen.getCommands()


def rgb(c, k=1.0):
    return "#%02X%02X%02X" % tuple(round(v * k) for v in c)


def ease(p):
    """Sine in-out: peak speed 1.57x the average (cubic in-out peaks at 3x and reads as a snap)."""
    p = min(max(p, 0.0), 1.0)
    return 0.5 - 0.5 * math.cos(math.pi * p)


def bracket_points(stem, arm_end):
    return [(arm_end, 17.5), (stem, 17.5), (stem, 46.5), (arm_end, 46.5)]


LEFT = [bracket_points(9, 13), bracket_points(18, 22)]          # [outer, inner], static
RIGHT = [[(64 - x, y) for x, y in b] for b in LEFT]              # [outer, inner] open positions
GHOSTS = 3                                                       # thin pages riffled between cover and last page
GHOST_SW = 2.2
# Right-hand pages in the order they turn open: the cover, a riffle of thin pages, the last page.
# Thin pages share the inner geometry, so once flat they sit under the last page's thicker stroke.
PAGES = [(RIGHT[0], SW)] + [(RIGHT[1], GHOST_SW)] * GHOSTS + [(RIGHT[1], SW)]


def project(points, a):
    """Right page hinged at the spine x=32: a=0 lies folded over the left, a=pi lies open on the right."""
    out = []
    for x, y in points:
        d = x - 32
        X, Z = 32 - d * math.cos(a), d * math.sin(a)
        s = PERSPECTIVE / (PERSPECTIVE - Z)
        out.append((32 + (X - 32) * s, 32 + (y - 32) * s))
    return out


def poly(points, color, dx=0.0, sw=SW):
    d = "M" + " L".join(f"{x + dx:.3f} {y:.3f}" for x, y in points)
    return (f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{sw}" '
            'stroke-linecap="round" stroke-linejoin="round"/>')


OPEN_ALL = [math.pi] * len(PAGES)


def scene(angles=None, n_chars=0, shift=0.0, cursor_on=True, ink=MINT, cursor_ink=None, text_ink=None):
    """angles: turn of each page in PAGES (default all open); shift: how far the right side sits from home."""
    still = angles is None             # a still has no riffle: the thin pages would only hide under the last
    angles = OPEN_ALL if still else angles
    ink_hex = rgb(ink)
    parts = [poly(b, ink_hex) for b in LEFT]
    for k in range(int(n_chars)):
        x = CUR[0] + k * CELL
        parts.append(f'<path d="{GLYPH[WORD[k]]}" fill="{text_ink or ink_hex}" '
                     f'transform="translate({x:.3f} {BASE}) scale({FS / 1000:.5f} {-FS / 1000:.5f})"/>')
    if cursor_on:
        cx, cy, cw, ch = CUR
        cur_x = CUR[0] + n_chars * CELL
        parts.append(f'<rect x="{cur_x:.3f}" y="{cy}" width="{cw}" height="{ch}" rx="2.4" fill="{cursor_ink or ink_hex}"/>')
    # Turning pages last (they pass in front of the spine); the cover is drawn on top of the riffle.
    order = [len(PAGES) - 1, 0] if still else list(range(1, len(PAGES))) + [0]
    for i in order:
        (pts, sw), a = PAGES[i], angles[i]
        flat = abs(math.cos(a))
        shade = (0.5 + 0.5 * flat) if sw == SW else (0.35 + 0.65 * flat)
        parts.append(poly(project(pts, a), rgb(ink, shade), shift, sw))
    return "".join(parts)


def frame_svg(body, vw, vh, center_shift, px_w, px_h, bg=NAVY):
    tx = vw / 2 - 32 - center_shift
    ground = f'<rect width="{vw}" height="{vh}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{px_w}" height="{px_h}" viewBox="0 0 {vw} {vh}">'
            f'{ground}<g transform="translate({tx:.3f} {(vh - 64) / 2:.3f})">{body}</g></svg>')


# ---- timelines -------------------------------------------------------------

def riffle(t, open_at, close_at):
    """Angles for PAGES: open = cover, then a short riffle, then the last page; close runs it backwards."""
    n = len(PAGES)
    opens = [(open_at, open_at + 0.55)]
    opens += [(open_at + 0.14 + i * 0.12, open_at + 0.14 + i * 0.12 + 0.48) for i in range(GHOSTS)]
    s = open_at + 0.14 + GHOSTS * 0.12 + 0.06
    opens.append((s, s + 0.55))
    closes = [None] * n
    closes[n - 1] = (close_at, close_at + 0.50)
    for j, i in enumerate(range(n - 2, 0, -1)):
        c = close_at + 0.10 + j * 0.10
        closes[i] = (c, c + 0.44)
    c = close_at + 0.10 + GHOSTS * 0.10 + 0.06
    closes[0] = (c, c + 0.55)
    out = []
    for (o0, o1), (c0, c1) in zip(opens, closes):
        a = math.pi * ease((t - o0) / (o1 - o0))
        if t >= c0:
            a = math.pi * (1 - ease((t - c0) / (c1 - c0)))
        out.append(a)
    return out


def typing_state(t, start, gaps, delete_at, delete_gap):
    """Chars typed so far, the camera-pan factors (one glide per phase), and the time of the last key."""
    times = [start]
    for g in gaps:
        times.append(times[-1] + g)
    dels = [delete_at + i * delete_gap for i in range(len(WORD))]
    n = sum(1 for k in range(len(WORD)) if t >= times[k] and t < dels[len(WORD) - 1 - k])
    pan_in = ease((t - start) / (times[-1] - start + 0.2))
    pan_out = ease((t - delete_at) / (dels[-1] - delete_at + 0.15)) if t >= delete_at else 0.0
    return n, pan_in, pan_out, times[-1]


REST = len(WORD) * CELL - CUR[2]       # right side's offset once the word is done and the cursor is gone


def lockup_state(t, start, show_at, delete_at):
    """The cursor leaves on the same frame the last letter lands, and ]] steps straight to rest on that
    frame, like every other keystroke (a glide would let ]] sit on the 'y' for a few frames). Before
    deleting, the cursor returns and ]] steps back out. Only the camera glides."""
    n, pan_in, pan_out, last = typing_state(t, start, GAPS, delete_at, 0.045)
    cursor = t < last or t >= show_at
    shift = n * CELL if cursor else REST
    reopen = ease((t - show_at) / 0.18) if t >= show_at else 0.0
    center = (REST + CUR[2] * reopen) * pan_in * (1 - pan_out)
    return n, shift, center, cursor


def blink(t, on_until, period=1.0):
    return t < on_until or ((t - on_until) % period) >= period / 2


GAPS = [0.14, 0.12, 0.16, 0.11, 0.15, 0.13, 0.17, 0.12]   # typing starts + 1.10 s = last key


def book(t):
    ang = riffle(t, 0.45, 3.3)
    cursor = not (2.05 <= t < 2.4 or 2.85 <= t < 3.2)
    return frame_svg(scene(ang, 0, 0.0, cursor), 64, 64, 0.0, 512, 512)


def typing(t):
    n, shift, center, cursor = lockup_state(t, 0.75, 3.9, 4.15)
    cursor = cursor and not (0.4 <= t < 0.65)
    return frame_svg(scene(None, n, shift, cursor), 240, 64, center / 2, 1200, 320)


def merged(t):
    ang = riffle(t, 0.45, 6.25)
    n, shift, center, cursor = lockup_state(t, 2.2, 5.4, 5.65)
    cursor = cursor and not (1.85 <= t < 2.1)
    return frame_svg(scene(ang, n, shift, cursor), 240, 64, center / 2, 1200, 320)


ANIMS = {"book": (book, 4.8, 512, 512), "typing": (typing, 4.9, 1200, 320), "merged": (merged, 7.7, 1200, 320)}


# ---- rendering -------------------------------------------------------------

def page_socket(proc, port_file, timeout=15.0):
    """The websocket of the page in the Chrome this script started (read from its own profile)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            sys.exit(f"Chrome exited while starting (code {proc.returncode})")
        try:
            port = int(port_file.read_text(encoding="utf-8").split()[0])
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2) as resp:
                targets = json.load(resp)
            return next(t["webSocketDebuggerUrl"] for t in targets if t["type"] == "page")
        except (OSError, ValueError, IndexError, StopIteration):
            time.sleep(0.2)
    sys.exit(f"Chrome did not open its debugging port within {timeout:g} s")


async def render_jobs(jobs):
    """jobs: iterable of (svg, width, height, png_path, transparent).

    Chrome picks a free debugging port and writes it to DevToolsActivePort in this run's
    fresh profile, so the page driven here is always the one this process started, never
    another Chrome that happens to listen on a fixed port."""
    prof = CACHE / "chrome-cdp"
    shutil.rmtree(prof, ignore_errors=True)
    prof.mkdir(parents=True)
    proc = subprocess.Popen([find_chrome(), "--headless=new", "--disable-gpu", "--hide-scrollbars",
                             "--remote-debugging-port=0", f"--user-data-dir={prof}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        ws_url = page_socket(proc, prof / "DevToolsActivePort")
        async with websockets.connect(ws_url, max_size=64 * 2**20) as ws:
            seq = 0

            async def call(method, **params):
                nonlocal seq
                seq += 1
                await ws.send(json.dumps({"id": seq, "method": method, "params": params}))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == seq:
                        return msg.get("result", {})

            size = None
            for svg, w, h, path, transparent in jobs:
                if size != (w, h, transparent):
                    await call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=1, mobile=False)
                    await call("Emulation.setDefaultBackgroundColorOverride",
                               color={"r": 0, "g": 0, "b": 0, "a": 0} if transparent else {"r": 15, "g": 27, "b": 45, "a": 1})
                    size = (w, h, transparent)
                await call("Runtime.evaluate", awaitPromise=True, expression=(
                    "document.documentElement.style.background='transparent';document.body.style.margin='0';"
                    "document.body.innerHTML=" + json.dumps(svg) +
                    ";document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))"))
                shot = await call("Page.captureScreenshot", format="png",
                                  clip={"x": 0, "y": 0, "width": w, "height": h, "scale": 1})
                pathlib.Path(path).write_bytes(base64.b64decode(shot["data"]))
            try:
                await call("Browser.close")      # the graceful way out; the socket may close before a reply
            except Exception:
                pass
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)


def frame_jobs(name):
    fn, dur, w, h = ANIMS[name]
    fdir = CACHE / "frames" / name
    shutil.rmtree(fdir, ignore_errors=True)
    fdir.mkdir(parents=True)
    return [(fn(i / FPS), w, h, fdir / f"f{i:04d}.png", False) for i in range(round(dur * FPS))]


def encode(name):
    fdir = CACHE / "frames" / name
    gif, mp4 = OUT / f"engramory-{name}.gif", OUT / f"engramory-{name}.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(fdir / "f%04d.png"),
                    "-vf", "split[a][b];[a]palettegen=max_colors=64:stats_mode=full[p];[b][p]paletteuse=dither=none",
                    "-loop", "0", str(gif)], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", str(fdir / "f%04d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-movflags", "+faststart", str(mp4)], check=True)
    print(gif.name, gif.stat().st_size // 1024, "KB;", mp4.name, mp4.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    names = sys.argv[1:] or list(ANIMS)
    OUT.mkdir(parents=True, exist_ok=True)
    asyncio.run(render_jobs([job for n in names for job in frame_jobs(n)]))
    for n in names:
        encode(n)
