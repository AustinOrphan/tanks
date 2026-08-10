/**
 * Trivial fixture, used ONLY by the mutation harness's own tests (see
 * ../orchestrate.test.ts). It exists so those tests can point the REAL harness at a
 * real file matching vitest's `tools/**\/*.test.ts` include glob, instead of faking
 * out git/fs/vitest -- proving the actual apply -> vitest subprocess -> restore
 * pipeline works, not just the orchestration logic around it.
 *
 * Never referenced by tools/mutate/manifest.json; it is not a real mutation target.
 */
export function greet(name) {
  return `hello ${name}`;
}
