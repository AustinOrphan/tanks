/**
 * The compatibility contract: are these two recipes the same measuring instrument?
 *
 * WHY THIS EXISTS AT ALL. Changing the instrument and the feature in the same comparison
 * makes the evidence ambiguous -- a moved viewport, a different seed, or a retimed schedule
 * produces a difference image that looks exactly like a behaviour change and is not one.
 * So the recipe is held fixed and only the code varies.
 *
 * The content hash alone decides compatibility: it covers the whole recipe, so equal hashes
 * mean equal instruments and nothing else needs checking. The per-field comparison below
 * exists purely to make a REFUSAL actionable -- "these differ" is useless, "the viewport is
 * 640x480 on base and 800x600 on head" tells the reader what to fix.
 */

/** Fields named by the issue's compatibility contract, each with a reader and a label. */
const CHECKS = [
  ['schemaVersion', (r) => r.schemaVersion],
  ['recipeVersion', (r) => r.recipeVersion],
  ['producer.kind', (r) => r.producer.kind],
  ['producer.scenarioId', (r) => r.producer.scenarioId],
  ['fixture', (r) => r.fixture],
  ['variant', (r) => r.variant],
  ['viewport', (r) => r.viewport],
  ['profile', (r) => r.profile],
  ['schedule', (r) => r.schedule],
  ['playback', (r) => r.playback],
  ['artifacts', (r) => r.artifacts.map((a) => `${a.format}:${a.filename}`)],
  ['expectations', (r) => r.expectations],
];

function stable(value) {
  return JSON.stringify(value, (_key, inner) => {
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]));
    }
    return inner;
  });
}

/**
 * @param base {{ recipe: object, hash: string }} registry entry as it exists at base
 * @param head {{ recipe: object, hash: string }} registry entry as it exists at head
 */
export function checkRecipeCompatibility(base, head) {
  const fields = CHECKS.map(([name, read]) => {
    const baseValue = read(base.recipe);
    const headValue = read(head.recipe);
    return { name, equal: stable(baseValue) === stable(headValue), base: baseValue, head: headValue };
  });
  const differing = fields.filter((field) => !field.equal);
  return {
    compatible: base.hash === head.hash,
    baseHash: base.hash,
    headHash: head.hash,
    fields,
    differing: differing.map((field) => field.name),
  };
}

/**
 * Turn an incompatible result into an instruction.
 *
 * The hash can differ while every named field matches -- the recipe grew a field this
 * contract does not read, or a title/description changed. That is still a refusal, because
 * the hash is what identifies the reviewed configuration, but it needs a different sentence:
 * telling someone "these differ" while showing them a table where everything matches reads
 * as a tool bug.
 */
export function describeIncompatibility(recipeId, base, head, result) {
  const lines = [
    `recipe '${recipeId}' is not the same instrument at both refs, so a comparison of it `
      + 'would confuse a change in the measurement with a change in the code.',
    `  base ${base.requestedRef} (${base.commitSha.slice(0, 7)}) hash ${result.baseHash.slice(0, 12)}`,
    `  head ${head.requestedRef} (${head.commitSha.slice(0, 7)}) hash ${result.headHash.slice(0, 12)}`,
  ];
  if (result.differing.length > 0) {
    lines.push('Differing fields:');
    for (const field of result.fields.filter((candidate) => !candidate.equal)) {
      lines.push(`  ${field.name}: base ${stable(field.base)} vs head ${stable(field.head)}`);
    }
  } else {
    lines.push(
      'Every field this contract compares matches, so the difference is elsewhere in the '
        + 'recipe -- its title, description, budget, timeout, or a field added since this '
        + 'check was written. The hash is what identifies the reviewed configuration, so '
        + 'this is still a refusal.',
    );
  }
  lines.push(
    'Land the capture fixture on both refs first, then make the behaviour change, so the '
      + 'instrument is held fixed while the code varies.',
  );
  return lines.join('\n');
}

/**
 * The environment half of the contract, checked AFTER both captures.
 *
 * Not knowable up front: it is read out of each `capture.json`'s recorded tool versions.
 * A mismatch here is reported rather than refused, and that reading of the contract is
 * deliberate. The issue lists the capture environment among the things to validate and
 * elsewhere says an incompatible recipe must FAIL, so refusing here is a defensible reading
 * too. What settles it is where the five recorded keys come from:
 *
 *   node        the process `runCaptureAtRef` spawned -- the caller's node, both sides
 *   playwright  resolved through the symlink `linkSharedModules` makes to the caller's
 *               node_modules -- the caller's install, both sides
 *   ffmpeg      the caller's PATH, both sides
 *   ffprobe     the caller's PATH, both sides
 *   producer    `{ chromium }`, the browser that same symlink resolves to -- one Chromium
 *
 * Every one of them is the CALLER's, by the same symlink that makes "one Playwright, one
 * Chromium, one FFmpeg produce both halves" true in the first place. In the supported path
 * the two sides therefore cannot differ, and a real two-ref run bears that out: all five
 * compare equal.
 *
 * So a reported difference does not mean two environments. It means the RECORDING CODE
 * changed between the refs -- a key added, renamed, or formatted differently by whichever
 * side is newer. Refusing would discard a perfectly good comparison over a manifest-schema
 * edit, which is the opposite of what the refusal clause is for. Both captures already
 * exist and are honest recordings; a loud caveat serves the reader, and `compare.json`
 * names the differing keys so they can see for themselves which it was.
 *
 * The caveat is not decoration: if a future capture ever sources a tool version from the
 * REF's own tree rather than the caller's, this stops being unreachable and the ruling
 * above has to be revisited.
 */
export function checkEnvironmentParity(baseManifest, headManifest) {
  const names = [...new Set([...Object.keys(baseManifest.tools ?? {}), ...Object.keys(headManifest.tools ?? {})])].sort();
  const tools = names.map((name) => {
    const baseValue = baseManifest.tools?.[name] ?? null;
    const headValue = headManifest.tools?.[name] ?? null;
    return { name, equal: stable(baseValue) === stable(headValue), base: baseValue, head: headValue };
  });
  return { equal: tools.every((tool) => tool.equal), tools, differing: tools.filter((t) => !t.equal).map((t) => t.name) };
}
