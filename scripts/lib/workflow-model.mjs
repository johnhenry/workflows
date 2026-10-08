// Small read-only model over a GitHub Actions workflow file, built on the
// vendored `yaml` parser (scripts/vendor/yaml.mjs -- a self-contained bundle,
// so nothing here needs an `npm install`). Shared by the linter and the
// codemod. Every node carries 1-based line numbers.
import { parseDocument, LineCounter, isMap, isSeq, isScalar } from "../vendor/yaml.mjs";

export const REUSABLE_RE = /^johnhenry\/workflows\/\.github\/workflows\/npm-publish\.ya?ml@/;
export const PUBLISH_RUN_RE =
  /\bnpm\s+publish\b|\bchangeset\s+publish\b|\bnpm\s+run\s+release\b|\b(?:yarn|pnpm)\s+publish\b/;

export function parseWorkflow(text) {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const lines = text.split("\n");
  const lineOf = (off) => lc.linePos(off).line;
  const endLineOf = (node) => {
    let p = node.range[1] - 1;
    while (p > node.range[0] && /\s/.test(text[p])) p--;
    return lineOf(Math.max(p, node.range[0]));
  };
  return {
    text,
    lines,
    doc,
    errors: doc.errors.map((e) => ({ line: e.linePos?.[0]?.line ?? 1, message: e.message })),
    root: isMap(doc.contents) ? doc.contents : null,
    lineOf,
    endLineOf,
  };
}

export const indentOf = (line) => line.length - line.trimStart().length;

/** Find a pair by scalar key in a map node. */
export function pairOf(map, key) {
  if (!isMap(map)) return null;
  return map.items.find((p) => isScalar(p.key) && String(p.key.value) === key) ?? null;
}

export function valueOf(map, key) {
  return pairOf(map, key)?.value ?? null;
}

export function scalarOf(node) {
  return isScalar(node) ? node.value : undefined;
}

/**
 * Line span of a pair, 1-based inclusive. Trailing comment-only lines that are
 * indented deeper than the key (continuation comments of the value) belong to
 * the span, so a rewrite doesn't strand them.
 */
export function pairSpan(wf, pair) {
  const start = wf.lineOf(pair.key.range[0]);
  let end = start;
  if (pair.value?.range) end = Math.max(start, wf.endLineOf(pair.value));
  const keyIndent = indentOf(wf.lines[start - 1]);
  while (end < wf.lines.length) {
    const next = wf.lines[end];
    if (next.trim().startsWith("#") && indentOf(next) > keyIndent) end++;
    else break;
  }
  return { start, end };
}

/** `on:` -> { line, events: { name: { line, node, pair } } }. */
export function triggersOf(wf) {
  const pair = pairOf(wf.root, "on");
  if (!pair) return null;
  const events = {};
  const v = pair.value;
  if (isScalar(v) && v.value != null) events[String(v.value)] = { line: wf.lineOf(v.range[0]), node: null, pair: null };
  else if (isSeq(v)) {
    for (const it of v.items) if (isScalar(it)) events[String(it.value)] = { line: wf.lineOf(it.range[0]), node: null, pair: null };
  } else if (isMap(v)) {
    for (const p of v.items) {
      events[String(p.key.value)] = { line: wf.lineOf(p.key.range[0]), node: p.value, pair: p };
    }
  }
  return { pair, line: wf.lineOf(pair.key.range[0]), events };
}

export function stringList(node) {
  if (isScalar(node)) return node.value == null ? [] : [String(node.value)];
  if (isSeq(node)) return node.items.filter(isScalar).map((i) => String(i.value));
  return [];
}

/** All jobs with the facts both tools need. */
export function jobsOf(wf) {
  const jobsPair = pairOf(wf.root, "jobs");
  if (!jobsPair || !isMap(jobsPair.value)) return [];
  return jobsPair.value.items.map((pair) => {
    const map = pair.value;
    const usesNode = valueOf(map, "uses");
    const uses = scalarOf(usesNode);
    const stepsNode = valueOf(map, "steps");
    const steps = isSeq(stepsNode) ? stepsNode.items.filter(isMap) : [];
    const reusable = typeof uses === "string" && REUSABLE_RE.test(uses);
    const stepFacts = steps.map((s) => ({
      map: s,
      uses: scalarOf(valueOf(s, "uses")),
      run: scalarOf(valueOf(s, "run")),
    }));
    const inlinePublish = stepFacts.some(
      (s) =>
        (typeof s.uses === "string" && /^changesets\/action(@|$)/.test(s.uses)) ||
        (typeof s.run === "string" && PUBLISH_RUN_RE.test(s.run)),
    );
    return {
      id: String(pair.key.value),
      pair,
      map,
      line: wf.lineOf(pair.key.range[0]),
      uses,
      reusable,
      steps: stepFacts,
      usesChangesets: stepFacts.some((s) => typeof s.uses === "string" && /^changesets\/action(@|$)/.test(s.uses)),
      isPublish: reusable || inlinePublish,
    };
  });
}

/** Effective permission lookup for a job: job-level replaces workflow-level. */
export function effectivePermissions(wf, job) {
  const node = valueOf(job.map, "permissions") ?? valueOf(wf.root, "permissions");
  const level = (key) => {
    if (!node) return undefined; // unspecified: repo default, unknown
    if (isScalar(node)) return node.value === "write-all" ? "write" : "none";
    return scalarOf(valueOf(node, key)) ?? "none";
  };
  return { declared: !!node, level, node };
}

/** Does concurrency on the workflow or this job set cancel-in-progress: false? */
export function concurrencyState(wf, job) {
  for (const holder of [job?.map, wf.root]) {
    const c = valueOf(holder, "concurrency");
    if (!c) continue;
    if (isMap(c)) {
      const cancel = valueOf(c, "cancel-in-progress");
      const v = scalarOf(cancel);
      const g = scalarOf(valueOf(c, "group"));
      return { present: true, line: wf.lineOf(c.range[0]), cancelFalse: v === false || v === "false", cancelLine: cancel ? wf.lineOf(cancel.range[0]) : null, group: g == null ? null : String(g).trim() };
    }
    return { present: true, line: wf.lineOf(c.range[0]), cancelFalse: false, cancelLine: null, group: scalarOf(c) == null ? null : String(scalarOf(c)).trim() };
  }
  return { present: false };
}

/** Major from an `engines.node` range ('>=26.0.0', '^26', '26.x', '>=20 <27'). */
export function majorOfRange(range) {
  if (typeof range !== "string") return null;
  const m = /(\d+)/.exec(range);
  return m ? Number(m[1]) : null;
}

export function majorOfVersion(v) {
  if (v == null) return null;
  const m = /^\s*v?(\d+)/.exec(String(v));
  return m ? Number(m[1]) : null;
}
