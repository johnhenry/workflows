import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { lintWorkflow, warnWorkflow, lintRepo, RULES, WARN_RULES } from "../scripts/lint-publish-workflow.mjs";
import { engineInfo, globToRegExp, matchWorkflowFiles } from "../scripts/lib/repo-info.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, "fixtures", "lint", `${n}.yml`), "utf8");
const lint = (n, engineMajor = 26) => lintWorkflow({ text: fx(n), engineMajor });
const lineOf = (text, needle) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;

test("good fixtures produce no findings", () => {
  for (const n of ["good-reusable", "good-inline", "good-changesets", "good-pypi-reusable", "good-pypi-inline", "good-pypi-composite"]) assert.deepEqual(lint(n), [], n);
});

// [fixture, expected rule, text on the line the finding must point at]
const BAD = [
  ["bad-release-trigger", "no-release-trigger", "release:"],
  ["bad-tag-trigger", "no-tag-trigger", 'tags: ["v*"]'],
  ["bad-push-branches", "push-main-only", "branches: [main, next]"],
  ["bad-no-push", "push-main-only", "on:"],
  ["bad-no-dispatch", "workflow-dispatch", "on:"],
  ["bad-no-concurrency", "concurrency-no-cancel", "on:"],
  ["bad-cancel-true", "concurrency-no-cancel", "cancel-in-progress: true"],
  ["bad-no-id-token", "permissions-id-token", "permissions:"],
  ["bad-no-contents-write", "permissions-contents-write", "permissions:"],
  ["bad-node-mismatch", "node-matches-engines", 'node-version: "24"'],
  ["bad-inline-node", "node-matches-engines", "node-version: 24"],
  ["bad-no-secrets-inherit", "secrets-inherit", "publish:"],
  ["bad-changesets-no-pr-write", "permissions-pull-requests", "permissions:"],
  ["bad-pypi-push-branches", "push-main-only", "branches: [main, next]"],
  ["bad-pypi-tag-trigger", "no-tag-trigger", 'tags: ["v*"]'],
  ["bad-pypi-no-contents-write", "permissions-contents-write", "permissions:"],
  ["bad-pypi-composite-no-contents-write", "permissions-contents-write", "permissions:"],
  ["bad-pypi-no-id-token", "permissions-id-token", "permissions:"],
  ["bad-pypi-no-concurrency", "concurrency-no-cancel", "on:"],
  ["bad-pypi-cancel-true", "concurrency-no-cancel", "cancel-in-progress: true"],
];
for (const [name, rule, needle] of BAD) {
  test(`${name} -> ${rule} (line-numbered)`, () => {
    const found = lint(name);
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(found[0].rule, rule);
    // first line containing the needle at or before the reported line is the anchor
    const text = fx(name);
    const want = lineOf(text, needle);
    assert.equal(found[0].line, want, `${rule} should point at line ${want} (${needle})`);
    assert.ok(found[0].message.length > 20);
  });
}

test("every documented rule is covered by a bad fixture", () => {
  const covered = new Set(BAD.map((b) => b[1]));
  const REPO_LEVEL = new Set(["concurrency-group-unique"]); // covered by the lintRepo test below
  for (const r of Object.keys(RULES).filter((k) => !REPO_LEVEL.has(k))) assert.ok(covered.has(r), `no fixture for ${r}`);
});

test("node rule is skipped when engines is unknown or node-version is an expression", () => {
  assert.deepEqual(lint("bad-node-mismatch", null), []);
  const expr = fx("good-reusable").replace('node-version: "26"', "node-version: ${{ vars.NODE }}");
  assert.deepEqual(lintWorkflow({ text: expr, engineMajor: 22 }), []);
});

test("reusable caller without node-version is judged against the default 26", () => {
  const t = fx("good-reusable").replace(/ {6}node-version:.*\n/, "");
  assert.deepEqual(lintWorkflow({ text: t, engineMajor: 26 }), []);
  assert.equal(lintWorkflow({ text: t, engineMajor: 24 })[0].rule, "node-matches-engines");
});

test("workflow-level permissions satisfy the publish job", () => {
  const t = fx("good-inline").replace(/ {4}permissions:\n.*\n.*\n/, "").replace("jobs:", "permissions:\n  id-token: write\njobs:");
  assert.deepEqual(lintWorkflow({ text: t, engineMajor: 26 }), []);
});

test("string-form `on: [push]` and unparsable YAML are reported, not thrown", () => {
  const f = lintWorkflow({ text: "on: [push, release]\njobs: {}\n", engineMajor: 26 });
  assert.ok(f.some((x) => x.rule === "no-release-trigger"));
  assert.ok(f.some((x) => x.rule === "push-main-only"));
  assert.equal(lintWorkflow({ text: "a: [unclosed\n" })[0].rule, "parse-error");
});

test("non-publish jobs are not held to publish-job rules", () => {
  const t = "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  docs:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run docs\n";
  assert.deepEqual(lintWorkflow({ text: t, engineMajor: 26 }), []);
});

function tmpRepo(files, pkg = { engines: { node: ">=26" } }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wl-"));
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), content);
  }
  return d;
}

test("repo scan handles .yaml, npm-publish.yaml and content-sniffed workflows", () => {
  const d = tmpRepo({
    ".github/workflows/npm-publish.yaml": fx("bad-release-trigger"),
    ".github/workflows/deploy.yml": fx("good-inline"),
    ".github/workflows/ci.yml": "on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - run: npm test\n",
  });
  const { files, results } = lintRepo(d);
  assert.deepEqual(files, [".github/workflows/deploy.yml", ".github/workflows/npm-publish.yaml"]);
  assert.ok(results.find((r) => r.file.endsWith("npm-publish.yaml")).findings.length > 0);
  assert.equal(lintRepo(d, ".github/workflows/publish.yml").files.length, 0);
});

test("engines: root wins; monorepo falls back to highest workspace floor", () => {
  assert.equal(engineInfo(tmpRepo({}, { engines: { node: ">=24" } })).major, 24);
  const mono = tmpRepo(
    { "packages/a/package.json": '{"engines":{"node":">=22"}}', "packages/b/package.json": '{"engines":{"node":"^24.1"}}', "packages/c/package.json": "{}" },
    { workspaces: ["packages/*"] },
  );
  const info = engineInfo(mono);
  assert.equal(info.major, 24);
  assert.equal(info.monorepo, true);
  assert.equal(engineInfo(tmpRepo({}, {})).major, null);
  assert.equal(engineInfo(tmpRepo({}, { workspaces: { packages: ["x"] }, engines: { node: "26.x" } })).major, 26);
});

test("glob: braces and * stay inside one path segment", () => {
  const re = globToRegExp(".github/workflows/{publish,release}*.{yml,yaml}");
  for (const ok of [".github/workflows/publish.yml", ".github/workflows/release-npm.yaml"]) assert.ok(re.test(ok), ok);
  for (const no of [".github/workflows/ci.yml", ".github/workflows/publish.yml.bak", ".github/workflows/x/publish.yml"]) assert.ok(!re.test(no), no);
  assert.deepEqual(matchWorkflowFiles(tmpRepo({}), undefined), []);
});

test("templates lint clean", () => {
  for (const t of ["publish", "publish-changesets", "publish-pypi"]) {
    const text = fs.readFileSync(path.join(here, "..", "templates", `${t}.yml`), "utf8");
    assert.deepEqual(lintWorkflow({ text, engineMajor: 26 }), [], t);
    assert.deepEqual(warnWorkflow({ text }), [], `${t} must also be warning-free (verification wired)`);
  }
});

test("CLI: exit codes and line-numbered output", async () => {
  const script = path.join(here, "..", "scripts", "lint-publish-workflow.mjs");
  const bad = tmpRepo({ ".github/workflows/publish.yml": fx("bad-release-trigger") });
  const r = spawnSync(process.execPath, [script, bad], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\.github\/workflows\/publish\.yml:\d+: \[no-release-trigger\]/);
  const good = tmpRepo({ ".github/workflows/publish.yml": fx("good-reusable") });
  assert.equal(spawnSync(process.execPath, [script, good], { encoding: "utf8" }).status, 0);
  const none = tmpRepo({});
  assert.equal(spawnSync(process.execPath, [script, none], { encoding: "utf8" }).status, 0);
});

test("concurrency-group-unique: two publish workflows sharing a group fail, naming both files", () => {
  const good = fs.readFileSync(new URL("./fixtures/lint/good-reusable.yml", import.meta.url), "utf8");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cgu-"));
  fs.mkdirSync(path.join(d, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(d, ".github/workflows/publish.yml"), good);
  fs.writeFileSync(path.join(d, ".github/workflows/release.yml"), good);
  const { results } = lintRepo(d);
  const f = results.flatMap((r) => r.findings).filter((x) => x.rule === "concurrency-group-unique");
  assert.equal(f.length, 1);
  assert.match(f[0].message, /publish\.yml/);
  assert.ok(RULES["concurrency-group-unique"]);
  fs.writeFileSync(path.join(d, ".github/workflows/release.yml"), good.replace(/group: .*/, "group: release-${{ github.ref }}"));
  assert.deepEqual(lintRepo(d).results.flatMap((r) => r.findings).filter((x) => x.rule === "concurrency-group-unique"), []);
});

// --- warning-level rules (never fail the run) -------------------------------
const warn = (text) => warnWorkflow({ text });

test("verify-published: inline and changesets publish jobs without a verification step warn (line = job)", () => {
  for (const n of ["good-inline", "good-changesets"]) {
    const w = warn(fx(n));
    assert.equal(w.length, 1, n);
    assert.equal(w[0].rule, "verify-published");
    assert.equal(w[0].severity, "warning");
    assert.equal(w[0].line, lineOf(fx(n), "  publish:"));
    assert.match(w[0].message, /verify-published/);
  }
  assert.ok(WARN_RULES["verify-published"]);
  assert.equal(RULES["verify-published"], undefined, "warning rules are listed separately from error rules");
});

test("verify-published: reusable npm-publish.yml callers are exempt (it verifies itself)", () => {
  assert.deepEqual(warn(fx("good-reusable")), []);
});

test("verify-published: a verify-published action step or a script step silences the warning", () => {
  const act = fx("good-inline").replace("      - run: npm publish --provenance --access public", "      - run: npm publish --provenance --access public\n      - uses: johnhenry/workflows/.github/actions/verify-published@v1\n        with:\n          packages: x@1.0.0");
  assert.deepEqual(warn(act), []);
  const script = fx("good-inline").replace("      - run: npm publish --provenance --access public", "      - run: npm publish --provenance --access public\n      - run: node scripts/verify-published.mjs pkg");
  assert.deepEqual(warn(script), []);
});

test("verify-published: warnings do not affect error findings, and non-publish workflows never warn", () => {
  assert.deepEqual(lint("good-inline"), []);
  const t = "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  docs:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run docs\n";
  assert.deepEqual(warn(t), []);
});

test("verify-published: lintRepo reports warnings separately; CLI prints WARN but exits 0", () => {
  const d = tmpRepo({ ".github/workflows/publish.yml": fx("good-inline") });
  const { results } = lintRepo(d);
  assert.deepEqual(results[0].findings, []);
  assert.equal(results[0].warnings.length, 1);
  const r = spawnSync(process.execPath, [path.join(here, "..", "scripts", "lint-publish-workflow.mjs"), d], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true" } });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /publish\.yml:\d+: WARN \[verify-published\]/);
  assert.match(r.stdout, /::warning file=\.github\/workflows\/publish\.yml,line=\d+,title=verify-published::/);
  assert.doesNotMatch(r.stdout, /::error/);
  assert.match(r.stdout, /1 warning/);
});

// --- PyPI publish workflows --------------------------------------------------
test("PyPI: node-version/engines and npm verify-published rules never apply to PyPI jobs", () => {
  assert.deepEqual(lintWorkflow({ text: fx("good-pypi-inline"), engineMajor: 22 }), []);
  assert.deepEqual(lintWorkflow({ text: fx("good-pypi-reusable"), engineMajor: 22 }), []);
  assert.deepEqual(lintWorkflow({ text: fx("good-pypi-composite"), engineMajor: 22 }), []);
  assert.deepEqual(warn(fx("good-pypi-composite")), []);
  assert.deepEqual(warn(fx("good-pypi-inline")), []);
  assert.deepEqual(warn(fx("good-pypi-reusable")), []);
});

test("PyPI: reusable pypi-publish.yml callers do not need secrets: inherit", () => {
  assert.ok(!fx("good-pypi-reusable").includes("secrets:"));
  assert.deepEqual(lint("good-pypi-reusable"), []);
});

test("PyPI: the composite-action inline job is a publish job and still rejects release:/tags: triggers", () => {
  const text = fx("good-pypi-composite");
  const rel = lintWorkflow({ text: text.replace("  workflow_dispatch: {}\n", "  workflow_dispatch: {}\n  release:\n    types: [published]\n"), engineMajor: 26 }).map((f) => f.rule);
  assert.deepEqual(rel, ["no-release-trigger"]);
  const tags = lintWorkflow({ text: text.replace("    branches: [main]\n", "    branches: [main]\n    tags: ['v*']\n"), engineMajor: 26 }).map((f) => f.rule);
  assert.deepEqual(tags, ["no-tag-trigger"]);
  const d = tmpRepo({ ".github/workflows/release-py.yml": text });
  assert.deepEqual(lintRepo(d).files, [".github/workflows/release-py.yml"]);
});

test("PyPI: lintRepo classifies pypa action / pypi-publish.yml workflows as publish workflows, not skipped", () => {
  const d = tmpRepo({
    ".github/workflows/publish-pypi.yml": fx("bad-pypi-tag-trigger"),
    ".github/workflows/release-py.yml": fx("good-pypi-inline"),
    ".github/workflows/release-rust.yml": "on:\n  push:\n    tags: ['v*']\njobs:\n  b:\n    runs-on: x\n    steps:\n      - run: cargo publish\n",
  });
  const r = lintRepo(d);
  assert.deepEqual(r.files, [".github/workflows/publish-pypi.yml", ".github/workflows/release-py.yml"]);
  assert.deepEqual(r.skipped, [".github/workflows/release-rust.yml"]);
  assert.ok(r.results.find((x) => x.file.endsWith("publish-pypi.yml")).findings.some((f) => f.rule === "no-tag-trigger"));
});

test("PyPI: the pre-v1.4 math-plus tag-triggered workflow is now flagged", () => {
  const text = fs.readFileSync(path.join(here, "fixtures", "non-npm", "math-plus.release-interop-python.yml"), "utf8");
  const rules = lintWorkflow({ text, engineMajor: 26 }).map((f) => f.rule).sort();
  assert.deepEqual(rules, ["concurrency-no-cancel", "no-tag-trigger", "push-main-only"]);
});
