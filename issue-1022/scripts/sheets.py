"""Issue #1022 contact sheets and the evidence folder, from the captures run-all.sh made.

    python3 -I sheets.py

Reads ev/runs (drive.mjs: DOM readings, lossless topbar PNGs, the loss-cue burst) and ev/rec
(record.mjs: report.json and frame-0000..0003). Writes media-1022/{sheets,stills,readings.json}.
"""
import json
import os
import shutil

from PIL import Image, ImageDraw, ImageFont

EV = '/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/w1022/ev'
OUT = '/Users/austinorphan/.claude/jobs/8fe9c2c6/tmp/media-1022'
DPR = 2
REC = 'rec1'  # record.mjs at --dpr 1; ev/rec holds the --dpr 2 attempt whose frames came back 1x
ARMS = ['main', 'head']
ARM_LABEL = {'main': 'BEFORE origin/main ba8f7085', 'head': 'AFTER HEAD aede7232'}
VPS = ['1280x800', '390x844']
CASES = ['ffa-2p', 'ffa-4p', 'teams-4p', 'reversal-ffa-4p']
CASE_LABEL = {
    'ffa-2p': 'FFA, 2 players (?dev=1&mode=ffa&players=2&bots=2)',
    'ffa-4p': 'FFA, 4 players (?dev=1&mode=ffa&players=4&bots=4)',
    'teams-4p': 'Teams, 4 players (?dev=1&mode=teams&players=4&bots=4)',
    'reversal-ffa-4p': 'Reversed marker, FFA 4 players (?dev=1&identityMarker=solid)',
}
F = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf', 19)
FB = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 21)
FT = ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial Bold.ttf', 26)
BG = (238, 238, 238)
INK = (20, 20, 20)


def load(path):
    with open(path) as fh:
        return json.load(fh)


def facts(arm, run):
    return load(f'{EV}/runs/{arm}/{run}/facts.json')


def summarise(start):
    es = start['entries']
    marks = sum(e['marks'] for e in es)
    pips = sum(e['pips'] for e in es)
    lead = sum(e['leadingMarker'] for e in es)
    counts = [e['count'] for e in es if e['count'] is not None]
    if marks:
        row = f'marks row: {marks} outlines ({", ".join(str(e["marks"]) for e in es)})'
    elif pips:
        row = f'pips row: {pips} pips ({", ".join(str(e["pips"]) for e in es)})'
    else:
        row = 'digit strip: no row'
    texts = ' | '.join(repr(e['text']) for e in es)
    names = es[0]['name']
    same = all(e['name'] == names for e in es)
    name_s = 'no role=img name' if names is None else (f'name "{names}" x{len(es)}' if same else 'names ' + ', '.join(str(e['name']) for e in es))
    return (f'{row}; leading marks {lead}' + (f'; digits {counts}' if counts else ''),
            f'text {texts}; {name_s}; strip right {start["strip"]["right"]} / {start["topbar"]["contentRight"]}px')


def crop_box(vp, rights):
    """CSS-px box of the topbar band the driver clips; at 1280 only up to the strip's end."""
    w = int(vp.split('x')[0])
    right = w if w < 600 else min(w, int(max(rights)) + 40)
    return (0, right)


def labelled(tile, lines, width):
    pad = 8
    lh = [FB.size + 6] + [F.size + 5] * (len(lines) - 1)
    head = pad + sum(lh) + 4
    im = Image.new('RGB', (width, head + tile.size[1]), BG)
    d = ImageDraw.Draw(im)
    y = pad
    for i, line in enumerate(lines):
        d.text((pad, y), line, fill=INK, font=FB if i == 0 else F)
        y += lh[i]
    im.paste(tile, (0, head))
    return im


def stack(images, title, gap=10):
    w = max(i.size[0] for i in images)
    tb = FT.size + 20
    h = tb + sum(i.size[1] for i in images) + gap * (len(images) + 1)
    sheet = Image.new('RGB', (w, h), (200, 200, 200))
    d = ImageDraw.Draw(sheet)
    d.text((10, 10), title, fill=INK, font=FT)
    y = tb + gap
    for i in images:
        sheet.paste(i, (0, y))
        y += i.size[1] + gap
    return sheet


def grid(columns, title, gap=10):
    """columns: list of lists of images, laid side by side."""
    colw = [max(i.size[0] for i in col) for col in columns]
    rows = max(len(col) for col in columns)
    rowh = [max(col[r].size[1] for col in columns if r < len(col)) for r in range(rows)]
    tb = FT.size + 20
    W = sum(colw) + gap * (len(columns) + 1)
    H = tb + sum(rowh) + gap * (rows + 1)
    sheet = Image.new('RGB', (W, H), (200, 200, 200))
    d = ImageDraw.Draw(sheet)
    d.text((10, 10), title, fill=INK, font=FT)
    x = gap
    for c, col in enumerate(columns):
        y = tb + gap
        for r, im in enumerate(col):
            sheet.paste(im, (x, y))
            y += rowh[r] + gap
        x += colw[c] + gap
    return sheet


os.makedirs(f'{OUT}/sheets', exist_ok=True)
readings = {'cases': {}, 'loss': {}}

# ---- the four static cases ------------------------------------------------------------------
for case in CASES:
    tiles = []
    readings['cases'][case] = {}
    for vp in VPS:
        fs = {arm: facts(arm, f'{case}-{vp}') for arm in ARMS}
        x0, x1 = crop_box(vp, [fs[a]['start']['strip']['right'] for a in ARMS])
        for arm in ARMS:
            f = fs[arm]
            start = f['start']
            top = max(0, start['topbar']['top'] - 4)
            hgt = start['topbar']['height'] + 8
            drv = Image.open(f'{EV}/runs/{arm}/{case}-{vp}/start-topbar.png').crop((x0 * DPR, 0, x1 * DPR, int(hgt * DPR)))
            rec_dir = f'{EV}/{REC}/{arm}/{case}-{vp}'
            rep = load(f'{rec_dir}/report.json')['producer']
            frame = Image.open(f'{rec_dir}/frame-0000.png')
            k = frame.size[0] / int(vp.split('x')[0])
            rec = frame.crop((int(x0 * k), int(top * k), int(x1 * k), int((top + hgt) * k)))
            # Shown at the drive.mjs tile's 2x by pixel doubling, so its real resolution stays visible.
            rec = rec.resize((rec.size[0] * round(DPR / k), rec.size[1] * round(DPR / k)), Image.NEAREST)
            s1, s2 = summarise(start)
            width = max(drv.size[0], 1460)
            tiles.append(labelled(drv, [f'{ARM_LABEL[arm]}  |  {vp} @2x  |  drive.mjs screenshot (PNG)', s1, s2], width))
            tiles.append(labelled(rec, [
                f'{ARM_LABEL[arm]}  |  {vp} @{k:g}x shown 2x  |  record.mjs frame-0000 (JPEG-sourced)',
                f'{rep["url"]}  arena {rep["world"]["arenaId"]} seed {rep["world"]["seed"]}; '
                f'sim {rep["timing"]["simulation"]["ticksPerSecond"]:.1f} ticks/s; refused/unknown params: '
                f'{rep["diagnostics"]["requestedNotInEffect"] + rep["diagnostics"]["unknownParams"]}',
            ], width))
            # Lossless stills, full topbar width and the full frame, per arm and viewport.
            sd = f'{OUT}/stills/{case}'
            os.makedirs(sd, exist_ok=True)
            shutil.copyfile(f'{EV}/runs/{arm}/{case}-{vp}/start-topbar.png', f'{sd}/{arm}-{vp}-topbar.png')
            shutil.copyfile(f'{EV}/runs/{arm}/{case}-{vp}/start-full.png', f'{sd}/{arm}-{vp}-full.png')
            shutil.copyfile(f'{rec_dir}/frame-0000.png', f'{sd}/{arm}-{vp}-record-frame-0000.png')
            readings['cases'][case][f'{arm}-{vp}'] = {
                'driver': {
                    'url': f['url'], 'world': f['world'], 'diagnostics': f['diagnostics'],
                    'font': start['font'], 'narrow': start['narrow'], 'strip': start['strip'],
                    'topbarContentRight': start['topbar']['contentRight'],
                    'entries': [{k: e[k] for k in ('text', 'name', 'marks', 'marksLost', 'pips', 'pipsLost', 'leadingMarker', 'count', 'color')} for e in start['entries']],
                    'pageErrors': f['pageErrors'],
                },
                'record': {
                    'url': rep['url'], 'world': rep['world'], 'diagnostics': rep['diagnostics'],
                    'ticksPerSecond': rep['timing']['simulation']['ticksPerSecond'],
                    'renderFps': rep['timing']['render']['fps'], 'frames': rep['timing']['frameCount'],
                    'surfaceAtEnd': rep['readiness']['surfaceAtEnd'], 'pageErrors': rep['pageErrors'],
                    'renderer': rep['browser']['renderer'],
                },
            }
    stack(tiles, f'#1022 {CASE_LABEL[case].split(" (")[0]}: topbar strip before and after, arena-01 seed 7').save(f'{OUT}/sheets/case-{case}.png')

# ---- the loss cue ---------------------------------------------------------------------------
PROGRESS = [0.0, 0.25, 0.5, 0.75]


def cue_progress(shot, when='before'):
    """The FIRST cue element's animation, read just before (or just after) the screenshot."""
    for c in shot[when]['cues']:
        for a in c['anims']:
            if a['progress'] is not None:
                return a['progress'], a['name'], a['playState']
    return None


def p_range(shot):
    """The shot lies between the reading taken before it and the one taken after it."""
    b, a = cue_progress(shot), cue_progress(shot, 'after')
    if b is None:
        return 'no cue element'
    hi = f'{a[0]:.2f}' if a is not None else '?'
    return f'{b[1]} p={b[0]:.2f}-{hi} {b[2]}'


def first_window(shots):
    """The shots taken before the strip changed a second time: only the FIRST loss's cue."""
    key = [e['name'] or e['text'] for e in shots[0]['before']['entries']]
    n = 0
    while n < len(shots) and [e['name'] or e['text'] for e in shots[n]['before']['entries']] == key:
        n += 1
    return n


def pick(shots, targets_ms=None):
    """Frames at cue progress 0, .25, .5, .75 and the first finished one, else by elapsed ms,
    from the first loss's window only."""
    chosen = []
    shots = shots[:first_window(shots)]
    if targets_ms is None:
        prog = [(i, cue_progress(s)) for i, s in enumerate(shots)]
        live = [(i, p) for i, p in prog if p is not None and p[2] == 'running']
        for t in PROGRESS:
            if live:
                chosen.append(min(live, key=lambda ip: abs(ip[1][0] - t))[0])
        done = [i for i, p in prog if p is not None and p[2] == 'finished']
        if done:
            chosen.append(done[0])
        return chosen
    for t in targets_ms:
        chosen.append(min(range(len(shots)), key=lambda i: abs(shots[i]['msSinceDetect'] - t)))
    return chosen


RUNS = [('main', ''), ('head', ''), ('head', '-reduced'), ('main', '-reduced')]
for vp in VPS:
    fl = {(arm, red): facts(arm, f'ffa-4p-{vp}{red}') for arm, red in RUNS}
    ref = fl[('head', '')]['loss']
    ref_idx = pick(ref['shots'])
    ref_ms = [ref['shots'][i]['msSinceDetect'] for i in ref_idx]
    rights = [fl[k]['start']['strip']['right'] for k in fl]
    x0, x1 = crop_box(vp, rights)
    columns = []
    for arm, red in RUNS:
        f = fl[(arm, red)]
        run = f'ffa-4p-{vp}{red}'
        key = f'{arm}-{vp}{red}'
        col = []
        loss = f['loss']
        if not loss.get('found'):
            readings['loss'][key] = {'found': False}
            continue
        has_cue = any(cue_progress(s) for s in loss['shots'])
        idx = pick(loss['shots']) if has_cue and red == '' else pick(loss['shots'], ref_ms)
        hgt = f['start']['topbar']['height'] + 8
        width = max((x1 - x0) * DPR, 880)
        title = f'{ARM_LABEL[arm]}{" | reduced motion" if red else ""}'
        st = Image.open(f'{EV}/runs/{arm}/{run}/start-topbar.png').crop((x0 * DPR, 0, x1 * DPR, int(hgt * DPR)))
        col.append(labelled(st, [title, f'round start, tick {f["start"]["ticks"]}'], width))
        sel = []
        for i in idx:
            s = loss['shots'][i]
            cp = cue_progress(s)
            names = [e['name'] or e['text'] for e in s['before']['entries']]
            changed = [n for n, e0 in zip(names, f['start']['entries']) if n != (e0['name'] or e0['text'])]
            tf = s['before']['cues'][0]['transform'] if s['before']['cues'] else 'none'
            scale = float(tf[7:].split(',')[0]) if tf.startswith('matrix(') else 1.0
            cue_s = 'no cue element' if not s['before']['cues'] else (
                p_range(s) + f'; scale {scale:.2f} before the shot')
            im = Image.open(f'{EV}/runs/{arm}/{run}/{s["file"]}').crop((x0 * DPR, 0, x1 * DPR, int(hgt * DPR)))
            col.append(labelled(im, [f'{title}  |  +{s["msSinceDetect"]} ms, tick {s["before"]["ticks"]}', cue_s[:110],
                                     f'changed: {changed}'], width))
            sel.append({'file': s['file'], 'msSinceDetect': s['msSinceDetect'], 'ticks': s['before']['ticks'],
                        'cues': s['before']['cues'], 'entries': names})
        se = loss['settled']
        im = Image.open(f'{EV}/runs/{arm}/{run}/settled-topbar.png').crop((x0 * DPR, 0, x1 * DPR, int(hgt * DPR)))
        col.append(labelled(im, [f'{title}  |  +1.2 s after the burst, tick {se["ticks"]}',
                                 'entries: ' + ', '.join((e['name'] or e['text']).strip() for e in se['entries'])], width))
        columns.append(col)
        # The mid-run still on its own, full topbar width.
        ld = f'{OUT}/stills/loss-cue'
        os.makedirs(ld, exist_ok=True)
        mid = idx[2] if len(idx) > 2 else idx[len(idx) // 2]
        shutil.copyfile(f'{EV}/runs/{arm}/{run}/{loss["shots"][mid]["file"]}', f'{ld}/{arm}-{vp}{red}-mid.png')
        shutil.copyfile(f'{EV}/runs/{arm}/{run}/start-topbar.png', f'{ld}/{arm}-{vp}{red}-start.png')
        shutil.copyfile(f'{EV}/runs/{arm}/{run}/settled-topbar.png', f'{ld}/{arm}-{vp}{red}-settled.png')
        readings['loss'][key] = {
            'found': True, 'url': f['url'], 'world': f['world'], 'reducedMotion': f['start']['reducedMotion'],
            'startTicks': f['start']['ticks'], 'firstChangeTicks': loss['shots'][0]['before']['ticks'],
            'shots': len(loss['shots']), 'selected': sel, 'mid': loss['shots'][mid]['file'],
            'settled': [e['name'] or e['text'] for e in se['entries']], 'pageErrors': f['pageErrors'],
        }
    grid(columns, f'#1022 loss cue mid-run, FFA 4 players, {vp} @2x, arena-01 seed 7: first stock lost on the board').save(
        f'{OUT}/sheets/loss-cue-{vp}.png')

# ---- the loss cue mid-run in every case (the bursts every static run also took) ----------------
readings['lossEveryCase'] = {}
# The first take's burst stalled 275 ms between p=0.19 and p=0.63 of the first cue, so it holds no
# mid-run frame; the second take (same board, same first loss at tick 884) does.
RETAKE = {('head', 'teams-4p-1280x800'): 'teams-4p-1280x800-take2'}
rows = []
for case in CASES:
    for vp in VPS:
        rundir = {arm: RETAKE.get((arm, f'{case}-{vp}'), f'{case}-{vp}') for arm in ARMS}
        fs = {arm: facts(arm, rundir[arm]) for arm in ARMS}
        if not all(fs[a].get('loss', {}).get('found') for a in ARMS):
            readings['lossEveryCase'][f'{case}-{vp}'] = {a: fs[a].get('loss', {}).get('found', False) for a in ARMS}
            continue
        x0, x1 = crop_box(vp, [fs[a]['start']['strip']['right'] for a in ARMS])
        h_idx = pick(fs['head']['loss']['shots'])
        h_mid = h_idx[2] if len(h_idx) > 2 else 0
        ms = fs['head']['loss']['shots'][h_mid]['msSinceDetect']
        row = []
        for arm in ARMS:
            f = fs[arm]
            shots = f['loss']['shots']
            i = h_mid if arm == 'head' else pick(shots, [ms])[0]
            sh = shots[i]
            hgt = f['start']['topbar']['height'] + 8
            im = Image.open(f'{EV}/runs/{arm}/{rundir[arm]}/{sh["file"]}').crop((x0 * DPR, 0, x1 * DPR, int(hgt * DPR)))
            cp = cue_progress(sh)
            names = [(e['name'] or e['text']).strip() for e in sh['before']['entries']]
            row.append(labelled(im, [
                f'{ARM_LABEL[arm]}  |  {case}  |  {vp}' + ('  |  take 2' if rundir[arm].endswith('take2') else ''),
                f'+{sh["msSinceDetect"]} ms, tick {sh["before"]["ticks"]}; {p_range(sh)}',
                'entries: ' + ', '.join(names),
            ], max((x1 - x0) * DPR, 880)))
            ld = f'{OUT}/stills/loss-cue-every-case'
            os.makedirs(ld, exist_ok=True)
            shutil.copyfile(f'{EV}/runs/{arm}/{rundir[arm]}/{sh["file"]}', f'{ld}/{arm}-{case}-{vp}-mid.png')
            readings['lossEveryCase'].setdefault(f'{case}-{vp}', {})[arm] = {
                'run': rundir[arm], 'file': sh['file'], 'msSinceDetect': sh['msSinceDetect'],
                'firstChangeTicks': shots[0]['before']['ticks'],
                'cueProgress': cp[0] if cp else None, 'entries': names,
            }
        rows.append(row)
grid([[r[0] for r in rows], [r[1] for r in rows]],
     '#1022 loss cue at mid-run in every case: first stock lost on the board, arena-01 seed 7').save(
    f'{OUT}/sheets/loss-cue-mid-every-case.png')

with open(f'{OUT}/readings.json', 'w') as fh:
    json.dump(readings, fh, indent=1)
print('sheets written')
