#!/usr/bin/env python3
"""Generates `appendix-b-scan.jpg`, the scanned page inside `maintenance-log.pdf`.

    python3 eval/corpus-assets/make-appendix-b-scan.py            # dry run, writes nothing
    python3 eval/corpus-assets/make-appendix-b-scan.py --out /tmp/scan.jpg
    python3 eval/corpus-assets/make-appendix-b-scan.py --force    # overwrite the asset

Requires Pillow (`pip install Pillow`). Nothing in the JS build calls this — it
exists so the page's ground truth is readable, not so CI can run it.

## Why this file exists

`eval/make-corpus.mjs` opens by stating that the corpus is committed alongside
its generator so it is "reproducible and reviewable as text rather than as
opaque binaries". `appendix-b-scan.jpg` was the one place that was not true.
Its generator was a throwaway, so the facts the eval scores against —
`layout-chiller-warranty` expects "60" — lived only inside 53KB of JPEG. Grep
the corpus source for "chiller" and you got nothing. A reviewer could not check
the expected answer without opening an image, and nobody could regenerate the
page at all.

The text below IS that ground truth. `LINES` is the whole of it.

## Why it is a scan and not a text page

The page is deliberately image-only. `maintenance-log.pdf`'s first page is
ordinary text, so the document averages ~120 characters per page against
`RAG_MIN_CHARS_PER_PAGE=50`: it ingests, reports success, and silently
contributes nothing from page 2. That silent-appendix failure is what spec 0031
FR1 exists to fix, and it only reproduces if this page has no text layer.

So the output must stay a real raster: greyscale, JPEG, with scanner artefacts
(paper that is not white, a shadow down the gutter edge, sensor noise, and a
fraction of a degree of skew). Those are not decoration — a clean synthetic
render is easier to OCR than a scan, and would make the cracking numbers
optimistic.

## Byte-identity is not a goal

This reproduces the committed JPEG *visually*, not byte-for-byte: the exact
bytes depend on the installed Pillow, its JPEG encoder and the host's fonts.
Byte-identity would be worth having if the corpus PDFs were hash-pinned, and
they are not — the eval scores retrieved text, and the text is fixed here.

That is also why `--force` is required to overwrite the asset. Regenerating
changes `maintenance-log.pdf`'s bytes on the next `node eval/make-corpus.mjs`,
which is harmless for the frozen single-hop baseline (that baseline predates
this document entirely) but is not something to do by accident.
"""

import argparse
import os
import random
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - a human-facing script, not a test
    sys.exit("Pillow is required: pip install Pillow")

# --- Ground truth ----------------------------------------------------------
#
# Everything the eval can legitimately ask about this page. `eval/questions.json`
# draws on it for the chiller warranty (60 months) and for Hartley Mechanical,
# who also appear in `site-operations-report.pdf` and `plant-services-manual.pdf`
# — that shared name is the bridge a multi-hop question crosses.

TITLE = "MAINTENANCE LOG - APPENDIX B"

LINES = [
    "This appendix was scanned from the site logbook.",
    "",
    "The chiller on level 4 was replaced on 14 March.",
    "The replacement unit is a Carrier 30XA-1002.",
    "Warranty on the replacement chiller runs for 60 months.",
    "The old unit was removed by Hartley Mechanical.",
    "",
    "Signed: site supervisor",
]

# --- Page geometry ---------------------------------------------------------
#
# 1240x1754 is A4 at 150dpi, and is what `make-corpus.mjs` declares in the image
# XObject (`/Width 1240 /Height 1754`). Changing it here means changing it there.

WIDTH, HEIGHT = 1240, 1754
PAPER = 236  # off-white; a scan of white paper is never 255
MARGIN_X = 110
TITLE_TOP = 145
TITLE_SIZE = 46
RULE_Y = 206
RULE_WIDTH = 3
BODY_SIZE = 30
BODY_TOP = 246
LEADING = 55
BLANK_LEADING = 32  # a blank entry in LINES prints nothing and advances by this
SKEW_DEGREES = 0.45  # counter-clockwise, i.e. the page fed in slightly crooked
GUTTER_WIDTH = 27  # dark band down the left edge, where the page lifted off the glass
GUTTER_DARKEST = 176
NOISE_SIGMA = 1.2
JPEG_QUALITY = 60
NOISE_SEED = 0x5CA4  # fixed, so two runs on one machine agree

SERIF_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "/Library/Fonts/Times New Roman.ttf",
]


def load_serif(size):
    """A serif face, because the page is meant to read as photocopied print.

    Metrics differ a little between these faces, so the line breaks are fixed
    in `LINES` rather than wrapped — the text must not reflow depending on
    which font a machine happens to have.
    """
    for path in SERIF_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    sys.exit(
        "No serif font found. Tried:\n  "
        + "\n  ".join(SERIF_CANDIDATES)
        + "\nInstall one, or add its path to SERIF_CANDIDATES."
    )


def render():
    page = Image.new("L", (WIDTH, HEIGHT), PAPER)
    draw = ImageDraw.Draw(page)

    draw.text((MARGIN_X, TITLE_TOP), TITLE, font=load_serif(TITLE_SIZE), fill=25)
    draw.rectangle(
        [MARGIN_X - 10, RULE_Y, WIDTH - 122, RULE_Y + RULE_WIDTH - 1], fill=60
    )

    body = load_serif(BODY_SIZE)
    y = BODY_TOP
    for line in LINES:
        if not line:
            y += BLANK_LEADING
            continue
        draw.text((MARGIN_X, y), line, font=body, fill=30)
        y += LEADING

    add_gutter_shadow(page)
    add_sensor_noise(page)

    # Rotate last: the skew has to carry the artefacts with it, the way a
    # crooked feed does. `fillcolor=PAPER` keeps the exposed corners paper-
    # coloured instead of the black PIL would otherwise leave.
    return page.rotate(SKEW_DEGREES, resample=Image.BICUBIC, fillcolor=PAPER)


def add_gutter_shadow(page):
    """The dark band down the left edge, where the page lifted off the glass."""
    pixels = page.load()
    for x in range(GUTTER_WIDTH):
        shade = GUTTER_DARKEST + (PAPER - GUTTER_DARKEST) * (x / GUTTER_WIDTH)
        shade = round(shade)
        for y in range(HEIGHT):
            if pixels[x, y] > shade:
                pixels[x, y] = shade


def add_sensor_noise(page):
    """Per-pixel jitter. Small, but it is what stops this looking rendered."""
    rng = random.Random(NOISE_SEED)
    pixels = page.load()
    for y in range(HEIGHT):
        for x in range(WIDTH):
            value = pixels[x, y] + round(rng.gauss(0, NOISE_SIGMA))
            pixels[x, y] = 0 if value < 0 else 255 if value > 255 else value


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    asset = os.path.join(here, "appendix-b-scan.jpg")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", help="write here instead of the committed asset")
    parser.add_argument(
        "--force",
        action="store_true",
        help="overwrite the committed asset (then re-run node eval/make-corpus.mjs)",
    )
    args = parser.parse_args()

    destination = args.out or asset
    if destination == asset and not args.force:
        sys.exit(
            f"Refusing to overwrite {asset} without --force.\n"
            "Regenerating changes maintenance-log.pdf's bytes on the next\n"
            "`node eval/make-corpus.mjs`. Use --out to render a copy instead."
        )

    render().save(destination, "JPEG", quality=JPEG_QUALITY, optimize=True)
    print(f"wrote {destination} ({os.path.getsize(destination)} bytes)")


if __name__ == "__main__":
    main()
