# Source images for the Android / iOS app icon and launch screen (then: npx @capacitor/assets generate).
#   python3 tools/make_app_assets.py tools/.tmp/tank_icon.png assets
import sys, os
from PIL import Image, ImageDraw, ImageFont
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
tank = Image.open(src).convert('RGBA'); tank = tank.crop(tank.getbbox())

def bg(size):
    img = Image.new('RGBA', (size, size)); d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / size
        d.line([(0, y), (size, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip((255, 196, 110), (196, 120, 52))) + (255,))
    r = int(size * 0.30); d.ellipse([size * .5 - r, size * .40 - r, size * .5 + r, size * .40 + r], fill=(255, 232, 170, 255))
    return img

def put(img, scale, cy=0.54):
    size = img.size[0]; w = int(size * scale); h = int(tank.height * w / tank.width)
    t = tank.resize((w, h), Image.LANCZOS)
    img.alpha_composite(t, ((size - w) // 2, int(size * cy - h / 2)))
    return img

S = 1024
put(bg(S), 0.80).convert('RGB').save(f'{out}/icon-only.png')                      # iOS (no transparency)
bg(S).save(f'{out}/icon-background.png')                                           # Android adaptive: background
put(Image.new('RGBA', (S, S), (0, 0, 0, 0)), 0.56).save(f'{out}/icon-foreground.png')   # foreground in the safe zone

# launch screen: dark brown, the tank and the name
L = 2732
sp = Image.new('RGBA', (L, L), (43, 29, 18, 255))
put(sp, 0.30, 0.46)
d = ImageDraw.Draw(sp)
f = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Black.ttc', 150, index=0)
for txt, col, x0 in [('HOVER TANK ', (255, 247, 234), None), ('ARENA', (255, 181, 71), None)]:
    pass
w1 = d.textlength('HOVER TANK ', font=f); w2 = d.textlength('ARENA', font=f); x = (L - w1 - w2) / 2; y = L * 0.62
d.text((x, y), 'HOVER TANK ', font=f, fill=(255, 247, 234)); d.text((x + w1, y), 'ARENA', font=f, fill=(255, 181, 71))
sp.convert('RGB').save(f'{out}/splash.png'); sp.convert('RGB').save(f'{out}/splash-dark.png')
print('ok')
