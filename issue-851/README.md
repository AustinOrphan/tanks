# Issue #851: the match-failure overlay, captured again

`match-failed-overlay.png` from a build of commit `217271765694a52875c50da58e11b0498d807c0d`, via
`npm run screens -- --state screen.startup.match-failed`.

Before the fix this state timed out after 20 s and captured nothing. The page it actually
reached was the full-page **"This browser cannot run Tanks!"** screen -- the FATAL state --
rather than the recoverable overlay the state is named for.

## Why

The fixture throws from a WebGL call to simulate a match that cannot be built. It has to throw
from BELOW `new THREE.WebGLRenderer(...)`, the one statement `scene.ts` wraps in
`RenderContextUnavailableError`, because issue #325 made that wrap fatal.

**three 0.186 allocates a framebuffer inside that constructor.** So `createFramebuffer`, the
call the fixture had used since #700, started throwing one statement too early.

Re-measured on three 0.186, first call site and where the page lands:

| override | calls | first call site | lands on |
| --- | ---: | --- | --- |
| `createFramebuffer` | 12 | `new WebGLRenderer` | fatal page |
| `texImage2D` | 16 | `new WebGLTexture` | fatal page |
| **`framebufferTexture2D`** | 16 | `setupRenderTarget` | **overlay** |
| `createProgram` | 8 | `acquireProgram` | overlay |
| `linkProgram` | 8 | `acquireProgram` | overlay |
| `drawElements` | 3963 | `renderBufferDirect` | overlay |

`framebufferTexture2D` is the earliest that still lands on the overlay, which keeps the
fixture as close to its original intent -- the first render-target allocation after the
context -- as the renderer's internals now allow.

The original comment recorded each candidate as "called exactly once". None is, now.
