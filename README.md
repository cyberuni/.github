# .github

Organization setting repository.

[Default Community Health Files](https://docs.github.com/en/github/building-a-strong-community/creating-a-default-community-health-file)

[Starter Workflows](https://docs.github.com/en/actions/learn-github-actions/creating-starter-workflows-for-your-organization)

Use the workflow templates to create workflows for each repository.

References:

- <https://github.blog/changelog/2020-04-15-github-actions-new-workflow-features/>

## Dependency-update changesets

Two reusable workflows decide the changeset for Renovate PRs and keep a bot from
choosing a major release.

| Workflow | Runs on | What it does |
| --- | --- | --- |
| [`dep-changeset.yml`](.github/workflows/dep-changeset.yml) | Renovate PRs | Writes a patch changeset for an in-major runtime update only after the leak checks pass. Anything else fails until a person commits a changeset. |
| [`dep-changeset-release-guard.yml`](.github/workflows/dep-changeset-release-guard.yml) | the Version Packages PR | Fails when a package's major goes up and no person-written changeset asked for it. |

The header of each file explains the rules. In short:

- `dep-changeset:auto` (set by `unional/renovate-preset` on non-major runtime
  updates): the workflow installs and builds the merge base and the head, then
  runs three checks on each affected public package. It writes
  `.changeset/renovate-<PR>.md` at `patch` only if all three pass.
  - The public type surface, read with the TypeScript compiler from the
    published declaration entry points and every file they import, does not
    change.
  - The dependency's `engines.node` floor does not exceed the package's own.
  - The dependency does not add a required peer dependency or narrow a peer
    range.
- `dep-changeset:human` (runtime majors, every `peerDependencies` update), a
  check that trips or cannot run, or a runtime change with no label: the
  workflow writes nothing, comments the findings on the PR, and fails until a
  person commits a changeset naming each affected package. Changesets committed
  by `renovate[bot]` or `github-actions[bot]` do not count.
- `bundled: true`: a lock-file update also gets a patch changeset, after the
  same checks, for every public package.

### Caller

Add the jobs to the workflow that produces the required `all-checks` check, and
list them in its `needs:`. Both pass on PRs they do not apply to.

The `labeled` trigger re-runs that whole workflow when a label changes. If that
costs too much, put the two jobs in a workflow file of their own and require the
`dep-changeset / gate` and `release-guard / guard` checks in the ruleset
instead.

```yaml
on:
  pull_request:
    # `labeled`: Renovate adds its labels just after it opens the PR.
    types: [opened, synchronize, reopened, labeled, unlabeled]

jobs:
  dep-changeset:
    permissions:
      contents: read
      pull-requests: write
    uses: cyberuni/.github/.github/workflows/dep-changeset.yml@main
    secrets: inherit
    # with:
    #   bundled: true                  # published files inline dependencies
    #   build-command: pnpm build      # emits the .d.ts the type check reads (default)
    #   rebuild-command: pnpm cl build # rebuild committed output on every Renovate PR
    #   rebuild-paths: packages/cyberlegion/dist/cli.mjs

  release-guard:
    permissions:
      contents: read
      pull-requests: read
    uses: cyberuni/.github/.github/workflows/dep-changeset-release-guard.yml@main
```

#### When `all-checks` comes from `pnpm-verify.yml`

A repo whose required check is the `all-checks` job of `pnpm-verify.yml` cannot
add jobs to that job's `needs:`. Wrap the three calls in a local reusable
workflow, `.github/workflows/code.yml`, that ends in its own `all-checks` job,
and call it from the PR workflow as a job named `code`. The roll-up then reports
as `code / all-checks`, the name the ruleset already requires.
[cyberuni/cyberlegion](https://github.com/cyberuni/cyberlegion/blob/main/.github/workflows/code.yml)
is the reference copy.

```yaml
# .github/workflows/code.yml
on:
  workflow_call:
    secrets:
      AUTOFIX_APP_ID:
        required: false
      AUTOFIX_APP_PRIVATE_KEY:
        required: false

jobs:
  verify:
    uses: cyberuni/.github/.github/workflows/pnpm-verify.yml@main
  dep-changeset: # as above
  release-guard: # as above

  all-checks:
    needs: [verify, dep-changeset, release-guard]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - env:
          VERIFY: ${{ needs.verify.result }}
          GATE: ${{ needs.dep-changeset.result }}
          GUARD: ${{ needs.release-guard.result }}
        run: |
          [ "$VERIFY" = success ] || exit 1
          [ "$GATE" = success ] || exit 1
          [ "$GUARD" = success ] || [ "$GUARD" = skipped ] || exit 1
```

```yaml
# .github/workflows/pull-request.yml
jobs:
  code: # this job name makes the check `code / all-checks`
    uses: ./.github/workflows/code.yml
    permissions:
      contents: read
      pull-requests: write
    secrets:
      AUTOFIX_APP_ID: ${{ secrets.AUTOFIX_APP_ID }}
      AUTOFIX_APP_PRIVATE_KEY: ${{ secrets.AUTOFIX_APP_PRIVATE_KEY }}
```

What each result means to the roll-up:

- `dep-changeset` must be `success`. Its `gate` job runs on every event (`if:
  always()`) and passes on PRs it does not apply to, so any other result is a
  real failure.
- `release-guard` is `skipped` on every branch except the Version Packages
  branch, because its only job does not run there. Accept `skipped`, or the
  roll-up fails on every ordinary PR.
- The AUTOFIX secrets must reach `dep-changeset.yml` through both levels. Pass
  them by name at each level, as above, or use `secrets: inherit` at both.

Secrets, passed with `secrets: inherit`:

| Secret | Used for |
| --- | --- |
| `AUTOFIX_APP_ID` | The GitHub App that pushes the changeset. A push made with `GITHUB_TOKEN` would not re-run the required checks. |
| `AUTOFIX_APP_PRIVATE_KEY` | The same App's private key. |

Without them, the workflow still blocks what it should block, but it fails on
PRs where it would have written a changeset.

The workflows reference `@main` until a `v3` tag is cut. The scripts they run
live in [`.github/scripts/dep-changeset`](.github/scripts/dep-changeset) and are
loaded from the `tools-ref` input, `main` by default. Run their tests with `npm
ci && npm test` in that directory.

Known limits:

- A behavior change that shows in neither the types nor the tests passes the
  checks. That relies on the dependency following semver.
- The type check trips on any change to a dependency declaration the public
  types reach, even a new member the package never uses. Those PRs go to a
  person.
- Catalog entries in `pnpm-workspace.yaml` are attributed to the packages that
  use them only in the one-entry-per-line form pnpm and Renovate write.
