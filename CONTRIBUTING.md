# Contributing

Issues and small pull requests are welcome. Before opening a pull request:

```sh
npm ci
npm run check
npm run build:studio
```

## Commits

Every commit on a pull request, and the pull request title, uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). The title becomes the merge commit subject, so it is held to the same rule as a commit subject.

```
type(scope): description
```

`scope` is optional. A breaking change is `type!:` or `type(scope)!:`.

Types: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

- The type is lowercase. A scope is lowercase and may contain `.`, `_`, `/`, and `-`.
- The description is at least 10 characters and does not end with a period.
- The whole subject is at most 100 characters.
- A merge commit (more than one parent) is not checked. Updating a branch by merging `main` is fine; the commits that introduce the change are what the check reads.

```
feat: run job images as processes when Docker is not installed
fix(agent): keep image writes inside the rootfs
ci: enforce conventional commits and pull request descriptions
```

## Pull request description

Use `.github/pull_request_template.md`. The body has these sections, in this order, each with real text (a sentence or two, not a placeholder):

- `## Summary` — what the change does for someone running Home Compute.
- `## Why` — the problem or goal, and why this approach.
- `## What changed` — the behavior, APIs, files, or config a reviewer should look at.
- `## Testing` — commands, tests, and what you observed, including what you did not run.

HTML comments and tags do not count. Each section needs at least 40 characters and 24 letters or numbers. `n/a`, `none`, `tbd`, `todo`, `wip`, `fixme`, and `placeholder` do not count, so an untouched template fails. Extra sections are fine. The check runs on `pull_request` (`opened`, `edited`, `synchronize`, `reopened`, `ready_for_review`), so editing the title or body re-runs it.

## Merging

Pull requests merge with a merge commit. Squash and rebase merges are not used. The merge commit's title is the pull request title, and its message is the pull request body.

A workflow file cannot change repository settings. The `merge strategy` check reads them and fails until an owner with admin on this repository applies:

```sh
gh api --method PATCH repos/sprintengine/home-compute --input - <<'EOF'
{
  "allow_merge_commit": true,
  "allow_squash_merge": false,
  "allow_rebase_merge": false,
  "merge_commit_title": "PR_TITLE",
  "merge_commit_message": "PR_BODY"
}
EOF
```

`merge_commit_title: PR_TITLE` is the pull request title. `merge_commit_message: PR_BODY` is the pull request body. That is the opposite of the previous defaults (`MERGE_MESSAGE` and `PR_TITLE`).

## Required status checks

The convention jobs are `conventional commits`, `pull request description`, and `merge strategy` (workflow `Conventions`). The existing test job is `test`. Branch protection is also outside a workflow. If `main` already has protection, add the three convention jobs to the contexts that are already required (this replaces the context list, so keep `test` and anything else you rely on):

```sh
gh api repos/sprintengine/home-compute/branches/main/protection \
  --jq '{
    strict: .required_status_checks.strict,
    contexts: ((.required_status_checks.contexts // []) + ["test", "conventional commits", "pull request description", "merge strategy"] | unique)
  }' \
  | gh api --method PATCH repos/sprintengine/home-compute/branches/main/protection/required_status_checks --input -
```

If that request answers 404, `main` has no branch protection yet. This creates it and requires those four checks, without requiring reviews:

```sh
gh api --method PUT repos/sprintengine/home-compute/branches/main/protection --input - <<'EOF'
{
  "required_status_checks": {
    "strict": false,
    "contexts": [
      "test",
      "conventional commits",
      "pull request description",
      "merge strategy"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

`strict: false` does not require the branch to be up to date with `main` before merging. Set it to `true` in either command if you want that. The `merge strategy` check stays red until the merge settings above are applied, so requiring it blocks merges until then.

Keep the core workload-agnostic. Provider-specific configuration belongs under
`examples/`, while fetching, processing, and publication logic belongs in the
workload image. Changes that duplicate Bacalhau placement, execution, or worker
health behavior need a clear reason and migration path.

Never commit credentials, API tokens, signing keys, or populated env files.
Changes to the Studio manifest invalidate its signature; release maintainers
sign the final artifact after all manifest edits.
