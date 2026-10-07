import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { convertWorkflowText, convertRepo, addWorkflowLint, formatSummary, lineDiff } from "../scripts/convert-publish.mjs";
import { lintWorkflow } from "../scripts/lint-publish-workflow.mjs";
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
  ["raijin.publish.yml", "release-only inline monorepo publish"],
];

for (const [name, what] of CONSUMERS) {
  test(`consumer fixture ${name} (${what})`, () => {
    const before = read("consumers", name);
    const a = convertWorkflowText(before, { engineMajor: 26 });
    const goldenPath = path.join(here, "fixtures", "expected", name);
    if (UPDATE) fs.writeFileSync(goldenPath, a.text);
    assert.equal(a.text, fs.readFileSync(goldenPath, "utf8"), "output differs from golden file");
    // idempotent
    assert.equal(convertWorkflowText(a.text, { engineMajor: 26 }).text, a.text, "second run changed the file");
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
    const norm = (t) => t.slice(t.indexOf("\njobs:")).replace(/node-version: 24/, "node-version: 26");
    assert.equal(norm(after).replace(/\n {4}permissions:\n(?: {6}.*\n)+/, "\n"), norm(before).replace(/\n {4}permissions:\n(?: {6}.*\n)+/, "\n"), name);
    assert.deepEqual(stepsOf(after).length, stepsOf(before).length);
  }
  const a2a = convertWorkflowText(read("consumers", "a2a-query.release.yml"), { engineMajor: 26 });
  assert.match(a2a.text, /DIST_TAG=rc/);
  assert.match(a2a.text, /group: npm-publish/, "existing concurrency group is preserved");
  assert.ok(a2a.warnings.some((w) => /tag ref/.test(w)), "tag-dependent steps are flagged for manual review");
  assert.doesNotMatch(a2a.text, /contents: write/, "inline jobs don't get contents: write");
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
