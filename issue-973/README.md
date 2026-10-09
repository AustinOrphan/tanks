# Issue #973 evidence: the link-card image

- `share-image.png`: byte-identical to `public/share-image.png` on branch `feat/share-image`
  (SHA-256 `9499f762cbeefd12b9d3a18e9635dfdab65d124b3bc370b0f675e75b6c982504`, 406,274 bytes,
  1200x630 RGB PNG).
- `share-image-300.png`: the same image downscaled to 300 px wide, for the legibility criterion.
- `source-frame-0001.png`: the uncropped frame it was cut from (2480x1340), so the crop can be
  checked.

## Provenance

- Source: `npm run gallery -- --scene game --w 1200 --h 630 --dpr 2 --burst 30 --settle 4300 --out gallery-out/share-973b`,
  frame `frame-0001.png`, on the tree of `main` at `1e110d34`. `--scene game` drives the real
  game page through New Game and shoots its real camera. No query string: no `?dev=1`, no
  developer flag, no experimental arm. No seed either, because the seed is a developer flag; the
  round is campaign level 1 as a player starts it.
- Crop and scale: `ffmpeg -i frame-0001.png -vf "crop=2400:1260:40:80,scale=1200:630:flags=lanczos" share-image.png`.
  The 80-pixel top offset removes the HUD's topbar, which sits above the board.
- 300 px copy: `ffmpeg -i share-image.png -vf "scale=300:-1:flags=lanczos" share-image-300.png`.
- Frame choice: the burst's later frames end in Game Over (the idle player is shot), and its
  first frame still shows a respawn countdown digit; frame 1 is the live round between them.
