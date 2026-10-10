"""Count pixels whose RGB differ between two PNGs, over the whole frame and inside optional boxes.

Usage: python3 -I pixdiff.py A.png B.png [name=x0,y0,x1,y1 ...]
Boxes are half-open pixel rectangles. Prints the whole-frame count and bounding box, then each box.
"""
import sys
from PIL import Image, ImageChops


def mask(a, b):
    d = ImageChops.difference(a.convert('RGB'), b.convert('RGB'))
    r, g, bl = d.split()
    m = ImageChops.lighter(ImageChops.lighter(r, g), bl).point(lambda v: 255 if v else 0)
    return m


def count(m, box=None):
    region = m.crop(box) if box else m
    return region.histogram()[255]


def main():
    a = Image.open(sys.argv[1])
    b = Image.open(sys.argv[2])
    if a.size != b.size:
        raise SystemExit(f'sizes differ: {a.size} vs {b.size}')
    m = mask(a, b)
    print(f'whole {a.size[0]}x{a.size[1]}: {count(m)} differing px, bbox {m.getbbox()}')
    for spec in sys.argv[3:]:
        name, coords = spec.split('=')
        box = tuple(int(v) for v in coords.split(','))
        sub = m.crop(box)
        print(f'{name} {box}: {count(m, box)} differing px, bbox-in-box {sub.getbbox()}')


main()
