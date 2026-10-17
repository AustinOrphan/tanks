// @vitest-environment jsdom
import { afterEach, describe } from 'vitest';

import { layerReachCase, unmount } from './hud-reachability-fixtures';

/**
 * The developer-config layer's walk (issue #914), split from `hud.reachability.test.ts` so the
 * mutation entries scoped to that file stop paying for it (`hud-reachability-fixtures.ts` says
 * why). That file checks this one still registers the walk below.
 */

afterEach(unmount);

describe('every HUD layer is reachable by arrows and by a D-pad (issue #914)', () => {
  // A RAISED BUDGET, not a hung test. `developer-config` is the registry-driven pane and holds
  // 163 controls; every pad Down re-derives the container's control list, and each control's
  // visibility is a `getComputedStyle` walk up to the container. Truncating the walk to a sample
  // is the one thing the sweep exists to stop -- the panes that went unchecked were exactly the
  // ones nobody walked to the end.
  //
  // Its own, larger budget since jsdom 30.1.2, which empties its computed-style cache on every
  // focus change (so `:focus` rules recompute, as in a browser). Each pad Down moves focus, so
  // the next one re-runs the cascade for all ~290 nodes on the control paths -- 0.1 fresh
  // cascades per step became 312, and the walk went from ~1s to ~29s locally and from 2.5s to
  // 87s in CI's `checks` job.
  //
  // The real ceiling is the mutation harness, not this number. Vitest judges a synchronous
  // test's budget only when it returns (CI's failing run reported its 30s timeout at 87s), and a
  // mutation run of this file is killed whole, before Vitest writes any report, at
  // tools/mutate/run.mjs's SUBPROCESS_TIMEOUT_MS (180s). So this budget cannot usefully exceed
  // about 150s: past that, a slowing walk shows up as a harness timeout, not as a named failure.
  layerReachCase('developer-config', 150_000);
});
