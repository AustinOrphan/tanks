/**
 * Renders docs/dev-flags.md from the FLAG_REGISTRY in src/game/devflags.ts.
 *
 * Pure string building, no filesystem access -- both generate.mjs (which writes the file)
 * and doc.test.ts (which compares against what's committed) call this exact function, so
 * the doc can never be rendered two different ways by the two halves of the guard. See
 * CLAUDE.md's "Dev flags" section and this directory's own doc comment in generate.mjs.
 */
import {
  DEV_FLAGS_OFF,
  FLAG_REGISTRY,
  PLAYTEST_BUNDLE,
  type DevFlags,
  type FlagSpec,
} from '../../src/game/devflags';

/** Markdown table cells break on a bare `|`; none of today's copy needs one, but escaping
 *  is cheap insurance against a future description that does. */
function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function fmtDefault(v: DevFlags[keyof DevFlags]): string {
  if (v === null) return '`null`';
  return `\`${String(v)}\``;
}

function fmtValues(spec: FlagSpec): string {
  const values = spec.values && spec.values.length > 0
    ? spec.values.map((v) => `\`${v}\``).join(', ')
    : '';
  // Both set (only sandboxTanks today) means `type` frames the SHAPE (e.g. a multiset
  // that keeps repeats) and `values` is the per-element vocabulary -- render both, or a
  // multiset's "repeats kept" would never appear anywhere in the doc.
  if (spec.type && values) return `${spec.type}: ${values}`;
  if (values) return values;
  return spec.type ?? '';
}

/** DevFlags keys, sorted -- the canonical identity to sort by, not the query param (three
 *  sandbox knobs render under a shorter param than their key: tanks/disarmed/walls). */
function sortedKeys(kind: FlagSpec['kind']): (keyof DevFlags)[] {
  return (Object.keys(FLAG_REGISTRY) as (keyof DevFlags)[])
    .filter((k) => FLAG_REGISTRY[k].kind === kind)
    .sort();
}

function notesBlock(entries: [string, FlagSpec][]): string {
  const withNotes = entries.filter(([, spec]) => spec.notes && spec.notes.length > 0);
  if (withNotes.length === 0) return '';
  const lines = withNotes.flatMap(([name, spec]) =>
    (spec.notes ?? []).map((n) => `- **${name}**: ${n}`),
  );
  return `\nNotes:\n\n${lines.join('\n')}\n`;
}

function bundleNotesBlock(): string {
  const notes = PLAYTEST_BUNDLE.notes ?? [];
  if (notes.length === 0) return '';
  return `\nNotes:\n\n${notes.map((n) => `- ${n}`).join('\n')}\n`;
}

function booleanTable(): string {
  const keys = sortedKeys('boolean');
  const header = '| Flag | Param | Default | Description |\n| --- | --- | --- | --- |';
  const rows = keys.map((k) => {
    const spec = FLAG_REGISTRY[k];
    const param = spec.param ?? k;
    return `| \`${k}\` | \`${param}\` | ${fmtDefault(DEV_FLAGS_OFF[k])} | ${cell(spec.description)} |`;
  });
  const entries = keys.map((k): [string, FlagSpec] => [k, FLAG_REGISTRY[k]]);
  return `${header}\n${rows.join('\n')}\n${notesBlock(entries)}`;
}

function valuedTable(): string {
  const keys = sortedKeys('valued');
  const header = '| Flag | Param | Values | Default | Description |\n| --- | --- | --- | --- | --- |';
  const rows = keys.map((k) => {
    const spec = FLAG_REGISTRY[k];
    const param = spec.param ?? k;
    return `| \`${k}\` | \`${param}\` | ${cell(fmtValues(spec))} | ${fmtDefault(DEV_FLAGS_OFF[k])} | ${cell(spec.description)} |`;
  });
  const entries = keys.map((k): [string, FlagSpec] => [k, FLAG_REGISTRY[k]]);
  return `${header}\n${rows.join('\n')}\n${notesBlock(entries)}`;
}

/** Every query param this doc names, real or bundle-level -- `dev` and `playtest` included
 *  since neither is a DevFlags field. Examples are checked against this set below so a
 *  flag rename can't leave a stale example silently pointing at a name nothing parses. */
function knownParams(): Set<string> {
  const params = (Object.keys(FLAG_REGISTRY) as (keyof DevFlags)[]).map(
    (k) => FLAG_REGISTRY[k].param ?? k,
  );
  return new Set([...params, 'dev', PLAYTEST_BUNDLE.param]);
}

const EXAMPLES: readonly [string, string][] = [
  ['?dev=1&aimRay=1', 'draw the aim ray'],
  ['?dev=1&playtest=1', 'the whole playtest kit in one flag'],
  [
    '?dev=1&level=sandbox&tanks=brown,teal,teal&walls=8&disarmed=0',
    'a scripted, armed sandbox arena -- repeats in `tanks` are kept, not deduplicated',
  ],
  ['?dev=1&coop=1', 'couch co-op, second player on gamepad[0]'],
  ['?dev=1&quality=low', 'force the low render quality preset'],
];

function checkExamples(): void {
  const known = knownParams();
  for (const [query] of EXAMPLES) {
    const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
    for (const key of params.keys()) {
      if (!known.has(key)) {
        throw new Error(
          `tools/devflags/render.ts: example "${query}" names "${key}", which is not a ` +
            'FLAG_REGISTRY param, "dev", or the playtest bundle -- a flag was probably renamed.',
        );
      }
    }
  }
}

function examplesSection(): string {
  return EXAMPLES.map(([query, why]) => `- \`${query}\` -- ${why}.`).join('\n');
}

export function renderDevFlagsDoc(): string {
  checkExamples(); // a stale example throws rather than rendering a broken doc

  const booleanKeys = sortedKeys('boolean');
  const valuedKeys = sortedKeys('valued');

  return `<!-- GENERATED by \`npm run devflags:doc\` (tools/devflags/generate.mjs) from the -->
<!-- FLAG_REGISTRY in src/game/devflags.ts. Do not hand-edit -- run the generator; -->
<!-- tools/devflags/doc.test.ts fails \`npm test\` if this file drifts from the source. -->

# Dev flags

Generated reference for the flags in \`src/game/devflags.ts\`. Regenerate with
\`npm run devflags:doc\`.

## The gate

Nothing below does anything unless \`dev\` is present in the query string: \`?aimRay=1\`
alone is inert, it needs \`?dev=1&aimRay=1\`. A shared link cannot turn a flag on by
accident.

## Boolean flags (${booleanKeys.length})

${booleanTable()}
## Valued flags (${valuedKeys.length})

${valuedTable()}
## The \`playtest\` bundle

\`?dev=1&${PLAYTEST_BUNDLE.param}=1\` -- ${PLAYTEST_BUNDLE.description} Not a DevFlags field
itself; it expands at parse time into:

${PLAYTEST_BUNDLE.expandsTo.map((f) => `- \`${f}\``).join('\n')}
${bundleNotesBlock()}
## Examples

${examplesSection()}
`;
}
