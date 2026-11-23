"""Generate PageRadar extension icons (radar sweep on a dark rounded tile)."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
S = 512
SS = 4  # supersample factor


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def radial_bg(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    top = (18, 26, 43)
    bottom = (8, 12, 20)
    for y in range(size):
        c = lerp(top, bottom, y / (size - 1))
        for x in range(size):
            px[x, y] = c
    glow = Image.new("L", (size, size), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-size * 0.35, -size * 0.55, size * 0.75, size * 0.55], fill=90)
    from PIL import ImageFilter
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.12))
    tint = Image.new("RGB", (size, size), (56, 189, 248))
    return Image.composite(tint, img, glow.point(lambda v: int(v * 0.35)))


def draw_icon(px):
    img = radial_bg(px).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    cx, cy = px / 2, px / 2
    unit = px / 512.0

    # rings
    for radius, alpha, width in ((156, 70, 14), (104, 110, 12), (52, 150, 10)):
        r = radius * unit
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(94, 224, 255, alpha), width=max(1, int(width * unit)))

    # sweep wedge (bright arc, from -50deg to 8deg)
    sweep = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sweep)
    r = 156 * unit
    sd.pieslice([cx - r, cy - r, cx + r, cy + r], start=-50, end=10, fill=(94, 224, 255, 70))
    from PIL import ImageFilter
    sweep = sweep.filter(ImageFilter.GaussianBlur(6 * unit))
    img.alpha_composite(sweep.convert("RGBA"))

    # sweep line
    import math
    ang = math.radians(-22)
    ex, ey = cx + math.cos(ang) * 150 * unit, cy + math.sin(ang) * 150 * unit
    d.line([(cx, cy), (ex, ey)], fill=(160, 240, 255, 235), width=max(2, int(10 * unit)))

    # center dot + target dot
    d.ellipse([cx - 16 * unit, cy - 16 * unit, cx + 16 * unit, cy + 16 * unit], fill=(240, 253, 255, 255))
    tx, ty = cx + math.cos(ang) * 108 * unit, cy + math.sin(ang) * 108 * unit
    for rr, aa in ((34, 60), (24, 110), (14, 255)):
        d.ellipse([tx - rr * unit, ty - rr * unit, tx + rr * unit, ty + rr * unit], fill=(94, 224, 255, aa))

    # rim
    d.rounded_rectangle([1, 1, px - 2, px - 2], radius=int(110 * unit), outline=(255, 255, 255, 26), width=max(1, int(3 * unit)))
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    big = draw_icon(S * SS)
    mask = rounded_mask(S * SS, 110 * SS)
    big.putalpha(mask)
    big = big.resize((S, S), Image.LANCZOS)
    for size in (16, 32, 48, 128):
        icon = big.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT, f"icon{size}.png")
        icon.save(path, "PNG")
        print("wrote", path)


if __name__ == "__main__":
    main()
