import { FLAG_REGISTRY, type DevFlags } from './devflags';
import { canonicalDevSearch, explainDevConfig, type DevConfigNote } from './dev-config';

/**
 * WHAT A RUNNING DEVELOPER SESSION IS, as text somebody else can act on (issue #247).
 *
 * The problem it closes: a developer session is reproducible only if you can say what it
 * WAS, and until now that meant reading a terminal and guessing the seed. The seed in
 * particular is unrecoverable by inspection -- `loop.ts` derives it from the wall clock, so
 * it exists only inside the running world, and a bug seen once at an unseeded seed could not
 * be handed to anyone.
 *
 * PURE, and injected on both sides. No `location`, no `navigator`, no `import.meta`: the
 * page facts arrive as strings, the build identity arrives as a record, and the live session
 * arrives as a snapshot the game layer took. That is what makes "an unseeded observed world
 * can produce a URL that recreates the same seed" testable without a browser -- and it is
 * the same rule `hud.ts` is already under, which may not touch `location` either.
 *
 * NOT AN EXPORT FORMAT, and deliberately smaller than one. Issue #241 owns the diagnostic
 * file and its schema; this is the "concise enough for a GitHub issue" half issue #247 asks
 * for, and it keeps a structured source (`diagnosticsReport`) beside the text so #241 can
 * consume the record rather than re-parse the prose. The controller self-test's
 * `formatPadReport` is the precedent this follows -- a developer-facing formatter with its
 * own tests -- and is deliberately NOT absorbed here: that is #241's job, not this one's.
 *
 * SECRETS AND UNRELATED BROWSER DATA ARE ABSENT BY CONSTRUCTION rather than by filtering.
 * Nothing in this module can reach a store, a cookie or a header; every field is named
 * below, and the query string is the one the page was opened with, canonicalised through the
 * same model the game parses it with.
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

/**
 * The live world, as the game layer sees it at the moment Copy is pressed.
 *
 * A SNAPSHOT, not a reference: every field is a primitive, so nothing here can keep a world
 * alive or read one that has since been replaced. `null` where the session simply has no
 * such fact -- there is no arena on the main menu -- rather than a placeholder string that a
 * reader could mistake for a real arena id.
 */
export interface SessionDiagnostics {
  /**
   * `world.seed`, the resolved one. THE FIELD THIS ISSUE EXISTS FOR: `loop.ts` derives it
   * from the wall clock when the URL names none, so it is the one fact about a session that
   * cannot be recovered from the URL, the build, or anything the player can see.
   */
  readonly seed: number;
  readonly arenaId: string | null;
  readonly mode: string | null;
  /** Humans and bots separately, because `players=3&bots=2` and `players=5` are different sessions. */
  readonly humanPlayers: number;
  readonly bots: number;
  /** The quality preset actually in force, which the `quality` flag can override. */
  readonly quality: string;
}

/** The page facts, the build, and the session -- everything the report is derived from. */
export interface DiagnosticsInput {
  /** `location.pathname`. */
  readonly path: string;
  /** `location.search`, with or without its leading `?`. */
  readonly search: string;
  /** `location.hash`, carried through the canonical URL untouched. */
  readonly hash: string;
  readonly build: BuildIdentity;
  /** `null` when nothing is simulating, which is a legitimate state to copy from. */
  readonly session: SessionDiagnostics | null;
}

/** The structured form, so issue #241's export can consume a record rather than parse prose. */
export interface DiagnosticsReport {
  readonly canonicalUrl: string;
  readonly build: BuildIdentity;
  readonly session: SessionDiagnostics | null;
  readonly developerMode: boolean;
  readonly effective: DevFlags;
  /** Every parameter whose request and effect differ, with the model's own reason. */
  readonly notes: readonly DevConfigNote[];
  /** Parameters the model does not know, carried through rather than dropped. */
  readonly unknownParams: readonly string[];
}

/** The `seed` parameter's name, from the registry rather than as a literal. */
const SEED_PARAM = FLAG_REGISTRY.seed.param ?? 'seed';

function toParams(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
}

/**
 * The canonical URL for a page, as one string.
 *
 * Canonicalised through `canonicalDevSearch`, so the URL in a report is the one the model
 * would produce for those flags rather than whatever order the developer happened to type --
 * and so a report pasted into an issue and a URL built by the configuration menu are the
 * same string for the same session.
 */
export function canonicalUrl(path: string, search: string, hash: string): string {
  return `${path}${canonicalDevSearch(search).search}${hash}`;
}

/**
 * The URL that would reproduce this session's seed.
 *
 * READ-ONLY, which is the criterion most at risk here: "seed pinning does not change the
 * current world before the user applies/reloads". This function takes a number and a string
 * and returns a string. It has no world to write to, no store, and no `location` -- so the
 * pin cannot reach the running simulation even by accident, and the button that calls it can
 * only ever offer a URL.
 *
 * `set`, not `append`: pinning REPLACES any seed already in the query. Appending would leave
 * two, and `devflags.ts` reads the first, so the pinned value would be silently ignored by
 * the very reload it exists to configure.
 */
export function pinnedSeedUrl(input: DiagnosticsInput): string | null {
  if (input.session === null) return null;
  const params = toParams(input.search);
  params.set(SEED_PARAM, String(input.session.seed));
  return canonicalUrl(input.path, `?${params.toString()}`, input.hash);
}

/** Everything the text is rendered from, and what issue #241 can export instead of the text. */
export function diagnosticsReport(input: DiagnosticsInput): DiagnosticsReport {
  const state = explainDevConfig(input.search);
  return {
    canonicalUrl: canonicalUrl(input.path, input.search, input.hash),
    build: input.build,
    session: input.session,
    developerMode: state.developerMode,
    effective: state.effective,
    notes: state.notes,
    unknownParams: state.unknownParams,
  };
}

function buildLine(build: BuildIdentity): string {
  return build.known ? `- Build: ${build.commit}` : '- Build: unknown (not a deployed build)';
}

/**
 * The copyable half: one short Markdown block.
 *
 * SHORT ON PURPOSE. The acceptance criterion is "concise enough for a GitHub issue", and the
 * failure mode of a diagnostics dump is that nobody reads it -- so the effective flags are
 * listed only where they DIFFER from their defaults, and the requested-versus-effective
 * section appears only when the model actually has something to say. A session that behaved
 * exactly as its URL asked produces four lines and a URL.
 *
 * REQUESTED AND EFFECTIVE ARE TWO SECTIONS, never one merged map, because the criterion is
 * that they "cannot be confused in the output". `explainDevConfig` already computes that
 * distinction with a machine-readable reason per parameter; this renders those reasons
 * rather than re-deriving them, so the text cannot disagree with the configuration menu
 * beside it.
 */
export function formatDiagnostics(input: DiagnosticsInput): string {
  const report = diagnosticsReport(input);
  const lines: string[] = ['## Tanks! session diagnostics', ''];
  lines.push(`- URL: ${report.canonicalUrl}`);
  lines.push(buildLine(report.build));
  lines.push(`- Developer mode: ${report.developerMode ? 'on' : 'off'}`);

  if (report.session === null) {
    lines.push('- Session: none simulating (no seed to report)');
  } else {
    const s = report.session;
    lines.push(`- Seed: ${s.seed}`);
    lines.push(`- Arena: ${s.arenaId ?? '(none)'}`);
    lines.push(`- Mode: ${s.mode ?? '(none)'}`);
    lines.push(`- Players: ${s.humanPlayers} human, ${s.bots} bot${s.bots === 1 ? '' : 's'}`);
    lines.push(`- Quality: ${s.quality}`);
  }

  /*
   * TWO SECTIONS, SPLIT ON WHETHER THE URL ASKED, which is the criterion "requested and
   * effective flags cannot be confused in the output" taken from both directions:
   *
   *  - asked for and did not get, which is the case a developer is usually chasing;
   *  - got without asking, which is the case nobody thinks to look for.
   *
   * The split is on `note.requested` rather than on the reason code, because the codes do
   * not partition that way: `inverted-default` never carries a request (`sandboxDisarmed`
   * defaults ON, so its absence is not "off"), and it appears on EVERY developer session --
   * filing it under "requested" would put a line that was never requested under a heading
   * saying it was, on every report this pane ever produces.
   */
  const asked = report.notes.filter((n) => n.requested !== undefined);
  const unasked = report.notes.filter((n) => n.requested === undefined);
  const render = (note: DevConfigNote): string =>
    `- \`${note.param}\`: requested ${note.requested === undefined ? '(absent)' : `\`${note.requested}\``}, effective \`${String(note.effective)}\` — ${note.reason}`;
  if (asked.length > 0) {
    lines.push('', '### Requested, but not in effect', '');
    for (const note of asked) lines.push(render(note));
  }
  if (unasked.length > 0) {
    lines.push('', '### In effect without being requested', '');
    for (const note of unasked) lines.push(render(note));
  }

  if (report.unknownParams.length > 0) {
    lines.push('', '### Parameters this build does not know', '');
    lines.push(report.unknownParams.map((p) => `- \`${p}\``).join('\n'));
  }

  return lines.join('\n');
}
