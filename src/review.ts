// The review model: parse an OpenAPI / AsyncAPI / Arazzo document, resolve its
// internal $ref pointers (cycle-safe) so a review shows the *resolved* shape, and
// diff an old document against a new one into a categorized, breaking-flagged list
// of human-readable changes. A Markdown exporter turns that list into something a
// reviewer can paste into a pull request. Pure data — no DOM in this module.
import { parse as parseYaml } from 'yaml';

// ---- types ------------------------------------------------------------------
export type Kind = 'added' | 'removed' | 'changed';
export type Area =
  | 'Paths/Operations'
  | 'Parameters'
  | 'Request/Response bodies'
  | 'Schemas/Models'
  | 'Security';

export interface Change {
  area: Area;
  kind: Kind;
  breaking: boolean;
  path: string;      // a JSON-pointer-ish location in the spec
  summary: string;   // plain-English one-liner
  detail?: string;   // optional extra context
}

// A marker left in place of a $ref that closes a cycle, so resolution terminates.
export interface Circular { $circular: string; }
export interface Unresolved { $unresolved: string; }

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// ---- parse ------------------------------------------------------------------
export function parseSpec(text: string): any {
  const t = (text ?? '').trim();
  if (!t) throw new Error('Empty document.');
  let doc: any;
  try { doc = JSON.parse(t); }
  catch { doc = parseYaml(t); }
  if (doc == null || typeof doc !== 'object') throw new Error('Document is not an object.');
  return doc;
}

// ---- $ref resolution (internal, cycle-safe) ---------------------------------
function pointer(root: any, ref: string): any {
  // ref looks like "#/components/schemas/Order"
  const hash = ref.indexOf('#');
  const frag = hash >= 0 ? ref.slice(hash + 1) : ref;
  if (frag === '' || frag === '/') return root;
  const parts = frag.replace(/^\//, '').split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// Resolve every internal `#/...` $ref against the document root. Nested refs are
// resolved recursively; a ref that reappears on the active chain is rendered as a
// stable `{ $circular }` marker so cyclic schemas don't loop forever. External
// refs (anything not starting with `#`) are left untouched.
export function resolveRefs(doc: any): any {
  const root = doc;
  function res(node: any, stack: string[]): any {
    if (Array.isArray(node)) return node.map((n) => res(n, stack));
    if (node && typeof node === 'object') {
      const ref = (node as any).$ref;
      if (typeof ref === 'string' && ref.startsWith('#')) {
        if (stack.includes(ref)) return { $circular: ref } as Circular;
        const target = pointer(root, ref);
        if (target === undefined) return { $unresolved: ref } as Unresolved;
        const resolved = res(target, [...stack, ref]);
        // Preserve any sibling keys alongside the $ref (rare, but valid).
        const siblings = Object.keys(node).filter((k) => k !== '$ref');
        if (siblings.length && resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
          const out: any = { ...resolved };
          for (const k of siblings) out[k] = res((node as any)[k], stack);
          return out;
        }
        return resolved;
      }
      const out: any = {};
      for (const k of Object.keys(node)) out[k] = res((node as any)[k], stack);
      return out;
    }
    return node;
  }
  return res(doc, []);
}

// ---- small helpers ----------------------------------------------------------
const isObj = (v: any): boolean => !!v && typeof v === 'object' && !Array.isArray(v);
const isCircular = (v: any): boolean => isObj(v) && ('$circular' in v || '$unresolved' in v);
const code = (s: string) => '`' + s + '`';

function typeLabel(schema: any): string {
  if (!isObj(schema)) return 'any';
  const t = schema.type;
  if (Array.isArray(t)) return t.join('|');
  if (typeof t === 'string') return t;
  if (schema.enum) return 'enum';
  if (schema.$circular || schema.$unresolved) return 'ref';
  if (schema.properties || schema.additionalProperties) return 'object';
  return 'any';
}

function ops(pathItem: any): [string, any][] {
  if (!isObj(pathItem)) return [];
  return METHODS.filter((m) => isObj(pathItem[m])).map((m) => [m, pathItem[m]] as [string, any]);
}
const opLabel = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

// ---- schema diff (recursive) ------------------------------------------------
// Compares two resolved schema objects and emits Change rows into `out`. Used for
// component models, request bodies, and response bodies. `label` is the human name
// of the thing being compared ("Model Order", "POST /orders request body").
function diffSchema(oldS: any, newS: any, area: Area, label: string, ptr: string, out: Change[], depth = 0): void {
  if (depth > 8) return;
  if (!isObj(oldS) || !isObj(newS)) return;
  if (isCircular(oldS) || isCircular(newS)) return;

  // type narrowing / change
  const ot = typeLabel(oldS), nt = typeLabel(newS);
  if (oldS.type != null && newS.type != null && ot !== nt) {
    out.push({
      area, kind: 'changed', breaking: true, path: ptr,
      summary: `${label} type changed from ${code(ot)} to ${code(nt)}`,
    });
  }

  // enum values removed
  if (Array.isArray(oldS.enum) && Array.isArray(newS.enum)) {
    const removed = oldS.enum.filter((v: any) => !newS.enum.includes(v));
    const added = newS.enum.filter((v: any) => !oldS.enum.includes(v));
    if (removed.length) out.push({
      area, kind: 'changed', breaking: true, path: ptr,
      summary: `${label} no longer allows value${removed.length > 1 ? 's' : ''} ${removed.map((v: any) => code(String(v))).join(', ')}`,
    });
    if (added.length) out.push({
      area, kind: 'changed', breaking: false, path: ptr,
      summary: `${label} now also allows value${added.length > 1 ? 's' : ''} ${added.map((v: any) => code(String(v))).join(', ')}`,
    });
  }

  // properties
  const oldProps = isObj(oldS.properties) ? oldS.properties : {};
  const newProps = isObj(newS.properties) ? newS.properties : {};
  const oldReq: string[] = Array.isArray(oldS.required) ? oldS.required : [];
  const newReq: string[] = Array.isArray(newS.required) ? newS.required : [];
  const names = new Set([...Object.keys(oldProps), ...Object.keys(newProps)]);

  for (const name of names) {
    const inOld = name in oldProps, inNew = name in newProps;
    const pptr = `${ptr}/properties/${name}`;
    if (inOld && !inNew) {
      const wasReq = oldReq.includes(name);
      out.push({
        area, kind: 'removed', breaking: wasReq, path: pptr,
        summary: `${label} removed ${wasReq ? 'required ' : ''}property ${code(name)}`,
      });
    } else if (!inOld && inNew) {
      const nowReq = newReq.includes(name);
      out.push({
        area, kind: 'added', breaking: nowReq, path: pptr,
        summary: `${label} ${nowReq ? 'now requires new property' : 'adds optional property'} ${code(name)}`,
      });
    } else {
      // present in both — did requiredness tighten?
      if (!oldReq.includes(name) && newReq.includes(name)) {
        out.push({
          area, kind: 'changed', breaking: true, path: pptr,
          summary: `${label} property ${code(name)} is now required`,
        });
      } else if (oldReq.includes(name) && !newReq.includes(name)) {
        out.push({
          area, kind: 'changed', breaking: false, path: pptr,
          summary: `${label} property ${code(name)} is no longer required`,
        });
      }
      diffSchema(oldProps[name], newProps[name], area, `${label} property ${code(name)}`, pptr, out, depth + 1);
    }
  }

  // array item schemas
  if (isObj(oldS.items) && isObj(newS.items)) {
    diffSchema(oldS.items, newS.items, area, `${label} items`, `${ptr}/items`, out, depth + 1);
  }
}

// ---- parameters -------------------------------------------------------------
function paramKey(p: any): string { return `${p?.name ?? '?'} ${p?.in ?? 'query'}`; }

function diffParams(oldOp: any, newOp: any, path: string, method: string, out: Change[]): void {
  const oldParams: any[] = Array.isArray(oldOp?.parameters) ? oldOp.parameters : [];
  const newParams: any[] = Array.isArray(newOp?.parameters) ? newOp.parameters : [];
  const oldMap = new Map(oldParams.map((p) => [paramKey(p), p]));
  const newMap = new Map(newParams.map((p) => [paramKey(p), p]));
  const label = opLabel(method, path);
  const ptr = `/paths/${path}/${method}/parameters`;

  for (const [k, p] of newMap) {
    if (!oldMap.has(k)) {
      const req = !!p.required;
      out.push({
        area: 'Parameters', kind: 'added', breaking: req, path: ptr,
        summary: `${label} ${req ? 'now requires' : 'adds optional'} parameter ${code(p.name)} (${p.in ?? 'query'})`,
      });
    }
  }
  for (const [k, p] of oldMap) {
    if (!newMap.has(k)) {
      out.push({
        area: 'Parameters', kind: 'removed', breaking: false, path: ptr,
        summary: `${label} no longer accepts parameter ${code(p.name)} (${p.in ?? 'query'})`,
      });
    } else {
      const np = newMap.get(k);
      if (!p.required && np.required) out.push({
        area: 'Parameters', kind: 'changed', breaking: true, path: ptr,
        summary: `${label} parameter ${code(p.name)} is now required`,
      });
      else if (p.required && !np.required) out.push({
        area: 'Parameters', kind: 'changed', breaking: false, path: ptr,
        summary: `${label} parameter ${code(p.name)} is no longer required`,
      });
      if (isObj(p.schema) && isObj(np.schema)) {
        diffSchema(p.schema, np.schema, 'Parameters', `${label} parameter ${code(p.name)}`, `${ptr}/${p.name}/schema`, out);
      }
    }
  }
}

// ---- request / response bodies ---------------------------------------------
function firstJsonSchema(body: any): any {
  const content = body?.content;
  if (!isObj(content)) return undefined;
  const key = content['application/json'] ? 'application/json'
    : Object.keys(content).find((k) => /json/.test(k)) ?? Object.keys(content)[0];
  return key ? content[key]?.schema : undefined;
}

function diffBodies(oldOp: any, newOp: any, path: string, method: string, out: Change[]): void {
  const label = opLabel(method, path);

  // request body
  const oldReqBody = oldOp?.requestBody, newReqBody = newOp?.requestBody;
  if (!oldReqBody && newReqBody) {
    const req = !!newReqBody.required;
    out.push({
      area: 'Request/Response bodies', kind: 'added', breaking: req, path: `/paths/${path}/${method}/requestBody`,
      summary: `${label} ${req ? 'now requires a request body' : 'adds an optional request body'}`,
    });
  } else if (oldReqBody && !newReqBody) {
    out.push({
      area: 'Request/Response bodies', kind: 'removed', breaking: false, path: `/paths/${path}/${method}/requestBody`,
      summary: `${label} no longer accepts a request body`,
    });
  } else if (oldReqBody && newReqBody) {
    if (!oldReqBody.required && newReqBody.required) out.push({
      area: 'Request/Response bodies', kind: 'changed', breaking: true, path: `/paths/${path}/${method}/requestBody`,
      summary: `${label} request body is now required`,
    });
    const os = firstJsonSchema(oldReqBody), ns = firstJsonSchema(newReqBody);
    if (isObj(os) && isObj(ns)) diffSchema(os, ns, 'Request/Response bodies', `${label} request body`, `/paths/${path}/${method}/requestBody`, out);
  }

  // responses
  const oldResp = isObj(oldOp?.responses) ? oldOp.responses : {};
  const newResp = isObj(newOp?.responses) ? newOp.responses : {};
  const codes = new Set([...Object.keys(oldResp), ...Object.keys(newResp)]);
  for (const c of codes) {
    const rptr = `/paths/${path}/${method}/responses/${c}`;
    if (c in oldResp && !(c in newResp)) {
      out.push({
        area: 'Request/Response bodies', kind: 'removed', breaking: true, path: rptr,
        summary: `${label} no longer returns response ${code(c)}`,
      });
    } else if (!(c in oldResp) && c in newResp) {
      out.push({
        area: 'Request/Response bodies', kind: 'added', breaking: false, path: rptr,
        summary: `${label} adds response ${code(c)}`,
      });
    } else {
      const os = firstJsonSchema(oldResp[c]), ns = firstJsonSchema(newResp[c]);
      if (isObj(os) && isObj(ns)) diffSchema(os, ns, 'Request/Response bodies', `${label} response ${code(c)}`, rptr, out);
    }
  }
}

// ---- paths / operations -----------------------------------------------------
function diffPaths(oldDoc: any, newDoc: any, out: Change[]): void {
  const oldPaths = isObj(oldDoc.paths) ? oldDoc.paths : {};
  const newPaths = isObj(newDoc.paths) ? newDoc.paths : {};
  const paths = new Set([...Object.keys(oldPaths), ...Object.keys(newPaths)]);

  for (const p of paths) {
    const inOld = p in oldPaths, inNew = p in newPaths;
    if (inOld && !inNew) {
      out.push({ area: 'Paths/Operations', kind: 'removed', breaking: true, path: `/paths/${p}`, summary: `Removed path ${code(p)} and all its operations` });
      continue;
    }
    if (!inOld && inNew) {
      out.push({ area: 'Paths/Operations', kind: 'added', breaking: false, path: `/paths/${p}`, summary: `New path ${code(p)}` });
      // still surface each new operation for a fuller picture
      for (const [m] of ops(newPaths[p])) out.push({ area: 'Paths/Operations', kind: 'added', breaking: false, path: `/paths/${p}/${m}`, summary: `New operation ${code(opLabel(m, p))}` });
      continue;
    }
    // path in both — compare operations
    const oldOps = new Map(ops(oldPaths[p]));
    const newOps = new Map(ops(newPaths[p]));
    const methods = new Set([...oldOps.keys(), ...newOps.keys()]);
    for (const m of methods) {
      if (oldOps.has(m) && !newOps.has(m)) {
        out.push({ area: 'Paths/Operations', kind: 'removed', breaking: true, path: `/paths/${p}/${m}`, summary: `Removed operation ${code(opLabel(m, p))}` });
      } else if (!oldOps.has(m) && newOps.has(m)) {
        out.push({ area: 'Paths/Operations', kind: 'added', breaking: false, path: `/paths/${p}/${m}`, summary: `New operation ${code(opLabel(m, p))}` });
      } else {
        const oo = oldOps.get(m), no = newOps.get(m);
        diffParams(oo, no, p, m, out);
        diffBodies(oo, no, p, m, out);
        diffOpSecurity(oo, no, p, m, out);
      }
    }
  }
}

// ---- schemas / models -------------------------------------------------------
function componentSchemas(doc: any): Record<string, any> {
  const c = doc?.components?.schemas;         // OpenAPI 3 / AsyncAPI 2 components
  if (isObj(c)) return c;
  const d = doc?.definitions;                 // Swagger 2 / JSON Schema definitions
  return isObj(d) ? d : {};
}

function diffSchemas(oldDoc: any, newDoc: any, out: Change[]): void {
  const oldS = componentSchemas(oldDoc), newS = componentSchemas(newDoc);
  const names = new Set([...Object.keys(oldS), ...Object.keys(newS)]);
  for (const name of names) {
    const ptr = `/components/schemas/${name}`;
    if (name in oldS && !(name in newS)) {
      out.push({ area: 'Schemas/Models', kind: 'removed', breaking: true, path: ptr, summary: `Removed model ${code(name)}` });
    } else if (!(name in oldS) && name in newS) {
      out.push({ area: 'Schemas/Models', kind: 'added', breaking: false, path: ptr, summary: `New model ${code(name)}` });
    } else {
      diffSchema(oldS[name], newS[name], 'Schemas/Models', `Model ${code(name)}`, ptr, out);
    }
  }
}

// ---- security ---------------------------------------------------------------
function secReqNames(sec: any[]): Set<string> {
  const names = new Set<string>();
  if (Array.isArray(sec)) for (const req of sec) if (isObj(req)) for (const k of Object.keys(req)) names.add(k);
  return names;
}

function diffOpSecurity(oldOp: any, newOp: any, path: string, method: string, out: Change[]): void {
  const label = opLabel(method, path);
  const ptr = `/paths/${path}/${method}/security`;
  const oldHas = Array.isArray(oldOp?.security);
  const newHas = Array.isArray(newOp?.security);
  const oldOptional = oldHas && oldOp.security.some((r: any) => isObj(r) && Object.keys(r).length === 0);
  const newOptional = newHas && newOp.security.some((r: any) => isObj(r) && Object.keys(r).length === 0);

  // going from no/optional auth to required auth is a tightening = breaking
  if (newHas && !newOptional && (!oldHas || oldOptional)) {
    out.push({ area: 'Security', kind: 'changed', breaking: true, path: ptr, summary: `${label} now requires authentication` });
  } else if (oldHas && !oldOptional && (!newHas || newOptional)) {
    out.push({ area: 'Security', kind: 'changed', breaking: false, path: ptr, summary: `${label} no longer requires authentication` });
  } else if (oldHas && newHas) {
    const added = [...secReqNames(newOp.security)].filter((n) => !secReqNames(oldOp.security).has(n));
    const removed = [...secReqNames(oldOp.security)].filter((n) => !secReqNames(newOp.security).has(n));
    for (const n of removed) out.push({ area: 'Security', kind: 'removed', breaking: false, path: ptr, summary: `${label} dropped security scheme ${code(n)}` });
    for (const n of added) out.push({ area: 'Security', kind: 'added', breaking: true, path: ptr, summary: `${label} now also requires security scheme ${code(n)}` });
  }
}

function diffGlobalSecurity(oldDoc: any, newDoc: any, out: Change[]): void {
  // security schemes catalog
  const oldSchemes = isObj(oldDoc?.components?.securitySchemes) ? oldDoc.components.securitySchemes : {};
  const newSchemes = isObj(newDoc?.components?.securitySchemes) ? newDoc.components.securitySchemes : {};
  const names = new Set([...Object.keys(oldSchemes), ...Object.keys(newSchemes)]);
  for (const n of names) {
    const ptr = `/components/securitySchemes/${n}`;
    if (n in oldSchemes && !(n in newSchemes)) out.push({ area: 'Security', kind: 'removed', breaking: false, path: ptr, summary: `Removed security scheme ${code(n)}` });
    else if (!(n in oldSchemes) && n in newSchemes) out.push({ area: 'Security', kind: 'added', breaking: false, path: ptr, summary: `New security scheme ${code(n)} (${newSchemes[n]?.type ?? 'unknown'})` });
    else if (oldSchemes[n]?.type !== newSchemes[n]?.type) out.push({ area: 'Security', kind: 'changed', breaking: true, path: ptr, summary: `Security scheme ${code(n)} changed type from ${code(oldSchemes[n]?.type ?? '—')} to ${code(newSchemes[n]?.type ?? '—')}` });
  }

  // global default security
  const oldHas = Array.isArray(oldDoc?.security);
  const newHas = Array.isArray(newDoc?.security);
  const oldOptional = oldHas && oldDoc.security.some((r: any) => isObj(r) && Object.keys(r).length === 0);
  const newOptional = newHas && newDoc.security.some((r: any) => isObj(r) && Object.keys(r).length === 0);
  if (newHas && !newOptional && (!oldHas || oldOptional)) {
    out.push({ area: 'Security', kind: 'changed', breaking: true, path: '/security', summary: `API now requires authentication by default` });
  } else if (oldHas && !oldOptional && (!newHas || newOptional)) {
    out.push({ area: 'Security', kind: 'changed', breaking: false, path: '/security', summary: `API no longer requires authentication by default` });
  }
}

// ---- AsyncAPI channels / Arazzo workflows (light-touch) ---------------------
function diffChannels(oldDoc: any, newDoc: any, out: Change[]): void {
  const o = isObj(oldDoc.channels) ? oldDoc.channels : {};
  const n = isObj(newDoc.channels) ? newDoc.channels : {};
  const names = new Set([...Object.keys(o), ...Object.keys(n)]);
  for (const c of names) {
    if (c in o && !(c in n)) out.push({ area: 'Paths/Operations', kind: 'removed', breaking: true, path: `/channels/${c}`, summary: `Removed channel ${code(c)}` });
    else if (!(c in o) && c in n) out.push({ area: 'Paths/Operations', kind: 'added', breaking: false, path: `/channels/${c}`, summary: `New channel ${code(c)}` });
  }
}
function diffWorkflows(oldDoc: any, newDoc: any, out: Change[]): void {
  const idx = (doc: any) => {
    const m = new Map<string, any>();
    if (Array.isArray(doc.workflows)) for (const w of doc.workflows) if (isObj(w) && w.workflowId) m.set(String(w.workflowId), w);
    return m;
  };
  const o = idx(oldDoc), n = idx(newDoc);
  const names = new Set([...o.keys(), ...n.keys()]);
  for (const w of names) {
    if (o.has(w) && !n.has(w)) out.push({ area: 'Paths/Operations', kind: 'removed', breaking: true, path: `/workflows/${w}`, summary: `Removed workflow ${code(w)}` });
    else if (!o.has(w) && n.has(w)) out.push({ area: 'Paths/Operations', kind: 'added', breaking: false, path: `/workflows/${w}`, summary: `New workflow ${code(w)}` });
    else {
      const os = Array.isArray(o.get(w).steps) ? o.get(w).steps.length : 0;
      const ns = Array.isArray(n.get(w).steps) ? n.get(w).steps.length : 0;
      if (os !== ns) out.push({ area: 'Paths/Operations', kind: 'changed', breaking: false, path: `/workflows/${w}/steps`, summary: `Workflow ${code(w)} step count changed from ${os} to ${ns}` });
    }
  }
}

// ---- top-level diff ---------------------------------------------------------
export function diffSpecs(oldDoc: any, newDoc: any): Change[] {
  const oldR = resolveRefs(oldDoc);
  const newR = resolveRefs(newDoc);
  const out: Change[] = [];

  if (isObj(oldR.paths) || isObj(newR.paths)) diffPaths(oldR, newR, out);
  if (isObj(oldR.channels) || isObj(newR.channels)) diffChannels(oldR, newR, out);
  if (Array.isArray(oldR.workflows) || Array.isArray(newR.workflows)) diffWorkflows(oldR, newR, out);

  diffSchemas(oldR, newR, out);
  diffGlobalSecurity(oldR, newR, out);

  return dedupe(out);
}

function dedupe(changes: Change[]): Change[] {
  const seen = new Set<string>();
  const out: Change[] = [];
  for (const c of changes) {
    const key = `${c.area}|${c.kind}|${c.breaking}|${c.path}|${c.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export interface Counts { total: number; added: number; removed: number; changed: number; breaking: number; }
export function countChanges(changes: Change[]): Counts {
  return {
    total: changes.length,
    added: changes.filter((c) => c.kind === 'added').length,
    removed: changes.filter((c) => c.kind === 'removed').length,
    changed: changes.filter((c) => c.kind === 'changed').length,
    breaking: changes.filter((c) => c.breaking).length,
  };
}

// ---- Markdown export --------------------------------------------------------
const AREAS: Area[] = ['Paths/Operations', 'Parameters', 'Request/Response bodies', 'Schemas/Models', 'Security'];

export function toMarkdown(changes: Change[]): string {
  const c = countChanges(changes);
  const lines: string[] = [];
  lines.push('## API design review');
  lines.push('');
  lines.push(`**${c.total}** change${c.total === 1 ? '' : 's'} — ${c.added} added, ${c.removed} removed, ${c.changed} changed · **${c.breaking} breaking**`);
  lines.push('');
  if (!changes.length) { lines.push('_No differences detected between the two documents._'); return lines.join('\n'); }

  const breaking = changes.filter((x) => x.breaking);
  if (breaking.length) {
    lines.push('### ⚠️ Breaking changes');
    lines.push('');
    for (const x of breaking) lines.push(`- **[${x.kind}]** ${x.summary}`);
    lines.push('');
  }

  for (const area of AREAS) {
    const inArea = changes.filter((x) => x.area === area);
    if (!inArea.length) continue;
    lines.push(`### ${area}`);
    lines.push('');
    for (const x of inArea) {
      const flag = x.breaking ? ' **⚠️ BREAKING**' : '';
      lines.push(`- \`${x.kind}\` ${x.summary}${flag}`);
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('_Generated by [Spec Review](https://review.apicommons.org) — a ref-resolving design-diff. Refs were resolved before diffing, so this reflects the real shape._');
  return lines.join('\n');
}
