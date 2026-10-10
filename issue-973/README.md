# Issue #973 evidence: the share image (round 2, the split card)

`share-image.png` is `public/share-image.png` in PR #1047: a 1200x630 palette PNG, 96,965 bytes,
SHA-256 `856eb9594082d7e923fc1bc615eac41eb803ecbca831c42ea21d2fefcdaa536f`.

The owner chose it on 2026-10-10 from two rounds of options. In round 1, seven concepts were
shown and the owner picked the split card, saying the square crop was bad. In round 2, five
square-safe versions of the split card were shown, and this is the "seam at the centre" one.
The owner's ruling: "973's rule can be amended", and the amendment is on #973.

## Source frame

`source-frame-0008.png` (3280x1880, SHA-256 `e856f08f...cfa2c2`) is frame 8 of
`npm run gallery -- --scene game --w 1600 --h 900 --dpr 2 --slowmo 0.3 --burst 16 --settle 12000 --out gallery-out/share-main-1600-slow30`.
It was run on a detached checkout of `main` at `c200cf62`.

- The command uses no query string, so there is no `dev=1`, flag or seed.
- `--slowmo 0.3` scales only the clocks the game reads, never what it draws. Without it the idle
  player loses all three lives within a few frames of a full-speed burst.

## Composition

The `*.txt` files are the one-off build scripts. They live outside the repository, as the
amended rules ask. Run `build.sh` to reproduce `share-image.png` byte for byte; this was checked
by rebuilding in a fresh folder, which gave the same SHA-256.

1. `ffmpeg` crops the frame to x 934-2324, y 467-1617 and scales it 1.1x with Lanczos. That is
   a net 0.55 of source size in the final card. Gameplay pixels are cropped and scaled only.
2. `render.mjs` (Playwright, device scale 2) renders `card.html`. The card is the board, a dark
   panel in the HUD palette, the splash title "TANKS!" in the bundled IBM Plex Sans, two lines of
   copy, a green accent rule and a slanted green seam at the centre.
3. `ffmpeg` scales the render to 1200x630 with Lanczos. `quantize.py` (Pillow) reduces it to a
   256-colour palette: Floyd-Steinberg dithering on the board, nearest colour on the flat panel.

## Check copies

- `share-image-300.png`: the full card at 300 px wide.
- `share-image-square-630.png` and `share-image-square-200.png`: the centred 630x630 square
  (x 285-915) that compact link previews crop to. It holds the whole title, the copy and all four
  tanks.
