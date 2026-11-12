#!/usr/bin/env node
// ohmybug: review the git diff of the current folder with the OhMyBug hosted bug hunt, from a CI job or a shell.
// One file, no dependencies, Node 18+. Exit 0: no medium or worse bug. 1: at least one. 2: the review could not run,
// or was cut short with no medium or worse bug.
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION = "0.7.0";
const USAGE = `ohmybug ${VERSION}: review this repository's changes with OhMyBug.

Usage:
  ohmybug [--base <ref>]     review <base>...HEAD (the committed changes of this branch)
  ohmybug --uncommitted      review the working tree against HEAD, untracked files included
  ohmybug --deep [--base <branch>]  the deep hunt of the pushed HEAD commit (GitHub only): the service reads the
                             whole repository; up to 2 hours, so OHMYBUG_TIMEOUT_S defaults to 10800
  --format text|markdown|json  what goes to stdout: text (default, for people), markdown (a block for a CI summary)
                             or json (one object, schema ohmybug-cli/result/1, for scripts); once the arguments are read, json
                             and markdown are printed on every exit, and progress stays on stderr
  --step-summary             also append the markdown block to the file $GITHUB_STEP_SUMMARY names (GitHub Actions)
  --mode lite|snap|fast  the hunt mode, where the service runs it; without it, fast. Each bills only when
                             it finds a real bug, at the mode's price. Lite and snap need the repository (a pushed
                             GitHub commit), and snap a diff under 1 MB; not with --deep or --uncommitted
  --story auto|private|never  the feed story of this hunt: auto (default) leaves it to the account and key
                             settings; private keeps any story private; never drafts and posts none

Without --uncommitted, a pushed HEAD of a github.com repository whose base is an origin branch (at the same commit as
here) is read by the service from GitHub (public, or with the OhMyBug GitHub App installed), which runs the full fast
hunt; otherwise, or when the service does not take it from GitHub, the diff is sent and reviewed without the repository.

The base is --base, else $CI_MERGE_REQUEST_TARGET_BRANCH_NAME (GitLab merge request pipelines),
else origin/main. With --deep it is a branch name: --base, else $GITHUB_BASE_REF, else main.

Environment:
  OHMYBUG_API_KEY     required: a key from https://app.ohmybug.ai/me
  OHMYBUG_URL         default https://mcp.ohmybug.ai
  OHMYBUG_TIMEOUT_S   how long to wait for the review, 30 to 86400 seconds, default 1800 (10800 with --deep)
  OHMYBUG_STORY       the --story value when the flag is not given
  OHMYBUG_FORMAT      the --format value when the flag is not given
  OHMYBUG_MODE        the --mode value when the flag is not given (not used with --deep)

Behind a proxy: Node's fetch reads HTTPS_PROXY only with NODE_USE_ENV_PROXY=1 (Node 22.21+, 24+).

Exit codes: 0 no medium or worse bug, 1 at least one, 2 the review could not run, or was cut short with no
medium or worse bug.`;

/** Severity order, in lower case; P0-P3 is the same scale. Medium or worse blocks: what OhMyBug bills as a real bug. */
const RANK = { critical: 0, p0: 0, high: 1, p1: 1, medium: 2, p2: 2, low: 3, p3: 3 };
const rankOf = (f) => RANK[String(f?.severity).toLowerCase()] ?? 4;
// A gate fails closed: a severity it does not know blocks.
const isBlocking = (f) => rankOf(f) !== 3;
const MAYBE_STARTED = "A hunt may have started: see https://app.ohmybug.ai/me";
// Time kept after the paid call for at least one poll and get_findings.
const POLL_ROOM = 20_000;
// Server caps: 30 files and about 10 MiB of diff and files per call; 20 files per answer to a file request.
const MAX_FILES = 30, MAX_EXTRA = 20, MAX_BYTES = 9 * 1024 * 1024, MAX_BODY = 11_500_000, MAX_FILE = 512 * 1024;
const MAX_TREE = 1024 * 1024;
// Pinned diff format, whatever the user's git config says (noprefix, mnemonicPrefix, textconv drivers).
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
const TRANSIENT_TOOL = new Set(["internal", "rate_limited"]);
const STORY = new Set(["auto", "private", "never"]);
const FORMATS = new Set(["text", "markdown", "json"]);
export const RESULT_SCHEMA = "ohmybug-cli/result/1";
// Modes that read the repository: the service refuses them on a diff alone (mode_needs_repo).
const MODES = new Set(["lite", "snap", "fast"]), REPO_MODES = new Set(["lite", "snap"]);

/** A run that cannot go on; `code` is the service's error code when the service refused. */
export class Refusal extends Error { constructor(message, code) { super(message); this.code = code; } }
export class Deadline extends Error {}

/** argv → options, or a string to print and exit 2 on. */
export function parseArgs(argv) {
  const o = { base: undefined, uncommitted: false, deep: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--uncommitted") o.uncommitted = true;
    else if (a === "--deep") o.deep = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--version") o.version = true;
    else if (a === "--base") { if (!argv[i + 1] || argv[i + 1].startsWith("-")) return "--base needs a ref"; o.base = argv[++i]; }
    else if (a.startsWith("--base=")) { if (!a.slice(7)) return "--base needs a ref"; o.base = a.slice(7); }
    else if (a === "--step-summary") o.stepSummary = true;
    else if (a === "--format" || a.startsWith("--format=")) {
      const v = a === "--format" ? argv[++i] : a.slice(9);
      if (!FORMATS.has(v)) return "--format needs text, markdown or json";
      o.format = v;
    }
    else if (a === "--mode" || a.startsWith("--mode=")) {
      const v = a === "--mode" ? argv[++i] : a.slice(7);
      if (!MODES.has(v)) return "--mode needs lite, snap or fast";
      o.mode = v;
    }
    else if (a === "--story" || a.startsWith("--story=")) {
      const v = a === "--story" ? argv[++i] : a.slice(8);
      if (!STORY.has(v)) return "--story needs auto, private or never";
      o.story = v;
    }
    else return `unknown argument: ${a}`;
  }
  if (o.uncommitted && o.base) return "--uncommitted and --base do not go together";
  if (o.mode && o.deep) return "--mode picks a fast hunt's mode; --deep is its own hunt: use one of them";
  if (o.uncommitted && REPO_MODES.has(o.mode)) return `--mode ${o.mode} reads the repository, which --uncommitted cannot send: commit and push, or use --mode fast`;
  if (o.uncommitted && o.deep) return "--deep reviews a pushed commit, not the working tree: commit, push and run ohmybug --deep";
  return o;
}

/**
 * The ref the branch is compared with: --base, then the merge request's target branch (as the remote-tracking ref when
 * the clone has it, since a CI clone rarely has the local branch), then origin/main.
 */
export function resolveBase(opts, env, hasRef) {
  if (opts.base) return opts.base;
  const target = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
  if (target) return hasRef(`origin/${target}`) ? `origin/${target}` : target;
  return "origin/main";
}

/**
 * The change to review: { diff, changed, all, rev, base }. `rev` is the tree object reviewed: the commit's with a base,
 * a snapshot of the working tree with --uncommitted. Every file sent is read from it, so a file request answered
 * minutes later reads what was reviewed. `all` is every path in it.
 */
export function selectChange(opts, env, git, snapshot) {
  let from, range, base;
  if (opts.uncommitted) {
    base = "HEAD";
    // A repository with no commit yet is reviewed against the empty tree.
    try { from = git("rev-parse", "--verify", "--quiet", "HEAD^{tree}").trim(); }
    catch { from = git("hash-object", "-t", "tree", "/dev/null").trim(); }
    range = [from, snapshot()];
  } else {
    base = resolveBase(opts, env, (ref) => { try { git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`); return true; } catch { return false; } });
    try { git("rev-parse", "--verify", "--quiet", `${base}^{commit}`); }
    catch { throw new Refusal(`base ${base} is not a commit in this clone (${opts.base ? "fetch it, or check the ref" : "fetch it, or pass --base"})`); }
    range = [`${base}...${git("rev-parse", "--verify", "HEAD^{commit}").trim()}`];
  }
  const rev = git("rev-parse", "--verify", `${range.at(-1).split("...").pop()}^{tree}`).trim();
  const diff = git("diff", ...range, ...DIFF_FLAGS);
  const changed = git("diff", ...range, "--name-only", "--diff-filter=d", "-z").split("\0").filter(Boolean);
  const all = git("ls-tree", "-r", "--name-only", "-z", rev).split("\0").filter(Boolean);
  return { diff, changed, all, rev, base };
}

/**
 * The working tree, untracked files included and ignored ones not, as a tree object, built in a throwaway index so
 * the user's own index is untouched (the blobs land in the object store, where git gc finds them). A nested
 * repository is left out: git cannot add one with no commit checked out.
 */
function snapshotTree(git, gitWith, root) {
  const index = join(tmpdir(), `ohmybug-index-${process.pid}-${Date.now()}`);
  try {
    const real = git("rev-parse", "--git-path", "index").trim();
    try { copyFileSync(isAbsolute(real) ? real : join(root, real), index); } catch {} // no index yet: start empty
    // Without --directory, git lists every untracked file and stops at a nested repository at any depth as `dir/`.
    const nested = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter((p) => p.endsWith("/"));
    gitWith({ GIT_INDEX_FILE: index }, "add", "-A", "--", ".", ...nested.map((p) => `:(exclude,top,literal)${p}`));
    return gitWith({ GIT_INDEX_FILE: index }, "write-tree").trim();
  } finally { rmSync(index, { force: true }); }
}

// A diff over the server's 2 MiB cut is split across reviewers; its per-file entries over 160 KiB are lockfiles,
// bundles or generated output: dropped, unless none would be left.
const SPLIT_BYTES = 2 * 1024 * 1024, MAX_ENTRY = 160 * 1024;
export function trimDiff(diff, log = () => {}) {
  if (Buffer.byteLength(diff) <= SPLIT_BYTES) return diff;
  const parts = diff.split(/(?=^diff --git )/m);
  const isBig = (p) => p.startsWith("diff --git ") && Buffer.byteLength(p) > MAX_ENTRY;
  const kept = parts.filter((p) => !isBig(p));
  if (kept.length === parts.length || !kept.some((p) => p.startsWith("diff --git "))) return diff;
  log(`diff trimmed: left out ${parts.length - kept.length} file(s) over ${MAX_ENTRY} bytes`);
  return kept.join("");
}

/**
 * path → text or null, from the reviewed tree. Only a path in it is read, so a request cannot reach an ignored file,
 * .git, or anything outside the repository; a symlink reads as its target's name. Missing, binary, LFS pointers and
 * files over MAX_FILE read as null.
 */
export function fileReader(change, gitBuf) {
  const known = new Set(change.all);
  return (requested) => {
    const path = String(requested).replace(/^\/+/, "");
    if (!known.has(path)) return null;
    try {
      if (Number(gitBuf("cat-file", "-s", `${change.rev}:${path}`).toString()) > MAX_FILE) return null;
      const buf = gitBuf("cat-file", "blob", `${change.rev}:${path}`);
      if (buf.subarray(0, 8000).includes(0)) return null;
      const text = buf.toString("utf8");
      return text.startsWith("version https://git-lfs.github.com/spec/") ? null : text;
    } catch { return null; }
  };
}

function pack(read, paths, max, budget) {
  const files = [];
  for (const path of paths) {
    if (files.length >= max) break;
    const content = read(path);
    if (content === null || Buffer.byteLength(content) > budget) continue;
    budget -= Buffer.byteLength(content);
    files.push({ path, content });
  }
  return files;
}

/** Project manifests and rule files a reviewer checks a change against. */
const ROOT_FILES = /^(package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements[\w.-]*\.txt|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|tsconfig\.json|AGENTS\.md|CLAUDE\.md|CONTRIBUTING\.md|README\.md)$/i;

/** Changed files first, then root manifests, then the files that name a changed module, those naming most of them first. */
function contextPaths(changed, all, git, rev) {
  const seen = new Set(changed);
  const roots = all.filter((p) => !p.includes("/") && ROOT_FILES.test(p) && !seen.has(p));
  roots.forEach((p) => seen.add(p));
  const hits = new Map();
  const stems = [...new Set(changed.map((p) => p.split("/").pop().replace(/\.[^.]+$/, ""))
    .filter((s) => s.length >= 4 && !/^(index|main|init|__init__|readme|test|tests|utils)$/i.test(s)))].slice(0, 20);
  for (const stem of stems) {
    let out = "";
    try { out = git("grep", "--no-color", "-l", "-I", "-F", "-w", "-z", "-e", stem, ...(rev ? [rev] : []), "--"); } catch { continue; } // exit 1: no match
    for (const ref of out.split("\0").filter(Boolean)) {
      const p = rev ? ref.slice(rev.length + 1) : ref;
      if (!seen.has(p)) hits.set(p, (hits.get(p) ?? 0) + 1);
    }
  }
  return [...changed, ...roots, ...[...hits].sort((a, b) => b[1] - a[1]).map(([p]) => p)];
}

/** What the CI says about the change, as the server's optional labels; never repo or ref: those come only from repoTarget, on a pushed GitHub commit. */
export function ciMeta(env, git) {
  const cut = (v, n) => (typeof v === "string" ? v.slice(0, n).trim() : "");
  let branch = cut(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME || env.BITBUCKET_BRANCH, 200);
  if (!branch) { try { branch = git("rev-parse", "--abbrev-ref", "HEAD").trim(); } catch { branch = ""; } }
  const title = cut(env.CI_MERGE_REQUEST_TITLE, 300), body = cut(env.CI_MERGE_REQUEST_DESCRIPTION, 8000);
  return { ...(branch && branch !== "HEAD" ? { branch } : {}), ...(title ? { pr_title: title } : {}), ...(body ? { pr_body: body } : {}) };
}

/** 0, 1 or 2 for a finished review body. */
/** get_findings' `silent_bill` (a fast hunt that bills on its own unless every medium or worse finding is rejected) as
 *  one fixed stderr line, or null when there is none. Only a well-formed UTC timestamp is echoed: server text never is. */
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
export function silentBillLine(sb) {
  if (!sb || typeof sb !== "object") return null;
  const at = typeof sb.at === "string" && ISO_UTC.test(sb.at) ? sb.at : null;
  if (sb.billed === true) return at ? `silent bill: billed on its own at ${at}` : "silent bill: billed on its own";
  if (!at) return "silent bill: may bill on its own; the deadline could not be read now";
  return `silent bill: bills on its own at ${at} unless every medium or worse finding is rejected (NOT_REAL) first`;
}

export function exitCodeFor(r) {
  if (r.status !== "done") return 2;
  if ((r.findings ?? []).some(isBlocking)) return 1;
  // A run that was cut short and found nothing is not a clean result: the gate cannot pass on it.
  return r.review_of_record === false ? 2 : 0;
}

export function formatFindings(findings) {
  return [...findings].sort((a, b) => rankOf(a) - rankOf(b)).map((f) => {
    const where = f.file ? (f.line ? `${f.file}:${f.line}` : String(f.file)) : "";
    const scenario = String(f.failure_scenario ?? "").trim().replace(/\n/g, "\n    ");
    return `${String(f.severity ?? "unrated").toUpperCase()}  ${where}  ${f.title ?? ""}`.trimEnd() + (scenario ? `\n    ${scenario}` : "");
  }).join("\n\n");
}

const SEVERITIES = ["critical", "high", "medium", "low", "unrated"];
const severityOf = (f) => ["critical", "high", "medium", "low"][rankOf(f)] ?? "unrated";
const strOrNull = (v) => (typeof v === "string" && v ? v : null);
// A string or a number as a string; anything else (absent, empty, an object) is null.
const scalar = (v) => ((typeof v === "string" && v) || (typeof v === "number" && Number.isFinite(v)) ? String(v) : null);
// An amount the service reported, or null when it reported none: never a guessed 0.
const usd = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * The run as one object (schema ohmybug-cli/result/1): fields are only ever added within /1. `rec` is what the run
 * saw: reviewId, deep, live, answer (the last done/failed body), error, timedOut, maybeStarted, noChanges.
 */
export function resultOf(rec, code) {
  const r = rec.answer;
  const findings = [...(r?.findings ?? []).filter((f) => f && typeof f === "object")].sort((a, b) => rankOf(a) - rankOf(b)).map((f) => ({
    id: scalar(f.finding_id ?? f.id), severity: severityOf(f), blocking: isBlocking(f), file: scalar(f.file),
    line: /^[1-9]\d*$/.test(String(f.line ?? "")) ? Number(f.line) : null, title: String(f.title ?? ""),
    body: String(f.failure_scenario ?? ""), suggested_fix: strOrNull(f.suggested_fix),
  }));
  const counts = { total: findings.length, blocking: findings.filter((f) => f.blocking).length };
  for (const s of SEVERITIES) counts[s] = 0;
  for (const f of findings) counts[f.severity]++;
  const outcome = rec.noChanges ? "no_changes" : !rec.reviewId ? (rec.maybeStarted ? "maybe_started" : "not_run") : rec.timedOut ? "timed_out"
    : !r ? "interrupted" : r.status === "failed" ? "failed" : code === 1 ? "blocking" : code === 0 ? "clean" : "cut_short";
  const live = strOrNull(r?.live_url) ?? strOrNull(rec.live);
  // The service sends a billing block only on CI billing (tariff "ci"); any other block is read as the confirm tariff.
  const b = r?.billing && typeof r.billing === "object" && r.billing.tariff === "ci" ? r.billing : null;
  const sb0 = r?.silent_bill && typeof r.silent_bill === "object";
  const maybe = rec.maybeStarted && !rec.reviewId;
  const billing = maybe ? { tariff: null, charged_usd: null, paid_by: null,
      note: "a hunt may have started and may be charged: check https://app.ohmybug.ai/me before running again" }
    : !rec.reviewId ? { tariff: null, charged_usd: null, paid_by: null, note: "nothing started, nothing charged" }
    : r?.status === "failed" ? { tariff: b ? "ci" : null, charged_usd: usd(b?.charged_usd), paid_by: strOrNull(b?.paid_by),
      note: usd(b?.charged_usd) ? "the charge the service reported for this review" : "a failed review is free" }
    : b ? { tariff: "ci", charged_usd: usd(b.charged_usd), paid_by: strOrNull(b.paid_by),
      note: "CI billing: charged when the result holds a medium or worse finding" }
    : r ? { tariff: "confirm", charged_usd: null, paid_by: null,
      note: `charged only when someone confirms a medium or worse finding as REAL${sb0 ? ", or at the billing deadline" : ""}` }
    : { tariff: null, charged_usd: null, paid_by: null, note: "no result was read, so the charge is not known here" };
  const sb = r?.silent_bill && typeof r.silent_bill === "object" ? r.silent_bill : null;
  return {
    schema: RESULT_SCHEMA, cli_version: VERSION, exit_code: code, outcome,
    review: { id: rec.reviewId ?? null, status: r ? String(r.status) : rec.reviewId ? "running" : null, deep: !!rec.deep,
      complete: r ? r.review_of_record !== false && r.status === "done" : false },
    live_url: live,
    live_url_missing: live ? null : maybe ? "the start was not confirmed: check https://app.ohmybug.ai/me" : !rec.reviewId ? "nothing started"
      : "the service sent no live link: the key's live link setting is off (app.ohmybug.ai/me), or it was not read",
    billing,
    silent_bill: sb ? { at: typeof sb.at === "string" && ISO_UTC.test(sb.at) ? sb.at : null, billed: sb.billed === true, note: silentBillLine(sb) } : null,
    findings, counts,
    error: rec.error ?? null,
  };
}

// Server text in a step summary is data: HTML is escaped, and a table cell keeps to one line and its own column.
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cell = (s) => {
  const t = String(s).replace(/[\r\n]+/g, " ").trim();
  if (!t) return "";
  const fence = "`".repeat(Math.max(0, ...(t.match(/`+/g) ?? []).map((m) => m.length)) + 1);
  return `${fence} ${t.replace(/\|/g, "\\|")} ${fence}`;
};
const HEADLINE = {
  clean: "No blocking bugs", failed: "The review failed", cut_short: "Cut short, no blocking bug found: not a clean result",
  timed_out: "Timed out before a result", interrupted: "Stopped before a result", not_run: "Could not run", no_changes: "Nothing to review",
  maybe_started: "Could not confirm the start: a hunt may be running",
};

// GitHub drops a step summary over 1 MiB: past this bound the folds go and the table stays.
const SUMMARY_MAX = 900 * 1024;

/** The markdown block for a CI summary, from resultOf's object; `folds` false leaves the failure scenarios out. */
export function resultMarkdown(res, folds = true) {
  const head = res.outcome === "blocking" ? `${res.counts.blocking} blocking bug${res.counts.blocking === 1 ? "" : "s"}` : HEADLINE[res.outcome] ?? res.outcome;
  const out = [`### OhMyBug review: ${head}`, ""];
  const where = (f) => (f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "");
  if (res.findings.length) {
    out.push("| Severity | Location | Finding |", "|---|---|---|");
    for (const f of res.findings) out.push(`| ${f.severity.toUpperCase()} | ${cell(where(f))} | ${cell(f.title)} |`);
    out.push("");
    for (const f of folds ? res.findings : []) {
      out.push(`<details><summary>${escHtml(`${f.severity.toUpperCase()} ${where(f)}: ${f.title}`.replace(/[\r\n]+/g, " "))}</summary>`, "");
      out.push(`<pre>${escHtml(f.body)}</pre>`, "", "</details>", "");
    }
  }
  if (res.error) out.push(`<pre>${escHtml(res.error.message)}</pre>`, "");
  const b = res.billing;
  const how = [b.tariff === "ci" ? "CI billing" : "", b.paid_by ? cell(b.paid_by) : ""].filter(Boolean).join(", ");
  const bill = b.charged_usd !== null ? `$${b.charged_usd} charged${how ? ` (${how})` : ""}` : escHtml(b.note);
  out.push(`Billing: ${bill}.${res.silent_bill ? ` ${escHtml(res.silent_bill.note)}.` : ""}`, "");
  // The link is drawn only as a plain https URL: anything else is not a link to follow.
  const link = /^https:\/\/[^\s<>()[\]`]+$/.test(res.live_url ?? "") ? res.live_url : null;
  out.push(link ? `Report: <${link}>` : `Report: none (${escHtml(res.live_url_missing ?? "the link the service sent is not a plain https URL")})`);
  if (!folds) out.push("", `Failure scenarios left out: the summary would be over GitHub's size limit.${link ? " The report has them." : ""}`);
  const md = out.join("\n");
  return folds && Buffer.byteLength(md) > SUMMARY_MAX ? resultMarkdown(res, false) : md;
}

/** Context files dropped from the end until the JSON body (escaping and meta included) fits the server's cap. */
export function fitBody(body, max = MAX_BODY) {
  const files = [...body.files];
  while (files.length > 1 && Buffer.byteLength(JSON.stringify({ ...body, files })) > max) files.pop();
  return { ...body, files };
}

/** An MCP answer: a JSON body, or a text/event-stream whose last data event carries the JSON-RPC response. */
export function rpcMessage(text) {
  if (text.trimStart().startsWith("{")) return JSON.parse(text);
  const events = text.split(/\r?\n\r?\n/).map((e) => e.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n"));
  for (const data of events.reverse()) {
    try { const m = JSON.parse(data); if (m && (m.result || m.error)) return m; } catch {}
  }
  throw new Refusal(`unreadable answer: ${text.slice(0, 200)}`);
}

/**
 * Where the service finds the change on GitHub, read from git and the environment only (no local diff: a shallow CI
 * clone has no base): the github.com repository (the origin remote, which is the checkout's own, else
 * GITHUB_REPOSITORY), the pushed HEAD commit and the base branch. `{ repo, ref, base_branch }`, or `{ why }` when
 * there is none. The service reads a public repository, or one with the OhMyBug GitHub App installed. With `local`
 * (the fast hunt, whose diff was made here) the base must be an origin branch at the very commit the local diff used:
 * the service diffs the branch of that name on GitHub, and another tip is another range.
 */
export function repoTarget(env, git, base, local = false) {
  const server = env.GITHUB_SERVER_URL;
  if (server && !/^https:\/\/github\.com\/?$/.test(server)) return { why: `the service reads repositories on github.com, not on ${server}` };
  let url = "";
  try { url = git("remote", "get-url", "origin").trim(); } catch {}
  let repo = url.match(/^(?:[\w.+-]+:\/\/)?(?:[^@/]+@)?github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? "";
  if (!repo && /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) repo = env.GITHUB_REPOSITORY;
  if (!repo) return { why: "no GitHub repository: an origin remote on github.com, or GITHUB_REPOSITORY=owner/name" };
  const ref = git("rev-parse", "HEAD").trim();
  // In Actions the checked-out commit GITHUB_SHA is GitHub's own; any other HEAD must be on an origin branch.
  if (ref !== env.GITHUB_SHA && !git("branch", "-r", "--list", "origin/*", "--contains", ref).trim()) return { why: "HEAD is not pushed: no remote branch holds it; push it first" };
  const branch = base.replace(/^(refs\/remotes\/)?origin\//, "");
  // A sha or an expression is not sent: the service keys the commit and its deep hunt on a branch name.
  if (/^[0-9a-f]{7,40}$/i.test(branch) || /[~^:\s]|\.\./.test(branch)) return { why: `the base ${base} is not a branch name` };
  if (local) {
    const at = (r) => { try { return git("rev-parse", "--verify", "--quiet", `${r}^{commit}`).trim(); } catch { return ""; } };
    const name = base.replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "");
    if (name === "HEAD" || !at(`refs/remotes/origin/${name}`) || at(`refs/remotes/origin/${name}`) !== at(base)) {
      return { why: `the base ${base} is not an origin branch at the commit diffed here` };
    }
    return { repo, ref, base_branch: name };
  }
  return { repo, ref, base_branch: branch };
}

/** The deep hunt's target: repoTarget with the base --base, else $GITHUB_BASE_REF, else main; none is a refusal. */
export function deepTarget(opts, env, git) {
  const t = repoTarget(env, git, opts.base || env.GITHUB_BASE_REF || "main");
  if (t.why) throw new Refusal(`--deep cannot run: ${t.why}`);
  return t;
}

// The service refused to fetch the change from GitHub before starting anything: the diff is sent instead.
const REPO_REFUSED = new Set(["diff_required", "repo_not_listed", "diff_fetch_failed", "empty_compare", "diff_too_large"]);

/** One review, start to end. Returns the exit code; never calls process.exit itself (the tests drive it). */
export async function run({ argv, env, cwd, out = (s) => process.stdout.write(s + "\n"), log = (s) => process.stderr.write(`ohmybug: ${s}\n`) }) {
  const opts = parseArgs(argv);
  if (typeof opts === "string") { log(opts); log("see ohmybug --help"); return 2; }
  if (opts.help) { out(USAGE); return 0; }
  if (opts.version) { out(VERSION); return 0; }
  const format = opts.format ?? (env.OHMYBUG_FORMAT || "text");
  if (!FORMATS.has(format)) { log(`OHMYBUG_FORMAT must be text, markdown or json, not ${env.OHMYBUG_FORMAT}`); return 2; }
  const rec = { deep: opts.deep };
  // The text lines go to stdout only in text; the other formats print the one result below.
  const code = await review({ opts, env, cwd, out: format === "text" ? out : () => {}, log, rec });
  const res = format === "text" && !opts.stepSummary ? null : resultOf(rec, code);
  if (format === "json") out(JSON.stringify(res));
  if (format === "markdown") out(resultMarkdown(res));
  if (opts.stepSummary) {
    if (!env.GITHUB_STEP_SUMMARY) log("--step-summary: GITHUB_STEP_SUMMARY is not set, so no summary was written");
    else try { appendFileSync(env.GITHUB_STEP_SUMMARY, resultMarkdown(res) + "\n"); }
    catch (e) { log(`--step-summary: could not write ${env.GITHUB_STEP_SUMMARY} (${e.code ?? e.message})`); }
  }
  return code;
}

async function review({ opts, env, cwd, out, log, rec }) {
  // A run that stops before a hunt says why in the result too.
  const fail = (message) => { log(message); rec.error = { code: null, message }; return 2; };
  if (!env.OHMYBUG_API_KEY) return fail("OHMYBUG_API_KEY is not set: create a key at https://app.ohmybug.ai/me");
  // Under 30 s no poll fits before the deadline: refused before a paid hunt starts.
  const story = opts.story ?? (env.OHMYBUG_STORY || "auto");
  if (!STORY.has(story)) return fail(`OHMYBUG_STORY must be auto, private or never, not ${env.OHMYBUG_STORY}`);
  // Sent only to narrow: an absent meta.story is the account's and key's settings alone.
  const storyMeta = story === "auto" ? {} : { story };
  // The env value is a default: never sent with --deep, where the service takes no mode.
  const mode = opts.deep ? undefined : opts.mode ?? (env.OHMYBUG_MODE || undefined);
  if (mode !== undefined && !MODES.has(mode)) return fail(`OHMYBUG_MODE must be lite, snap or fast, not ${env.OHMYBUG_MODE}`);
  if (!opts.mode && opts.uncommitted && REPO_MODES.has(mode)) return fail(`OHMYBUG_MODE=${mode} reads the repository, which --uncommitted cannot send: commit and push, or set OHMYBUG_MODE=fast`);
  // Absent: a fast hunt.
  const modeArg = mode ? { mode } : {};
  const timeoutS = Number(env.OHMYBUG_TIMEOUT_S || (opts.deep ? 10800 : 1800));
  if (!Number.isInteger(timeoutS) || timeoutS < 30 || timeoutS > 86400) return fail(`OHMYBUG_TIMEOUT_S must be whole seconds from 30 to 86400, not ${env.OHMYBUG_TIMEOUT_S}`);
  const api = (env.OHMYBUG_URL || "https://mcp.ohmybug.ai").replace(/\/$/, "");
  // The key and the code travel in this request: https, or plain http to this machine only (a local test server).
  let apiUrl;
  try { apiUrl = new URL(api); } catch { return fail(`OHMYBUG_URL is not a URL: ${api}`); }
  if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(apiUrl.hostname))) {
    return fail(`OHMYBUG_URL must be https (plain http only to this machine): ${api}`);
  }
  const deadline = Date.now() + timeoutS * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, deadline - Date.now()))));
  const execGit = (dir, a, extra) => execFileSync("git", ["-C", dir, ...a], { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...(extra ? { env: { ...process.env, ...extra } } : {}) });

  /**
   * POST and return the body text, retrying network errors, 408, 429 and 5xx until the deadline; a host never reached
   * fails after four tries. With `once` (the call that starts a paid hunt) only failures that prove the server never
   * took the request are retried, and the request is not cut at 60 s (a multi-MB upload on a slow uplink takes longer)
   * but at POLL_ROOM before the deadline, so a started hunt always gets polled. No redirect is followed: the body
   * would go to wherever it points.
   */
  let reached = false;
  async function http(url, init, { once = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Deadline("timed out");
      if (once && left <= POLL_ROOM) throw new Refusal("too little of OHMYBUG_TIMEOUT_S is left to start a hunt and wait for it; nothing was started");
      let why, retryAfter = 0;
      try {
        const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(once ? left - POLL_ROOM : Math.min(60_000, left)) });
        reached = true;
        const text = await res.text();
        if (res.ok) return text;
        if (res.status === 401 || res.status === 403) throw new Refusal(`the API key was refused, or the request blocked (HTTP ${res.status} ${text.slice(0, 200)})`);
        const retryable = res.status === 429 || (!once && (res.status === 408 || res.status >= 500));
        if (!retryable) throw new Refusal(`HTTP ${res.status} ${text.slice(0, 300)}${once && res.status >= 500 ? `. ${MAYBE_STARTED}` : ""}`);
        why = `HTTP ${res.status}`;
        const after = res.headers.get("retry-after");
        retryAfter = Math.max(0, Number(after) * 1000 || Date.parse(after) - Date.now() || 0);
      } catch (e) {
        if (e instanceof Refusal) throw e;
        why = e.cause?.code ?? e.message;
        // Failures before any byte reached a server: safe to send again, even the paid call.
        const unreachable = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"].includes(e.cause?.code);
        if (once && !unreachable) {
          throw new Refusal(`no clear answer (${why}); not sent again, so as not to start a second hunt. ${MAYBE_STARTED}`);
        }
        // A host never reached is a wrong OHMYBUG_URL or a proxy-only runner, not a blip worth the whole timeout.
        if (unreachable && !reached && attempt >= 3) {
          const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
          throw new Refusal(`cannot reach ${new URL(url).host} (${why})${proxy && env.NODE_USE_ENV_PROXY !== "1" ? "; Node's fetch reads HTTPS_PROXY only with NODE_USE_ENV_PROXY=1 (Node 22.21+, 24+)" : ""}`);
        }
      }
      const wait = Math.max(retryAfter, Math.min(30_000, 2000 * 2 ** attempt));
      // A wait the deadline cannot fit ends now, not after idling to the deadline.
      if (wait >= deadline - Date.now() - (once ? POLL_ROOM : 0)) {
        if (once) throw new Refusal(`${why}: the service asks to wait ${Math.round(wait / 1000)}s, more than OHMYBUG_TIMEOUT_S leaves; nothing was started`);
        throw new Deadline("timed out");
      }
      log(`${why}; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
  let rpcId = 0;
  async function tool(name, args, once = false) {
    for (let attempt = 0; ; attempt++) {
      const text = await http(`${api}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.OHMYBUG_API_KEY}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      }, { once });
      let msg = null, body = null, raw = "";
      try {
        msg = rpcMessage(text);
        raw = msg.result?.content?.[0]?.text ?? "";
        body = msg.error || !raw.trimStart().startsWith("{") ? null : JSON.parse(raw);
      } catch {}
      // A garbled answer, a protocol error or a plain-text answer: a poll asks again; the paid call is no clear
      // answer, and is not resent.
      if (!body) {
        const what = !msg ? "unreadable answer" : msg.error ? `protocol error: ${msg.error.message}` : raw.slice(0, 300) || "empty answer";
        if (once) throw new Refusal(`${name}: ${what}; not sent again. ${MAYBE_STARTED}`);
        log(`${name}: ${what}; retrying`);
        await sleep(Math.min(30_000, 2000 * 2 ** attempt));
        if (Date.now() >= deadline) throw new Deadline("timed out");
        continue;
      }
      if (!msg.result?.isError) return body;
      // An internal error may come after the hunt was created: a paid call retries only a rate limit, and says so.
      if (!TRANSIENT_TOOL.has(body.error) || (once && body.error !== "rate_limited")) {
        throw new Refusal(`${body.error ?? name}: ${body.message ?? raw.slice(0, 300)}${once && body.error === "internal" ? `. ${MAYBE_STARTED}` : ""}`, body.error);
      }
      const wait = Math.min(60_000, 5000 * 2 ** attempt);
      log(`${body.error}; retrying in ${wait / 1000}s`);
      await sleep(wait);
      if (Date.now() >= deadline) throw new Deadline("timed out");
    }
  }

  /**
   * One try at a file request, never fatal: the service gives up on a request after a few minutes and goes on without
   * the files, so a failed answer costs the reviewers those files, not the run. Files go only to the service's own
   * origin, and a redirect is not followed (it would carry them elsewhere).
   */
  async function answerFiles(r) {
    let url;
    try { url = new URL(r.files_url, api); } catch { log(`a file request named no usable address; not answered`); return true; }
    if (url.origin !== apiUrl.origin) { log(`a file request named another host (${url.host}); not answered`); return true; }
    const sent = pack(read, (r.requested_files ?? []).slice(0, 200), MAX_EXTRA, MAX_BYTES);
    log(`the reviewers asked for ${(r.requested_files ?? []).length} file(s); sending ${sent.length}`);
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fitBody({ files: sent })),
        redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(120_000, deadline - Date.now()))),
      });
      if (res.ok) return true;
      log(`the file answer was refused (HTTP ${res.status}); continuing`);
    } catch (e) { log(`the file answer did not go through (${e.cause?.code ?? e.cause?.message ?? e.message}); continuing`); }
    return false;
  }

  let started, read, fallback;
  try {
    let root;
    try { root = realpathSync(execGit(cwd, ["rev-parse", "--show-toplevel"]).toString().trim()); }
    catch { throw new Refusal("this folder is not inside a git repository"); }
    const gitBuf = (...a) => execGit(root, a), git = (...a) => gitBuf(...a).toString();
    let args;
    if (opts.deep) {
      // The service fetches the repository and the diff itself: only where to find them goes up.
      read = () => null;
      args = { deep: true, meta: { ...ciMeta(env, git), ...storyMeta, ...deepTarget(opts, env, git) } };
      log(`deep hunt of ${args.meta.repo} at ${args.meta.ref.slice(0, 12)} against ${args.meta.base_branch}; waiting up to ${timeoutS}s`);
      if (timeoutS < 7200) log("a deep hunt takes up to 2 hours: OHMYBUG_TIMEOUT_S under 7200 may end the wait before the result");
    } else {
      const change = selectChange(opts, env, git, () => snapshotTree(git, (extra, ...a) => execGit(root, a, extra).toString(), root));
      if (!change.diff.trim()) { out(`Nothing to review: no changes against ${change.base}.`); rec.noChanges = true; return 0; }
      read = fileReader(change, gitBuf);
      // The reviewers can ask for any file by path; without the list they cannot name a caller to ask for.
      let listing = change.all.join("\n");
      if (Buffer.byteLength(listing) > MAX_TREE) {
        listing = Buffer.from(listing).subarray(0, MAX_TREE).toString();
        listing = `${listing.slice(0, listing.lastIndexOf("\n"))}\n# (list cut at ${MAX_TREE} bytes)`;
      }
      const tree = { path: ".review-client/tree.txt", content: `# Every file path in this repository at the reviewed head, one per line. Sent by the review client; request any of them.\n${listing}\n` };
      const meta = { ...ciMeta(env, git), ...storyMeta };
      const context = contextPaths(change.changed, change.all, git, change.rev);
      const files = (budget) => [tree, ...pack(read, context, MAX_FILES - 1, budget - Buffer.byteLength(tree.content))];
      // The diff is trimmed and its size checked only when it is sent: with the repository the service reads the change itself.
      const payload = () => {
        const diff = trimDiff(change.diff, log);
        // Raw and escaped: a quote- or tab-heavy diff can pass the first and not the second. fitBody never drops the
        // listing, so the diff and the listing together, escaped, leave room for meta (8 KB at most).
        if (Buffer.byteLength(diff) > MAX_BYTES || Buffer.byteLength(JSON.stringify(diff)) + Buffer.byteLength(JSON.stringify(tree.content)) > MAX_BODY - 64 * 1024) {
          throw new Refusal(`the diff (${Buffer.byteLength(diff)} bytes) and the file list are over what the service takes once encoded: ${opts.uncommitted ? "commit part of it and review" : "review"} a smaller range with --base`);
        }
        return fitBody({ diff, files: files(MAX_BYTES - Buffer.byteLength(diff)), ...(Object.keys(meta).length ? { meta } : {}) });
      };
      log(`reviewing ${change.changed.length} changed file(s) against ${change.base}`);
      // With the repository the service runs the full fast hunt; with the diff alone, a review without it.
      const target = opts.uncommitted ? { why: "--uncommitted reviews the working tree, which only this machine has" } : repoTarget(env, git, change.base, true);
      if (target.why) {
        log(`reviewing the diff only, without the repository: ${target.why}`);
        args = payload();
      } else {
        log(`the service reads ${target.repo} at ${target.ref.slice(0, 12)} against ${target.base_branch} from GitHub`);
        args = fitBody({ diff: "", files: files(MAX_BYTES), meta: { ...meta, ...target } });
        fallback = (code) => {
          log(`the service did not take the change from GitHub (${code}): reviewing the diff only, without the repository${code === "diff_required" ? "; the OhMyBug GitHub App installed on the repository (read-only) gives the full fast hunt" : ""}`);
          return payload();
        };
      }
    }

    // The client route (get_balance.route, switched on by the service): with no mode and no --deep, a commit the service
    // reads is hunted as snap first; a snap with no medium or worse bug is followed by an ordinary fast hunt of the same
    // commit, whose result is the answer. A snap the service refuses, fails or cuts short falls back to that fast hunt too.
    let route = !mode && !opts.deep && !!fallback && await tool("get_balance", {}).then((b) => b?.route?.first === "snap", () => false);
    const submit = async (asked) => {
      let sub;
      try { sub = await tool("submit_review", { ...args, ...asked }, true); }
      catch (e) {
        if (route && asked.mode === "snap" && e instanceof Refusal && String(e.code ?? "").startsWith("mode_")) {
          log(`the snap pass was refused (${e.code}): running the fast hunt`);
          route = false;
          return submit({});
        }
        if (!fallback || !(e instanceof Refusal) || !REPO_REFUSED.has(e.code)) throw e;
        // A diff alone cannot run a mode that reads the repository: say so instead of a second, refused call.
        if (REPO_MODES.has(mode)) throw new Refusal(`${e.message}; --mode ${mode} needs the repository, so the diff was not sent alone: use --mode fast to review the diff without it`, e.code);
        // The route reads the repository too: the diff alone goes as the plain hunt.
        route = false;
        sub = await tool("submit_review", { ...fallback(e.code), ...modeArg }, true);
      }
      if (!sub.review_id) throw new Refusal(`submit_review answered without a review id: ${JSON.stringify(sub).slice(0, 300)}. ${MAYBE_STARTED}`);
      started = sub;
      rec.reviewId = sub.review_id;
      rec.live = sub.live_url;
      log(`review ${sub.review_id} started${typeof sub.hunt_mode === "string" && MODES.has(sub.hunt_mode) ? ` in ${sub.hunt_mode} mode` : ""}${sub.recent_median_minutes ? `; recent ones took about ${sub.recent_median_minutes} min` : ""}`);
      if (sub.live_url) log(`live progress: ${sub.live_url}`);
      return sub;
    };
    /** Waits for the hunt and returns get_findings' answer once it is done or failed. */
    const finished = async (sub) => {
      const answered = new Set();
      for (;;) {
        // The long poll ends before the request's own abort, which is the time left.
        // 15 s are kept for the get_findings that follows a finished wait.
        const waitS = Math.min(45, Math.floor((deadline - Date.now()) / 1000) - 15);
        if (waitS < 1) throw new Deadline("timed out");
        let r = await tool("wait_review", { review_id: sub.review_id, timeout_s: waitS });
        // The findings and review_of_record are get_findings'; a finished wait_review carries neither in full.
        if (r.status === "done" || r.status === "failed") r = await tool("get_findings", { review_id: sub.review_id });
        if (r.status === "done" || r.status === "failed") return r;
        // One answer per request: the same address may serve a later request for other files. A failed answer is not
        // marked, so a re-ask is answered again, one poll interval later.
        const request = r.status === "needs_files" && r.files_url ? `${r.files_url} ${[...(r.requested_files ?? [])].sort().join("\0")}` : null;
        if (request && !answered.has(request)) {
          if (await answerFiles(r)) { answered.add(request); continue; }
        }
        if (Date.now() >= deadline) throw new Deadline("timed out");
        if (!r.timed_out) await sleep(5000);
      }
    };

    let r = await finished(await submit(route ? { mode: "snap" } : modeArg));
    if (route) {
      const snapCode = exitCodeFor({ ...r, findings: (r.findings ?? []).filter((f) => f && typeof f === "object") });
      if (snapCode === 1) log("the snap pass found a medium or worse bug: that is the answer, no fast hunt follows");
      else {
        log(snapCode === 0 ? `quick pass ${rec.reviewId}: nothing major; running the full fast hunt` : `quick pass ${rec.reviewId} did not finish cleanly; running the full fast hunt`);
        rec.snapId = rec.reviewId;
        route = false;
        r = await finished(await submit({}));
      }
    }
    const findings = (r.findings ?? []).filter((f) => f && typeof f === "object");
    const code = exitCodeFor({ ...r, findings });
    rec.answer = { ...r, findings };
    if (r.status === "failed") {
      const message = `the review failed: ${String(r.error ?? r.summary ?? "no reason given").slice(0, 300)}`;
      log(message);
      rec.error = { code: null, message };
    }
    else if (findings.length) out(formatFindings(findings));
    else out(code === 2 ? "No bugs found before the review was cut short." : "No bugs found.");
    if (code === 2 && r.status === "done") log("the review did not finish its protocol: this is not a clean result");
    if (typeof r.story?.note === "string") log(`story: ${r.story.note.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300)}`);
    if (r.billing) log(`billing: ${r.billing.charged_usd ? `$${r.billing.charged_usd}` : "nothing"} charged${r.billing.paid_by ? ` (${r.billing.paid_by})` : ""}`);
    const silent = silentBillLine(r.silent_bill);
    if (silent) log(silent);
    if (r.live_url) out(`\nReport: ${r.live_url}`);
    if (code !== 2) out(code === 1 ? `\n${findings.filter(isBlocking).length} blocking bug(s): medium or worse, or unrated.` : "\nNo blocking bugs.");
    return code;
  } catch (e) {
    const message = e instanceof Refusal ? `could not review: ${e.message}`
      : e instanceof Deadline ? `could not review: no result within OHMYBUG_TIMEOUT_S (${timeoutS}s)` : `could not review: ${e.message ?? e}`;
    log(message);
    rec.error = { code: e instanceof Refusal && typeof e.code === "string" ? e.code : null, message };
    rec.timedOut = e instanceof Deadline;
    rec.maybeStarted = e instanceof Refusal && e.message.includes(MAYBE_STARTED);
    if (started) log(`review ${started.review_id} may still be running${started.live_url ? `: ${started.live_url}` : ""}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }).then((code) => process.stdout.write("", () => process.exit(code)));
}
