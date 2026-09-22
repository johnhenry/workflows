# johnhenry/workflows

Shared, reusable [GitHub Actions `workflow_call`
workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows)
for the `@johnhenry` npm-scope open-source family. This repo holds one
copy of each pattern that used to be pasted into ~25+ sibling repos:

- `.github/workflows/npm-publish.yml` -- single-package npm publish, with
  the idempotent `npm view` pre-flight guard and `--provenance`.
- `.github/workflows/ci.yml` -- the family's test workflow: concurrency
  cancellation, an OS/Node matrix, and an optional generated-artifact
  drift gate.
- `.github/workflows/codeql.yml` -- the CodeQL security-scan job.
- `.github/workflows/dependency-review.yml` -- the PR dependency-review
  job.
- `scripts/npm-publish-if-new.mjs` -- a standalone, repo-agnostic
  implementation of the same idempotent-publish guard, for anything that
  wants to invoke it directly instead of through `npm-publish.yml`.

This repo is not an npm package. It has no `package.json` to publish, so
most of the family's documentation-feature checklist (badges, `engines`,
publish workflow, etc.) doesn't apply here -- noting that plainly rather
than forcing npm-package conventions onto a repo that isn't one. It does
follow the family's general engineering conventions (MIT license, `main`
as the default branch, PR-based review for anything that touches other
repos' CI).

Background: `~/.claude/skills/publish-npm-single/SKILL.md` and
`~/.claude/skills/publish-npm-monorepo/SKILL.md` (local Claude skills, not
in this repo) document the settled family CI/publish standard that these
workflows implement, and the wider
`ecosystem-cohesion-plan.md` (section 2a) explains why this repo exists.

## Versioning

Tags, not branches: consumers pin `@v1` (or a more specific `@v1.x.y` tag
if one exists) rather than `@main`, so a change here can't silently break
every consuming repo's CI/publish on the next run. Treat `v1` as a stable
major -- additive, backwards-compatible input changes bump a minor/patch
tag; anything that changes existing input defaults or removes an input
gets a new major (`v2`) and consumers migrate deliberately.

## The `id-token: write` gotcha (read this before wiring `npm-publish.yml`)

`npm publish --provenance` needs an OIDC token, which needs
`permissions: id-token: write`. Because `npm-publish.yml` is a *reusable*
workflow, the permissions available to its job are the **intersection** of
what the reusable workflow's own job requests and what the **calling**
job/workflow grants. Declaring `id-token: write` only inside
`npm-publish.yml` (which it does) is not enough -- if the caller doesn't
also grant it, GitHub silently narrows the token and provenance signing
fails. Every consumer must declare `permissions: id-token: write` (plus
`contents: read`) on the job that does the `uses:` call, as shown below.

## Consuming `npm-publish.yml`

```yaml
# .github/workflows/publish.yml
name: Publish to npm

on:
  release:
    types: [published]
  workflow_dispatch: {}

jobs:
  publish:
    permissions:
      contents: read
      id-token: write # required here too -- see the gotcha above
    uses: johnhenry/workflows/.github/workflows/npm-publish.yml@v1
    with:
      node-version: "26"
      gate-commands: npm test
    secrets: inherit
```

Inputs (all optional):

| Input | Default | Purpose |
|---|---|---|
| `node-version` | `"26"` | Must equal the caller's `engines.node` major. |
| `working-directory` | `"."` | Directory containing the package.json to publish. |
| `install-command` | `"npm ci"` | Use `"npm install"` for repos with no committed lockfile. |
| `node-cache` | `"npm"` | Passed to `actions/setup-node`'s `cache` input; set to `""` for repos with no lockfile (otherwise `setup-node` errors). |
| `gate-commands` | `"npm test"` | Newline-separated commands that must all pass before publish runs. |

`secrets: inherit` passes the caller repo's `NPM_TOKEN` secret through
automatically -- simplest option and what every current consumer uses. You
can instead pass `secrets: { NPM_TOKEN: ${{ secrets.NPM_TOKEN }} }`
explicitly if the caller and the secret name ever diverge.

This workflow does **not** do monorepo dependency-ordered publishing --
that's still `publish-npm-monorepo`'s staggered script (a separate,
pending design decision per `ecosystem-cohesion-plan.md` section 2b).

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

## Why these four and not more

Per `ecosystem-cohesion-plan.md` section 2, three other publish/CI patterns
were deliberately left out of this repo rather than forced in:

- **Monorepo dependency-ordered publishing** (`publish-npm-monorepo`'s
  staggered script) -- three incompatible strategies exist across the
  family with different failure histories; Changesets is the recommended
  future standard but needs a pilot (`math`) before consolidation.
- **The `file:../sibling` checkout-and-build pattern** (servable,
  hostable) -- every copy is commented "drop this once X is published for
  real"; the fix is publishing the dependency chain, not abstracting the
  workaround.
- **Deploy pipelines** (Dokku, TypeDoc-to-Pages) -- one instance each; not
  worth abstracting a pattern that only exists once.
