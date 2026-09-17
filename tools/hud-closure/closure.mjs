/**
 * The closure-ownership analysis behind issue #556's account, checked in (issue #767).
 *
 * `createHud` is one function whose body holds most of the HUD. #556 splits it into pane modules,
 * and each extraction has to state its shared-state cost in measured terms. This module measures
 * it: which statements of the closure belong to which pane, what each pane reaches outside
 * itself, and who reaches in.
 *
 * WHY THE TYPE CHECKER AND NOT NAME MATCHING. A closure this size reuses short names in inner
 * scopes (`result`, `outcome`, `el`). A text search would count an inner `const el` as a
 * reference to the closure's `el`. Resolving each identifier to its declaration through the
 * checker counts only the real references, and the fixture test pins that.
 *
 * Nothing here launches a process or reads git: `analyze.mjs` is the command.
 */

import { SHARED } from './attribution.mjs';

/**
 * @typedef {'const' | 'let' | 'function' | 'type' | 'member' | 'statement'} OwnerKind
 * @typedef {{
 *   index: number, kind: OwnerKind, names: string[], start: number, end: number,
 *   pos: number, fullPos: number, endPos: number, node: any,
 *   reads: Set<Owner>, writes: Set<Owner>, pane: string,
 * }} Owner
 */

/**
 * A program over one file's real imports, using the checkout's own `tsconfig.json`.
 * @param {any} ts the `typescript` module @param {string} root @param {string} file absolute path
 */
export function programForFile(ts, root, file) {
  const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  const options = configPath
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, root).options
    : {};
  return ts.createProgram({ rootNames: [file], options: { ...options, noEmit: true } });
}

/**
 * A program over one in-memory source file, for fixtures. Imports are not resolved.
 * @param {any} ts @param {string} fileName @param {string} text
 */
export function programForSource(ts, fileName, text) {
  const options = { target: ts.ScriptTarget.ES2022, noEmit: true, noLib: true, types: [] };
  const host = ts.createCompilerHost(options);
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) => (name === fileName ? source : original(name, ...rest));
  host.fileExists = (name) => name === fileName;
  host.readFile = (name) => (name === fileName ? text : undefined);
  return ts.createProgram({ rootNames: [fileName], options, host });
}

/**
 * Every direct statement of `functionName`'s body as an owner, plus one owner per property of the
 * object literal it returns. References between owners are resolved through the checker.
 * @param {any} ts @param {any} program @param {string} fileName @param {string} functionName
 * @returns {{ owners: Owner[], span: { start: number, end: number, pos: number, endPos: number }, text: string }}
 */
export function collectOwners(ts, program, fileName, functionName) {
  const sf = program.getSourceFile(fileName);
  if (!sf) throw new Error(`${fileName} is not in the program`);
  const checker = program.getTypeChecker();
  const line = (/** @type {number} */ pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

  let fn = null;
  sf.forEachChild((/** @type {any} */ n) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === functionName && n.body) fn = n;
  });
  if (fn === null) throw new Error(`no function declaration named ${functionName} in ${fileName}`);
  const body = /** @type {any} */ (fn).body;

  /** @type {Owner[]} */
  const owners = [];
  /** @type {Map<any, Owner>} */
  const declared = new Map();
  const add = (/** @type {OwnerKind} */ kind, /** @type {string[]} */ names, /** @type {any} */ node) => {
    const pos = node.getStart(sf);
    /** @type {Owner} */
    const owner = {
      index: owners.length, kind, names, node, pos, fullPos: node.pos, endPos: node.end,
      start: line(pos), end: line(node.end),
      reads: new Set(), writes: new Set(), pane: SHARED,
    };
    owners.push(owner);
    return owner;
  };

  for (const st of body.statements) {
    if (ts.isVariableStatement(st)) {
      const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
      const owner = add(isConst ? 'const' : 'let', [], st);
      const walk = (/** @type {any} */ name) => {
        if (ts.isIdentifier(name)) owner.names.push(name.text);
        else for (const el of name.elements) if (ts.isBindingElement(el)) { declared.set(el, owner); walk(el.name); }
      };
      for (const d of st.declarationList.declarations) { declared.set(d, owner); walk(d.name); }
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      declared.set(st, add('function', [st.name.text], st));
    } else if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) {
      declared.set(st, add('type', [st.name.text], st));
    } else if (ts.isClassDeclaration(st) && st.name) {
      declared.set(st, add('const', [st.name.text], st));
    } else if (ts.isReturnStatement(st) && st.expression && ts.isObjectLiteralExpression(st.expression)) {
      for (const p of st.expression.properties) {
        const name = p.name ? ts.getTextOfNode(p.name) : '...';
        add('member', [name], p);
      }
    } else {
      add('statement', [], st);
    }
  }

  const ownerOf = (/** @type {any} */ symbol) => {
    if (!symbol) return null;
    const target = (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
    for (const d of target.declarations ?? []) {
      let n = d;
      while (n && n !== body && !declared.has(n)) n = n.parent;
      if (n && declared.has(n)) return declared.get(n) ?? null;
    }
    return null;
  };

  for (const owner of owners) {
    const visit = (/** @type {any} */ n) => {
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        let symbol = null;
        if (ts.isShorthandPropertyAssignment(p) && p.name === n) symbol = checker.getShorthandAssignmentValueSymbol(p);
        else if (!isPropertyName(ts, n)) symbol = checker.getSymbolAtLocation(n);
        const target = ownerOf(symbol);
        if (target && target !== owner) (isWriteTarget(ts, n) ? owner.writes : owner.reads).add(target);
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(owner.node, visit);
  }

  return {
    owners,
    span: { start: line(/** @type {any} */ (fn).getStart(sf)), end: line(/** @type {any} */ (fn).end), pos: body.pos, endPos: body.end },
    text: sf.text,
  };
}

/** A name in a property position, which is not a reference to a variable. */
function isPropertyName(/** @type {any} */ ts, /** @type {any} */ n) {
  const p = n.parent;
  return (ts.isPropertyAccessExpression(p) && p.name === n)
    || (ts.isPropertyAssignment(p) && p.name === n)
    || (ts.isMethodDeclaration(p) && p.name === n)
    || (ts.isPropertySignature(p) && p.name === n)
    || (ts.isGetAccessorDeclaration(p) && p.name === n)
    || (ts.isSetAccessorDeclaration(p) && p.name === n)
    || (ts.isQualifiedName(p) && p.right === n);
}

/**
 * Whether an identifier is assigned to: `x = `, `x += `, `x++`, `--x`, a destructuring target,
 * or the variable of a `for...of` / `for...in` loop.
 */
export function isWriteTarget(/** @type {any} */ ts, /** @type {any} */ id) {
  let node = id;
  let parent = node.parent;
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) {
    return true;
  }
  // Climb out of destructuring patterns written as expressions: `[a, b] = ...`, `({ a } = ...)`.
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isArrayLiteralExpression(parent)
    || ts.isSpreadElement(parent) || ts.isShorthandPropertyAssignment(parent)
    || (ts.isPropertyAssignment(parent) && parent.initializer === node)
    || ts.isObjectLiteralExpression(parent))) {
    node = parent;
    parent = parent.parent;
  }
  if (parent && ts.isBinaryExpression(parent) && parent.left === node) {
    const k = parent.operatorToken.kind;
    if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) {
      // A destructuring target only counts under plain `=`; `x += 1` never contains a pattern.
      return node === id || k === ts.SyntaxKind.EqualsToken;
    }
  }
  if (parent && (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) {
    return true;
  }
  return false;
}

/**
 * Put every owner in a pane: exact corrections, then nouns in order, then statements by what they
 * reference. Returns the corrections that name nothing in the closure.
 * @param {Owner[]} owners
 * @param {{ panes: readonly { pane: string, nouns: readonly string[] }[], corrections: readonly { pane: string, names: readonly string[], source?: string }[] }} attribution
 * @returns {{ staleCorrections: { name: string, pane: string, source?: string }[], crossPaneStatements: Owner[] }}
 */
export function attribute(owners, attribution) {
  /** @type {Map<string, { pane: string, source?: string }>} */
  const exact = new Map();
  for (const c of attribution.corrections) for (const name of c.names) exact.set(name, { pane: c.pane, source: c.source });
  const byName = (/** @type {string} */ name) => {
    const hit = exact.get(name);
    if (hit) return hit.pane;
    const lower = name.toLowerCase();
    for (const { pane, nouns } of attribution.panes) if (nouns.some((noun) => lower.includes(noun))) return pane;
    return SHARED;
  };

  const seen = new Set();
  for (const owner of owners) {
    if (owner.kind === 'statement') continue;
    for (const name of owner.names) seen.add(name);
    const panes = owner.names.map(byName);
    owner.pane = panes.find((p) => p !== SHARED) ?? SHARED;
  }
  /** @type {Owner[]} */
  const crossPaneStatements = [];
  for (const owner of owners) {
    if (owner.kind !== 'statement') continue;
    const referenced = new Set([...owner.reads, ...owner.writes].map((t) => t.pane).filter((p) => p !== SHARED));
    if (referenced.size === 1) owner.pane = [...referenced][0];
    else {
      owner.pane = SHARED;
      if (referenced.size > 1) crossPaneStatements.push(owner);
    }
  }

  const staleCorrections = [...exact.entries()]
    .filter(([name]) => !seen.has(name))
    .map(([name, { pane, source }]) => ({ name, pane, source }));
  return { staleCorrections, crossPaneStatements };
}

/** How an owner is named in a report: its first name, or where a nameless statement starts. */
export const ownerLabel = (/** @type {Owner} */ o) => o.names[0] ?? `statement@${o.start}`;

const byLabel = (/** @type {string} */ a, /** @type {string} */ b) => a.localeCompare(b);

/**
 * The per-pane report. `entries` are manifest entries already filtered to the analysed file;
 * `costOf` returns a scope's recorded seconds, or null when none is recorded.
 * @param {{ owners: Owner[], span: any, text: string }} collected
 * @param {readonly string[]} paneOrder
 * @param {{ entries?: readonly any[], costOf?: (tests: readonly string[]) => number | null }} [mutation]
 */
export function paneReport(collected, paneOrder, mutation = {}) {
  const { owners, span, text } = collected;
  const panes = [...paneOrder, SHARED];
  const kinds = /** @type {Record<OwnerKind, number>} */ ({ const: 0, let: 0, function: 0, member: 0, statement: 0, type: 0 });
  for (const o of owners) kinds[o.kind] += 1;

  const placement = placeEntries(owners, span, text, mutation.entries ?? []);
  const costOf = mutation.costOf ?? (() => null);

  const rows = panes.map((pane) => {
    const mine = owners.filter((o) => o.pane === pane);
    const set = new Set(mine);
    let places = 0;
    let inside = false;
    for (const o of owners) {
      const now = set.has(o);
      if (now && !inside) places += 1;
      inside = now;
    }
    /** @type {Set<Owner>} */
    const outside = new Set();
    /** @type {{ binding: string, kind: string, pane: string, writers: string[] }[]} */
    const writesAcross = [];
    for (const o of mine) {
      for (const t of o.reads) if (!set.has(t)) outside.add(t);
      for (const t of o.writes) if (!set.has(t)) outside.add(t);
    }
    for (const t of outside) {
      const writers = mine.filter((o) => o.writes.has(t)).map(ownerLabel).sort(byLabel);
      if (writers.length > 0) writesAcross.push({ binding: ownerLabel(t), kind: t.kind, pane: t.pane, writers });
    }
    const outsideValues = [...outside].filter((t) => t.kind !== 'type');
    const entries = placement.filter((p) => p.pane === pane);
    const costed = entries.map((p) => costOf(p.entry.tests ?? [])).filter((c) => c !== null && Number.isFinite(c));
    return {
      pane,
      owners: mine.length,
      lines: mine.reduce((sum, o) => sum + o.end - o.start + 1, 0),
      members: mine.filter((o) => o.kind === 'member').length,
      places,
      outsideValues: outsideValues.map(ownerLabel).sort(byLabel),
      outsideTypes: [...outside].filter((t) => t.kind === 'type').map(ownerLabel).sort(byLabel),
      sharedNames: outsideValues.filter((t) => t.pane === SHARED).map(ownerLabel).sort(byLabel),
      crossPane: outsideValues.filter((t) => t.pane !== SHARED)
        .map((t) => ({ name: ownerLabel(t), pane: t.pane })).sort((a, b) => byLabel(a.name, b.name)),
      writesAcross: writesAcross.sort((a, b) => byLabel(a.binding, b.binding)),
      inbound: owners.filter((o) => !set.has(o) && [...o.reads, ...o.writes].some((t) => set.has(t)))
        .map(ownerLabel).sort(byLabel),
      manifestEntries: entries.length,
      costedEntries: costed.length,
      serialSeconds: Math.round(costed.reduce((sum, c) => sum + /** @type {number} */ (c), 0) * 10) / 10,
    };
  });

  /** @type {Map<string, string[]>} */
  const sharedUse = new Map();
  for (const row of rows) {
    if (row.pane === SHARED) continue;
    for (const name of row.sharedNames) sharedUse.set(name, [...(sharedUse.get(name) ?? []), row.pane]);
  }

  return {
    span: { start: span.start, end: span.end },
    owners: owners.length,
    kinds,
    rows,
    sharedUse: [...sharedUse.entries()]
      .map(([name, usedBy]) => ({ name, usedBy }))
      .sort((a, b) => b.usedBy.length - a.usedBy.length || byLabel(a.name, b.name)),
    manifest: {
      total: placement.length,
      outsideFunction: placement.filter((p) => p.pane === null && p.where === 'outside').length,
      betweenOwners: placement.filter((p) => p.pane === null && p.where === 'between').length,
      notFound: placement.filter((p) => p.where === 'not-found').map((p) => p.entry.id),
    },
  };
}

/**
 * Which owner each entry's `find` STARTS inside, by character position. An `occurrence` picks the
 * nth match, as the mutation runner does.
 *
 * An owner's range starts at its FULL start, which includes the comments above it: a `find` that
 * begins with a statement's leading comment belongs to that statement.
 * @param {Owner[]} owners @param {{ pos: number, endPos: number }} span @param {string} text @param {readonly any[]} entries
 */
export function placeEntries(owners, span, text, entries) {
  return entries.map((entry) => {
    let at = -1;
    let from = 0;
    const wanted = entry.occurrence ?? 1;
    for (let i = 0; i < wanted; i += 1) {
      at = text.indexOf(entry.find, from);
      if (at === -1) break;
      from = at + entry.find.length;
    }
    if (at === -1) return { entry, pane: null, where: 'not-found' };
    if (at < span.pos || at >= span.endPos) return { entry, pane: null, where: 'outside' };
    const owner = owners.find((o) => at >= o.fullPos && at < o.endPos);
    if (!owner) return { entry, pane: null, where: 'between' };
    return { entry, pane: owner.pane, where: 'owner' };
  });
}

/**
 * What `--strict` fails on: a write across a pane boundary, and a correction naming nothing.
 * `pane` limits the check to one pane's writes.
 * @param {ReturnType<typeof paneReport>} report @param {{ name: string, pane: string }[]} staleCorrections @param {string | null} [pane]
 * @returns {string[]}
 */
export function strictFailures(report, staleCorrections, pane = null) {
  const failures = [];
  for (const row of report.rows) {
    if (row.pane === SHARED || (pane !== null && row.pane !== pane)) continue;
    for (const w of row.writesAcross) {
      failures.push(`${row.pane} writes ${w.binding} (${w.kind}, ${w.pane}) from ${w.writers.join(', ')}`);
    }
  }
  for (const c of staleCorrections) failures.push(`correction names ${c.name} (${c.pane}), which is not in the closure`);
  if (pane !== null && !report.rows.some((r) => r.pane === pane)) failures.push(`no pane named ${pane}`);
  return failures;
}

const cell = (/** @type {readonly string[]} */ list) => (list.length === 0 ? 'none' : list.map((s) => `\`${s}\``).join(', '));

/**
 * The report as Markdown, in the shape the #556 account used.
 * @param {ReturnType<typeof paneReport>} report
 * @param {{ label: string, file: string, staleCorrections: { name: string, pane: string }[], crossPaneStatements: Owner[] }} context
 */
export function formatMarkdown(report, context) {
  const out = [];
  out.push(`# Closure ownership: \`${context.file}\` at ${context.label}`);
  out.push('');
  const k = report.kinds;
  out.push(`\`createHud\` spans lines ${report.span.start}-${report.span.end} and has **${report.owners} owners**: `
    + `${k.const} \`const\`, ${k.let} \`let\`, ${k.function} functions, ${k.member} returned members, `
    + `${k.statement} other statements, ${k.type} local types.`);
  out.push('');
  out.push('| Pane | Owners | Owner lines | Members | Places | Outside values | Shared names | Cross-pane | Writes across | Inbound | Manifest entries | Costed | Serial s |');
  out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of report.rows) {
    if (r.pane === SHARED) {
      out.push(`| shared | ${r.owners} | ${r.lines} | ${r.members} | ${r.places} | | | | | | ${r.manifestEntries} | ${r.costedEntries} | ${r.serialSeconds} |`);
    } else {
      out.push(`| ${r.pane} | ${r.owners} | ${r.lines} | ${r.members} | ${r.places} | ${r.outsideValues.length} | ${r.sharedNames.length} | ${r.crossPane.length} | ${r.writesAcross.length} | ${r.inbound.length} | ${r.manifestEntries} | ${r.costedEntries} | ${r.serialSeconds} |`);
    }
  }
  out.push('');
  const m = report.manifest;
  out.push(`Manifest entries naming the file: ${m.total}. Of those, ${m.outsideFunction} start outside \`createHud\`, `
    + `${m.betweenOwners} start between owners (in a comment or blank line), and ${m.notFound.length} were not found.`);
  out.push('"Costed" counts entries whose exact test scope has a recorded cost; "Serial s" sums those costs. An entry with no recorded cost adds nothing, which is not the same as costing nothing.');
  out.push('');
  out.push('## Shared names each pane uses');
  out.push('');
  out.push('| Name | Used by |');
  out.push('| --- | --- |');
  for (const s of report.sharedUse) out.push(`| \`${s.name}\` | ${s.usedBy.join(', ')} |`);
  out.push('');
  out.push('## Cross-pane references');
  out.push('');
  const cross = report.rows.filter((r) => r.pane !== SHARED && r.crossPane.length > 0);
  if (cross.length === 0) out.push('None.');
  for (const r of cross) {
    for (const c of r.crossPane) out.push(`- ${r.pane} uses \`${c.name}\`, owned by ${c.pane}.`);
  }
  if (context.crossPaneStatements.length > 0) {
    out.push(`- ${context.crossPaneStatements.length} statement(s) reference two or more panes and count as shared: `
      + context.crossPaneStatements.map((o) => `line ${o.start}`).join(', ') + '.');
  }
  out.push('');
  out.push('## Writes across a pane boundary');
  out.push('');
  const writes = report.rows.flatMap((r) => (r.pane === SHARED ? [] : r.writesAcross.map((w) => ({ writerPane: r.pane, ...w }))));
  if (writes.length === 0) out.push('None.');
  for (const w of writes) out.push(`- ${w.writerPane}: ${cell(w.writers)} write \`${w.binding}\` (${w.kind}, owned by ${w.pane}).`);
  out.push('');
  out.push('## Per pane');
  for (const r of report.rows) {
    if (r.pane === SHARED) continue;
    out.push('');
    out.push(`### ${r.pane}`);
    out.push('');
    out.push(`- Outside values (${r.outsideValues.length}): ${cell(r.outsideValues)}`);
    out.push(`- Outside types (${r.outsideTypes.length}): ${cell(r.outsideTypes)}`);
    out.push(`- Inbound (${r.inbound.length}): ${cell(r.inbound)}`);
  }
  if (context.staleCorrections.length > 0) {
    out.push('');
    out.push('## Stale corrections');
    out.push('');
    for (const c of context.staleCorrections) out.push(`- \`${c.name}\` (${c.pane}) names nothing in the closure.`);
  }
  out.push('');
  return out.join('\n');
}
