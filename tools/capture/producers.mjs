import { runGalleryMoment } from './gallery-adapter.mjs';

export function createProducerRegistry(entries) {
  const registry = new Map();
  for (const [kind, adapter] of entries) {
    if (registry.has(kind)) throw new Error(`duplicate capture producer registration '${kind}'`);
    if (typeof adapter !== 'function') throw new Error(`capture producer '${kind}' must be a function`);
    registry.set(kind, adapter);
  }
  return registry;
}

export const CAPTURE_PRODUCERS = createProducerRegistry([
  ['moment', runGalleryMoment],
]);

export function producerForKind(kind, registry = CAPTURE_PRODUCERS) {
  const adapter = registry.get(kind);
  if (adapter) return adapter;
  if (['moment', 'screen', 'flow', 'replay'].includes(kind)) {
    throw new Error(
      `capture producer '${kind}' is recognized but not implemented; registered producers: `
        + `${[...registry.keys()].join(', ') || 'none'}`,
    );
  }
  throw new Error(`unknown capture producer '${kind}'`);
}
