# Compose PWA / home-screen icons from the rendered tank (tools/render_icon.py).
#   python3 tools/make_icons.py tools/.tmp/tank_icon.png public/icons
import sys, os
from PIL import Image, ImageDraw, ImageFilter
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
tank = Image.open(src).convert('RGBA')
tank = tank.crop(tank.getbbox())

def background(size, rounded):
    img = Image.new('RGBA', (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):                       # desert sky -> sand gradient
        t = y / size
        c = tuple(int(a + (b - a) * t) for a, b in zip((255, 196, 110), (196, 120, 52)))
        d.line([(0, y), (size, y)], fill=c + (255,))
    # a sun disc behind the tank
    r = int(size * 0.30)
    d.ellipse([size * 0.5 - r, size * 0.40 - r, size * 0.5 + r, size * 0.40 + r], fill=(255, 232, 170, 255))
    if rounded:
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
        img.putalpha(mask)
    return img

def compose(size, scale, rounded):
    img = background(size, rounded)
    w = int(size * scale); h = int(tank.height * w / tank.width)
    t = tank.resize((w, h), Image.LANCZOS)
    shadow = Image.new('RGBA', (w, h), (0, 0, 0, 0)); shadow.putalpha(t.split()[3].point(lambda v: v * 0.35))
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.015))
    x, y = (size - w) // 2, int(size * 0.56 - h / 2)
    img.alpha_composite(shadow, (x + int(size * 0.02), y + int(size * 0.03)))
    img.alpha_composite(t, (x, y))
    return img

for s in (192, 512):
    compose(s, 0.78, False).save(f'{out}/icon-{s}.png')
    compose(s, 0.62, False).save(f'{out}/icon-maskable-{s}.png')   # content inside the 80% safe zone
compose(180, 0.78, False).convert('RGB').save(f'{out}/apple-touch-icon.png')
compose(64, 0.86, True).save(f'{out}/favicon-64.png')
print('icons written to', out)
