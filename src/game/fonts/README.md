# Bundled typefaces

Vendored rather than depended on, because these three files are the whole of what ships and a
package that resolves them adds a build-time dependency for no runtime benefit.

| File | Family | Weights | Source |
| --- | --- | --- | --- |
| `ibm-plex-sans-latin-wght-normal.woff2` | IBM Plex Sans | variable, 100–700 | `@fontsource-variable/ibm-plex-sans@5.3.0` |
| `ibm-plex-mono-latin-400-normal.woff2` | IBM Plex Mono | 400 | `@fontsource/ibm-plex-mono@5.3.0` |
| `ibm-plex-mono-latin-600-normal.woff2` | IBM Plex Mono | 600 | `@fontsource/ibm-plex-mono@5.3.0` |

Latin subsets only. The game ships no other script, and the full files are several times the
size for glyphs nothing renders.

`OFL.txt` is the SIL Open Font License 1.1 both families are released under, copied from the
same packages. It permits bundling and redistribution; keep it beside the files.

To update, install the package at the new version, copy the same three files, and refresh the
versions above. Then **regenerate the screen baselines**: a new version can change metrics, and
metric stability is the reason these are bundled at all — see `tools/screens/README.md`,
"The required gate, decided".
