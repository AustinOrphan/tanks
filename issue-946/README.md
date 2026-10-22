# Issue #946: closing measurement scripts

The two scripts behind the closing measurement recorded on #946 for #1016. They compare main at 66694b47 (before the first code-splitting slice) with 47b32b4a (after all four slices).

- `probe.mjs <tree> <port> <out.json>` serves a built tree with `vite preview` and records every request Chromium makes in three arms: an ordinary URL, `?dev=1` with the developer panes opened, and the gallery route. Set `TANKS_REPO` to a checkout of the repository, for Playwright and `tools/shared/audio-context.mjs`.
- `analyze.mjs <after> <before> <out.json>` reads each chunk's source map with `source-map-js`. It attributes each mapped segment's bytes to that segment's source module, sums the bytes per population, and checks the probe strings.

Both were run from scratch copies of the two commits (`git archive`, then `npm ci`, `vite build` and `vite build --sourcemap --outDir dist-map`), never inside the repository.
