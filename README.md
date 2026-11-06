# ohmybug CLI

[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/6d7g8J44C7)

Review the changes in a git repository with the [OhMyBug](https://ohmybug.ai) bug hunt from any CI system (GitLab CI, Bitbucket Pipelines, Jenkins) or from your shell. The repository can be hosted anywhere: the CLI sends the diff and a few related files itself.

One file, no dependencies, Node.js 18 or newer.

Questions → [Discord](https://discord.gg/6d7g8J44C7).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/main/install.sh | sh
```

Or download [`ohmybug.mjs`](ohmybug.mjs) and run it with `node ohmybug.mjs`. The installer takes the latest `main`; to pin a release in CI, name its file:

```sh
curl -fsSL https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/main/install.sh | OHMYBUG_CLI_URL=https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/v0.3.0/ohmybug.mjs sh
```

Behind a proxy: Node's `fetch` reads `HTTPS_PROXY` only with `NODE_USE_ENV_PROXY=1` (Node 22.21 or newer, or 24 or newer).

## Use

Create an API key at [app.ohmybug.ai/me](https://app.ohmybug.ai/me) and put it in `OHMYBUG_API_KEY`. Then, in the repository folder:

```sh
ohmybug                  # review <base>...HEAD: the commits of this branch
ohmybug --base develop   # the same against another base
ohmybug --uncommitted    # review the working tree against HEAD, untracked files included (not ignored ones)
ohmybug --deep           # the deep hunt of the pushed HEAD (GitHub, public or with the OhMyBug App): the service reads the whole repository; up to 2 hours
```

The base is `--base`, else `$CI_MERGE_REQUEST_TARGET_BRANCH_NAME` (GitLab merge request pipelines), else `origin/main`. The CI clone must contain the base: fetch it, or clone with enough depth.

The CLI prints each finding (severity, file:line, title, failure scenario) and a link to the full report.

| Exit code | Meaning |
|---|---|
| 0 | no medium or worse bug (lows are printed, and do not fail the job) |
| 1 | at least one medium or worse bug, or a finding whose severity the CLI does not know (the gate fails closed) |
| 2 | the review could not run: no key, a refused key, network, a failed review, or a run cut short with no medium or worse bug (lows found by a cut-short run do not make it clean) |

| Variable | Default | |
|---|---|---|
| `OHMYBUG_API_KEY` | required | your key |
| `OHMYBUG_TIMEOUT_S` | `1800` (`10800` with `--deep`) | how long to wait for the review, 30 to 86400 seconds |
| `OHMYBUG_URL` | `https://mcp.ohmybug.ai` | the service |
| `OHMYBUG_STORY` | `auto` | the `--story` value when the flag is not given |

## Feed stories

A hunt that found a bug can be told as a short anonymous story on the public feed. A CI hunt has no agent to write it, so the service may draft one, and the draft waits on [app.ohmybug.ai/me](https://app.ohmybug.ai/me) until you post, edit, keep private or discard it. When a draft is coming or waiting, the run prints one `story:` line.

`--story` narrows this for one hunt and never widens it: `auto` (the default) leaves it to your account and key settings; `private` keeps any story of the hunt private; `never` drafts and posts none. A re-run that lands on the same hunt while it is still running does not change it.

## Billing

A key on **CI billing** (the key setting on [app.ohmybug.ai/me](https://app.ohmybug.ai/me)) pays per hunt with no confirm step: $4 for a fast hunt and $12 for a deep one ($24 on a wide change, one spread over 11 or more folder chunks), only when the result holds a medium or worse bug. A clean or failed hunt is free. The run prints what it was charged.

## GitLab CI

```yaml
ohmybug:
  image: node:22
  stage: test
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    GIT_DEPTH: 0
  script:
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - curl -fsSL https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/v0.3.0/install.sh | OHMYBUG_CLI_URL=https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/v0.3.0/ohmybug.mjs sh
    - ohmybug
```

Set `OHMYBUG_API_KEY` as a masked CI/CD variable.

## Bitbucket Pipelines

```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          image: node:22
          clone:
            depth: full
          script:
            # The clone tracks one branch: name where the target goes, or origin/<target> does not exist.
            - git fetch origin "+refs/heads/$BITBUCKET_PR_DESTINATION_BRANCH:refs/remotes/origin/$BITBUCKET_PR_DESTINATION_BRANCH"
            - curl -fsSL https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/v0.3.0/install.sh | OHMYBUG_CLI_URL=https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/v0.3.0/ohmybug.mjs sh
            - ohmybug --base "origin/$BITBUCKET_PR_DESTINATION_BRANCH"
```

## What is sent

With `--deep`, no code is sent: only the GitHub repository name (from the origin remote, else `$GITHUB_REPOSITORY`), the HEAD commit, the base branch and the branch name; the service reads the repository from GitHub (public, or with the OhMyBug App installed).

The diff (when it is over 2 MiB, per-file entries over 160 KiB, such as lockfiles and generated files, are left out and the run says so), the list of file paths at the reviewed head, and up to 29 related files (the changed files, the project manifests, and files that mention a changed module). During the review the reviewers may ask for more files by path. Every file sent is read from the reviewed commit; with `--uncommitted`, from a snapshot of the working tree taken at the start (untracked files included, nested repositories left out), so edits made while the review runs do not reach it. Only files of the reviewed tree are sent: untracked ignored files, anything under `.git` and anything outside the repository never are (a file committed to the repository is part of it, ignored or not). File requests are answered only to the service's own address, and redirects are not followed. With the review go the branch name and, in a GitLab merge request pipeline, the merge request title and description. With `--story private` or `never` (or `OHMYBUG_STORY`), that value goes too, on fast and deep hunts.

## Develop

```sh
node --test test/*.test.mjs
```
