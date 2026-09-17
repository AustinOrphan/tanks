# Closure ownership of `createHud`

`npm run hud:closure` measures who owns what inside `createHud` in `src/game/hud.ts` (issue #767).
Issue #556 splits that function into pane modules. Each extraction has to state its shared-state
cost in measured terms, and this is the measurement.

```sh
npm run hud:closure                                   # Markdown tables for the working tree
npm run hud:closure -- --json                         # the same report as JSON
npm run hud:closure -- --strict                       # exit 1 on a write across a pane boundary
npm run hud:closure -- --strict --pane Customize      # only that pane's writes
```

The report names the commit it measured. It marks the report when `hud.ts` has uncommitted changes.

## What it counts

- **Owner.** Each direct statement of `createHud`'s body is one owner, and so is each property of
  the object the function returns. A `const`, a `let`, a function or a local type is named by its
  declaration. Any other statement, mostly `addEventListener` wiring, has no name.
- **Reference.** Every identifier inside an owner is resolved through the TypeScript checker to
  the owner that declares it. A local that shadows a closure name therefore resolves to the
  function it sits in, not to the closure name.
- **Write.** A reference is a write when it is assigned to (`=`, `+=` and the rest), updated
  (`++`, `--`), destructured into, or used as a `for...of` or `for...in` variable. Everything
  else is a read.
- **Pane.** Pane attribution is data, in [`attribution.mjs`](attribution.mjs):
  1. Exact-name corrections win.
  2. Otherwise the first pane whose noun appears in the lowercased name owns it.
  3. A statement with no name belongs to a pane when every pane-owned name it references is that
     pane's. Otherwise it is shared.

  The noun table and the first corrections come from the measured account on #556. Corrections
  added later say so in `source`, and every correction says `why`.

## The columns

| Column | Meaning |
| --- | --- |
| Owners, Owner lines | How many owners the pane has, and the sum of their line spans. Markup inside the one `el.innerHTML` template belongs to a single shared owner. |
| Members | Returned `Hud` members attributed to the pane. |
| Places | Runs of consecutive owners belonging to the pane: how scattered it is in the file. |
| Outside values | Owners outside the pane that the pane reads or writes. Local types are listed separately. |
| Shared names | The outside values that belong to no pane: what a pane module would have to be handed. |
| Cross-pane | Outside values owned by another pane. |
| Writes across | Outside bindings the pane assigns. `--strict` fails on any. |
| Inbound | Owners outside the pane that reference it: the tables and dispatchers a pane registers into. |
| Manifest entries | Mutation entries naming `hud.ts` whose `find` starts inside one of the pane's owners. A statement's range includes the comments above it. |
| Costed, Serial s | Of those entries, how many have a recorded cost in `tools/mutate/scope-costs.json`, and the sum of those costs. An unrecorded scope adds nothing. That is not the same as costing nothing. |

## Limits

- **The attribution is a heuristic.** A name can match a noun by accident. For example, "records"
  matches inside `recordStockLosses`. A name can also match no noun at all, like the `ach*`
  names. Read the per-pane lists before quoting a count, and correct the data rather than the
  number.
- **`--strict` also fails on a correction that names nothing in the closure.** Stale data is
  reported, never silently ignored.
- **It describes `createHud`. It does not decide the split.** The seam an extraction implements is
  issue #765's specification.
