// Tests for the verify-published composite action's script, using an injected
// `view` for the polling logic and a fake `npm` on PATH for the CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../scripts/vendor/yaml.mjs";
import { parsePackageSpecs, readWorkspacePackages, verifyPublished, formatTable } from "../.github/actions/verify-published/verify-published.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const actionDir = path.join(here, "..", ".github", "actions", "verify-published");
const script = path.join(actionDir, "verify-published.mjs");

test("parsePackageSpecs handles scoped, unscoped, blanks, comments, commas", () => {
  assert.deepEqual(parsePackageSpecs("@a/b@1.0.0\nfoo@2.0.0-rc.1\n\n# c\n x@3.0.0 ,y@4.0.0"), [
    { name: "@a/b", version: "1.0.0" },
    { name: "foo", version: "2.0.0-rc.1" },
    { name: "x", version: "3.0.0" },
    { name: "y", version: "4.0.0" },
  ]);
  assert.deepEqual(parsePackageSpecs(""), []);
  assert.throws(() => parsePackageSpecs("@a/b"), /Invalid package spec/);
  assert.throws(() => parsePackageSpecs("foo@"), /Invalid package spec/);
});

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("found on the first poll", async () => {
  const { results, missing } = await verifyPublished([{ name: "a", version: "1.0.0" }], { view: () => true, ...fakeClock() });
  assert.equal(missing.length, 0);
  assert.equal(results[0].attempts, 1);
});

test("found late: keeps polling until it appears", async () => {
  let calls = 0;
  const { results, missing } = await verifyPublished([{ name: "a", version: "1.0.0" }, { name: "b", version: "2.0.0" }], {
    view: (n) => (n === "a" ? true : ++calls >= 4),
    timeoutMs: 600_000,
    intervalMs: 20_000,
    ...fakeClock(),
  });
  assert.equal(missing.length, 0);
  assert.equal(results[0].attempts, 1, "a found immediately and is not re-polled");
  assert.equal(results[1].attempts, 4);
});

test("never found: gives up after the timeout and reports it missing", async () => {
  const clock = fakeClock();
  const { results, missing } = await verifyPublished([{ name: "a", version: "1.0.0" }], { view: () => false, timeoutMs: 60_000, intervalMs: 20_000, ...clock });
  assert.deepEqual(missing.map((m) => m.name), ["a"]);
  assert.ok(results[0].attempts >= 3 && results[0].attempts <= 4, String(results[0].attempts));
  assert.ok(clock.now() <= 60_000);
  assert.match(formatTable(results), /a\s+1\.0\.0\s+MISSING/);
});

function mkMonorepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vp-"));
  const w = (rel, obj) => {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), JSON.stringify(obj));
  };
  w("package.json", { name: "root", private: true, version: "0.0.0", workspaces: ["packages/*", "tools/cli"] });
  w("packages/a/package.json", { name: "@s/a", version: "1.1.0" });
  w("packages/b/package.json", { name: "@s/b", version: "2.0.0" });
  w("packages/priv/package.json", { name: "@s/priv", version: "9.9.9", private: true });
  w("tools/cli/package.json", { name: "@s/cli", version: "0.3.0" });
  fs.mkdirSync(path.join(d, "packages/empty"), { recursive: true });
  return d;
}

test("readWorkspacePackages: skips private, empty dirs; supports globs and literal paths and {packages}", () => {
  const d = mkMonorepo();
  assert.deepEqual(readWorkspacePackages(d).map((p) => `${p.name}@${p.version}`).sort(), ["@s/a@1.1.0", "@s/b@2.0.0", "@s/cli@0.3.0"]);
  const pj = JSON.parse(fs.readFileSync(path.join(d, "package.json"), "utf8"));
  pj.workspaces = { packages: ["packages/*"] };
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify(pj));
  assert.equal(readWorkspacePackages(d).length, 2);
});

function cli(env, { npmBody }) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vpc-"));
  const bin = path.join(d, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "npm"), `#!/usr/bin/env bash\necho "$*" >> "$CALLS"\n${npmBody}\n`, { mode: 0o755 });
  const calls = path.join(d, "calls");
  fs.writeFileSync(calls, "");
  const r = spawnSync(process.execPath, [script], {
    cwd: env.VERIFY_ROOT ?? d,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: d, CALLS: calls, VERIFY_INTERVAL: "0.05", VERIFY_TIMEOUT: "0.01", ...env },
  });
  return { ...r, calls: fs.readFileSync(calls, "utf8").split("\n").filter(Boolean), dir: d };
}

test("CLI: all present -> exit 0 with table", () => {
  const r = cli({ VERIFY_PACKAGES: "@a/b@1.0.0\nfoo@2.0.0" }, { npmBody: 'echo "${2##*@}"' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /@a\/b\s+1\.0\.0\s+ok/);
  assert.ok(r.calls.includes("view @a/b@1.0.0 version --prefer-online"));
});

test("CLI: found late (fake npm view succeeds on the 3rd call)", () => {
  const r = cli(
    { VERIFY_PACKAGES: "foo@2.0.0", VERIFY_TIMEOUT: "0.1" },
    { npmBody: 'n=$(wc -l < "$CALLS"); if [ "$n" -ge 3 ]; then echo 2.0.0; else exit 1; fi' },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /foo\s+2\.0\.0\s+ok \(3 polls\)/);
});

test("CLI: never found -> exit 1, MISSING table, error annotation", () => {
  const r = cli({ VERIFY_PACKAGES: "foo@2.0.0\nbar@1.0.0" }, { npmBody: 'if [ "${2%@*}" = bar ]; then echo 1.0.0; else echo "npm error E404" >&2; exit 1; fi' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /foo\s+2\.0\.0\s+MISSING/);
  assert.match(r.stdout, /bar\s+1\.0\.0\s+ok/);
  assert.match(r.stderr, /::error title=Not on registry::foo@2\.0\.0/);
  assert.doesNotMatch(r.stderr, /bar@1\.0\.0 never/);
});

test("CLI: from-workspaces reads versions from the workspace package.json files", () => {
  const root = mkMonorepo();
  const r = cli({ VERIFY_FROM_WORKSPACES: "true", VERIFY_ROOT: root }, { npmBody: 'echo "${2##*@}"' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.split(" ")[1]).sort(), ["@s/a@1.1.0", "@s/b@2.0.0", "@s/cli@0.3.0"]);
});

test("CLI: nothing to verify is an error (misconfiguration must not pass silently)", () => {
  const r = cli({}, { npmBody: "exit 0" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no packages to verify/);
});

test("action.yml contract", () => {
  const a = parseDocument(fs.readFileSync(path.join(actionDir, "action.yml"), "utf8")).toJS();
  assert.equal(a.runs.using, "composite");
  assert.deepEqual(Object.keys(a.inputs).sort(), ["from-workspaces", "interval-seconds", "packages", "timeout-minutes", "working-directory"]);
  assert.equal(a.inputs["timeout-minutes"].default, "10");
  assert.equal(a.inputs["interval-seconds"].default, "20");
  assert.match(a.runs.steps[0].run, /verify-published\.mjs/);
});
