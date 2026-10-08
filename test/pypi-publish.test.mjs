// Contract + dry-run tests for the pypi-publish composite action: the real `run:` scripts under
// bash with a fake `curl` on PATH (no network), and a real python3 (>=3.11).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../scripts/vendor/yaml.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const wf = parseDocument(fs.readFileSync(path.join(here, "..", ".github", "actions", "pypi-publish", "action.yml"), "utf8")).toJS();
const steps = wf.runs.steps;
const step = (prefix) => steps.find((s) => (s.name ?? "").startsWith(prefix));

test("action contract: composite, inputs, outputs, run steps are bash in working-directory", () => {
  assert.equal(wf.runs.using, "composite");
  const i = wf.inputs;
  assert.deepEqual(Object.keys(i).sort(), ["build-command", "create-release", "gate-commands", "package-name", "python-version", "verify-interval", "verify-timeout", "working-directory"]);
  assert.equal(i["python-version"].default, "3.12");
  assert.equal(i["build-command"].default, "python -m build");
  assert.equal(i["create-release"].default, "true");
  assert.deepEqual(Object.keys(wf.outputs).sort(), ["published", "version"]);
  assert.ok(!steps.some((s) => (s.uses ?? "").startsWith("actions/checkout")), "the caller checks out");
  for (const s of steps.filter((x) => x.run)) {
    assert.equal(s.shell, "bash", s.name);
    assert.equal(s["working-directory"], "${{ inputs.working-directory }}", s.name);
  }
});

test("step order: check -> gate -> build -> publish -> verify -> tag/release, all gated on the PyPI check", () => {
  const names = steps.map((s) => s.name ?? s.uses);
  const idx = (p) => steps.findIndex((s) => (s.name ?? "").startsWith(p));
  const order = ["Check whether", "Gate", "Build", "Publish to PyPI", "Verify the version", "Tag and GitHub Release"].map(idx);
  assert.deepEqual([...order].sort((a, b) => a - b), order, names.join(" | "));
  for (const p of ["Gate", "Build", "Publish to PyPI", "Verify the version", "Tag and GitHub Release"]) assert.match(step(p).if, /exists == 'false'/, p);
  const pub = step("Publish to PyPI");
  assert.match(pub.uses, /^pypa\/gh-action-pypi-publish@/);
  const rel = step("Tag and GitHub Release");
  assert.equal(rel.uses, "johnhenry/workflows/.github/actions/create-release@v1");
  assert.match(rel.with["tag-prefix"], /-v$/);
  assert.match(rel.if, /inputs\.create-release == 'true'/);
});

function sandbox({ pyproject, codes }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pp-"));
  fs.writeFileSync(path.join(d, "pyproject.toml"), pyproject);
  const bin = path.join(d, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(d, "codes"), codes.join("\n") + "\n");
  // fake curl: pops the next HTTP code from the `codes` file (repeats the last)
  fs.writeFileSync(path.join(bin, "curl"), `#!/bin/bash\necho "$@" >> "${d}/curl.log"\nc=$(head -n1 "${d}/codes")\n[ "$(wc -l < "${d}/codes")" -gt 1 ] && sed -i 1d "${d}/codes"\nprintf %s "$c"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const run = (script, env = {}) => {
    const out = path.join(d, "out");
    fs.writeFileSync(out, "");
    const r = spawnSync("bash", ["-eo", "pipefail", "-c", script], { cwd: d, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, ...env } });
    return { ...r, outputs: Object.fromEntries(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2))), log: fs.existsSync(path.join(d, "curl.log")) ? fs.readFileSync(path.join(d, "curl.log"), "utf8") : "" };
  };
  return { d, run };
}
const PYPROJECT = '[project]\nname = "My_Pkg"\nversion = "1.2.3"\n';

test("meta: reads version and name from pyproject.toml; package-name input overrides", () => {
  const { run } = sandbox({ pyproject: PYPROJECT, codes: ["404"] });
  const a = run(step("Read name").run, { INPUT_NAME: "" });
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(a.outputs, { name: "My_Pkg", version: "1.2.3" });
  assert.equal(run(step("Read name").run, { INPUT_NAME: "other-name" }).outputs.name, "other-name");
});

test("meta: a missing static version fails loudly", () => {
  const { run } = sandbox({ pyproject: '[project]\nname = "x"\ndynamic = ["version"]\n', codes: ["404"] });
  const r = run(step("Read name").run, { INPUT_NAME: "" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /No static version/);
});

test("check: 200 -> exists=true (clean no-op), 404 -> exists=false, other -> fail; hits the version JSON URL", () => {
  const env = { PKG_NAME: "johnhenry-x", PKG_VERSION: "0.1.0" };
  const yes = sandbox({ pyproject: PYPROJECT, codes: ["200"] }).run(step("Check whether").run, env);
  assert.equal(yes.status, 0);
  assert.equal(yes.outputs.exists, "true");
  assert.match(yes.stdout, /::notice title=Already published::/);
  const no = sandbox({ pyproject: PYPROJECT, codes: ["404"] });
  const r = no.run(step("Check whether").run, env);
  assert.equal(r.outputs.exists, "false");
  assert.match(r.log, /https:\/\/pypi\.org\/pypi\/johnhenry-x\/0\.1\.0\/json/);
  const bad = sandbox({ pyproject: PYPROJECT, codes: ["503"] }).run(step("Check whether").run, env);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /PyPI lookup failed/);
  const flaky = sandbox({ pyproject: PYPROJECT, codes: ["503", "404"] }).run(step("Check whether").run, env);
  assert.equal(flaky.outputs.exists, "false", "transient 5xx is retried");
});

test("verify: polls until the version appears; fails after the timeout", () => {
  const env = { PKG_NAME: "x", PKG_VERSION: "1.0.0", TIMEOUT_MIN: "5", INTERVAL: "1" };
  const ok = sandbox({ pyproject: PYPROJECT, codes: ["404", "404", "200"] }).run(step("Verify the version").run, env);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /Verified/);
  const never = sandbox({ pyproject: PYPROJECT, codes: ["404"] }).run(step("Verify the version").run, { ...env, TIMEOUT_MIN: "0" });
  assert.equal(never.status, 1);
  assert.match(never.stdout, /title=Not on PyPI/);
});
