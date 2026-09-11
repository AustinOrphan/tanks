# Issue #117 — About & Legal gains the repository's legal documents

Every frame is the **built** page, captured through `tools/screens/run.mjs` against `dist`.

## The pane

| | Frame | Viewport |
| --- | --- | --- |
| Before (`origin/main` @ `04e6591`) | `about-before.png` | 1280x800 @2dpr |
| After | `about-after.png` | 1280x800 @2dpr |
| After, Privacy open | `about-doc.png` | 1280x800 @2dpr |

Before: three paragraphs and Back, vertically centred. After: the two outbound links, a
**Documents** heading, and one collapsed disclosure per repository document — Privacy,
Credits, Third-party notices, Code licence, Content licence — every word of which is
generated from the markdown at the repository root by `npm run legal`.

The sentence "Built with Three.js and Howler.js, which are used under their own licences"
is gone from the before frame on purpose: it was a hand-maintained dependency list one
screen away from `THIRD-PARTY-NOTICES.md`, which `npm run notices` derives from
`package.json` for exactly that reason. The Third-party notices document replaces it.

## The centred-overflow clip, measured

Both frames are `screen.about.document` at **900x500 @2dpr** with the Privacy document
open. The only difference between them is one declaration on `.hud-about`:

| `justify-content` | top of the open document | frame |
| --- | --- | --- |
| `center` (what the pane shipped) | **y = -454** | `scroll-before.png` |
| `flex-start` (this change) | y = +388 | `scroll-after.png` |

Centring the main axis of an `overflow-y: auto` column puts the overflow above the scroll
origin, where no scrollbar reaches it. 454 CSS px of a privacy policy were unreachable.
Harmless while the pane held three short lines; a defect the moment it holds documents.

Three sibling panes still carry the same shape — `.hud-versus-setup`, `.hud-settings`,
`.hud-devtools`. They are **not** changed here; issue #642 owns them, and
`hud.css.test.ts` pins the set so a fourth cannot join quietly.
