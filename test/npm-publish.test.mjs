// Dry-runs the real `run:` scripts of npm-publish.yml under bash, with fake
// `npm`, `gh` and `git` on PATH, to pin down the publish + tag/release logic.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../scripts/vendor/yaml.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const wfPath = path.join(here, "..", ".github", "workflows", "npm-publish.yml");
const wf = parseDocument(fs.readFileSync(wfPath, "utf8")).toJS();
const steps = wf.jobs.publish.steps;
const stepScript = (name) => steps.find((s) => s.name === name).run;
const PUBLISH = stepScript("Publish (idempotent)");
const RELEASE = stepScript("Tag and GitHub Release (by-product)");

function sandbox({ version = "1.2.3", name = "@johnhenry/pkg" } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "np-"));
  const bin = path.join(d, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name, version }));
  const fake = (n, body) => {
    fs.writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\necho "${n} $*" >> "$CALLS"\n${body}\n`, { mode: 0o755 });
  };
  fake("npm", 'if [ "$1" = view ]; then [ "$FAKE_NPM_HAS_VERSION" = 1 ]; exit $?; fi; exit 0');
  fake("git", 'if [ "$1" = ls-remote ]; then [ "$FAKE_TAG_EXISTS" = 1 ] && echo "abc123\trefs/tags/$3"; exit 0; fi; exit 0');
  fake("gh", 'case "$FAKE_GH" in forbidden) echo "HTTP 403: Resource not accessible by integration" >&2; exit 1;; exists) echo "HTTP 422: tag_name already exists" >&2; exit 1;; boom) echo "HTTP 500: kaboom" >&2; exit 1;; *) echo "https://github.com/o/r/releases/tag/x"; exit 0;; esac');
  const out = path.join(d, "out");
  const calls = path.join(d, "calls");
  fs.writeFileSync(out, "");
  fs.writeFileSync(calls, "");
  const run = (script, env = {}) => {
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      cwd: d,
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: d, GITHUB_OUTPUT: out, CALLS: calls, ...env },
    });
    return { ...r, outputs: Object.fromEntries(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))), calls: fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) };
  };
  return { run };
}

const relEnv = (extra = {}) => ({
  GH_TOKEN: "t", GH_REPO: "o/r", PKG_NAME: "@johnhenry/pkg", PKG_VERSION: "1.2.3", RELEASE_NOTES: "auto",
  DEFAULT_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: "deadbeef", ...extra,
});

test("publish: new version is published and reported", () => {
  const r = sandbox().run(PUBLISH, { FAKE_NPM_HAS_VERSION: "0" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.outputs, { version: "1.2.3", name: "@johnhenry/pkg", published: "true" });
  assert.ok(r.calls.includes("npm publish --provenance --access public"));
});

test("publish: version already on the registry is a clean skip (exit 0, published=false, no publish)", () => {
  const r = sandbox().run(PUBLISH, { FAKE_NPM_HAS_VERSION: "1" });
  assert.equal(r.status, 0);
  assert.equal(r.outputs.published, "false");
  assert.equal(r.outputs.version, "1.2.3");
  assert.ok(!r.calls.some((c) => c.startsWith("npm publish")));
  assert.match(r.stdout, /::notice title=Already published::/);
});

test("release: creates v<version> at the pushed commit with generated notes", () => {
  const r = sandbox().run(RELEASE, relEnv());
  assert.equal(r.status, 0, r.stderr);
  const call = r.calls.find((c) => c.startsWith("gh "));
  assert.equal(call, "gh release create v1.2.3 --target deadbeef --title v1.2.3 --generate-notes");
});

test("release: release-notes none writes a one-line body instead", () => {
  const r = sandbox().run(RELEASE, relEnv({ RELEASE_NOTES: "none" }));
  const call = r.calls.find((c) => c.startsWith("gh "));
  assert.doesNotMatch(call, /--generate-notes/);
  assert.match(call, /--notes Published to npm: https:\/\/www\.npmjs\.com\/package\/@johnhenry\/pkg\/v\/1\.2\.3/);
});

test("release: prerelease versions are flagged --prerelease", () => {
  const r = sandbox().run(RELEASE, relEnv({ PKG_VERSION: "2.0.0-rc.1" }));
  assert.match(r.calls.find((c) => c.startsWith("gh ")), /v2\.0\.0-rc\.1 .*--prerelease/);
});

test("release: existing tag -> skip cleanly, gh never called", () => {
  const r = sandbox().run(RELEASE, relEnv({ FAKE_TAG_EXISTS: "1" }));
  assert.equal(r.status, 0);
  assert.ok(!r.calls.some((c) => c.startsWith("gh ")));
  assert.match(r.stdout, /::notice title=Tag exists::/);
});

test("release: tag created by a racing run (gh says already exists) -> notice, not failure", () => {
  const r = sandbox().run(RELEASE, relEnv({ FAKE_GH: "exists" }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::notice title=Tag exists::/);
});

test("release: caller without contents: write -> warning, exit 0 (so moving v1 is safe)", () => {
  const r = sandbox().run(RELEASE, relEnv({ FAKE_GH: "forbidden" }));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /::warning title=Tag\/release skipped::.*contents: write/);
});

test("release: an unexpected gh error still fails the step loudly", () => {
  const r = sandbox().run(RELEASE, relEnv({ FAKE_GH: "boom" }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /kaboom/);
});

test("release: dispatch from a non-default branch does not tag", () => {
  const r = sandbox().run(RELEASE, relEnv({ GITHUB_REF_NAME: "feature/x" }));
  assert.equal(r.status, 0);
  assert.ok(!r.calls.some((c) => c.startsWith("gh ")));
});

test("workflow contract: inputs, outputs, gating, no job-level permissions", () => {
  const i = wf.on.workflow_call.inputs;
  assert.deepEqual(Object.keys(i).sort(), ["create-release", "gate-commands", "install-command", "node-cache", "node-version", "release-notes", "working-directory"]);
  assert.equal(i["create-release"].default, true);
  assert.equal(i["create-release"].type, "boolean");
  assert.equal(i["release-notes"].default, "auto");
  assert.equal(i["node-version"].default, "26");
  assert.deepEqual(Object.keys(wf.on.workflow_call.outputs).sort(), ["published", "version"]);
  assert.equal(wf.jobs.publish.permissions, undefined, "requesting permissions here would break callers granting only contents: read");
  const rel = steps.find((s) => s.name?.startsWith("Tag and GitHub Release"));
  assert.match(rel.if, /published == 'true'/);
  assert.match(rel.if, /inputs\.create-release/);
  assert.ok(wf.on.workflow_call.secrets.NPM_TOKEN.required);
});

test("npm-publish.yml declares no concurrency block (same-group deadlock invariant)", () => {
  assert.equal("concurrency" in wf, false);
  for (const job of Object.values(wf.jobs)) assert.equal("concurrency" in job, false);
});
