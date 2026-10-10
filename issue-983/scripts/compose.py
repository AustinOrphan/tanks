"""Stitch the Map-row slices, write before/after pairs, and build one contact sheet per case.

    python3 -I compose.py <raw dir> <media dir>
"""
import json
import shutil
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

RAW = Path(sys.argv[1])
OUT = Path(sys.argv[2])
CASES = ['fresh-2p-ffa', 'fresh-4p-teams', 'mid-3p-ffa', 'cleared-2p-ffa']
TITLES = {
    'fresh-2p-ffa': 'Fresh save, 2 players, FFA',
    'fresh-4p-teams': 'Fresh save, 4 players, Teams',
    'mid-3p-ffa': 'MID_CAMPAIGN save (levels 1-2 cleared), 3 players, FFA',
    'cleared-2p-ffa': 'All five levels cleared, 2 players, FFA',
}
LAYOUTS = ['1280x800', '390x844']
ARMS = [('before', 'BEFORE  origin/main 5d8d7de6'), ('after', 'AFTER  HEAD d7e40bdc')]

FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
BG = (20, 22, 28)
FG = (230, 232, 238)
DIM = (160, 166, 178)
RULE = (70, 76, 90)


def stitch(arm_dir: Path) -> Image.Image:
    report = json.loads((arm_dir / 'report.json').read_text())
    dpr = report['viewport']['dpr']
    slices = report['stitch']['slices']
    imgs = [Image.open(arm_dir / 'slices' / s['file']).convert('RGB') for s in slices]
    width = max(i.width for i in imgs)
    height = round(report['stitch']['totalCss'] * dpr)
    canvas = Image.new('RGB', (width, height), BG)
    for s, img in zip(slices, imgs):
        canvas.paste(img, (0, round(s['offset'] * dpr)))
    last = slices[-1]
    end = round(last['offset'] * dpr) + imgs[-1].height
    if abs(end - height) > 1:
        raise SystemExit(f'{arm_dir}: stitched height {end} != expected {height}')
    return canvas


def wrap(draw, text, font, width):
    words, lines, line = text.split(' '), [], ''
    for w in words:
        trial = f'{line} {w}'.strip()
        if draw.textlength(trial, font=font) <= width or not line:
            line = trial
        else:
            lines.append(line)
            line = w
    if line:
        lines.append(line)
    return lines


def card_line(report):
    cards = report['dom']['cards']
    boards = [c for c in cards if c['map'] != 'random']
    random = next(c for c in cards if c['map'] == 'random')
    names = ', '.join(f"{c['name']} ({c['map']})" for c in boards)
    return (f"{len(cards)} cards = {len(boards)} boards + Random ({random['config']}): "
            f"{names}, Random")


def build_sheet(case: str, pairs: dict) -> Image.Image:
    pad, gutter = 32, 24
    f_title = ImageFont.truetype(BOLD, 40)
    f_sub = ImageFont.truetype(FONT, 24)
    f_head = ImageFont.truetype(BOLD, 28)
    f_arm = ImageFont.truetype(BOLD, 24)
    f_text = ImageFont.truetype(FONT, 22)
    col_w = {lay: max(pairs[lay]['before']['img'].width, pairs[lay]['after']['img'].width) for lay in LAYOUTS}
    sheet_w = max(2 * col_w[lay] + gutter for lay in LAYOUTS) + 2 * pad
    probe = ImageDraw.Draw(Image.new('RGB', (10, 10)))

    blocks = []  # (layout, header lines per arm, image height)
    for lay in LAYOUTS:
        texts = {}
        for arm, _ in ARMS:
            texts[arm] = wrap(probe, card_line(pairs[lay][arm]['report']), f_text, col_w[lay])
        n = max(len(texts['before']), len(texts['after']))
        img_h = max(pairs[lay][a]['img'].height for a, _ in ARMS)
        blocks.append((lay, texts, n, img_h))

    line_h = 28
    height = pad + 52 + 34 + 34 + 16
    for lay, texts, n, img_h in blocks:
        height += 24 + 40 + 34 + n * line_h + 14 + img_h + 16
    height += pad

    sheet = Image.new('RGB', (sheet_w, height), BG)
    d = ImageDraw.Draw(sheet)
    y = pad
    d.text((pad, y), f'Issue #983 - Versus Setup Map row: {TITLES[case]}', font=f_title, fill=FG)
    y += 52
    d.text((pad, y), 'before = origin/main 5d8d7de6    after = feat/gate-campaign-boards-behind-progress d7e40bdc',
           font=f_sub, fill=DIM)
    y += 34
    d.text((pad, y), 'Cards read from the DOM (data-map, in row order). Same capture driver, viewport and DPR for both arms.',
           font=f_sub, fill=DIM)
    y += 34 + 16
    for lay, texts, n, img_h in blocks:
        d.line([(pad, y), (sheet_w - pad, y)], fill=RULE, width=2)
        y += 24
        vp = pairs[lay]['before']['report']['viewport']
        d.text((pad, y), f"{lay} @ DPR {vp['dpr']}", font=f_head, fill=FG)
        y += 40
        total_w = 2 * col_w[lay] + gutter
        x0 = pad + (sheet_w - 2 * pad - total_w) // 2
        for i, (arm, label) in enumerate(ARMS):
            x = x0 + i * (col_w[lay] + gutter)
            d.text((x, y), label, font=f_arm, fill=FG)
            ty = y + 34
            for line in texts[arm]:
                d.text((x, ty), line, font=f_text, fill=DIM)
                ty += line_h
            iy = y + 34 + n * line_h + 14
            img = pairs[lay][arm]['img']
            sheet.paste(img, (x, iy))
            d.rectangle([x - 1, iy - 1, x + img.width, iy + img.height], outline=RULE, width=1)
        y += 34 + n * line_h + 14 + img_h + 16
    return sheet


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    summary = {}
    for case in CASES:
        cdir = OUT / case
        cdir.mkdir(exist_ok=True)
        pairs = {}
        for lay in LAYOUTS:
            pairs[lay] = {}
            for arm, _ in ARMS:
                adir = RAW / case / lay / arm
                report = json.loads((adir / 'report.json').read_text())
                if report['pageErrors']:
                    raise SystemExit(f'{adir}: page errors {report["pageErrors"]}')
                img = stitch(adir)
                img.save(cdir / f'{lay}-{arm}.png', optimize=True)
                shutil.copyfile(adir / 'viewport.png', cdir / f'{lay}-{arm}-viewport.png')
                shutil.copyfile(adir / 'report.json', cdir / f'{lay}-{arm}.json')
                pairs[lay][arm] = {'img': img, 'report': report}
        sheet = build_sheet(case, pairs)
        sheet.save(cdir / 'contact.png', optimize=True)
        summary[case] = {
            lay: {arm: [c['map'] for c in pairs[lay][arm]['report']['dom']['cards']] for arm, _ in ARMS}
            for lay in LAYOUTS
        }
        print(case, 'contact', sheet.size)
    print(json.dumps(summary, indent=1))


main()
