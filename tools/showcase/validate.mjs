/**
 * The showcase publication rules (issue #1062; the limits are #258's publication policy). A GIF
 * reaches the repository's documentation only as a clip in `tools/showcase/manifest.json`, at a
 * tracked path under `docs/media/showcase/`, within these limits.
 *
 * Pure: every input is passed in, and nothing here reads the file system, git or the network.
 * `check.mjs` gathers the inputs. The rules live in this module rather than in the manifest
 * because the manifest is read with `readFileSync`, and the mutation harness relates a test to a
 * file only through import edges, so a rule only the JSON carried could never be mutation-tested.
 */
import path from 'node:path';
import { MEDIA_VALIDATION_TOLERANCES } from '../capture/media.mjs';

export const SHOWCASE_DIR = 'docs/media/showcase/';

/** The document each `placement` value shows its clip in. */
export const PLACEMENT_DOCUMENTS = Object.freeze({ readme: 'README.md', docs: 'docs/showcase.md' });

export const SHOWCASE_LIMITS = Object.freeze({
  clips: 4,
  readmeClips: 1,
  widthPixels: 640,
  framesPerSecond: 15,
  durationSeconds: 8,
  clipBytes: 2_097_152, // 2 MiB
  setBytes: 6_291_456, // 6 MiB
  altCharacters: 500, // the capture recipe schema's `altText` bound, measured the same way
});

const MANIFEST_KEYS = ['version', 'clips'];

// Each clip key and the type its value must have. Publication metadata only: the viewport, seed,
// timing, flags and encoder settings belong to the capture recipe the clip names.
const CLIP_FIELDS = {
  id: 'string',
  recipe: 'string',
  output: 'string',
  placement: 'placement',
  caption: 'string',
  alt: 'string',
  maxBytes: 'positive integer',
  order: 'integer',
};

const FIELD_TYPES = {
  string: (value) => typeof value === 'string',
  placement: (value) => Object.hasOwn(PLACEMENT_DOCUMENTS, value),
  'positive integer': (value) => Number.isInteger(value) && value > 0,
  integer: (value) => Number.isInteger(value),
};

// `docs/media/showcase/<name>.gif`, where a name is lowercase words joined by hyphens. That
// excludes a `..` segment, any other directory and an absolute URL by construction.
const OUTPUT_FORM = /^docs\/media\/showcase\/[a-z0-9]+(?:-[a-z0-9]+)*\.gif$/;

// A GIF delay is a whole number of centiseconds, so 15 fps (6.67 cs a frame) is not exactly
// representable. The displayed-timing rules allow one quantum, the capture pipeline's own GIF
// tolerance, and compare in integer centiseconds so no float rounding decides a boundary.
const GIF_QUANTUM_CENTISECONDS = MEDIA_VALIDATION_TOLERANCES.gifCentiseconds;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A field's value when it has the type its key requires, otherwise null (rule 1 reports it). */
function field(clip, key) {
  return Object.hasOwn(clip, key) && FIELD_TYPES[CLIP_FIELDS[key]](clip[key]) ? clip[key] : null;
}

function label(clip, index) {
  return typeof clip?.id === 'string' && clip.id !== '' ? `clip '${clip.id}'` : `clip ${index}`;
}

const blank = (text) => text.trim() === '';

/** Rule 1: the manifest's and every clip's key set, field types and version. */
function shapeProblems(manifest) {
  if (!isPlainObject(manifest)) return { messages: ['manifest: must be a JSON object'], clips: [] };
  const messages = [];
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.includes(key)) messages.push(`manifest: unknown key '${key}'`);
  }
  for (const key of MANIFEST_KEYS) {
    if (!Object.hasOwn(manifest, key)) messages.push(`manifest: missing key '${key}'`);
  }
  if (Object.hasOwn(manifest, 'version') && manifest.version !== 1) {
    messages.push(`manifest: version must be 1, got ${JSON.stringify(manifest.version)}`);
  }
  if (!Object.hasOwn(manifest, 'clips')) return { messages, clips: [] };
  if (!Array.isArray(manifest.clips)) {
    messages.push('manifest: clips must be an array');
    return { messages, clips: [] };
  }
  const clips = [];
  manifest.clips.forEach((clip, index) => {
    if (!isPlainObject(clip)) {
      messages.push(`clip ${index}: must be a JSON object`);
      return;
    }
    const name = label(clip, index);
    for (const key of Object.keys(clip)) {
      if (!Object.hasOwn(CLIP_FIELDS, key)) messages.push(`${name}: unknown key '${key}'`);
    }
    for (const [key, type] of Object.entries(CLIP_FIELDS)) {
      if (!Object.hasOwn(clip, key)) {
        messages.push(`${name}: missing key '${key}'`);
      } else if (!FIELD_TYPES[type](clip[key])) {
        const expected = type === 'placement' ? "'readme' or 'docs'" : `a ${type}`;
        messages.push(`${name}: ${key} must be ${expected}, got ${JSON.stringify(clip[key])}`);
      }
    }
    clips.push({ clip, name });
  });
  return { messages, clips };
}

/** The measured facts for a tracked output, or null when there are none to judge. */
function factsFor(media, output) {
  const facts = Object.hasOwn(media, output) ? media[output] : null;
  return isPlainObject(facts) && facts.error === undefined ? facts : null;
}

/** Bytes of every distinct, tracked, measured manifest output: the set rule 13 limits. */
function setBytes(clips, trackedSet, media) {
  const outputs = new Set(clips.map(({ clip }) => field(clip, 'output')).filter(Boolean));
  let total = 0;
  for (const output of outputs) {
    const facts = trackedSet.has(output) ? factsFor(media, output) : null;
    if (facts !== null) total += facts.bytes;
  }
  return total;
}

/** Rules 2 to 13: uniqueness, the registry, the output path, text, counts and each clip's file. */
function clipProblems(clips, { recipeArtifacts, trackedSet, media }) {
  const messages = [];

  // Rule 2.
  for (const key of ['id', 'output', 'order']) {
    const uses = new Map();
    for (const { clip } of clips) {
      const value = field(clip, key);
      if (value !== null) uses.set(value, (uses.get(value) ?? 0) + 1);
    }
    for (const [value, count] of uses) {
      if (count > 1) messages.push(`${key} ${JSON.stringify(value)} is shared by ${count} clips`);
    }
  }

  // Rule 6.
  if (clips.length > SHOWCASE_LIMITS.clips) {
    messages.push(`manifest: ${clips.length} clips; at most ${SHOWCASE_LIMITS.clips}`);
  }
  const readmeClips = clips.filter(({ clip }) => field(clip, 'placement') === 'readme').length;
  if (readmeClips > SHOWCASE_LIMITS.readmeClips) {
    messages.push(
      `manifest: ${readmeClips} clips are placed in README.md; at most ${SHOWCASE_LIMITS.readmeClips}`,
    );
  }

  for (const { clip, name } of clips) {
    const recipe = field(clip, 'recipe');
    const output = field(clip, 'output');
    const caption = field(clip, 'caption');
    const alt = field(clip, 'alt');
    const maxBytes = field(clip, 'maxBytes');

    // Rule 3.
    if (recipe !== null) {
      const formats = recipeArtifacts(recipe);
      if (formats === null) {
        messages.push(`${name}: recipe '${recipe}' is not in the capture registry`);
      } else if (!formats.includes('gif')) {
        messages.push(
          `${name}: recipe '${recipe}' declares no gif artifact (it declares ${formats.join(', ')})`,
        );
      }
    }

    // Rule 4.
    if (output !== null && !OUTPUT_FORM.test(output)) {
      messages.push(`${name}: output '${output}' is not of the form ${SHOWCASE_DIR}<name>.gif`);
    }

    // Rule 5.
    if (caption !== null && blank(caption)) messages.push(`${name}: caption is empty`);
    if (alt !== null && blank(alt)) messages.push(`${name}: alt is empty`);
    if (alt !== null && alt.length > SHOWCASE_LIMITS.altCharacters) {
      messages.push(
        `${name}: alt is ${alt.length} characters; at most ${SHOWCASE_LIMITS.altCharacters}`,
      );
    }
    if (alt !== null && caption !== null && !blank(alt) && alt.trim() === caption.trim()) {
      messages.push(`${name}: alt repeats the caption; it must describe the clip instead`);
    }

    // Rule 7.
    if (maxBytes !== null && maxBytes > SHOWCASE_LIMITS.clipBytes) {
      messages.push(`${name}: maxBytes ${maxBytes} exceeds ${SHOWCASE_LIMITS.clipBytes}`);
    }

    // Rule 8, then 9 to 12 on the measured facts it found.
    if (output === null) continue;
    if (!trackedSet.has(output)) {
      messages.push(`${name}: ${output} is not a tracked file`);
      continue;
    }
    const facts = factsFor(media, output);
    if (facts === null) {
      const reason = media[output]?.error ?? 'no measured facts';
      messages.push(`${name}: ${output} cannot be measured: ${reason}`);
      continue;
    }
    if (maxBytes !== null && facts.bytes > maxBytes) {
      messages.push(`${name}: ${output} is ${facts.bytes} bytes; its maxBytes is ${maxBytes}`);
    }
    if (facts.width > SHOWCASE_LIMITS.widthPixels) {
      messages.push(
        `${name}: ${output} is ${facts.width} px wide; at most ${SHOWCASE_LIMITS.widthPixels}`,
      );
    }
    // displayed >= frames / fps - quantum, in centiseconds and multiplied through by fps.
    const fps = SHOWCASE_LIMITS.framesPerSecond;
    if (facts.durationCentiseconds * fps < facts.frameCount * 100 - GIF_QUANTUM_CENTISECONDS * fps) {
      messages.push(
        `${name}: ${output} shows ${facts.frameCount} frames in `
          + `${facts.durationCentiseconds / 100} s, faster than ${fps} fps`,
      );
    }
    const longest = SHOWCASE_LIMITS.durationSeconds * 100 + GIF_QUANTUM_CENTISECONDS;
    if (facts.durationCentiseconds > longest) {
      messages.push(
        `${name}: ${output} displays for ${facts.durationCentiseconds / 100} s; `
          + `at most ${SHOWCASE_LIMITS.durationSeconds} s`,
      );
    }
    if (facts.loopCount !== 0) {
      const loops = facts.loopCount === null ? 'no loop extension' : `loop count ${facts.loopCount}`;
      messages.push(`${name}: ${output} has ${loops}; it must loop forever (loop count 0)`);
    }
  }

  // Rule 13.
  const bytes = setBytes(clips, trackedSet, media);
  if (bytes > SHOWCASE_LIMITS.setBytes) {
    messages.push(`showcase set: ${bytes} bytes; at most ${SHOWCASE_LIMITS.setBytes}`);
  }

  // Rule 14: a stray MP4, a PNG frame or a second GIF in the directory fails.
  const outputs = new Set(clips.map(({ clip }) => field(clip, 'output')).filter(Boolean));
  for (const file of trackedSet) {
    if (file.startsWith(SHOWCASE_DIR) && !outputs.has(file)) {
      messages.push(`${file} is tracked under ${SHOWCASE_DIR} but is not a manifest output`);
    }
  }
  return messages;
}

// Markdown, as CommonMark reads it: image text may hold backslash escapes and one level of
// balanced brackets, a link label escapes but no brackets, and a destination one level of
// balanced parentheses. A link definition may sit in block quotes and list items, at any indent,
// with its destination on the next line.
const IMAGE_TEXT = String.raw`!\[((?:\\.|[^\[\]\\]|\[(?:\\.|[^\[\]\\])*\])*)\]`;
const LABEL_CHARACTER = String.raw`(?:\\.|[^\[\]\\])`;
const DESTINATION = String.raw`(?:<([^>]*)>|((?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+))`;
const INLINE_IMAGE = new RegExp(String.raw`${IMAGE_TEXT}\(\s*${DESTINATION}[^)]*\)`, 'g');
const REFERENCE_IMAGE = new RegExp(String.raw`${IMAGE_TEXT}(?:\[(${LABEL_CHARACTER}*)\])?(?!\()`, 'g');
const DEFINITION = new RegExp(
  String.raw`^(?:[ \t>]|[-+*][ \t]|\d{1,9}[.)][ \t])*\[(${LABEL_CHARACTER}+)\]:\s*(?:<([^>]*)>|(\S+))`,
  'gm',
);

// HTML, as a browser reads it: a quote opens a value only after `=`, and a tag ends at the first
// `>` outside a quoted value. Reading a tag's attributes in order consumes each value whole, so
// text inside one value never reads as another attribute.
const IMG_TAG = /<img\b(?:[^>="']|=\s*(?:"[^"]*"|'[^']*')|=(?!\s*["'])|["'])*>/gi;
const ATTRIBUTE = /([^\s/>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

/** An `<img>` tag's attributes by lower-case name; the first of a repeated name wins, as in HTML. */
function attributes(tag) {
  const found = new Map();
  for (const match of tag.slice('<img'.length).matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (!found.has(name)) found.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return found;
}

const linkLabel = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase();

/** Image text as GitHub shows it in the alt attribute: `\*` is `*`. */
const unescapeMarkdown = (text) => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/**
 * Every image reference in a Markdown document whose target is a GIF: inline images, reference
 * images (full, collapsed and shortcut, resolved through their definitions) and `<img>` tags. A
 * reference inside a code block or an HTML comment is counted too, though GitHub shows it as
 * text. Image text nested deeper than the patterns above, or holding a bracket inside a code
 * span, is not recognised.
 */
function gifReferences(text) {
  const definitions = new Map();
  for (const match of text.matchAll(DEFINITION)) {
    const key = linkLabel(match[1]);
    if (!definitions.has(key)) definitions.set(key, match[2] ?? match[3]);
  }
  const found = [];
  for (const match of text.matchAll(INLINE_IMAGE)) {
    found.push({ alt: unescapeMarkdown(match[1]), target: match[2] ?? match[3] });
  }
  for (const match of text.matchAll(REFERENCE_IMAGE)) {
    const target = definitions.get(linkLabel(match[2] || match[1]));
    if (target !== undefined) found.push({ alt: unescapeMarkdown(match[1]), target });
  }
  for (const [tag] of text.matchAll(IMG_TAG)) {
    const tagAttributes = attributes(tag);
    const target = tagAttributes.get('src');
    if (target !== undefined) found.push({ alt: tagAttributes.get('alt') ?? null, target });
  }
  return found.filter(({ target }) => /\.gif$/i.test(target.replace(/[?#].*$/, '')));
}

/**
 * The repository path a reference names, resolved against its document's directory the way a
 * Markdown renderer does, or null for a target that is not a relative path: a URL with a scheme
 * (`https:`, `data:`), a protocol-relative `//host` or a root-relative `/path`.
 */
function resolveReference(document, target) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(target)) return null;
  return path.posix.normalize(path.posix.join(path.posix.dirname(document), target));
}

/** Rule 15: the GIF references in README.md and docs/showcase.md. */
function documentProblems(clips, documents) {
  const messages = [];
  const clipsByOutput = new Map();
  for (const { clip, name } of clips) {
    const output = field(clip, 'output');
    if (output === null) continue;
    const key = path.posix.normalize(output);
    clipsByOutput.set(key, [...(clipsByOutput.get(key) ?? []), { clip, name }]);
  }

  const resolved = {};
  for (const document of Object.values(PLACEMENT_DOCUMENTS)) {
    resolved[document] = gifReferences(documents[document]).map((reference) => ({
      ...reference,
      path: resolveReference(document, reference.target),
    }));
    for (const reference of resolved[document]) {
      const owners = (reference.path === null ? null : clipsByOutput.get(reference.path)) ?? [];
      if (owners.length === 0) {
        messages.push(
          `${document}: GIF reference '${reference.target}' is not a relative path to a `
            + 'manifest output',
        );
        continue;
      }
      const alts = owners.map(({ clip }) => field(clip, 'alt'));
      if (!alts.includes(reference.alt)) {
        messages.push(
          `${document}: GIF reference '${reference.target}' has alt text `
            + `${JSON.stringify(reference.alt)}; the manifest alt is `
            + alts.map((alt) => JSON.stringify(alt)).join(' or '),
        );
      }
    }
  }

  // A manifest that already places too many clips in the README has been reported by rule 6;
  // following it puts as many references there, so the count is not reported a second time.
  const readmeClips = clips.filter(({ clip }) => field(clip, 'placement') === 'readme').length;
  const readmeReferences = resolved[PLACEMENT_DOCUMENTS.readme].length;
  if (readmeClips <= SHOWCASE_LIMITS.readmeClips && readmeReferences > SHOWCASE_LIMITS.readmeClips) {
    messages.push(
      `${PLACEMENT_DOCUMENTS.readme}: ${readmeReferences} GIF references; `
        + `at most ${SHOWCASE_LIMITS.readmeClips}`,
    );
  }

  for (const { clip, name } of clips) {
    const output = field(clip, 'output');
    const placement = field(clip, 'placement');
    if (output === null || placement === null) continue;
    const document = PLACEMENT_DOCUMENTS[placement];
    const target = path.posix.normalize(output);
    if (!resolved[document].some((reference) => reference.path === target)) {
      messages.push(`${name}: ${output} is not referenced from ${document}`);
    }
  }
  return messages;
}

/**
 * Every broken rule, one message per violation; an empty array means the showcase conforms.
 *
 * - `manifest`: the parsed `tools/showcase/manifest.json`.
 * - `recipeArtifacts(id)`: the artifact formats the capture registry declares for a recipe, or
 *   null when the registry has no such recipe.
 * - `tracked`: every path `git ls-files` lists.
 * - `media`: keyed by output path, each tracked output's `gifFacts`, or `{ error }` when its bytes
 *   could not be measured.
 * - `documents`: the text of README.md and docs/showcase.md, keyed by those paths.
 *
 * A field with the wrong type is reported once, by rule 1, and skipped by the rules that read it.
 */
export function validateShowcase({ manifest, recipeArtifacts, tracked, media, documents }) {
  const shape = shapeProblems(manifest);
  const context = { recipeArtifacts, trackedSet: new Set(tracked), media };
  return [
    ...shape.messages,
    ...clipProblems(shape.clips, context),
    ...documentProblems(shape.clips, documents),
  ];
}

/**
 * What a check covered: the clips, the tracked files under `docs/media/showcase/` and the set's
 * bytes.
 */
export function showcasePopulation({ manifest, tracked, media }) {
  const { clips } = shapeProblems(manifest);
  return {
    clips: Array.isArray(manifest?.clips) ? manifest.clips.length : 0,
    trackedFiles: tracked.filter((file) => file.startsWith(SHOWCASE_DIR)).length,
    bytes: setBytes(clips, new Set(tracked), media),
  };
}
