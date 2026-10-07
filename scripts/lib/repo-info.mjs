// Reads a consumer repo's package.json(s) to find the Node major the publish
// workflow must pin. Single package: root engines.node. Monorepo: root
// engines.node if present, else the highest floor among workspace packages.
import fs from "node:fs";
import path from "node:path";
import { majorOfRange } from "./workflow-model.mjs";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function workspaceDirs(root, patterns) {
  const out = [];
  for (const pat of patterns) {
    if (pat.startsWith("!")) continue;
    const clean = pat.replace(/\/+$/, "");
    if (clean.endsWith("/*") || clean.endsWith("/**")) {
      const base = path.join(root, clean.replace(/\/\*+$/, ""));
      if (!fs.existsSync(base)) continue;
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        if (e.isDirectory()) out.push(path.join(base, e.name));
      }
    } else out.push(path.join(root, clean));
  }
  return out;
}

export function engineInfo(repoPath) {
  const pkg = readJson(path.join(repoPath, "package.json"));
  if (!pkg) return { major: null, source: "no package.json", monorepo: false };
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  const monorepo = Array.isArray(ws) && ws.length > 0;
  const rootMajor = majorOfRange(pkg.engines?.node);
  if (rootMajor != null) return { major: rootMajor, source: "root engines.node", monorepo };
  if (monorepo) {
    let best = null;
    for (const dir of workspaceDirs(repoPath, ws)) {
      const m = majorOfRange(readJson(path.join(dir, "package.json"))?.engines?.node);
      if (m != null && (best == null || m > best)) best = m;
    }
    if (best != null) return { major: best, source: "highest workspace engines.node", monorepo };
  }
  return { major: null, source: "no engines.node", monorepo };
}

/** Minimal glob (`*`, `**`-free, `{a,b}` braces) over repo-relative paths. */
export function globToRegExp(glob) {
  const expand = (g) => {
    const m = /\{([^{}]*)\}/.exec(g);
    if (!m) return [g];
    return m[1].split(",").flatMap((alt) => expand(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)));
  };
  const alts = expand(glob).map((g) =>
    g
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join("[^/]*"),
  );
  return new RegExp(`^(?:${alts.join("|")})$`);
}

export const DEFAULT_PUBLISH_GLOB = ".github/workflows/{publish,release,npm-publish}*.{yml,yaml}";

export function matchWorkflowFiles(repoPath, glob = DEFAULT_PUBLISH_GLOB) {
  const re = globToRegExp(glob);
  const dir = path.join(repoPath, ".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => `.github/workflows/${f}`)
    .filter((rel) => re.test(rel))
    .sort();
}
