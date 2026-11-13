# ohmybug CLI

[![Discord](https://img.shields.io/badge/Discord-join-5865F2?logo=discord&logoColor=white)](https://discord.gg/6d7g8J44C7)

Review the changes in a git repository with the [OhMyBug](https://ohmybug.ai) bug hunt from any CI system (GitLab CI, Bitbucket Pipelines, Jenkins) or from your shell. The repository can be hosted anywhere: the CLI sends the diff and a few related files itself. For a pushed commit on github.com it sends only where to find it, and the service reads the change from GitHub (see What is sent).

One file, no dependencies, Node.js 18 or newer.

Questions → [Discord](https://discord.gg/6d7g8J44C7).

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/main/install.sh | sh
```

Or download [`ohmybug.mjs`](ohmybug.mjs) and run it with `node ohmybug.mjs`. The installer takes the latest `main`; to pin a release in CI, name its file:

```sh
curl -fsSL https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/main/install.sh | OHMYBUG_CLI_URL=https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/v0.7.0/ohmybug.mjs sh
```

Behind a proxy: Node's `fetch` reads `HTTPS_PROXY` only with `NODE_USE_ENV_PROXY=1` (Node 22.21 or newer, or 24 or newer).

## Use

Create an API key at [app.ohmybug.ai/me](https://app.ohmybug.ai/me) and put it in `OHMYBUG_API_KEY`. Then, in the repository folder:

```sh
ohmybug                  # review <base>...HEAD: the commits of this branch
ohmybug --base develop   # the same against another base
ohmybug --uncommitted    # review the working tree against HEAD, untracked files included (not ignored ones)
ohmybug --mode lite      # a lite hunt of the pushed HEAD (see Hunt modes)
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
| `OHMYBUG_TIMEOUT_S` | `1800` (`10800` with `--deep`) | how long to wait for each review, 30 to 86400 seconds; when the service continues a review with another one (a quick first step, then the fast hunt), that one gets its own full wait |
| `OHMYBUG_URL` | `https://mcp.ohmybug.ai` | the service |
| `OHMYBUG_STORY` | `auto` | the `--story` value when the flag is not given |
| `OHMYBUG_FORMAT` | `text` | the `--format` value when the flag is not given |
| `OHMYBUG_MODE` | none | the `--mode` value when the flag is not given; not used with `--deep` |

## Output for scripts and CI summaries

`--format` picks what goes to stdout; progress and notes always go to stderr, and the exit code is the same in every format.

- `text` (the default): the findings for people, as before.
- `json`: one object on one line, schema `ohmybug-cli/result/1`, printed on every exit once the arguments are read, a refusal or a timeout included (a wrong flag exits 2 with nothing on stdout).
- `markdown`: one block for a CI summary: a headline, a table of findings (each cell a code span, so nothing from a finding renders as markup or a link), each failure scenario under its own fold, the billing line and the report link.

`--step-summary` also appends the markdown block to the file `$GITHUB_STEP_SUMMARY` names (GitHub Actions), whatever `--format` is. If the variable is unset or the file cannot be written, the run says so on stderr and its exit code does not change.

```sh
ohmybug --format json > ohmybug.json; code=$?
jq -r '.findings[] | select(.blocking) | "\(.severity) \(.file):\(.line) \(.title)"' ohmybug.json
exit $code
```

| JSON field | Meaning |
|---|---|
| `schema` | `ohmybug-cli/result/1` |
| `cli_version` | this CLI's version |
| `exit_code` | the run's exit code: 0 no medium or worse bug, 1 at least one, 2 could not run or cut short |
| `outcome` | `clean`, `blocking`, `failed`, `cut_short`, `timed_out`, `interrupted` (started, then the run could not follow it to the end), `maybe_started` (the start was not confirmed and a hunt may be running: check app.ohmybug.ai/me before running again), `not_run`, `no_changes` |
| `review` | `{id, status, deep, complete}`: `id` and `status` are null when nothing started; `complete` is true only for a review that finished its whole protocol |
| `live_url` | the report link, or null |
| `live_url_missing` | why `live_url` is null (for example, the key's live link setting is off), else null |
| `billing` | `{tariff, charged_usd, paid_by, note}`: on CI billing `tariff` is `ci` and `charged_usd` what was charged; otherwise `tariff` is `confirm` and `charged_usd` null, since the charge comes when someone confirms a medium or worse finding as real, or at the billing deadline; null `tariff` when nothing started or no result was read |
| `silent_bill` | null, or `{at, billed, note}` for a review with a billing deadline |
| `findings` | most severe first, each `{id, severity, blocking, file, line, title, body, suggested_fix}`; `severity` one of `critical`, `high`, `medium`, `low` (P0-P3 map to them) or `unrated` for none or one this CLI does not know; `blocking` is medium or worse or unrated; `body` is the failure scenario |
| `counts` | `{total, blocking, critical, high, medium, low, unrated}` |
| `error` | null, or `{code, message}` when the run stopped without a result or the review failed: `code` is the service's error code when it refused, else null |

Within `ohmybug-cli/result/1`, fields and values are only added, never renamed, removed or retyped: ignore fields you do not know, and treat an `outcome` you do not know by `exit_code`. A breaking change gets a new schema name.

## Feed stories

A hunt that found a bug can be told as a short anonymous story on the public feed. A CI hunt has no agent to write it, so the service may draft one, and the draft waits on [app.ohmybug.ai/me](https://app.ohmybug.ai/me) until you post, edit, keep private or discard it. When a draft is coming or waiting, the run prints one `story:` line.

`--story` narrows this for one hunt and never widens it: `auto` (the default) leaves it to your account and key settings; `private` keeps any story of the hunt private; `never` drafts and posts none. A re-run that lands on the same hunt while it is still running does not change it.

## Billing

## Hunt modes

`--mode` picks how a fast hunt runs: `lite`, `snap` or `fast` ($4). Each bills only when it finds a real bug, at the price the service sets for the mode; the run prints what it was charged.

Without `--mode` (or `OHMYBUG_MODE`) the hunt is `fast`. The service runs only the modes it lists as live for your key, and a mode it does not run is refused before anything starts. The run prints the mode the hunt started in. `lite` and `snap` read the repository, so they need a pushed GitHub commit the service can read (see below) and do not go with `--uncommitted`; `snap` takes a diff under 1 MB. When the service cannot run the mode asked for, it starts nothing and charges nothing, and the run prints its reason; `--mode fast` always runs. `--mode` does not go with `--deep`, which is its own hunt.

A key on **CI billing** (the key setting on [app.ohmybug.ai/me](https://app.ohmybug.ai/me)) pays per hunt with no confirm step: the mode's price for a fast hunt ($4 for `fast`) and $12 for a deep one ($24 on a wide change, one spread over 11 or more folder chunks), only when the result holds a medium or worse bug. A clean or failed hunt is free. The run prints what it was charged.

Outside CI billing, some fast hunts bill on their own at a deadline unless every medium or worse finding is rejected as not a real bug first (see the [terms](https://ohmybug.ai/terms/), section 2). When a hunt has one, the run prints one `silent bill:` line on stderr after the billing line: `bills on its own at <time> unless every medium or worse finding is rejected (NOT_REAL) first`, `may bill on its own; the deadline could not be read now`, or `billed on its own at <time>`. Reject or confirm the findings on the hunt's page in [app.ohmybug.ai/me](https://app.ohmybug.ai/me) before that time. The exit code does not change.

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
    - curl -fsSL https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/v0.7.0/install.sh | OHMYBUG_CLI_URL=https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/v0.7.0/ohmybug.mjs sh
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
            - curl -fsSL https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/v0.7.0/install.sh | OHMYBUG_CLI_URL=https://raw.githubusercontent.com/OhMyX-AI/ohmybug-cli/v0.7.0/ohmybug.mjs sh
            - ohmybug --base "origin/$BITBUCKET_PR_DESTINATION_BRANCH"
```

## What is sent

With `--deep`, no code is sent: only the GitHub repository name (from the origin remote, else `$GITHUB_REPOSITORY`), the HEAD commit, the base branch and the branch name; the service reads the repository from GitHub (public, or with the OhMyBug App installed).

Without `--deep` and `--uncommitted`, when HEAD is pushed to a github.com repository (the origin remote, else `$GITHUB_REPOSITORY`) and the base is an origin branch at the same commit as here, the diff is left out: the repository name, the HEAD commit and the base branch go instead, and the service reads the change from GitHub and runs its full fast hunt. If the service does not take the change from GitHub (it cannot read the repository: a private one without the OhMyBug App installed, or one off the key's repository list; or the compare fails, is empty or is too large), the run says so and sends the same review again with the diff, which the service reviews without the rest of the repository; with `--mode lite` or `snap` it stops there instead, since those modes need the repository. Otherwise the diff is sent, and the run says why.

The diff (when it is over 2 MiB, per-file entries over 160 KiB, such as lockfiles and generated files, are left out and the run says so), the list of file paths at the reviewed head, and up to 29 related files (the changed files, the project manifests, and files that mention a changed module). During the review the reviewers may ask for more files by path. Every file sent is read from the reviewed commit; with `--uncommitted`, from a snapshot of the working tree taken at the start (untracked files included, nested repositories left out), so edits made while the review runs do not reach it. Only files of the reviewed tree are sent: untracked ignored files, anything under `.git` and anything outside the repository never are (a file committed to the repository is part of it, ignored or not). File requests are answered only to the service's own address, and redirects are not followed. With the review go the branch name and, in a GitLab merge request pipeline, the merge request title and description. With `--story private` or `never` (or `OHMYBUG_STORY`), that value goes too, on fast and deep hunts.

## Develop

```sh
node --test test/*.test.mjs
```
