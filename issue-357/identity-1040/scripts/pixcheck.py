"""Count the pixels whose RGB differ between two PNGs of one size, decoded by ffmpeg.

An independent re-check of the page's `page frame is the CLI frame` control, outside the
browser: python3 -I scripts/pixcheck.py shape-cue.png cli-shape-cue.png
"""
import subprocess
import sys


def rgb(path):
    probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=width,height',
                            '-of', 'csv=p=0', path], capture_output=True, text=True, check=True)
    size = probe.stdout.strip()
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', path, '-f', 'rawvideo',
                          '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    return size, raw


(sa, a), (sb, b) = rgb(sys.argv[1]), rgb(sys.argv[2])
if sa != sb:
    sys.exit(f'sizes differ: {sa} vs {sb}')
differ = sum(1 for i in range(0, len(a), 3) if a[i:i + 3] != b[i:i + 3])
print(f'{sys.argv[1]} vs {sys.argv[2]}: {differ} of {len(a) // 3} pixels differ ({sa})')
