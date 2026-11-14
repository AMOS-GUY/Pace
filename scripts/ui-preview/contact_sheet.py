"""Builds a contact sheet of the UI preview screenshots (CI only; needs Pillow).

Usage: python3 contact_sheet.py <screens-dir> <output.png>
Screenshots are laid out in name order, 5 per row, each labelled with its file name.
"""
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

screens = sorted(pathlib.Path(sys.argv[1]).glob('*.png'))
if not screens:
    sys.exit('no screenshots found')
THUMB_W, COLS, PAD, LABEL_H = 300, 5, 16, 28
first = Image.open(screens[0])
thumb_h = int(first.height * THUMB_W / first.width)
rows = (len(screens) + COLS - 1) // COLS
sheet = Image.new('RGB', (COLS * (THUMB_W + PAD) + PAD, rows * (thumb_h + LABEL_H + PAD) + PAD), '#101418')
draw = ImageDraw.Draw(sheet)
try:
    font = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 15)
except OSError:
    font = ImageFont.load_default()
for i, path in enumerate(screens):
    img = Image.open(path).convert('RGB')
    img = img.resize((THUMB_W, int(img.height * THUMB_W / img.width)))
    x = PAD + (i % COLS) * (THUMB_W + PAD)
    y = PAD + (i // COLS) * (thumb_h + LABEL_H + PAD)
    draw.text((x, y), path.stem, fill='#E8EDF2', font=font)
    sheet.paste(img, (x, y + LABEL_H))
sheet.save(sys.argv[2], optimize=True)
print(f'{len(screens)} screenshots -> {sys.argv[2]}')
