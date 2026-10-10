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

function sandbox({ version = "1.2.3", name = "@johnhenry/pkg", npmBody } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "np-"));
  const bin = path.join(d, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name, version }));
  const fake = (n, body) => {
    fs.writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\necho "${n} $*" >> "$CALLS"\n${body}\n`, { mode: 0o755 });
  };
  fake("npm", npmBody ?? 'if [ "$1" = view ]; then [ "$FAKE_NPM_HAS_VERSION" = 1 ]; exit $?; fi; exit 0');
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

test("workflow contract: inputs, outputs, gating, no job-level permissions", () => {
  const i = wf.on.workflow_call.inputs;
  assert.deepEqual(Object.keys(i).sort(), ["create-release", "gate-commands", "install-command", "node-cache", "node-version", "release-notes", "verify-interval", "verify-timeout", "working-directory"]);
  assert.equal(i["create-release"].default, true);
  assert.equal(i["create-release"].type, "boolean");
  assert.equal(i["release-notes"].default, "auto");
  assert.equal(i["node-version"].default, "26");
  assert.deepEqual(Object.keys(wf.on.workflow_call.outputs).sort(), ["published", "version"]);
  assert.equal(wf.jobs.publish.permissions, undefined, "requesting permissions here would break callers granting only contents: read");
  const rel = steps.find((s) => s.name?.startsWith("Tag and GitHub Release"));
  assert.match(rel.if, /published == 'true'/);
  assert.match(rel.if, /inputs\.create-release/);
  assert.equal(rel.uses, "johnhenry/workflows/.github/actions/create-release@v1", "one implementation: the by-product step is the composite action");
  assert.equal(rel.run, undefined);
  assert.equal(rel.with.notes, "${{ inputs.release-notes }}");
  assert.equal(wf.on.workflow_call.secrets.NPM_TOKEN.required, false, "NPM_TOKEN optional: OIDC-only callers have no secret");
  const pub = steps.find((s) => s.id === "publish");
  assert.equal(pub.env.NODE_AUTH_TOKEN, "${{ secrets.NPM_TOKEN }}", "token path unchanged");
  assert.match(pub.run, /-z "\$\{NODE_AUTH_TOKEN:-\}"/);
  assert.match(pub.run, /unset NODE_AUTH_TOKEN/);
  assert.match(pub.run, /npm publish --provenance --access public/);
  const npmStep = steps.find((s) => s.name?.startsWith("Ensure npm supports trusted publishing"));
  assert.match(npmStep.run, /11\.5\.1/);
  assert.equal(npmStep.if, undefined, "step-level env is invisible to step if; the script checks the token");
  assert.match(npmStep.run, /-n "\$\{NODE_AUTH_TOKEN:-\}"/);
});

test("npm-publish.yml declares no concurrency block (same-group deadlock invariant)", () => {
  assert.equal("concurrency" in wf, false);
  for (const job of Object.values(wf.jobs)) assert.equal("concurrency" in job, false);
});

test("verification runs after publish and before the tag/release by-product", () => {
  const names = steps.map((s) => s.name ?? s.uses);
  const iPub = steps.findIndex((s) => s.id === "publish");
  const iVer = steps.findIndex((s) => s.uses === "johnhenry/workflows/.github/actions/verify-published@v1");
  const iRel = steps.findIndex((s) => s.name?.startsWith("Tag and GitHub Release"));
  assert.ok(iVer > iPub && iVer < iRel, names.join(" | "));
  const v = steps[iVer];
  assert.match(v.if, /published == 'true'/);
  assert.equal(v.with.packages, "${{ steps.publish.outputs.name }}@${{ steps.publish.outputs.version }}");
  assert.equal(v.with["timeout-minutes"], "${{ inputs.verify-timeout }}");
  assert.equal(v.with["interval-seconds"], "${{ inputs.verify-interval }}");
  const i = wf.on.workflow_call.inputs;
  assert.equal(i["verify-timeout"].default, "10");
  assert.equal(i["verify-interval"].default, "20");
  assert.equal(i["verify-timeout"].type, "string");
});

test("publish: E404 on a name that does not exist on the registry prints first-publish guidance and still fails", () => {
  const s = sandbox({ npmBody: 'if [ "$1" = view ]; then echo "npm error code E404" >&2; exit 1; fi; if [ "$1" = publish ]; then echo "npm error code E404" >&2; exit 1; fi; exit 0' });
  const r = s.run(PUBLISH);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /::error title=First publish of a new package name/);
  assert.match(r.stdout + r.stderr, /trusted publishing cannot create/i);
  assert.match(r.stdout + r.stderr, /objectify\/issues\/9/);
  assert.equal(r.outputs.published, undefined);
});

test("publish: E404 on a name that DOES exist (e.g. missing scope access) is not mislabelled as first publish", () => {
  const s = sandbox({ npmBody: 'if [ "$1" = view ]; then if [[ "$2" == *@*.*.* ]]; then exit 1; fi; echo "@johnhenry/pkg"; exit 0; fi; if [ "$1" = publish ]; then echo "npm error code E404" >&2; exit 1; fi; exit 0' });
  const r = s.run(PUBLISH);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /First publish of a new package name/);
});

test("publish: a non-E404 publish failure fails without first-publish guidance", () => {
  const s = sandbox({ npmBody: 'if [ "$1" = view ]; then exit 1; fi; if [ "$1" = publish ]; then echo "npm error code EOTP" >&2; exit 1; fi; exit 0' });
  const r = s.run(PUBLISH);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout + r.stderr, /First publish of a new package name/);
});

for (const [label, msg] of [
  ["E409 previously staged version", "npm error code E409\nnpm error 409 Conflict - PUT https://registry.npmjs.org/pkg - previously staged version 1.2.3"],
  ["EPUBLISHCONFLICT", "npm error code EPUBLISHCONFLICT"],
  ["cannot publish over the previously published", "npm error You cannot publish over the previously published versions: 1.2.3."],
]) {
  test(`publish: ${label} on a not-yet-visible version is treated as already published (green, published=false, conflict=true)`, () => {
    const s = sandbox({ npmBody: `if [ "$1" = view ]; then exit 1; fi; if [ "$1" = publish ]; then printf '%s\\n' "${msg.replace(/\n/g, '" "')}" >&2; exit 1; fi; exit 0` });
    const r = s.run(PUBLISH);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.outputs.published, "false");
    assert.equal(r.outputs.conflict, "true");
    assert.equal(r.outputs.version, "1.2.3");
    assert.match(r.stdout, /::notice title=Already published/);
    assert.doesNotMatch(r.stdout + r.stderr, /First publish of a new package name/);
  });
}

test("publish: a normal success and a registry-visible skip do not set conflict", () => {
  assert.equal(sandbox().run(PUBLISH, { FAKE_NPM_HAS_VERSION: "0" }).outputs.conflict, undefined);
  assert.equal(sandbox().run(PUBLISH, { FAKE_NPM_HAS_VERSION: "1" }).outputs.conflict, undefined);
});

test("conflict (E409) still runs verify-published and the tag/release step (which skips itself if the tag exists)", () => {
  const ver = steps.find((s) => s.uses === "johnhenry/workflows/.github/actions/verify-published@v1");
  const rel = steps.find((s) => s.name?.startsWith("Tag and GitHub Release"));
  for (const s of [ver, rel]) {
    assert.match(s.if, /outputs\.published == 'true'/);
    assert.match(s.if, /outputs\.conflict == 'true'/);
  }
  assert.match(rel.if, /inputs\.create-release/);
});
