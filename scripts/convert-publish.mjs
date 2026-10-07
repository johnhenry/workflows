#!/usr/bin/env node
// Codemod: rewrite a consumer repo's publish workflow(s) to the canonical
// "main is the release branch" shape, and wire `workflow-lint` into its CI.
//
//   node scripts/convert-publish.mjs <repo-path> [--dry-run] [--check] [--no-ci] [--glob '<glob>']
//
// What it changes, per publish workflow (text-level edits, so comments and
// formatting outside the touched blocks survive):
//   - `on:`            -> push to main + workflow_dispatch (existing
//                         workflow_dispatch inputs and unrelated triggers kept)
//   - `concurrency`    -> added if missing; `cancel-in-progress: false` forced
//   - `permissions`    -> jobs calling npm-publish.yml get contents: write +
//                         id-token: write; inline publish jobs get id-token: write
//   - `node-version`   -> set to the repo's engines.node major
//   - comments about the release/tag double-fire race are removed
// It never rewrites the body of an inline publish job (steps, dist-tag logic,
// ...); it only prints warnings where a body still assumes a tag ref.
// Idempotent: a second run changes nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isScalar } from "./vendor/yaml.mjs";
import {
  parseWorkflow,
  pairOf,
  valueOf,
  scalarOf,
  triggersOf,
  jobsOf,
  pairSpan,
  indentOf,
  majorOfVersion,
} from "./lib/workflow-model.mjs";
import { engineInfo, DEFAULT_PUBLISH_GLOB } from "./lib/repo-info.mjs";
import { discoverPublishWorkflows, publishGroups } from "./lint-publish-workflow.mjs";

export const MARKER = "# Publish model:";
const MARKER_LINES = [
  `${MARKER} main is the release branch. A push to main publishes only if`,
  "# package.json's version isn't on npm yet (otherwise a clean no-op), then tags",
  "# v<version> and creates a GitHub Release. See johnhenry/workflows' README.",
];
const RACE_RE = /release|\btags?\b|tag-|\brace\b|twice|double[- ]?fire|redundant|trigger/i;
const TAG_REF_RE = /GITHUB_REF#refs\/tags|github\.ref_type\s*==\s*['"]tag['"]|refs\/tags\/|github\.ref_name|GITHUB_REF_NAME/;
const LINT_USES = "johnhenry/workflows/.github/workflows/workflow-lint.yml@v1";
const CANON = {
  contents: ["write", "tag + GitHub Release by-product of npm-publish.yml"],
  "id-token": ["write", "npm provenance"],
};

const dedent = (lines) => {
  const n = indentOf(lines[0]);
  return lines.map((l) => (l.trim() === "" ? "" : l.slice(Math.min(n, indentOf(l)))));
};
const indent = (lines, n) => lines.map((l) => (l === "" ? "" : " ".repeat(n) + l));

/** Contiguous comment lines directly above 1-based `line` -> {start,end}|null. */
function commentRunAbove(wf, line) {
  let s = line;
  while (s > 1 && wf.lines[s - 2].trim().startsWith("#") && indentOf(wf.lines[s - 2]) === indentOf(wf.lines[line - 1])) s--;
  return s === line ? null : { start: s, end: line - 1 };
}

// `fileBase` (workflow basename, no extension) is passed only when the repo has
// more than one publish workflow: the default group is then suffixed with it,
// and an existing group that collides with one in `otherGroups` is suffixed too.
export function convertWorkflowText(text, { engineMajor = null, fileBase = null, otherGroups = [] } = {}) {
  const warnings = [];
  const wf = parseWorkflow(text);
  if (wf.errors.length || !wf.root) return { text, warnings: [`YAML parse error; left untouched${wf.errors[0] ? `: ${wf.errors[0].message}` : ""}`] };
  const trig = triggersOf(wf);
  if (!trig) return { text, warnings: ["no `on:` block; left untouched"] };
  const jobs = jobsOf(wf);
  const publishJobs = jobs.filter((j) => j.isPublish);
  const edits = []; // { start, end, lines }  (1-based inclusive; end = start-1 inserts)

  // ---- on: ----------------------------------------------------------------
  const onSpan = pairSpan(wf, trig.pair);
  const onLines = ["on:", "  push:", "    branches: [main]"];
  const wd = trig.events.workflow_dispatch;
  if (wd?.pair && isMap(wd.node) && wd.node.items.length > 0) {
    const s = pairSpan(wf, wd.pair);
    onLines.push(...indent(dedent(wf.lines.slice(s.start - 1, s.end)), 2));
  } else onLines.push("  workflow_dispatch: {}");
  for (const [name, ev] of Object.entries(trig.events)) {
    if (["push", "release", "workflow_dispatch"].includes(name)) continue;
    warnings.push(`kept extra trigger \`${name}\` (line ${ev.line}); check it still makes sense for a publish workflow`);
    if (ev.pair) {
      const s = pairSpan(wf, ev.pair);
      onLines.push(...indent(dedent(wf.lines.slice(s.start - 1, s.end)), 2));
    } else onLines.push(`  ${name}:`);
  }

  // marker comment / stale race comment above `on:`
  let onStart = onSpan.start;
  const onRun = commentRunAbove(wf, onSpan.start);
  const prefix = [];
  if (onRun) {
    const runLines = wf.lines.slice(onRun.start - 1, onRun.end);
    if (runLines.some((l) => l.startsWith(MARKER))) onStart = onRun.start, prefix.push(...runLines);
    else if (RACE_RE.test(runLines.join("\n"))) (onStart = onRun.start), prefix.push(...MARKER_LINES);
    else (onStart = onRun.start), prefix.push(...MARKER_LINES, ...runLines);
  } else prefix.push(...MARKER_LINES);
  let onReplacement = [...prefix, ...onLines];

  // ---- concurrency ----------------------------------------------------------
  const concPair = pairOf(wf.root, "concurrency");
  const jobHasConc = publishJobs.length > 0 && publishJobs.every((j) => valueOf(j.map, "concurrency"));
  if (concPair) {
    const span = pairSpan(wf, concPair);
    let group = fileBase ? `${fileBase}-\${{ github.ref }}` : "publish-${{ github.ref }}";
    const v = concPair.value;
    if (isMap(v) && valueOf(v, "group")) {
      const g = valueOf(v, "group");
      group = wf.text.slice(g.range[0], g.range[1]);
    } else if (isScalar(v) && v.value != null) group = wf.text.slice(v.range[0], v.range[1]);
    const bare = group.replace(/^(["'])(.*)\1$/, "$2").trim();
    if (fileBase && otherGroups.includes(bare)) {
      const q = /^["']/.test(group) ? group[0] : "";
      const next = `${q}${bare}-${fileBase}${q}`;
      warnings.push(`concurrency group \`${bare}\` is shared with another publish workflow (GitHub cancels queued runs in a shared group); changed to \`${bare}-${fileBase}\``);
      group = next;
    }
    const run = commentRunAbove(wf, span.start);
    let start = span.start;
    if (run && RACE_RE.test(wf.lines.slice(run.start - 1, run.end).join("\n"))) start = run.start;
    edits.push({ start, end: span.end, lines: ["concurrency:", `  group: ${group}`, "  cancel-in-progress: false"] });
  } else if (!jobHasConc) {
    onReplacement = [...onReplacement, "", "concurrency:", `  group: ${fileBase ? `${fileBase}-` : "publish-"}\${{ github.ref }}`, "  cancel-in-progress: false"];
  }
  edits.push({ start: onStart, end: onSpan.end, lines: onReplacement });

  // ---- permissions + node per publish job -------------------------------------
  const topPerm = pairOf(wf.root, "permissions");
  for (const job of publishJobs) {
    const required = job.reusable ? ["contents", "id-token"] : ["id-token"];
    const jobPerm = pairOf(job.map, "permissions");
    const jobIndent = indentOf(wf.lines[job.line - 1]);
    const childIndent = jobIndent + 2;
    const levelIn = (node, k) => (isMap(node) ? scalarOf(valueOf(node, k)) : undefined);
    const satisfied = (node) => isScalar(node) ? node.value === "write-all" : required.every((k) => levelIn(node, k) === "write");

    const makeBlock = (baseNode, blockIndent, key = "permissions") => {
      const lines = [`${key}:`];
      const keep = [];
      if (isMap(baseNode)) {
        for (const p of baseNode.items) {
          const k = String(p.key.value);
          if (required.includes(k)) continue;
          const s = pairSpan(wf, p);
          keep.push(...dedent(wf.lines.slice(s.start - 1, s.end)));
        }
      }
      const req = (job.reusable ? ["contents", "id-token"] : ["id-token"]).map((k) => `${k}: ${CANON[k][0]} # ${CANON[k][1]}`);
      const inlineKeep = !job.reusable && isMap(baseNode);
      lines.push(...indent([...(inlineKeep ? [] : []), ...req, ...keep], 2));
      return indent(lines, blockIndent);
    };

    if (jobPerm) {
      if (!satisfied(jobPerm.value)) {
        const s = pairSpan(wf, jobPerm);
        edits.push({ start: s.start, end: s.end, lines: makeBlock(jobPerm.value, jobIndent + 2) });
      }
    } else if (topPerm && satisfied(topPerm.value)) {
      if (job.reusable && !isScalar(topPerm.value)) {
        // contents+id-token already write at workflow level: nothing to do
      }
    } else if (job.reusable) {
      edits.push({ start: job.line + 1, end: job.line, lines: makeBlock(topPerm?.value ?? null, childIndent) });
    } else if (topPerm) {
      const s = pairSpan(wf, topPerm);
      edits.push({ start: s.start, end: s.end, lines: makeBlock(topPerm.value, 0) });
    } else {
      const lines = ["permissions:", "  contents: read", `  id-token: write # ${CANON["id-token"][1]}`];
      edits.push({ start: job.line + 1, end: job.line, lines: indent(lines, childIndent) });
    }

    // node-version
    if (engineMajor != null) {
      const targets = [];
      if (job.reusable) targets.push({ withNode: valueOf(valueOf(job.map, "with"), "node-version"), reusable: true });
      else
        for (const s of job.steps)
          if (typeof s.uses === "string" && s.uses.startsWith("actions/setup-node")) {
            const nv = valueOf(valueOf(s.map, "with"), "node-version");
            if (nv) targets.push({ withNode: nv, reusable: false });
          }
      for (const t of targets) {
        if (!t.withNode) {
          if (engineMajor === 26) continue; // reusable default
          const withPair = pairOf(job.map, "with");
          if (withPair && isMap(withPair.value) && withPair.value.items.length) {
            const first = withPair.value.items[0];
            edits.push({ start: wf.lineOf(first.key.range[0]), end: wf.lineOf(first.key.range[0]) - 1, lines: [`${" ".repeat(indentOf(wf.lines[wf.lineOf(first.key.range[0]) - 1]))}node-version: "${engineMajor}"`] });
          } else if (!withPair) {
            const usesLine = wf.lineOf(pairOf(job.map, "uses").key.range[0]);
            edits.push({ start: usesLine + 1, end: usesLine, lines: indent(["with:", `  node-version: "${engineMajor}"`], childIndent) });
          }
          continue;
        }
        const raw = scalarOf(t.withNode);
        if (typeof raw === "string" && raw.includes("${{")) continue;
        const major = majorOfVersion(raw);
        if (major == null || major === engineMajor) continue;
        const src = wf.text.slice(t.withNode.range[0], t.withNode.range[1]);
        const q = src[0] === '"' || src[0] === "'" ? src[0] : t.reusable ? '"' : "";
        const L = wf.lineOf(t.withNode.range[0]);
        const col = t.withNode.range[0] - wf.text.split("\n").slice(0, L - 1).reduce((n, l) => n + l.length + 1, 0);
        const line = wf.lines[L - 1];
        edits.push({ start: L, end: L, lines: [line.slice(0, col) + `${q}${engineMajor}${q}` + line.slice(col + src.length)] });
        if (major !== engineMajor) warnings.push(`line ${L}: node-version ${raw} -> ${engineMajor} (engines.node major)`);
      }
    }

    // tag-ref assumptions we deliberately do not touch
    const sp = pairSpan(wf, job.pair);
    for (let i = sp.start; i <= sp.end; i++) {
      const l = wf.lines[i - 1];
      if (!l.trim().startsWith("#") && TAG_REF_RE.test(l)) warnings.push(`line ${i}: job \`${job.id}\` still references a tag ref (\`${l.trim().slice(0, 70)}\`); on push to main this never holds, review by hand`);
    }
  }

  // ---- apply ---------------------------------------------------------------------
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].end >= edits[i - 1].start && !(edits[i - 1].end < edits[i - 1].start && edits[i].end === edits[i - 1].start - 1)) {
      if (edits[i].end >= edits[i - 1].start && edits[i - 1].end >= edits[i - 1].start) throw new Error(`overlapping edits at lines ${edits[i].start}-${edits[i].end} and ${edits[i - 1].start}`);
    }
  }
  const out = [...wf.lines];
  for (const e of edits) out.splice(e.start - 1, e.end - e.start + 1, ...e.lines);
  return { text: out.join("\n"), warnings };
}

/** Add a `workflow-lint` job to ci.yml (or create ci.yml). Returns {file,text|null,created}. */
export function addWorkflowLint(repoPath) {
  const dir = path.join(repoPath, ".github", "workflows");
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
  for (const f of existing) {
    const wf = parseWorkflow(fs.readFileSync(path.join(dir, f), "utf8"));
    if (wf.root && jobsOf(wf).some((j) => typeof j.uses === "string" && /workflows\/workflow-lint\.ya?ml@/.test(j.uses))) return { file: null, text: null, warnings: [] };
  }
  const ci = existing.find((f) => /^ci\.ya?ml$/.test(f));
  const jobBlock = (n) => indent(["workflow-lint:", `  uses: ${LINT_USES}`], n);
  if (!ci) {
    const text = ["name: CI", "", "on:", "  push:", "    branches: [main]", "  pull_request:", "", "jobs:", ...jobBlock(2), ""].join("\n");
    return { file: ".github/workflows/ci.yml", text, created: true, warnings: [] };
  }
  const rel = `.github/workflows/${ci}`;
  const src = fs.readFileSync(path.join(dir, ci), "utf8");
  const wf = parseWorkflow(src);
  const jobsPair = wf.root && pairOf(wf.root, "jobs");
  if (!jobsPair || !isMap(jobsPair.value) || jobsPair.value.flow) return { file: rel, text: null, warnings: [`${rel}: could not locate a block-style \`jobs:\` map; add a job calling ${LINT_USES} by hand`] };
  if (jobsPair.value.items.some((p) => String(p.key.value) === "workflow-lint")) return { file: rel, text: null, warnings: [`${rel}: a job named workflow-lint already exists but does not call ${LINT_USES}; fix by hand`] };
  const span = pairSpan(wf, jobsPair);
  const n = indentOf(wf.lines[wf.lineOf(jobsPair.value.items[0].key.range[0]) - 1]);
  const lines = [...wf.lines];
  lines.splice(span.end, 0, "", ...jobBlock(n));
  return { file: rel, text: lines.join("\n"), warnings: [] };
}

/** Plain LCS line diff -> [{op:'+'|'-'|' ', text}]. */
export function lineDiff(a, b) {
  const n = a.length, m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: " ", text: a[i] }); i++; j++; }
    else if (t[i + 1][j] >= t[i][j + 1]) ops.push({ op: "-", text: a[i++] });
    else ops.push({ op: "+", text: b[j++] });
  }
  while (i < n) ops.push({ op: "-", text: a[i++] });
  while (j < m) ops.push({ op: "+", text: b[j++] });
  return ops;
}

export function convertRepo(repoPath, { dryRun = false, glob = DEFAULT_PUBLISH_GLOB, ci = true } = {}) {
  const info = engineInfo(repoPath);
  const files = [];
  const warnings = [];
  if (info.major == null) warnings.push(`no engines.node found (${info.source}); node-version left as is`);
  const rels = discoverPublishWorkflows(repoPath, glob, { sniff: glob === DEFAULT_PUBLISH_GLOB });
  const texts = new Map(rels.map((rel) => [rel, fs.readFileSync(path.join(repoPath, rel), "utf8")]));
  for (const rel of rels) {
    const before = texts.get(rel);
    const multi = rels.length > 1;
    const otherGroups = multi ? rels.filter((o) => o !== rel).flatMap((o) => publishGroups(texts.get(o)).map((g) => g.group.replace(/^(["'])(.*)\1$/, "$2"))) : [];
    const r = convertWorkflowText(before, { engineMajor: info.major, fileBase: multi ? path.basename(rel).replace(/\.ya?ml$/, "") : null, otherGroups });
    files.push({ file: rel, before, after: r.text, created: false });
    for (const w of r.warnings) warnings.push(`${rel}: ${w}`);
  }
  if (ci) {
    const r = addWorkflowLint(repoPath);
    warnings.push(...r.warnings);
    if (r.text != null) {
      const abs = path.join(repoPath, r.file);
      files.push({ file: r.file, before: r.created ? "" : fs.readFileSync(abs, "utf8"), after: r.text, created: !!r.created });
    }
  }
  const summary = files.map((f) => {
    const ops = lineDiff(f.before === "" ? [] : f.before.split("\n"), f.after.split("\n"));
    return { ...f, changed: f.before !== f.after, added: ops.filter((o) => o.op === "+").length, removed: ops.filter((o) => o.op === "-").length, ops };
  });
  if (!dryRun)
    for (const f of summary)
      if (f.changed) {
        fs.mkdirSync(path.dirname(path.join(repoPath, f.file)), { recursive: true });
        fs.writeFileSync(path.join(repoPath, f.file), f.after);
      }
  return { files: summary, warnings, engine: info };
}

export function formatSummary(result, { verbose = true } = {}) {
  const out = [];
  const changed = result.files.filter((f) => f.changed);
  for (const f of result.files) {
    out.push(`${f.changed ? (f.created ? "create" : "change") : "ok    "} ${f.file}${f.changed ? `  (+${f.added} -${f.removed})` : ""}`);
    if (verbose && f.changed) for (const o of f.ops) if (o.op !== " ") out.push(`    ${o.op} ${o.text}`);
  }
  for (const w of result.warnings) out.push(`WARNING ${w}`);
  out.push(changed.length ? `${changed.length} file(s) changed.` : "Nothing to change (already canonical).");
  return out.join("\n");
}

function main(argv) {
  const opts = { dryRun: false, check: false, ci: true, glob: DEFAULT_PUBLISH_GLOB };
  let repo = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--check") (opts.check = true), (opts.dryRun = true);
    else if (a === "--no-ci") opts.ci = false;
    else if (a === "--glob") opts.glob = argv[++i];
    else if (a === "-h" || a === "--help") repo = null, argv = [];
    else repo = a;
  }
  if (!repo) {
    console.log("usage: node scripts/convert-publish.mjs <repo-path> [--dry-run] [--check] [--no-ci] [--glob '<glob>']");
    return 2;
  }
  const result = convertRepo(path.resolve(repo), opts);
  console.log(formatSummary(result));
  return opts.check && result.files.some((f) => f.changed) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
