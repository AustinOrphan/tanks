# Bundled typefaces

Vendored rather than depended on, because these files are the whole of what ships and a
package that resolves them adds a build-time dependency for no runtime benefit.

## Shipped

| File | Family | Weights | Source |
| --- | --- | --- | --- |
| `ibm-plex-sans-latin-wght-normal.woff2` | IBM Plex Sans | variable, 100–700 | `@fontsource-variable/ibm-plex-sans@5.3.0` |
| `ibm-plex-mono-latin-400-normal.woff2` | IBM Plex Mono | 400 | `@fontsource/ibm-plex-mono@5.3.0` |
| `ibm-plex-mono-latin-600-normal.woff2` | IBM Plex Mono | 600 | `@fontsource/ibm-plex-mono@5.3.0` |

## Developer arms (issue #865)

Reached only through `?dev=1&hudFont=atkinson` or `=inter`, and **not downloaded otherwise** --
a `@font-face` whose family no matched rule asks for is never fetched. That is verified in a
real browser rather than assumed; see the issue.

| File | Family | Weights | Source |
| --- | --- | --- | --- |
| `atkinson-hyperlegible-latin-400-normal.woff2` | Atkinson Hyperlegible | 400 | `@fontsource/atkinson-hyperlegible@5.3.0` |
| `atkinson-hyperlegible-latin-700-normal.woff2` | Atkinson Hyperlegible | 700 | `@fontsource/atkinson-hyperlegible@5.3.0` |
| `inter-latin-wght-normal.woff2` | Inter | variable, 100–900 | `@fontsource-variable/inter@5.3.0` |

**Atkinson Hyperlegible ships 400 and 700 only**, so the HUD's 100–300 and 500–600 are
synthesised by the browser under that arm. Stated rather than corrected: it is what the face
offers, and a developer arm is for looking at the face as it is.

Latin subsets only. The game ships no other script, and the full files are several times the
size for glyphs nothing renders.

All three families are released under the SIL Open Font License 1.1, which permits bundling and
redistribution. Each package carries its own copyright line, so each licence is kept whole and
separate: `OFL.txt` (IBM Plex), `OFL-atkinson-hyperlegible.txt`, `OFL-inter.txt`. Keep them
beside the files.

To update, install the package at the new version, copy the same files, and refresh the
versions above. Then **regenerate the screen baselines**: a new version can change metrics, and
metric stability is the reason these are bundled at all — see `tools/screens/README.md`,
"The required gate, decided".
