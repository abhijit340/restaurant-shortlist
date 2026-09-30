"""Generate the app's home-screen icons (a white map pin on green).

Run from the project root:  python tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

GREEN = (31, 111, 92, 255)
WHITE = (255, 255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "icons"
SCALE = 4  # draw big, then shrink, for smooth edges


def draw_icon(size: int, maskable: bool) -> Image.Image:
    s = size * SCALE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if maskable:
        # Android crops maskable icons to its own shape, so fill edge to edge
        # and keep the pin inside the central "safe zone".
        d.rectangle([0, 0, s, s], fill=GREEN)
        pin_scale = 0.55
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * 0.22, fill=GREEN)
        pin_scale = 0.7

    # Map pin: a circle on top of a downward-pointing triangle.
    cx = s / 2
    r = s * pin_scale * 0.30
    cy = s / 2 - r * 0.35
    tip_y = cy + r * 2.0
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=WHITE)
    d.polygon([(cx - r * 0.86, cy + r * 0.5), (cx + r * 0.86, cy + r * 0.5), (cx, tip_y)], fill=WHITE)
    hole = r * 0.42
    d.ellipse([cx - hole, cy - hole, cx + hole, cy + hole], fill=GREEN)

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    draw_icon(192, maskable=False).save(OUT / "icon-192.png")
    draw_icon(512, maskable=False).save(OUT / "icon-512.png")
    draw_icon(512, maskable=True).save(OUT / "icon-512-maskable.png")
    print(f"Wrote icons to {OUT}")
