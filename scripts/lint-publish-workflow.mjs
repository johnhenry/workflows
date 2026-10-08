#!/usr/bin/env node
// Lints a repo's npm publish workflows against the family's single publish
// model: "main is the release branch". Used by the reusable workflow-lint.yml
// and runnable locally:
//
//   node scripts/lint-publish-workflow.mjs [repo-path] [--glob '<glob>']
//
// Exits 1 (with `path:line: [rule] message` lines, plus GitHub annotations when
// running in Actions) if any publish workflow breaks a rule.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isScalar } from "./vendor/yaml.mjs";
import {
  parseWorkflow,
  pairOf,
  valueOf,
  scalarOf,
  triggersOf,
  stringList,
  jobsOf,
  effectivePermissions,
  concurrencyState,
  majorOfVersion,
} from "./lib/workflow-model.mjs";
import { engineInfo, matchWorkflowFiles, DEFAULT_PUBLISH_GLOB } from "./lib/repo-info.mjs";

export const RULES = {
  "no-release-trigger": "`release:` trigger is forbidden (publish on push to main only)",
  "no-tag-trigger": "`push.tags` / `push.tags-ignore` triggers are forbidden",
  "push-main-only": "must trigger on `push: branches: [main]`",
  "workflow-dispatch": "must have a `workflow_dispatch` trigger",
  "concurrency-no-cancel": "must set `concurrency` with `cancel-in-progress: false`",
  "permissions-id-token": "publish job needs `permissions: id-token: write`",
  "permissions-contents-write": "job calling npm-publish.yml needs `permissions: contents: write`",
  "permissions-pull-requests": "job using changesets/action needs `permissions: pull-requests: write` (it opens the Version Packages PR); the repo setting \"Allow GitHub Actions to create and approve pull requests\" must also be on",
  "node-matches-engines": "`node-version` major must equal the repo's `engines.node` major",
  "secrets-inherit": "job calling npm-publish.yml needs `secrets: inherit`",
  "concurrency-group-unique": "when a repo has several publish workflows, each `concurrency.group` must be distinct (a shared group makes GitHub cancel queued runs)",
};

/** Concurrency groups used by a workflow's publish jobs (workflow- or job-level): [{ group, line }]. */
export function publishGroups(text) {
  const wf = parseWorkflow(text);
  if (wf.errors.length || !wf.root) return [];
  const seen = new Map();
  for (const job of jobsOf(wf).filter((j) => j.isPublish)) {
    const c = concurrencyState(wf, job);
    if (c.present && c.group && !seen.has(c.group)) seen.set(c.group, c.line);
  }
  return [...seen].map(([group, line]) => ({ group, line }));
}

/**
 * @param {{ text: string, file?: string, engineMajor?: number|null }} input
 * @returns {{ line: number, rule: string, message: string }[]}
 */
export function lintWorkflow({ text, engineMajor = null }) {
  const out = [];
  const add = (line, rule, message) => out.push({ line, rule, message });
  const wf = parseWorkflow(text);
  if (wf.errors.length || !wf.root) {
    for (const e of wf.errors) add(e.line, "parse-error", `YAML parse error: ${e.message}`);
    if (!wf.root && !wf.errors.length) add(1, "parse-error", "workflow is not a YAML mapping");
    return out;
  }

  // --- triggers -----------------------------------------------------------
  const trig = triggersOf(wf);
  if (!trig) {
    add(1, "push-main-only", "no `on:` block found");
  } else {
    const ev = trig.events;
    if (ev.release) add(ev.release.line, "no-release-trigger", "`release:` trigger found; publish on push to main instead (a release event is also the one GitHub drops in the post-merge race)");
    const push = ev.push;
    if (push?.node && isMap(push.node)) {
      const tags = pairOf(push.node, "tags");
      const tagsIgnore = pairOf(push.node, "tags-ignore");
      if (tags) add(wf.lineOf(tags.key.range[0]), "no-tag-trigger", "`push.tags` trigger found; tag pushes must not publish (the tag is created as a by-product of publishing)");
      if (tagsIgnore) add(wf.lineOf(tagsIgnore.key.range[0]), "no-tag-trigger", "`push.tags-ignore` found; remove it, and list `branches: [main]` instead");
      const branches = pairOf(push.node, "branches");
      const list = branches ? stringList(branches.value) : [];
      if (!(list.length === 1 && list[0] === "main")) {
        add(branches ? wf.lineOf(branches.key.range[0]) : push.line, "push-main-only", branches ? `push.branches is [${list.join(", ")}]; it must be exactly [main]` : "`push` has no `branches: [main]`");
      }
      const brIgnore = pairOf(push.node, "branches-ignore");
      if (brIgnore) add(wf.lineOf(brIgnore.key.range[0]), "push-main-only", "`push.branches-ignore` found; use `branches: [main]`");
    } else if (push) {
      add(push.line, "push-main-only", "`push` has no `branches: [main]`");
    } else {
      add(trig.line, "push-main-only", "no `push` trigger; add `push: { branches: [main] }`");
    }
    if (!ev.workflow_dispatch) add(trig.line, "workflow-dispatch", "no `workflow_dispatch` trigger (needed to re-run a publish by hand)");
  }

  // --- publish jobs --------------------------------------------------------
  const publishJobs = jobsOf(wf).filter((j) => j.isPublish);
  if (publishJobs.length === 0) return out.sort((a, b) => a.line - b.line);

  const workflowConc = concurrencyState(wf, null);
  if (!workflowConc.present) {
    // maybe set per job
    const anyJob = publishJobs.every((j) => concurrencyState(wf, j).present);
    if (!anyJob) add(trig?.line ?? 1, "concurrency-no-cancel", "no `concurrency:` block; add `concurrency: { group: publish-${{ github.ref }}, cancel-in-progress: false }` so overlapping publishes queue instead of racing");
  }
  for (const job of publishJobs) {
    const c = concurrencyState(wf, job);
    if (c.present && !c.cancelFalse) {
      add(c.cancelLine ?? c.line, "concurrency-no-cancel", `\`concurrency\` must set \`cancel-in-progress: false\` (a cancelled publish can leave a half-published release)`);
    }

    const perms = effectivePermissions(wf, job);
    const permLine = () => {
      const pair = pairOf(job.map, "permissions") ?? pairOf(wf.root, "permissions");
      return pair ? wf.lineOf(pair.key.range[0]) : job.line;
    };
    if (perms.level("id-token") !== "write") {
      add(permLine(), "permissions-id-token", `job \`${job.id}\` needs \`permissions: id-token: write\` (npm provenance / trusted publishing)`);
    }
    if (job.usesChangesets && perms.level("pull-requests") !== "write") {
      add(permLine(), "permissions-pull-requests", `job \`${job.id}\` uses changesets/action and needs \`permissions: pull-requests: write\` to open the "Version Packages" PR (and the repo setting Settings > Actions > General > "Allow GitHub Actions to create and approve pull requests" must be enabled: \`gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true\`)`);
    }
    if (job.reusable) {
      if (perms.level("contents") !== "write") {
        add(permLine(), "permissions-contents-write", `job \`${job.id}\` calls npm-publish.yml and needs \`permissions: contents: write\` so it can create the v<version> tag and GitHub Release`);
      }
      const secrets = valueOf(job.map, "secrets");
      if (!(isScalar(secrets) && secrets.value === "inherit")) {
        add(secrets?.range ? wf.lineOf(secrets.range[0]) : job.line, "secrets-inherit", `job \`${job.id}\` calls npm-publish.yml and needs \`secrets: inherit\``);
      }
    }

    // node-version vs engines
    if (engineMajor != null) {
      const nodeVersions = [];
      if (job.reusable) {
        const withMap = valueOf(job.map, "with");
        const nv = valueOf(withMap, "node-version");
        nodeVersions.push(nv ? { node: nv, line: wf.lineOf(nv.range[0]) } : { node: null, line: job.line });
      } else {
        for (const s of job.steps) {
          if (typeof s.uses === "string" && s.uses.startsWith("actions/setup-node")) {
            const nv = valueOf(valueOf(s.map, "with"), "node-version");
            if (nv) nodeVersions.push({ node: nv, line: wf.lineOf(nv.range[0]) });
          }
        }
      }
      for (const { node, line } of nodeVersions) {
        const raw = node ? scalarOf(node) : 26; // reusable default is "26"
        if (typeof raw === "string" && raw.includes("${{")) continue;
        const major = majorOfVersion(raw);
        if (major == null) continue; // lts/*, node-version-file, etc.
        if (major !== engineMajor) {
          add(line, "node-matches-engines", `node-version ${node ? `"${raw}"` : "(default 26)"} does not match engines.node major ${engineMajor}; the publish must run on the Node the package declares`);
        }
      }
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

/**
 * Select publish workflows by CONTENT: a workflow qualifies only if a job calls
 * npm-publish.yml, runs `npm publish` / `changeset publish` / a known publish
 * script, or uses changesets/action. The glob is only the search space (plus,
 * when `sniff`, every other workflow that qualifies). Glob matches that parse
 * but do not publish to npm are returned in `skipped`, never touched.
 * Unparseable glob matches stay in `files` so the parse error is reported.
 */
export function classifyWorkflows(repoPath, glob = DEFAULT_PUBLISH_GLOB, { sniff = true } = {}) {
  const matched = new Set(matchWorkflowFiles(repoPath, glob));
  const candidates = new Set(matched);
  const dir = path.join(repoPath, ".github", "workflows");
  if (sniff && fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) if (/\.ya?ml$/.test(f)) candidates.add(`.github/workflows/${f}`);
  }
  const files = [];
  const skipped = [];
  for (const rel of [...candidates].sort()) {
    let publishes = false;
    let parsed = true;
    try {
      const wf = parseWorkflow(fs.readFileSync(path.join(repoPath, rel), "utf8"));
      if (wf.errors.length || !wf.root) parsed = false;
      else publishes = jobsOf(wf).some((j) => j.isPublish);
    } catch {
      parsed = false;
    }
    if (publishes || (!parsed && matched.has(rel))) files.push(rel);
    else if (matched.has(rel)) skipped.push(rel);
  }
  return { files, skipped };
}

/** Workflows to lint: those that publish to npm (see classifyWorkflows). */
export function discoverPublishWorkflows(repoPath, glob = DEFAULT_PUBLISH_GLOB, opts = {}) {
  return classifyWorkflows(repoPath, glob, opts).files;
}

export const skipMessage = (file) => `skipped ${file}: does not publish to npm`;

export function lintRepo(repoPath, glob = DEFAULT_PUBLISH_GLOB, { sniff = glob === DEFAULT_PUBLISH_GLOB } = {}) {
  const info = engineInfo(repoPath);
  const { files, skipped } = classifyWorkflows(repoPath, glob, { sniff });
  const results = files.map((rel) => ({
    file: rel,
    findings: lintWorkflow({ text: fs.readFileSync(path.join(repoPath, rel), "utf8"), engineMajor: info.major }),
  }));
  // cross-file: concurrency groups must be distinct across publish workflows
  const owner = new Map();
  for (const r of results) {
    for (const { group, line } of publishGroups(fs.readFileSync(path.join(repoPath, r.file), "utf8"))) {
      const first = owner.get(group);
      if (first && first !== r.file) {
        r.findings.push({ line, rule: "concurrency-group-unique", message: `concurrency group \`${group}\` is also used by ${first}; two publish workflows sharing a group makes GitHub cancel queued runs. Give each a distinct group (e.g. \`<workflow-name>-\${{ github.ref }}\`)` });
        r.findings.sort((a, b) => a.line - b.line);
      } else owner.set(group, r.file);
    }
  }
  return { files, skipped, results, engine: info };
}

function main(argv) {
  let repo = ".";
  let glob = DEFAULT_PUBLISH_GLOB;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--glob") glob = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: lint-publish-workflow.mjs [repo-path] [--glob '<glob>']\n\nrules:\n" + Object.entries(RULES).map(([k, v]) => `  ${k.padEnd(28)} ${v}`).join("\n"));
      return 0;
    } else repo = argv[i];
  }
  const { files, skipped, results, engine } = lintRepo(path.resolve(repo), glob);
  for (const f of skipped) console.log(`workflow-lint: INFO ${skipMessage(f)}`);
  if (files.length === 0) {
    console.log(`workflow-lint: no publish workflows matched ${glob}; nothing to check.`);
    return 0;
  }
  console.log(`workflow-lint: engines.node major = ${engine.major ?? "unknown"} (${engine.source})`);
  console.log(`workflow-lint: INFO publish workflow filenames (trust-bound for npm trusted publishing; renaming one needs \`npm trust github\` re-trust): ${files.join(", ")}`);
  let failures = 0;
  for (const { file, findings } of results) {
    if (findings.length === 0) console.log(`ok   ${file}`);
    for (const f of findings) {
      failures++;
      console.log(`${file}:${f.line}: [${f.rule}] ${f.message}`);
      if (process.env.GITHUB_ACTIONS) console.log(`::error file=${file},line=${f.line},title=${f.rule}::${f.message}`);
    }
  }
  if (failures) {
    console.log(`\nworkflow-lint: ${failures} problem(s). See the "main is the release branch" section of the johnhenry/workflows README; \`scripts/convert-publish.mjs\` fixes most of these automatically.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
