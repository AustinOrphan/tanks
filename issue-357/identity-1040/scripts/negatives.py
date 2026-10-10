"""Hand-run negative controls for tools/gl/identity-cue-overlap-page.ts (issue #1040), run in a
SCRATCH tree (git archive of the commit under test plus a clone of node_modules), never the
worktree.

Each mutation is applied, the runner is run, the exit code and every control line are recorded,
and the original file is written back before the next mutation.

Usage: python3 -I negatives.py <tree dir> <out json>
"""
import json
import subprocess
import sys

TREE, OUT = sys.argv[1], sys.argv[2]
PAGE = 'tools/gl/identity-cue-overlap-page.ts'
MAIN = 'tools/gallery/main.ts'

MUTATIONS = [
    ('shared-count-returns-0', 'a footprint against itself is all shared', PAGE,
     '  for (const i of b) if (inA.has(i)) n++;\n', '\n'),
    ('shared-count-ignores-a', 'disjoint rings share nothing', PAGE,
     '  for (const i of b) if (inA.has(i)) n++;\n', '  for (const i of b) if (i >= 0) n++;\n'),
    ('wrapper-hides-nothing', 'staging guard', PAGE,
     '    for (const o of hide) o.visible = false;\n', '\n'),
    ('slots-sorted-backwards', 'slots', PAGE,
     '  tanks.sort((a, b) => a.slot - b.slot);\n', '  tanks.sort((a, b) => b.slot - a.slot);\n'),
    ('union-drops-slot-3', 'cue attribution complete', PAGE,
     '    const union = new Set(cue.flat());\n', '    const union = new Set(cue.slice(0, 3).flat());\n'),
    ('three-of-four-blocks-hidden', 'cue is the riser alone', PAGE,
     'withCue.frame(withCue.tanks.flatMap((t) => t.blocks))',
     'withCue.frame(withCue.tanks.slice(1).flatMap((t) => t.blocks))'),
    ('last-draw-hides-a-ring', 'repeat draw identical', PAGE,
     'const again = differing(A, withCue.frame()).length;',
     'const again = differing(A, withCue.frame([withCue.tanks[0].ring])).length;'),
    ('page-renderer-without-antialias', 'page frame is the CLI frame', PAGE,
     '{ canvas, antialias: true, preserveDrawingBuffer: true }',
     '{ canvas, antialias: false, preserveDrawingBuffer: true }'),
    ('shared-paired-with-next-slot', 'per-slot shared accounts for every owner and cue pixel', PAGE,
     'shared: sharedCount(ownerB[s], cue[s]),', 'shared: sharedCount(ownerB[s], cue[(s + 1) % 4]),'),
    ('cli-absent-flag-draws-riser', 'page frame is the CLI frame', MAIN,
     '      shellTrail: shellTrailParam,\n      enemyRole: enemyRoleParam,\n      motion: motionParam,\n    });',
     "      shellTrail: shellTrailParam,\n      enemyRole: enemyRoleParam ?? 'riser',\n      motion: motionParam,\n    });"),
    ('cue-absent-rig-without-antialias', 'page frame is the CLI frame', PAGE,
     'antialias: true,', 'antialias: enemyRole !== null,'),
]

originals = {rel: open(f'{TREE}/{rel}').read() for rel in (PAGE, MAIN)}
results = []
try:
    for mid, control, rel, find, replace in MUTATIONS:
        src = originals[rel]
        if src.count(find) != 1:
            sys.exit(f'{mid}: find string occurs {src.count(find)} times')
        open(f'{TREE}/{rel}', 'w').write(src.replace(find, replace))
        run = subprocess.run(['node', 'tools/gl/identity-cue-overlap.mjs'], cwd=TREE, capture_output=True,
                             text=True, timeout=600)
        open(f'{TREE}/{rel}', 'w').write(src)
        lines = [l for l in run.stdout.splitlines() if l.startswith('| ') and (' | pass | ' in l or ' | FAIL | ' in l)]
        failed = [l.split(' | ')[0][2:] for l in lines if ' | FAIL | ' in l]
        target = [l for l in lines if l.startswith(f'| {control}, ')]
        results.append({
            'id': mid, 'file': rel, 'control': control, 'exit': run.returncode,
            'target': target, 'failed': failed, 'passing': len(lines) - len(failed),
            'stderr_tail': run.stderr.splitlines()[-3:] if run.returncode not in (0, 1) else [],
        })
        print(mid, 'exit', run.returncode, f'{len(lines) - len(failed)} of {len(lines)} pass', 'failed:', *failed,
              sep='\n  ')
finally:
    for rel, src in originals.items():
        open(f'{TREE}/{rel}', 'w').write(src)
json.dump(results, open(OUT, 'w'), indent=2)
