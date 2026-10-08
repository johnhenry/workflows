#!/usr/bin/env node
/**
 * Post-publish verification: confirm each package version is actually visible
 * on the npm registry (`npm view <name>@<version> version`).
 *
 * `npm publish` / `changeset publish` can log `+ pkg@x.y.z` and exit green for
 * a version the registry never stores (aimatey-wrapper 0.2.0, objectify 0.0.2),
 * so we poll until it shows up or the timeout elapses. Dependency-free.
 *
 * Env (set by action.yml; usable standalone):
 *   VERIFY_PACKAGES         newline/comma separated `name@version` list
 *   VERIFY_FROM_WORKSPACES  "true" to read every non-private workspace package.json
 *   VERIFY_ROOT             repo root for workspaces (default: cwd)
 *   VERIFY_TIMEOUT          minutes to keep polling (default 10)
 *   VERIFY_INTERVAL         seconds between polls (default 20)
 * Exits 1 with a table when any package never appears.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Real registry lookup: true iff name@version exists. */
export function npmView(name, version) {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version", "--prefer-online"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === version;
  } catch {
    return false;
  }
}

/** Parse "name@version" lines (newline or comma separated; blanks and # comments ignored). */
export function parsePackageSpecs(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/[\n,]/)) {
    const spec = raw.trim();
    if (!spec || spec.startsWith("#")) continue;
    const at = spec.lastIndexOf("@");
    if (at <= 0 || at === spec.length - 1) throw new Error(`Invalid package spec "${spec}": expected name@version`);
    out.push({ name: spec.slice(0, at), version: spec.slice(at + 1) });
  }
  return out;
}

function expandWorkspacePattern(root, pattern) {
  const p = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
  if (p.startsWith("!")) return [];
  const parts = p.split("/");
  let dirs = [root];
  for (const part of parts) {
    const next = [];
    for (const d of dirs) {
      if (part === "*" || part === "**") {
        if (!existsSync(d)) continue;
        for (const e of readdirSync(d)) {
          if (e === "node_modules" || e.startsWith(".")) continue;
          const full = join(d, e);
          if (statSync(full).isDirectory()) next.push(full);
        }
      } else next.push(join(d, part));
    }
    dirs = next;
  }
  return dirs;
}

/** Every non-private workspace package of the repo at `root`: [{name, version}]. */
export function readWorkspacePackages(root) {
  const rootPkgFile = join(root, "package.json");
  if (!existsSync(rootPkgFile)) throw new Error(`No package.json in ${root}`);
  const rootPkg = JSON.parse(readFileSync(rootPkgFile, "utf8"));
  const ws = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages;
  if (!Array.isArray(ws) || ws.length === 0) throw new Error(`${rootPkgFile} declares no "workspaces"`);
  const seen = new Map();
  for (const pattern of ws) {
    for (const dir of expandWorkspacePattern(root, pattern)) {
      const file = join(dir, "package.json");
      if (!existsSync(file)) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8"));
      if (pkg.private === true || !pkg.name || !pkg.version) continue;
      seen.set(pkg.name, { name: pkg.name, version: pkg.version });
    }
  }
  return [...seen.values()];
}

/**
 * Poll until every package is visible or the timeout elapses.
 * `view(name, version)` -> boolean|Promise<boolean>; `sleep(ms)`/`now()` injectable.
 */
export async function verifyPublished(packages, opts = {}) {
  const {
    timeoutMs = 10 * 60_000,
    intervalMs = 20_000,
    view = npmView,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = opts;
  const results = packages.map((p) => ({ ...p, found: false, attempts: 0 }));
  const start = now();
  for (;;) {
    for (const r of results) {
      if (r.found) continue;
      r.attempts++;
      r.found = Boolean(await view(r.name, r.version));
    }
    if (results.every((r) => r.found) || now() - start + intervalMs > timeoutMs) break;
    await sleep(intervalMs);
  }
  return { results, missing: results.filter((r) => !r.found) };
}

export function formatTable(results) {
  const w = Math.max(7, ...results.map((r) => r.name.length));
  const v = Math.max(7, ...results.map((r) => r.version.length));
  const lines = [`${"PACKAGE".padEnd(w)}  ${"VERSION".padEnd(v)}  STATUS`];
  for (const r of results) {
    lines.push(`${r.name.padEnd(w)}  ${r.version.padEnd(v)}  ${r.found ? "ok" : "MISSING"} (${r.attempts} poll${r.attempts === 1 ? "" : "s"})`);
  }
  return lines.join("\n");
}

export async function main(env = process.env, io = { log: console.log, error: console.error }, injected = {}) {
  const fromWorkspaces = String(env.VERIFY_FROM_WORKSPACES ?? "").toLowerCase() === "true";
  let packages = [];
  try {
    packages = parsePackageSpecs(env.VERIFY_PACKAGES);
    if (fromWorkspaces) {
      const have = new Set(packages.map((p) => `${p.name}@${p.version}`));
      for (const p of readWorkspacePackages(resolve(env.VERIFY_ROOT || process.cwd()))) {
        if (!have.has(`${p.name}@${p.version}`)) packages.push(p);
      }
    }
  } catch (e) {
    io.error(`::error title=verify-published::${e.message}`);
    return 2;
  }
  if (packages.length === 0) {
    io.error("::error title=verify-published::no packages to verify (set `packages` or `from-workspaces: true`)");
    return 2;
  }
  const timeoutMin = Number(env.VERIFY_TIMEOUT || 10);
  const intervalSec = Number(env.VERIFY_INTERVAL || 20);
  io.log(`Verifying ${packages.length} package(s) on the npm registry (timeout ${timeoutMin} min, every ${intervalSec}s)...`);
  const { results, missing } = await verifyPublished(packages, { timeoutMs: timeoutMin * 60_000, intervalMs: intervalSec * 1000, ...injected });
  const table = formatTable(results);
  io.log(table);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `### Registry verification\n\n\`\`\`\n${table}\n\`\`\`\n`);
    } catch {}
  }
  if (missing.length > 0) {
    io.error(`\nNot visible on the npm registry after ${timeoutMin} min (${missing.length}):`);
    for (const m of missing) io.error(`::error title=Not on registry::${m.name}@${m.version} never appeared on the npm registry although the publish step reported success`);
    io.error("The publish step claimed success but the registry never stored these versions. Re-dispatch the publish workflow (already-published versions are skipped).");
    return 1;
  }
  io.log("\nAll packages verified on the registry.");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
