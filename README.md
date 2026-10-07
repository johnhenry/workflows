# johnhenry/workflows

Shared, reusable [GitHub Actions `workflow_call`
workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
for the `@johnhenry` npm-scope open-source family, plus the templates and
tooling that keep ~47 consumer repos on one publish model.

- `.github/workflows/npm-publish.yml` -- single-package npm publish: the
  idempotent `npm view` pre-flight guard, `--provenance`, and (since
  `v1.1.0`) the `v<version>` git tag + GitHub Release as a by-product.
- `.github/workflows/workflow-lint.yml` -- fails a repo's CI when its
  publish workflow drifts from the model below.
- `.github/workflows/ci.yml` -- the family's test workflow: concurrency
  cancellation, an OS/Node matrix, and an optional generated-artifact
  drift gate.
- `.github/workflows/codeql.yml` / `dependency-review.yml` -- security jobs.
- `templates/publish.yml` / `templates/publish-changesets.yml` -- copy-paste
  caller workflows (single package / monorepo).
- `scripts/lint-publish-workflow.mjs` -- the linter behind `workflow-lint.yml`.
- `scripts/convert-publish.mjs` -- codemod that rewrites a consumer's publish
  workflow to the canonical shape.
- `scripts/npm-publish-if-new.mjs` -- a standalone implementation of the
  idempotent-publish guard, for anything that wants it outside `npm-publish.yml`.

This repo is not an npm package. Its `package.json` is `private` and exists
only to run the tests (`npm test`); there is nothing to publish, so most of
the family's documentation-feature checklist (badges, publish workflow, etc.)
doesn't apply here.

Background: `~/.claude/skills/publish-npm-single/SKILL.md` and
`~/.claude/skills/publish-npm-monorepo/SKILL.md` (local Claude skills, not
in this repo) document the family standard, and the wider
`ecosystem-cohesion-plan.md` (section 2a) explains why this repo exists.

## Versioning

Tags, not branches: consumers pin `@v1` (or a more specific `@v1.x.y` tag
if one exists) rather than `@main`, so a change here can't silently break
every consuming repo's CI/publish on the next run. Treat `v1` as a stable
major -- additive, backwards-compatible input changes bump a minor/patch
tag; anything that changes existing input defaults or removes an input
gets a new major (`v2`) and consumers migrate deliberately.

`v1.1.0` is additive: new default-on behaviour (tag + Release) that needs a
new caller permission, but callers that don't grant it keep publishing as
before -- see "Permissions" below. The floating `v1` tag points at the latest
`v1.x.y`.

## The publish model: main is the release branch

One model for every repo that publishes `@johnhenry/*` packages:

1. **A publish workflow triggers only on `push: branches: [main]` and
   `workflow_dispatch`.** No `release:` trigger, no `push: tags:` trigger,
   anywhere.
2. **Landing the version bump on main is the release.** The bump arrives via a
   Changesets "Version Packages" PR (mandatory for monorepos, recommended for
   single packages) or via any PR that edits `package.json`'s `version` -- both
   are equivalent to the publish workflow.
3. **Publishing is idempotent.** If `name@version` is already on the registry
   the run is a clean no-op (green, `published=false`). Most pushes to main
   don't change the version, so most runs are no-ops.
4. **The tag and the GitHub Release are by-products, never triggers.** After a
   successful publish the workflow creates `v<version>` and a Release for it.
   Nobody creates tags or releases by hand to cause a publish.
5. **Publish runs queue, never cancel**: `concurrency` with
   `cancel-in-progress: false`.

`workflow-lint.yml` (below) enforces this, and `scripts/convert-publish.mjs`
migrates a repo to it mechanically.

### Permissions (changed in v1.1.0 -- read this)

**Callers must now declare `permissions: { contents: write, id-token: write }`
on the job that calls `npm-publish.yml`:**

```yaml
jobs:
  publish:
    permissions:
      contents: write # NEW in v1.1.0: lets the by-product step push the tag + create the Release
      id-token: write # npm provenance
    uses: johnhenry/workflows/.github/workflows/npm-publish.yml@v1
```

`npm-publish.yml` itself declares no job-level `permissions:` -- it inherits
what the caller grants (a reusable job that requests more than its caller
grants fails at startup, which would have broken every existing caller).
So a caller that still says `contents: read` **does not fail**: it publishes
exactly as before, and the tag/release step skips with a
`::warning title=Tag/release skipped::` annotation telling you to add
`contents: write`. Moving `v1` to `v1.1.0` is therefore safe; callers pick up
tags and Releases as they add the permission (the codemod does it for them).

Permissions by job type (write includes read):

| Job | `id-token` | `contents` | `pull-requests` |
|---|---|---|---|
| Calls `npm-publish.yml` | `write` (OIDC: trusted publishing + provenance) | `write` (tag + Release by-product; `read` still publishes, tag step skips) | -- |
| Inline `npm publish` job | `write` | `read` is enough | -- |
| `changesets/action` (Flow B) | `write` | `write` (bump commit, tags, Releases) | `write` (Version Packages PR) |

### Trusted publishing (OIDC) -- the filename is part of the trust

As of 2026-10-07 npm trusted publishing is live for 141 of the 143
`@johnhenry` packages. Each package trusts exactly **one repo and one workflow
filename**. Consequences:

- **Never rename, split or consolidate a publish workflow file** without
  re-trusting it. If a consolidation is unavoidable, keep the old filename as
  the trusted entry point, or have the maintainer (2FA required) run, per
  package: `npm trust github <pkg> --repo <owner/repo> --file <new>.yml --allow-publish`.
  Convert in place; `convert-publish.mjs` already does.
- Known trusted filenames: `publish.yml` (the default, single packages);
  `release.yml` (aimatey, browsermesh, optical-artifact-transport and the
  monorepos); `npm-publish.yaml` (tester); `objectify-publish.yml`
  (`@johnhenry/objectify`); `release-gate.yml` and
  `release-mcp-query-tanstack.yml` (mcp-gate, mcp-query-tanstack).
- For a reusable-workflow caller, the trusted filename is the **caller's**
  file, not `npm-publish.yml` (canvas-fx 0.0.1 published via OIDC this way;
  its `_npmUser` is "GitHub Actions").
- npm prefers OIDC even when `NODE_AUTH_TOKEN` is set. Keep passing the token
  (`secrets: inherit`) as a fallback for now; the `NPM_TOKEN` secrets have not
  been removed. `--provenance` stays standard.
- Caller-level `concurrency: { group: publish-${{ github.ref }},
  cancel-in-progress: false }` is the standard. The reusable workflow must
  **never** declare a `concurrency` block: the same group at two levels
  deadlocks the run before it starts (the `ci.yml@v1` lesson). A test pins
  this for `npm-publish.yml`.
- **A repo with more than one publish workflow needs a distinct group per
  file.** GitHub keeps only one pending run per group, so a shared group
  cancels queued publishes (seen live on mcp-query). Use
  `<workflow-basename>-${{ github.ref }}` (e.g. `publish-unscoped-${{ github.ref }}`,
  `release-gate-${{ github.ref }}`). The `concurrency-group-unique` lint rule
  enforces this, and the codemod suffixes default groups with the basename
  when it finds several publish workflows (an existing group is kept verbatim
  unless it collides, then it is suffixed and the summary says so).
- The linter prints an INFO line listing the publish workflow filenames it
  checked, so a rename shows up in PR logs.

Docs of record live in the fleet's `johnhenry/ecosystem` repo
(github.com/johnhenry/ecosystem, PR #9): `npm-tokens/README.md` ("Publishing:
trusted publishing"), and the `adopt-library` and `publish-npm-*` skills.

### Flow A -- single package (reusable workflow)

Copy [`templates/publish.yml`](templates/publish.yml) to
`.github/workflows/publish.yml`:

```yaml
name: Publish to npm

on:
  push:
    branches: [main]
  workflow_dispatch: {}

concurrency:
  group: publish-${{ github.ref }}
  cancel-in-progress: false

jobs:
  publish:
    permissions:
      contents: write
      id-token: write
    uses: johnhenry/workflows/.github/workflows/npm-publish.yml@v1
    with:
      node-version: "26" # must equal package.json engines.node major
      gate-commands: npm test
    secrets: inherit
```

To release: merge a PR that bumps `version` in `package.json` (or the
Changesets "Version Packages" PR, if the repo uses Changesets for a single
package). The merge to main publishes, then tags `v<version>` and creates the
Release. A repo with no lockfile sets `install-command: npm install` and
`node-cache: ""`.

### Flow B -- monorepo (Changesets)

Copy [`templates/publish-changesets.yml`](templates/publish-changesets.yml).
On every push to main, `changesets/action` either opens/updates the "Version
Packages" PR (when changesets are pending) or, when that PR has just been
merged, runs `publish: npm run release` (`"release": "npm run build &&
changeset publish"`), which publishes each package whose version is new
(already-published versions are skipped, so re-runs are safe). The action
pushes a git tag and creates a GitHub Release **per published package**
(`createGithubReleases` defaults to true) -- the same by-product as Flow A,
supplied natively, so no extra step is needed; it requires the workflow-level
`contents: write`. This is the shape `johnhenry/math` and `johnhenry/laya-js`
already use, minus their repo-specific extras (math's JSR job, laya's macOS
native-package job and `dry_run` input) which stay as additional jobs in those
repos' own workflow.

## Consuming `npm-publish.yml`

Use the template above. Inputs (all optional):

| Input | Default | Purpose |
|---|---|---|
| `node-version` | `"26"` | Must equal the caller's `engines.node` major. |
| `working-directory` | `"."` | Directory containing the package.json to publish. |
| `install-command` | `"npm ci"` | Use `"npm install"` for repos with no committed lockfile. |
| `node-cache` | `"npm"` | Passed to `actions/setup-node`'s `cache` input; set to `""` for repos with no lockfile (otherwise `setup-node` errors). |
| `gate-commands` | `"npm test"` | Newline-separated commands that must all pass before publish runs. |
| `create-release` | `true` | After a successful publish, create tag `v<version>` + a GitHub Release. Needs the caller's `contents: write`; otherwise skips with a warning. |
| `release-notes` | `"auto"` | `"auto"` = `gh release create --generate-notes`; `"none"` = a one-line body linking the npm page. |

Outputs (use with `needs.publish.outputs.*`):

| Output | Value |
|---|---|
| `published` | `"true"` if this run published a new version, else `"false"`. |
| `version` | The `package.json` version at the commit that ran. |

The tag/release step skips cleanly (success, with a notice or warning) when:
the version was already on the registry (nothing published), the tag
`v<version>` already exists, the caller lacks `contents: write`, or the run is
a `workflow_dispatch` from a non-default branch. Pre-release versions
(`1.0.0-rc.1`) are flagged as pre-releases. Any *other* `gh` failure fails the
step, loudly -- the package is already on npm by then, so re-run to retry.

`secrets: inherit` passes the caller repo's `NPM_TOKEN` through automatically
and is required by the linter.

This workflow does **not** do monorepo dependency-ordered publishing; use Flow B.

## The `id-token: write` gotcha

`npm publish --provenance` needs an OIDC token, which needs
`permissions: id-token: write`. Permissions on a reusable workflow's job are
bounded by what the **calling** job grants, so the caller must declare
`id-token: write` itself -- the reusable workflow cannot grant it on its own,
and GitHub narrows the token silently if the caller doesn't. (`contents: write`
works the same way.)

## `workflow-lint.yml` -- keep a repo on the model

Add one job to the repo's `ci.yml` (no inputs required):

```yaml
jobs:
  workflow-lint:
    uses: johnhenry/workflows/.github/workflows/workflow-lint.yml@v1
    # with:
    #   publish-workflows: ".github/workflows/{publish,release,npm-publish}*.{yml,yaml}"  # default
```

It checks out the caller repo, fetches `scripts/lint-publish-workflow.mjs`
from this repo at `ref: v1`, and fails (line-numbered messages, also emitted
as annotations) when any publish workflow -- files matching the glob, plus any
workflow that calls `npm-publish.yml`, runs `npm publish`, or uses
`changesets/action` -- breaks a rule:

| Rule | Fails when |
|---|---|
| `no-release-trigger` | an `on: release` trigger exists |
| `no-tag-trigger` | `push.tags` / `push.tags-ignore` exists |
| `push-main-only` | `push.branches` is not exactly `[main]` (or there is no `push`) |
| `workflow-dispatch` | there is no `workflow_dispatch` trigger |
| `concurrency-no-cancel` | no `concurrency` (workflow- or job-level), or `cancel-in-progress` is not `false` |
| `permissions-id-token` | the publish job lacks `id-token: write` |
| `permissions-contents-write` | a job calling `npm-publish.yml` lacks `contents: write` |
| `node-matches-engines` | a pinned `node-version` major differs from `engines.node` (root; for monorepos with no root `engines`, the highest workspace floor) |
| `secrets-inherit` | a job calling `npm-publish.yml` lacks `secrets: inherit` |
| `concurrency-group-unique` | two publish workflows in the repo use the same `concurrency.group` (the finding names both files) |

Run it locally with `node scripts/lint-publish-workflow.mjs <repo-path>`.
It also prints `workflow-lint: INFO publish workflow filenames (trust-bound ...)`
listing the files it checked (see "Trusted publishing").
The YAML parser is `yaml` (ISC) vendored as a single bundled file in
`scripts/vendor/` -- no install step is needed to run it from a checkout.

## `scripts/convert-publish.mjs` -- migrate a repo

```
node scripts/convert-publish.mjs <repo-path> [--dry-run] [--check] [--no-ci] [--glob '<glob>']
```

For each publish workflow it rewrites the `on:` block, adds/fixes
`concurrency`, adds `contents: write` + `id-token: write` (inline publish jobs
get only `id-token: write`), sets `node-version` from `engines`, preserves
`gate-commands` / `install-command` / `node-cache` / `working-directory` and any
`workflow_dispatch` inputs, removes comments about the old release race, and
adds a `workflow-lint` job to `ci.yml` (creating a minimal one if absent). It
prints a per-file diff summary, never rewrites the body of an inline publish
job, and is idempotent. It prints `WARNING` lines for things it will not fix
-- notably steps or `gate-commands` that compare against a tag ref
(`GITHUB_REF#refs/tags/...`), which can never hold on a push to main and must
be edited by hand. `--check` exits 1 if anything would change.

## History: the release-trigger race

This section used to tell consumers to wire *both* `release: [published]` and
`push: tags: ['v*']`, "required, not optional". That guidance is retired; it
is why the model above exists.

Observed on 2026-09-22: `fileable`'s first release after migrating to the
reusable workflow (`v0.0.2`) never triggered a `publish` run at all -- no
failed run, no run whatsoever, confirmed via the Actions API immediately and
15+ minutes later, while `workflow_dispatch` on the same file worked. A/B
testing showed the failing release was created ~35 seconds after a
push-triggered CI run on the same commit (the merge of the version-bump PR):
**creating a `release` very soon after a push/merge to the same commit can
cause GitHub to silently drop the `release` event** for a job whose whole body
is `uses: <external-repo>/...@v1`. The workaround was a second trigger,
`push: tags: ['v*']`, relying on the idempotent `npm view` guard to make the
duplicate run a no-op.

That workaround had its own cost: every release fired the workflow twice
(`release` plus the tag push it created), needing queueing concurrency and
two runs' worth of CI minutes, and it still left "create the release by
hand" as the way to publish. Publishing from the push to main removes the
dropped-event window entirely -- `push` is the event that did fire -- and
makes the tag and Release outputs rather than inputs.

## Consuming `ci.yml`

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    uses: johnhenry/workflows/.github/workflows/ci.yml@v1
    with:
      node-versions: '["26"]'
      os: '["ubuntu-latest", "windows-latest"]'
      gate-commands: npm test
```

`node-versions` and `os` are JSON-encoded array strings (`workflow_call`
inputs can't be typed as arrays), expanded with `fromJSON()` internally.
Set `drift-check: true` (plus `drift-build-command` / `drift-path`) for
repos that commit generated output that ships in the published tarball
(built CSS, `dist/`, generated schemas) -- see the comments in
`ci.yml` for the exact contract.

## Consuming `codeql.yml` / `dependency-review.yml`

Both are thin `workflow_call` wrappers around the CodeQL/dependency-review
actions. **Branches are intentionally not inputs on these two** -- a
reusable workflow's own `on:` triggers only fire for pushes/PRs to *this*
repo, so they cannot make a caller repo scan its own branches. Each
consumer keeps a small wrapper file with its own trigger block:

```yaml
# .github/workflows/codeql.yml
name: CodeQL Security Analysis

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * 1'

jobs:
  analyze:
    uses: johnhenry/workflows/.github/workflows/codeql.yml@v1
```

```yaml
# .github/workflows/dependency-review.yml
name: Dependency Review

on:
  pull_request:
    branches: [main]

jobs:
  dependency-review:
    uses: johnhenry/workflows/.github/workflows/dependency-review.yml@v1
```

Both reusable jobs declare their own `permissions:` block already
(`security-events: write` / `pull-requests: write` respectively), so the
caller doesn't need to repeat them.

## `scripts/npm-publish-if-new.mjs`

The same idempotent-publish guard as `npm-publish.yml`'s inline bash step,
as a standalone Node script with no dependencies. `npm-publish.yml` does
**not** call this script -- it inlines the guard directly to avoid a
second cross-repo checkout inside the reusable workflow (fetching this
script at the exact ref the reusable workflow is pinned to adds a real
failure mode for no real benefit). This script exists for cases the
reusable workflow doesn't cover: a monorepo's per-package publish loop, a
repo that adopted the guard before this repo existed (`tester`, the
original source), or manual/local publishing.

```
node scripts/npm-publish-if-new.mjs                  # reads name/version from ./package.json
node scripts/npm-publish-if-new.mjs @scope/name 1.2.3 # explicit override
```

Requires `NODE_AUTH_TOKEN` in the environment for the actual publish step.

## Why these and not more

Per `ecosystem-cohesion-plan.md` section 2, other publish/CI patterns
were deliberately left out of this repo rather than forced in:

- **Monorepo publishing as a reusable workflow** -- Changesets is the
  standard (`templates/publish-changesets.yml`), but it stays a copy-paste
  template rather than a `workflow_call`: `changesets/action` needs the
  caller's own `package.json` scripts and secrets in the same job.
- **The `file:../sibling` checkout-and-build pattern** (servable,
  hostable) -- every copy is commented "drop this once X is published for
  real"; the fix is publishing the dependency chain, not abstracting the
  workaround.
- **Deploy pipelines** (Dokku, TypeDoc-to-Pages) -- one instance each; not
  worth abstracting a pattern that only exists once.
