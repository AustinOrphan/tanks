# Issue #841: the three routes the screen catalogue could not reach

Captured from a build of commit `0ce10798141834cc879768199096bcb811b484ce` with `npm run screens -- --state <id>`, at the
catalogue's own 1280x800 at device pixel ratio 2.

| File | State | Why it was missing |
| --- | --- | --- |
| `screen-launch.png` | `screen.launch` | Every other state begins by pressing Space to get PAST this. |
| `screen-boot-loading.png` | `screen.boot-loading` | Removed by `boot()` the moment the module runs; elsewhere only ever measured for its absence. |
| `screen-practice.png` | `screen.practice` | The ninth `AppRoute` kind. The two practice ENDING panels photograph how a run finishes, not what it looks like running. |

The holding card and the splash are easy to confuse at a glance and are genuinely different
screens: the card is served markup with no application behind it, in the boot stylesheet's own
type; the splash is the built UI's first surface, and the game is already running underneath it.

`screen.practice` catches the board mid start-countdown. That countdown is drawn in the 3D
scene rather than the DOM, so there is no selector to wait for its end -- a content-determinism
problem for whoever commits a baseline over this state (#846), recorded in the state's own
comment rather than left to be found in a diff.
