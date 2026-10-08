import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { convertWorkflowText, convertRepo, addWorkflowLint, formatSummary, lineDiff } from "../scripts/convert-publish.mjs";
import { lintWorkflow, lintRepo } from "../scripts/lint-publish-workflow.mjs";
import { parseWorkflow, jobsOf } from "../scripts/lib/workflow-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(here, "fixtures", ...p), "utf8");
const UPDATE = process.env.UPDATE_GOLDEN === "1";

// Real publish workflows copied from consumers (2026-10-07) -> golden outputs.
const CONSUMERS = [
  ["fileable.publish.yml", "release + tags + reusable"],
  ["wsh.publish.yml", "tags-only, Node 24 vs engines 26, install-command"],
  ["isomorphic-jj.publish.yml", "v*.*.* tags, no dispatch, reusable"],
  ["isomorphic-jj.publish-unscoped.yml", "v*.*.* tags, inline job, workflow-level permissions"],
  ["a2a-query.release.yml", "inline job, npm-publish concurrency group, dist-tag logic"],
  ["raijin.publish.yml", "release-only inline monorepo publish (npm publish -w: no composite)"],
  ["apple-foundation-models.publish.yml", "inline, macos runner, id-less publish step"],
  ["domable.publish.yml", "inline, id-less publish step"],
  ["math-grapher.publish.yml", "inline, workflow-level permissions, NPM_TOKEN-guarded publish"],
  ["packfile.publish.yml", "inline, id-less publish step"],
  ["a2a-query.release-main.yml", "inline with a hand-written release step: no second one added"],
];

// isomorphic-jj has two publish workflows in one repo: convert them as such.
const MULTI = { "isomorphic-jj.publish.yml": "publish", "isomorphic-jj.publish-unscoped.yml": "publish-unscoped" };

for (const [name, what] of CONSUMERS) {
  test(`consumer fixture ${name} (${what})`, () => {
    const before = read("consumers", name);
    const opts = { engineMajor: 26, ...(MULTI[name] ? { fileBase: MULTI[name] } : {}) };
    const a = convertWorkflowText(before, opts);
    const goldenPath = path.join(here, "fixtures", "expected", name);
    if (UPDATE) fs.writeFileSync(goldenPath, a.text);
    assert.equal(a.text, fs.readFileSync(goldenPath, "utf8"), "output differs from golden file");
    // idempotent
    assert.equal(convertWorkflowText(a.text, opts).text, a.text, "second run changed the file");
    // converges to lint-clean
    assert.deepEqual(lintWorkflow({ text: a.text, engineMajor: 26 }), []);
    // no tag/release triggers or race commentary survive
    assert.doesNotMatch(a.text, /^\s*release:/m);
    assert.doesNotMatch(a.text, /silently drop|fire twice|Redundant with the release/);
  });
}

test("inline publish jobs: step bodies are never rewritten", () => {
  const stepsOf = (t) => {
    const wf = parseWorkflow(t);
    return jobsOf(wf).filter((j) => !j.reusable).map((j) => wf.lines.slice(j.line, wf.endLineOf(j.pair.value)).filter((l) => !/^\s+(contents|id-token|permissions):/.test(l)).join("\n"));
  };
  for (const name of ["a2a-query.release.yml", "raijin.publish.yml", "isomorphic-jj.publish-unscoped.yml"]) {
    const before = read("consumers", name);
    const after = convertWorkflowText(before, { engineMajor: 26 }).text;
    // everything below `jobs:` is identical except permissions lines and the node-version scalar
    // ... and the by-product steps the codemod inserts (probe, `id: publish`, create-release)
    const norm = (t) => t.slice(t.indexOf("\njobs:")).replace(/node-version: 24/, "node-version: 26")
      .replace(/ {6}- name: Check whether this version is new on npm\n(?: {8}.*\n| *\n)+?(?= {6}- |\n* *$)/, "")
      .replace(/\n\n {6}- name: Tag and GitHub Release \(by-product\)\n(?: {8}.*\n?)+/, "\n")
      .replace(/\n {8}id: publish(?=\n)/, "");
    assert.equal(norm(after).replace(/\n {4}permissions:\n(?: {6}.*\n)+/, "\n"), norm(before).replace(/\n {4}permissions:\n(?: {6}.*\n)+/, "\n"), name);
    assert.deepEqual(stepsOf(after).length, stepsOf(before).length);
  }
  const a2a = convertWorkflowText(read("consumers", "a2a-query.release.yml"), { engineMajor: 26 });
  assert.match(a2a.text, /DIST_TAG=rc/);
  assert.match(a2a.text, /group: npm-publish/, "existing concurrency group is preserved");
  assert.ok(a2a.warnings.some((w) => /tag ref/.test(w)), "tag-dependent steps are flagged for manual review");
  assert.match(a2a.text, /contents: write # tag \+ GitHub Release by-product/, "inline jobs that get the release step get contents: write");
  assert.match(a2a.text, /uses: johnhenry\/workflows\/\.github\/actions\/create-release@v1/);
});

test("wsh: install-command / node-cache / gate-commands preserved, node 24 -> 26", () => {
  const out = convertWorkflowText(read("consumers", "wsh.publish.yml"), { engineMajor: 26 });
  assert.match(out.text, /install-command: npm install --no-save --include=optional/);
  assert.match(out.text, /node-cache: ""/);
  assert.match(out.text, /gate-commands: npm test/);
  assert.match(out.text, /node-version: "26"/);
  assert.match(out.text, /# No committed lockfile; match ci\.yml/, "unrelated comments survive");
});

test("isomorphic-jj: gate-commands preserved verbatim and tag-ref use warned about", () => {
  const before = read("consumers", "isomorphic-jj.publish.yml");
  const out = convertWorkflowText(before, { engineMajor: 26 });
  const gate = (t) => t.slice(t.indexOf("gate-commands:"));
  assert.equal(gate(out.text), gate(before));
  assert.ok(out.warnings.some((w) => /refs\/tags/.test(w)));
});

test("workflow_dispatch inputs and extra triggers are preserved; cancel-in-progress forced false; top-level perms get id-token", () => {
  const out = convertWorkflowText(read("synthetic", "laya-like.yml"), { engineMajor: 24 });
  assert.match(out.text, /workflow_dispatch:\n {4}inputs:\n {6}dry_run:\n {8}description: "Dry run/);
  assert.match(out.text, /\n {2}pull_request:\n/);
  assert.ok(out.warnings.some((w) => /extra trigger `pull_request`/.test(w)));
  assert.match(out.text, /group: release\n {2}cancel-in-progress: false/);
  assert.match(out.text, /\npermissions:\n {2}id-token: write # npm provenance\n {2}contents: write\n {2}pull-requests: write\n/);
  assert.equal(convertWorkflowText(out.text, { engineMajor: 24 }).text, out.text);
  assert.deepEqual(lintWorkflow({ text: out.text, engineMajor: 24 }), []);
});

test(".yaml file with extra permission keys keeps them", () => {
  const out = convertWorkflowText(read("synthetic", "tester-like.yaml"), { engineMajor: 26 });
  assert.match(out.text, /contents: write[^\n]*\n {6}id-token: write[^\n]*\n {6}pull-requests: read/);
  assert.match(out.text, /gate-commands: \|\n {8}npm run build\n {8}npm test/);
  assert.deepEqual(lintWorkflow({ text: out.text, engineMajor: 26 }), []);
});

test("reusable caller with no node-version gets one when engines is not 26", () => {
  const out = convertWorkflowText(read("synthetic", "tester-like.yaml"), { engineMajor: 24 });
  assert.match(out.text, /with:\n {6}node-version: "24"\n {6}gate-commands/);
  assert.equal(convertWorkflowText(out.text, { engineMajor: 24 }).text, out.text);
});

test("unparseable / on-less files are left untouched with a warning", () => {
  assert.equal(convertWorkflowText("a: [x\n").text, "a: [x\n");
  const r = convertWorkflowText("name: x\njobs: {}\n");
  assert.equal(r.text, "name: x\njobs: {}\n");
  assert.ok(r.warnings.length);
});

function tmpRepo(files, pkg = { engines: { node: ">=26" } }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cp-"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), content);
  }
  return d;
}
const snapshot = (d) => {
  const out = {};
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : (out[path.relative(d, path.join(dir, e.name))] = fs.readFileSync(path.join(dir, e.name), "utf8"))));
  walk(d);
  return out;
};

test("repo run: converts, creates ci.yml with workflow-lint, second run is a no-op", () => {
  const d = tmpRepo({ ".github/workflows/publish.yml": read("consumers", "fileable.publish.yml") });
  const first = convertRepo(d);
  assert.deepEqual(first.files.map((f) => [f.file, f.created, f.changed]), [[".github/workflows/publish.yml", false, true], [".github/workflows/ci.yml", true, true]]);
  const after = snapshot(d);
  assert.match(after[".github/workflows/ci.yml"], /uses: johnhenry\/workflows\/\.github\/workflows\/workflow-lint\.yml@v1/);
  const second = convertRepo(d);
  assert.equal(second.files.filter((f) => f.changed).length, 0);
  assert.deepEqual(snapshot(d), after, "files changed on second run");
  assert.match(formatSummary(second), /Nothing to change/);
});

test("repo run: adds a job to an existing ci.yml without disturbing it, once", () => {
  const ci = read("synthetic", "ci-existing.yml");
  const d = tmpRepo({ ".github/workflows/ci.yml": ci, ".github/workflows/release.yaml": read("synthetic", "tester-like.yaml") });
  convertRepo(d);
  const out = snapshot(d)[".github/workflows/ci.yml"];
  assert.ok(out.startsWith(ci.replace(/\n$/, "")), "existing content is a prefix");
  assert.match(out, /\n {2}workflow-lint:\n {4}uses: johnhenry\/workflows\/\.github\/workflows\/workflow-lint\.yml@v1\n$/);
  const again = convertRepo(d);
  assert.equal(again.files.filter((f) => f.changed).length, 0);
  assert.equal(addWorkflowLint(d).text, null);
});

test("repo run: dry-run writes nothing; --no-ci skips ci.yml; ci wiring detected under any filename", () => {
  const d = tmpRepo({ ".github/workflows/publish.yml": read("consumers", "wsh.publish.yml") });
  const before = snapshot(d);
  const r = convertRepo(d, { dryRun: true });
  assert.ok(r.files.some((f) => f.changed));
  assert.deepEqual(snapshot(d), before);
  assert.equal(convertRepo(d, { ci: false, dryRun: true }).files.length, 1);
  const wired = tmpRepo({ ".github/workflows/checks.yml": "on: push\njobs:\n  l:\n    uses: johnhenry/workflows/.github/workflows/workflow-lint.yml@v1\n" });
  assert.equal(addWorkflowLint(wired).text, null);
});

test("repo run: node major comes from engines (monorepo -> highest workspace floor)", () => {
  const d = tmpRepo(
    { ".github/workflows/publish.yml": read("consumers", "raijin.publish.yml"), "packages/a/package.json": '{"engines":{"node":">=22"}}', "packages/b/package.json": '{"engines":{"node":">=25"}}' },
    { workspaces: ["packages/*"] },
  );
  convertRepo(d, { ci: false });
  assert.match(snapshot(d)[".github/workflows/publish.yml"], /node-version: 25/);
});

test("diff summary reports +/- counts", () => {
  assert.deepEqual(lineDiff(["a", "b", "c"], ["a", "x", "c", "d"]).filter((o) => o.op !== " ").map((o) => o.op + o.text), ["-b", "+x", "+d"]);
  const d = tmpRepo({ ".github/workflows/publish.yml": read("consumers", "wsh.publish.yml") });
  const s = formatSummary(convertRepo(d, { dryRun: true }));
  assert.match(s, /change \.github\/workflows\/publish\.yml {2}\(\+\d+ -\d+\)/);
  assert.match(s, /create \.github\/workflows\/ci\.yml/);
  assert.match(s, /^ {4}\+ {5}branches: \[main\]$/m);
});

test("multi-file repo: default groups are suffixed with the workflow basename and distinct", () => {
  const d = tmpRepo({
    ".github/workflows/publish.yml": read("consumers", "isomorphic-jj.publish.yml"),
    ".github/workflows/publish-unscoped.yml": read("consumers", "isomorphic-jj.publish-unscoped.yml"),
  });
  convertRepo(d, { ci: false });
  const a = fs.readFileSync(path.join(d, ".github/workflows/publish.yml"), "utf8");
  const b = fs.readFileSync(path.join(d, ".github/workflows/publish-unscoped.yml"), "utf8");
  assert.match(a, /group: publish-\$\{\{ github\.ref \}\}/);
  assert.match(b, /group: publish-unscoped-\$\{\{ github\.ref \}\}/);
  const { results } = lintRepo(d);
  assert.deepEqual(results.flatMap((r) => r.findings.filter((f) => f.rule === "concurrency-group-unique")), []);
  const again = convertRepo(d, { ci: false });
  assert.equal(again.files.filter((f) => f.changed).length, 0);
});

test("multi-file repo: a colliding existing group is suffixed and reported", () => {
  const wf = (g) => read("expected", "fileable.publish.yml").replace(/group: .*/, `group: ${g}`);
  const d = tmpRepo({ ".github/workflows/publish.yml": wf("shared"), ".github/workflows/release.yml": wf("shared") });
  const r = convertRepo(d, { ci: false });
  assert.ok(r.warnings.some((w) => /shared with another publish workflow/.test(w)));
  const a = fs.readFileSync(path.join(d, ".github/workflows/publish.yml"), "utf8");
  const b = fs.readFileSync(path.join(d, ".github/workflows/release.yml"), "utf8");
  assert.match(a, /group: shared-publish$/m);
  assert.match(b, /group: shared-release$/m);
  assert.equal(convertRepo(d, { ci: false }).files.filter((f) => f.changed).length, 0);
});

test("single-file repo: an existing shared-looking group is preserved verbatim", () => {
  const d = tmpRepo({ ".github/workflows/publish.yml": read("expected", "fileable.publish.yml").replace(/group: .*/, "group: shared") });
  convertRepo(d, { ci: false });
  assert.match(fs.readFileSync(path.join(d, ".github/workflows/publish.yml"), "utf8"), /group: shared$/m);
});

// Issue #6: select by content, not filename.
const NON_NPM = { "wsh.release-rust.yml": "release-rust.yml", "math-plus.release-interop-python.yml": "release-interop-python.yml" };

test("non-npm release workflows (rust binaries, PyPI) are untouched, unflagged and reported as skipped", () => {
  const files = { ".github/workflows/publish.yml": read("consumers", "fileable.publish.yml") };
  for (const [fx, name] of Object.entries(NON_NPM)) files[`.github/workflows/${name}`] = read("non-npm", fx);
  const d = tmpRepo(files);
  const r = convertRepo(d);
  assert.deepEqual(r.files.map((f) => f.file).filter((f) => f.includes("release-")), []);
  assert.deepEqual(r.infos.sort(), [
    "skipped .github/workflows/release-interop-python.yml: does not publish to npm",
    "skipped .github/workflows/release-rust.yml: does not publish to npm",
  ]);
  assert.match(formatSummary(r), /INFO skipped .*release-rust\.yml: does not publish to npm/);
  for (const [fx, name] of Object.entries(NON_NPM))
    assert.equal(fs.readFileSync(path.join(d, ".github/workflows", name), "utf8"), read("non-npm", fx));
  // the lone publish workflow is the only one that gets multi-file treatment -> default group unchanged
  assert.match(fs.readFileSync(path.join(d, ".github/workflows/publish.yml"), "utf8"), /group: publish-\$\{\{ github\.ref \}\}/);
});

test("lintRepo skips non-publish release workflows (rust) with an INFO and no findings; PyPI ones are linted", () => {
  const files = { ".github/workflows/publish.yml": read("expected", "fileable.publish.yml") };
  files[".github/workflows/release-rust.yml"] = read("non-npm", "wsh.release-rust.yml");
  const d = tmpRepo(files);
  const r = lintRepo(d);
  assert.deepEqual(r.files, [".github/workflows/publish.yml"]);
  assert.equal(r.skipped.length, 1);
  assert.deepEqual(r.results.flatMap((x) => x.findings), []);
});

const count = (t, re) => (t.match(re) ?? []).length;
const COMPOSITE = /uses: johnhenry\/workflows\/\.github\/actions\/create-release@v1/g;

test("release by-product: inline npm publish jobs get probe + composite, guarded by the publish step's outcome", () => {
  for (const name of ["apple-foundation-models", "domable", "math-grapher", "packfile"]) {
    const out = convertWorkflowText(read("consumers", `${name}.publish.yml`), { engineMajor: 26 }).text;
    assert.equal(count(out, COMPOSITE), 1, name);
    assert.match(out, /if: steps\.release-probe\.outputs\.new == 'true' && steps\.publish\.outcome == 'success'/, name);
    assert.match(out, /contents: write/, name);
    assert.ok(out.indexOf("id: release-probe") < out.indexOf("id: publish") && out.indexOf("id: publish") < out.indexOf("create-release@v1"), "order: probe, publish, release");
  }
});

test("release by-product: a hand-written release step is detected; no second one is added", () => {
  const src = read("consumers", "a2a-query.release-main.yml");
  assert.match(src, /gh release create/);
  const out = convertWorkflowText(src, { engineMajor: 26 }).text;
  assert.equal(out, src);
  assert.equal(count(out, COMPOSITE), 0);
  // same for a job that already uses the composite
  const withComposite = convertWorkflowText(read("consumers", "domable.publish.yml"), { engineMajor: 26 }).text;
  assert.equal(count(convertWorkflowText(withComposite, { engineMajor: 26 }).text, COMPOSITE), 1);
});

test("release by-product: monorepo (npm publish -w) and reusable callers get no composite step", () => {
  assert.equal(count(convertWorkflowText(read("consumers", "raijin.publish.yml"), { engineMajor: 26 }).text, COMPOSITE), 0);
  assert.equal(count(convertWorkflowText(read("consumers", "fileable.publish.yml"), { engineMajor: 26 }).text, COMPOSITE), 0);
});

test("release by-product: an existing publish step id is reused", () => {
  const src = read("consumers", "domable.publish.yml").replace("      - name: Publish\n", "      - name: Publish\n        id: pub\n");
  const out = convertWorkflowText(src, { engineMajor: 26 }).text;
  assert.match(out, /steps\.pub\.outcome == 'success'/);
  assert.doesNotMatch(out, /id: publish/);
});
