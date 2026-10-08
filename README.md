# johnhenry/workflows

Shared, reusable [GitHub Actions `workflow_call`
workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
for the `@johnhenry` npm-scope open-source family, plus the templates and
tooling that keep ~47 consumer repos on one publish model.

- `.github/workflows/npm-publish.yml` -- single-package npm publish: the
  idempotent `npm view` pre-flight guard, `--provenance`, and (since
  `v1.1.0`) the `v<version>` git tag + GitHub Release as a by-product.
- `.github/actions/create-release/action.yml` -- composite action: the
  `v<version>` tag + GitHub Release by-product, for inline publish jobs
  (`npm-publish.yml` uses it too, so there is one implementation).
- `.github/actions/verify-published/action.yml` -- composite action: polls the
  registry until the just-published versions are visible, fails with a table
  otherwise (`npm-publish.yml` uses it; Changesets repos use
  `from-workspaces: true`). See "Verification".
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
   don't change the version, so most runs are no-ops. A `npm publish` that
   409s (`E409` / "previously staged version" / `EPUBLISHCONFLICT` / "cannot
   publish over the previously published") because a duplicate run staged the
   same version first is also treated as already published: green,
   `published=false`, and the verify + tag/release steps still run. Custom or
   staggered publish scripts should match all of those strings.
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

`changesets/action` additionally needs the **repository setting** Settings >
Actions > General > "Allow GitHub Actions to create and approve pull requests"
(otherwise the run fails at `creating pull request` with "GitHub Actions is not
permitted to create or approve pull requests" even with `pull-requests: write`).
Enable it with `gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true`.
A workflow file cannot check that setting; the lint only enforces the permission.

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
- **Trusted publishing cannot create a brand-new package name.** npm only lets
  you configure a trusted publisher on a package that already exists, so the
  *first* publish of a new name must use a granular token that may create
  packages (`NPM_TOKEN`), or a manual `npm publish --access public` with 2FA;
  only then can you run `npm trust github ...` for it (seen on
  `@johnhenry/objectify`, [objectify#9](https://github.com/johnhenry/objectify/issues/9)).
  When `npm publish` fails with `E404` and the name does not exist on the
  registry, `npm-publish.yml` prints this guidance as an error annotation
  (`First publish of a new package name`) before failing the job.

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
supplied natively, so no extra tag step is needed (add the `verify-published` step the template ends with; see "Verification"); it requires the workflow-level
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
| `verify-timeout` | `"10"` | Minutes to poll the registry for the just-published version before failing (see "Verification"). |
| `verify-interval` | `"20"` | Seconds between registry polls. |

Outputs (use with `needs.publish.outputs.*`):

| Output | Value |
|---|---|
| `published` | `"true"` if this run published a new version, else `"false"`. |
| `version` | The `package.json` version at the commit that ran. |

After publishing, the job verifies the version actually reached the registry
(see "Verification") and only then runs the tag/release step, which skips cleanly (success, with a notice or warning) when:
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

## `create-release` -- tag + Release for inline publish jobs

Repos whose publish job is inline (not a call to `npm-publish.yml`) get the same
tag + GitHub Release by-product from a composite action. `npm-publish.yml`
itself calls it, so both paths share one implementation and one set of skip
rules.

```yaml
jobs:
  publish:
    permissions:
      contents: write # tag + GitHub Release by-product
      id-token: write # npm provenance
    steps:
      # ... checkout, setup-node, gate ...
      - name: Publish
        id: publish
        run: npm publish --provenance --access public
      - name: Tag and GitHub Release (by-product)
        if: steps.publish.outcome == 'success'   # + a "was this version new?" check, see below
        uses: johnhenry/workflows/.github/actions/create-release@v1
        with:
          version: ${{ steps.release-probe.outputs.version }}
```

| Input | Default | Purpose |
|---|---|---|
| `version` | required | Version being released; tag is `<tag-prefix><version>`. |
| `tag-prefix` | `v` | Tag prefix. |
| `notes` | `auto` | `auto` = `gh release create --generate-notes`; `none` = one-line body linking the npm page. |
| `prerelease` | `auto` | `auto` flags versions containing `-`; `true` / `false` force it. |
| `working-directory` | `.` | Where `package.json` lives (package name for `notes: none`). |
| `package-name` | package.json's | Override the name used in the `notes: none` body. |

Outputs: `created` (`"true"` only if this run created the Release) and `tag`.

Skip rules (the step still succeeds): not running on the default branch
(notice), the tag already exists (notice), the job lacks `contents: write`
(warning). Any other `gh` failure fails the step loudly -- the package is
already on npm, so re-run to retry. The action needs the repo checked out
(`actions/checkout`) because it asks `git ls-remote` about the tag.

The action does not know whether *this run* published: a publish step that
no-ops on an already-published version also succeeds. Guard it on something
that does. `scripts/convert-publish.mjs` inserts an `npm view` probe step
(`id: release-probe`, outputs `new` and `version`) before the publish step and
guards the action with
`steps.release-probe.outputs.new == 'true' && steps.<publish>.outcome == 'success'`.

## Verification -- confirm the registry really has it

`npm publish` and `changeset publish` have logged `+ pkg@x.y.z` and exited
green while the registry never stored the version (aimatey-wrapper 0.2.0 on
2026-10-07; `@johnhenry/objectify` 0.0.2 on 2026-10-08; both fixed by
re-dispatching). Every publish path therefore verifies after publishing, by
polling `npm view <name>@<version> version`.

- **`npm-publish.yml`** does it itself: after a real publish (not on a no-op
  run) it polls for `verify-timeout` minutes (default 10) every
  `verify-interval` seconds (default 20) and fails the job if the version never
  appears. The tag + GitHub Release by-product runs *after* verification, so a
  dropped publish never gets a tag or Release.
- **Inline and Changesets jobs** use the composite action
  `johnhenry/workflows/.github/actions/verify-published@v1` (dependency-free,
  needs only Node on the runner):

```yaml
      - name: Version PR or publish
        id: changesets
        uses: changesets/action@v1
        # ...
      - name: Verify published versions are on the registry
        if: steps.changesets.outputs.published == 'true'
        uses: johnhenry/workflows/.github/actions/verify-published@v1
        with:
          from-workspaces: true      # every non-private workspace package.json
          # or an explicit list:
          # packages: |
          #   @scope/a@1.2.3
          #   @scope/b@0.4.0
```

| Input | Default | Purpose |
|---|---|---|
| `packages` | `""` | Newline-separated `name@version` list. |
| `from-workspaces` | `"false"` | Also verify every non-private package in the root `workspaces` (globs and literal paths), at the version in its `package.json`. |
| `timeout-minutes` | `"10"` | How long to keep polling. |
| `interval-seconds` | `"20"` | Seconds between polls. |
| `working-directory` | `"."` | Repo root used to resolve workspaces. |

On failure it prints a table (`PACKAGE  VERSION  STATUS`, `MISSING` for the
ones that never appeared), emits an error annotation per missing version, and
fails. Re-dispatch the publish workflow to retry: already-published versions
are skipped. Giving it nothing to verify is an error (exit 2), so a
misconfigured step cannot pass silently. Guard the Changesets step with
`steps.<id>.outputs.published == 'true'` so it only runs after a real publish
(on Version-PR runs the workspace versions are the old, already-published
ones). Because `changesets/action` creates its own tags/Releases, verification
there is a failing check, not a gate on them.

`workflow-lint` warns (without failing) when a publish job has no verification
step; see the `verify-published` rule below.

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
| `permissions-pull-requests` | a job using `changesets/action` lacks `pull-requests: write` (the permission alone is not enough: the repo setting "Allow GitHub Actions to create and approve pull requests" must also be on, which a workflow file cannot check) |
| `permissions-contents-write` | a job calling `npm-publish.yml` lacks `contents: write` |
| `node-matches-engines` | a pinned `node-version` major differs from `engines.node` (root; for monorepos with no root `engines`, the highest workspace floor) |
| `secrets-inherit` | a job calling `npm-publish.yml` lacks `secrets: inherit` |
| `concurrency-group-unique` | two publish workflows in the repo use the same `concurrency.group` (the finding names both files) |

Warnings (printed as `WARN [rule]` / `::warning`, they never fail the run):

| Rule | Warns when |
|---|---|
| `verify-published` | an inline or Changesets publish job has no `verify-published` step (jobs that call `npm-publish.yml` are exempt: it verifies by itself) |

Workflows are selected by **content**, not filename: only files whose jobs call
`npm-publish.yml`, run `npm publish` / `changeset publish` / `npm run release`
(or the yarn/pnpm equivalents), or use `changesets/action` are checked. The
`publish-workflows` glob is just the search space; a file it matches that does
not publish to npm (a Rust-binary or PyPI release workflow such as wsh's
`release-rust.yml` or math-plus's `release-interop-python.yml`) is skipped with
`workflow-lint: INFO skipped <file>: does not publish to npm` and never flagged.

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
adds a `workflow-lint` job to `ci.yml` (**creating a minimal `ci.yml` if the repo has none**, as it did for isomorphic-jj). It
prints a per-file diff summary, never rewrites the body of an inline publish
job, and is idempotent. For inline jobs that run `npm publish` it also inserts
the `create-release` by-product (a version probe before the publish step, the
composite action after it, guarded on the publish step's outcome; the publish
step gets `id: publish` if it has none) and raises the job to
`contents: write`. A job that already creates its own release (`create-release`,
`gh release create`, ...) is left as is, and monorepo (`npm publish -w`) /
changesets jobs are skipped. It prints `WARNING` lines for things it will not fix
-- notably steps or `gate-commands` that compare against a tag ref
(`GITHUB_REF#refs/tags/...`), which can never hold on a push to main and must
be edited by hand. It uses the same content-based selection as the linter: workflows that do not publish to npm are left byte-for-byte untouched and listed as `INFO skipped <file>: does not publish to npm`. `--check` exits 1 if anything would change.

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
