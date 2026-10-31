"""Engramory brand kit: static icon / mark / lockup / banner / social preview (SVG + PNG + ICO).

Shares geometry and the Chrome renderer with make_anim.py.  usage: python brand/src/make_brand.py
"""
import asyncio
import hashlib
import re
import urllib.parse
import urllib.request

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from PIL import Image

import make_anim as A

OUT = A.BRAND
NAVY, MINT, TEAL = A.NAVY, A.MINT, (0x12, 0xA0, 0x7F)
NAVY_RGB = (0x0F, 0x1B, 0x2D)
TAGLINE_ZH = "通用 Agent 长期记忆层"
TAGLINE_EN = "General-purpose long-term memory layer for AI agents"
REPO_URL = "github.com/tinqiao-oss/engramory"

# Wherever the word appears the cursor is gone and ]] has closed over its slot: [[engramory]].
REST = len(A.WORD) * A.CELL - A.CUR[2]          # right side's offset at rest
LOCK_X0, LOCK_X1 = 9 - A.SW / 2, 64 - 9 + REST + A.SW / 2
LOCK_Y0, LOCK_Y1 = 17.5 - A.SW / 2, 46.5 + A.SW / 2
PAD = 4


def svg(body, vb, w, h):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w:g}" height="{h:g}">'
            f"{body}</svg>\n")


def icon(size=64):
    tile = f'<rect width="64" height="64" rx="14" fill="{NAVY}"/>'
    return svg(tile + A.scene(), "0 0 64 64", size, size)


def mark(light_ground, size=64):
    body = A.scene(ink=NAVY_RGB, cursor_ink=A.rgb(TEAL)) if light_ground else A.scene()
    return svg(body, "0 0 64 64", size, size)


def lockup_body(light_ground):
    n = len(A.WORD)
    if light_ground:
        return A.scene(n_chars=n, shift=REST, cursor_on=False, ink=NAVY_RGB)
    return A.scene(n_chars=n, shift=REST, cursor_on=False)


def lockup(light_ground, width=None):
    x, y = LOCK_X0 - PAD, LOCK_Y0 - PAD
    w, h = LOCK_X1 - LOCK_X0 + 2 * PAD, LOCK_Y1 - LOCK_Y0 + 2 * PAD
    width = width or w
    return svg(lockup_body(light_ground), f"{x:.2f} {y:.2f} {w:.2f} {h:.2f}", width, width * h / w)


def banner(px_w=1200):
    return A.frame_svg(A.scene(n_chars=len(A.WORD), shift=REST, cursor_on=False), 240, 64, REST / 2, px_w, px_w * 64 / 240)


def noto_subset(text):
    """Noto Sans SC Medium holding just the glyphs of `text`, from Google Fonts (cached per text)."""
    name = "NotoSansSC-500-%s.ttf" % hashlib.sha1(text.encode("utf-8")).hexdigest()[:10]
    if not (A.FONTS / name).exists():
        css_url = ("https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@500&text="
                   + urllib.parse.quote(text))
        req = urllib.request.Request(css_url, headers={"User-Agent": "curl/8"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            css = resp.read().decode("utf-8")
        return A.font_file(name, re.search(r"url\((https://[^)]+)\)", css).group(1))
    return A.FONTS / name


def text_paths(ttf, text, size, cx, baseline, fill):
    """A line of text as outlined paths, centred on cx (no kerning; fine for mono and CJK)."""
    f = TTFont(ttf)
    gset, cm, hmtx, upm = f.getGlyphSet(), f.getBestCmap(), f["hmtx"], f["head"].unitsPerEm
    k = size / upm
    names = [cm[ord(ch)] for ch in text]
    x = cx - sum(hmtx[g][0] for g in names) * k / 2
    out = ""
    for g in names:
        pen = SVGPathPen(gset)
        gset[g].draw(pen)
        if pen.getCommands():
            out += (f'<path d="{pen.getCommands()}" fill="{fill}" '
                    f'transform="translate({x:.2f} {baseline}) scale({k:.5f} {-k:.5f})"/>')
        x += hmtx[g][0] * k
    return out


def social():
    """GitHub social preview, 1280x640. Tagline decided 2026-10-31: 通用 Agent 长期记忆层."""
    s = 820 / (LOCK_X1 - LOCK_X0)
    cx, cy = (LOCK_X0 + LOCK_X1) / 2, 32
    body = (f'<rect width="1280" height="640" fill="{NAVY}"/>'
            f'<g transform="translate(640 250) scale({s:.4f}) translate({-cx:.3f} {-cy})">{lockup_body(False)}</g>'
            + text_paths(A.font_file("JetBrainsMono-Regular.ttf"), TAGLINE_EN, 26, 640, 494, "#9CC7BB")
            + text_paths(noto_subset(TAGLINE_ZH), TAGLINE_ZH, 40, 640, 440, "#C9F5EA")
            + text_paths(A.font_file("JetBrainsMono-Regular.ttf"), REPO_URL, 22, 640, 584, "#6F8E9B"))
    return svg(body, "0 0 1280 640", 1280, 640)


def main():
    for sub in ("icon", "mark", "lockup", "banner", "social"):
        (OUT / sub).mkdir(parents=True, exist_ok=True)
    files = {
        "icon/engramory-icon.svg": icon(),
        "mark/engramory-mark-on-dark.svg": mark(False),
        "mark/engramory-mark-on-light.svg": mark(True),
        "lockup/engramory-lockup-on-dark.svg": lockup(False),
        "lockup/engramory-lockup-on-light.svg": lockup(True),
        "banner/engramory-banner.svg": banner(),
        "social/engramory-social.svg": social(),
    }
    for rel, text in files.items():
        (OUT / rel).write_bytes(text.encode("utf-8"))      # LF on every OS

    jobs = [(icon(s), s, s, OUT / f"icon/engramory-icon-{s}.png", True) for s in (16, 32, 48, 64, 128, 180, 256, 512, 1024)]
    jobs += [(mark(light, 512), 512, 512, OUT / f"mark/engramory-mark-on-{'light' if light else 'dark'}-512.png", True)
             for light in (False, True)]
    lw = 1600
    lh = round(lw * (LOCK_Y1 - LOCK_Y0 + 2 * PAD) / (LOCK_X1 - LOCK_X0 + 2 * PAD))
    jobs += [(lockup(light, lw), lw, lh, OUT / f"lockup/engramory-lockup-on-{'light' if light else 'dark'}-{lw}.png", True)
             for light in (False, True)]
    jobs += [(banner(w), w, w * 64 // 240, OUT / f"banner/engramory-banner-{w}.png", False) for w in (1200, 2400)]
    jobs.append((social(), 1280, 640, OUT / "social/engramory-social-1280x640.png", False))
    asyncio.run(A.render_jobs(jobs))

    Image.open(OUT / "icon/engramory-icon-256.png").save(OUT / "icon/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    for p in sorted(OUT.rglob("*")):
        if p.is_file() and not {"anim", "src"} & set(p.relative_to(OUT).parts):
            print(f"{p.relative_to(OUT)}  {p.stat().st_size // 1024 or 1} KB")


if __name__ == "__main__":
    main()
