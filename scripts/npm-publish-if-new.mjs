#!/usr/bin/env node
// Publishes the current package.json version if it isn't on npm yet.
//
// Repo-agnostic version of tester's scripts/npm-publish-if-new.mjs (the
// ecosystem-cohesion plan's named best instance of this idempotent-publish
// logic already pulled out of inline bash). johnhenry/workflows'
// npm-publish.yml reusable workflow inlines this same guard directly as
// bash for zero cross-repo checkout coupling -- this script is the
// standalone, repo-agnostic form for anything that wants to invoke it
// directly: a monorepo's per-package publish loop, local/manual publish,
// or a repo that adopted this before the reusable workflow existed.
//
// By default reads name/version from package.json in the current working
// directory. Pass NAME and VERSION as positional CLI args to override --
// useful when the publishable package.json isn't in cwd (e.g. a monorepo
// workspace) or for local testing without a real package.json.
//
// Usage:
//   node scripts/npm-publish-if-new.mjs
//   node scripts/npm-publish-if-new.mjs @scope/name 1.2.3
//
// Requires NODE_AUTH_TOKEN in the environment for the publish step (same
// as `npm publish` always does). Exits non-zero on publish failure; exits
// 0 without publishing if the resolved version is already on the registry.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();

const [argName, argVersion] = process.argv.slice(2);

let name = argName;
let version = argVersion;

if (!name || !version) {
  const pkg = JSON.parse(
    await readFile(resolve(ROOT, "package.json"), "utf8"),
  );
  name ??= pkg.name;
  version ??= pkg.version;
}

const spec = `${name}@${version}`;
const npm = (args) => spawnSync("npm", args, { cwd: ROOT, encoding: "utf8" });

// Pre-flight idempotency guard (family standard): ask the registry whether
// this exact version already exists, rather than publishing and grepping
// npm's stderr for "cannot publish over the previously published
// versions" -- that older form breaks whenever npm rewords the error.
const view = npm(["view", spec, "version"]);
if (view.status === 0 && view.stdout.trim() !== "") {
  console.log(`⏭️  skip ${spec}: already published`);
  process.exit(0);
}

console.log(`🚀 publishing ${spec} ...`);
const publish = spawnSync(
  "npm",
  ["publish", "--provenance", "--access", "public"],
  { cwd: ROOT, stdio: "inherit" },
);
process.exit(publish.status ?? 1);
