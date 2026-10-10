"""Diff the left (shipped) and middle (--enemyRole both) columns of a composed ordnance-fire frame.

Usage: python3 -I columns.py frame.png [name=x0,y0,x1,y1 ...]   (boxes in column coordinates)
"""
import sys
from PIL import Image, ImageChops

img = Image.open(sys.argv[1]).convert('RGB')
left = img.crop((0, 0, 320, 330))
middle = img.crop((320, 0, 640, 330))
d = ImageChops.difference(left, middle)
r, g, b = d.split()
m = ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v else 0)
print(f'left vs middle: {m.histogram()[255]} differing px, bbox {m.getbbox()}')
for spec in sys.argv[2:]:
    name, coords = spec.split('=')
    box = tuple(int(v) for v in coords.split(','))
    sub = m.crop(box)
    print(f'  {name} {box}: {sub.histogram()[255]} differing px, bbox-in-box {sub.getbbox()}')
