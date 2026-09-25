/**
 * WHICH BUILD PRODUCED THE PAGE -- and why it is not in `dev-diagnostics.ts` (issue #946).
 *
 * This is the one fact in the diagnostics family that an ORDINARY session needs. `loop.ts`
 * and `route-host.ts` both call `readBuildIdentity` on paths a player reaches, and `bench.ts`
 * names `BuildIdentity` in its report shape. Everything else in `dev-diagnostics.ts` is
 * developer surface, and that module imports `devflags.ts`'s registry and `dev-config.ts` --
 * so leaving these three declarations there made a developer module reachable from ordinary
 * startup for the sake of one eight-line function, and #946's first criterion is that an
 * ordinary URL requests no developer chunk at all.
 *
 * Measured before the move, over `src/` excluding tests: 13 VALUE imports of a developer
 * module from outside the developer set -- `hud.ts` 8, `loop.ts` 4, `route-host.ts` 1. Two of
 * those thirteen were `loop.ts` and `route-host.ts` reaching for `readBuildIdentity` alone,
 * and both become type-only with this split. `bench.ts`'s was already type-only and stays so.
 *
 * NOT A BARREL, and not re-exported from `dev-diagnostics.ts`. A re-export would keep the
 * edge it exists to remove: the importer's module graph would still reach the developer
 * module, and `dependency-direction.test.ts` would have nothing to see. `dev-diagnostics.ts`
 * imports the TYPE from here instead, which is the direction that costs nothing at runtime.
 *
 * PURE, like the module it came from: the environment arrives as a record, so nothing here
 * touches `import.meta` and the whole thing is testable without a browser.
 */

/**
 * Which build produced the page.
 *
 * `known: false` is a first-class answer, not a fallback dressed as one. A developer build,
 * a local `npm run dev`, and anything served from a tree that never went through the
 * deploy workflow genuinely have no commit to name, and the acceptance criterion is that
 * copied diagnostics "identify local/unknown builds honestly" -- so this says unknown rather
 * than inventing a version string or quietly printing an empty field.
 */
export interface BuildIdentity {
  /** The commit the bundle was built from, or `''` when nothing supplied one. */
  readonly commit: string;
  readonly known: boolean;
}

/** The shape `import.meta.env` presents to this module. Injected so nothing here is build-time. */
export interface BuildEnv {
  readonly VITE_BUILD_SHA?: string;
}

/**
 * Read the build identity out of the bundle's environment.
 *
 * `VITE_`-prefixed because that is the only prefix Vite exposes to client code, and the
 * same mechanism `measure.yml` already uses for `VITE_RUN_MEASURE`. The deploy workflow
 * passes the commit; every other way of running this game does not, and gets `known: false`.
 *
 * A whitespace-only value is treated as absent: an unset variable in a shell substitution
 * usually arrives as `''`, and a build that printed "commit: " would be claiming to know
 * something it does not.
 */
export function readBuildIdentity(env: BuildEnv): BuildIdentity {
  const raw = (env.VITE_BUILD_SHA ?? '').trim();
  return raw === '' ? { commit: '', known: false } : { commit: raw, known: true };
}
