// Dry-runs the real `run:` script of the create-release composite action under
// bash, with fake `gh`, `git` on PATH, to pin down the tag + GitHub Release
// by-product (shared by npm-publish.yml and inline publish jobs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../scripts/vendor/yaml.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const action = parseDocument(fs.readFileSync(path.join(here, "..", ".github", "actions", "create-release", "action.yml"), "utf8")).toJS();
const RELEASE = action.runs.steps.find((s) => s.id === "release").run;

function sandbox({ name = "@johnhenry/pkg", version = "1.2.3" } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "cr-"));
  const bin = path.join(d, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(d, "pkg"));
  fs.writeFileSync(path.join(d, "pkg", "package.json"), JSON.stringify({ name, version }));
  const fake = (n, body) => {
    fs.writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\necho "${n} $*" >> "$CALLS"\n${body}\n`, { mode: 0o755 });
  };
  fake("git", 'if [ "$1" = ls-remote ]; then [ "$FAKE_TAG_EXISTS" = 1 ] && echo "abc123\trefs/tags/$3"; exit 0; fi; exit 0');
  fake("gh", 'case "$FAKE_GH" in forbidden) echo "HTTP 403: Resource not accessible by integration" >&2; exit 1;; exists) echo "HTTP 422: tag_name already exists" >&2; exit 1;; boom) echo "HTTP 500: kaboom" >&2; exit 1;; *) echo "https://github.com/o/r/releases/tag/x"; exit 0;; esac');
  const out = path.join(d, "out");
  const calls = path.join(d, "calls");
  fs.writeFileSync(out, "");
  fs.writeFileSync(calls, "");
  const run = (script, env = {}, cwd = d) => {
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
      cwd,
      encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: d, GITHUB_OUTPUT: out, CALLS: calls, ...env },
    });
    return { ...r, outputs: Object.fromEntries(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))), calls: fs.readFileSync(calls, "utf8").split("\n").filter(Boolean) };
  };
  return { run, dir: d };
}

const relEnv = (extra = {}) => ({
  GH_TOKEN: "t", GH_REPO: "o/r", VERSION: "1.2.3", TAG_PREFIX: "v", NOTES: "auto", PRERELEASE: "auto", PACKAGE_NAME: "@johnhenry/pkg",
  DEFAULT_BRANCH: "main", GITHUB_REF_NAME: "main", GITHUB_SHA: "deadbeef", ...extra,
});

test("release: creates v<version> at the pushed commit with generated notes", () => {
  const r = sandbox().run(RELEASE, relEnv());
  assert.equal(r.status, 0, r.stderr);
  const call = r.calls.find((c) => c.startsWith("gh "));
  assert.equal(call, "gh release create v1.2.3 --target deadbeef --title v1.2.3 --generate-notes");
});

test("release: release-notes none writes a one-line body instead", () => {
  const r = sandbox().run(RELEASE, relEnv({ NOTES: "none" }));
  const call = r.calls.find((c) => c.startsWith("gh "));
  assert.doesNotMatch(call, /--generate-notes/);
  assert.match(call, /--notes Published to npm: https:\/\/www\.npmjs\.com\/package\/@johnhenry\/pkg\/v\/1\.2\.3/);
});

test("release: prerelease versions are flagged --prerelease", () => {
  const r = sandbox().run(RELEASE, relEnv({ VERSION: "2.0.0-rc.1" }));
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


test("release: tag-prefix is honoured", () => {
  const r = sandbox().run(RELEASE, relEnv({ TAG_PREFIX: "pkg-v" }));
  assert.equal(r.calls.find((c) => c.startsWith("gh ")), "gh release create pkg-v1.2.3 --target deadbeef --title pkg-v1.2.3 --generate-notes");
});

test("release: prerelease true/false override the version heuristic", () => {
  const a = sandbox().run(RELEASE, relEnv({ PRERELEASE: "true" }));
  assert.match(a.calls.find((c) => c.startsWith("gh ")), /--prerelease/);
  const b = sandbox().run(RELEASE, relEnv({ VERSION: "2.0.0-rc.1", PRERELEASE: "false" }));
  assert.doesNotMatch(b.calls.find((c) => c.startsWith("gh ")), /--prerelease/);
});

test("release: outputs report created/tag; skip paths report created=false", () => {
  const ok = sandbox().run(RELEASE, relEnv());
  assert.deepEqual([ok.outputs.created, ok.outputs.tag], ["true", "v1.2.3"]);
  const skip = sandbox().run(RELEASE, relEnv({ FAKE_TAG_EXISTS: "1" }));
  assert.equal(skip.outputs.created, "false");
});

test("release: notes none without PACKAGE_NAME reads working-directory/package.json", () => {
  const s = sandbox({ name: "@johnhenry/other" });
  const r = s.run(RELEASE, relEnv({ NOTES: "none", PACKAGE_NAME: "" }), path.join(s.dir, "pkg"));
  assert.match(r.calls.find((c) => c.startsWith("gh ")), /package\/@johnhenry\/other\/v\/1\.2\.3/);
});

test("action contract: inputs, defaults, bash composite", () => {
  assert.equal(action.runs.using, "composite");
  assert.deepEqual(Object.keys(action.inputs).sort(), ["notes", "package-name", "prerelease", "tag-prefix", "version", "working-directory"]);
  assert.equal(action.inputs.version.required, true);
  assert.equal(action.inputs["tag-prefix"].default, "v");
  assert.equal(action.inputs.notes.default, "auto");
  assert.equal(action.inputs.prerelease.default, "auto");
  assert.equal(action.inputs["working-directory"].default, ".");
  assert.deepEqual(Object.keys(action.outputs).sort(), ["created", "tag"]);
  for (const s of action.runs.steps) assert.equal(s.shell, "bash");
});
