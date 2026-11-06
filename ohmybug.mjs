#!/usr/bin/env node
// ohmybug: review the git diff of the current folder with the OhMyBug hosted bug hunt, from a CI job or a shell.
// One file, no dependencies, Node 18+. Exit 0: no medium or worse bug. 1: at least one. 2: the review could not run,
// or was cut short with no medium or worse bug.
import { execFileSync } from "node:child_process";
import { copyFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION = "0.3.0";
const USAGE = `ohmybug ${VERSION}: review this repository's changes with OhMyBug.

Usage:
  ohmybug [--base <ref>]     review <base>...HEAD (the committed changes of this branch)
  ohmybug --uncommitted      review the working tree against HEAD, untracked files included
  ohmybug --deep [--base <branch>]  the deep hunt of the pushed HEAD commit (GitHub only): the service reads the
                             whole repository; up to 2 hours, so OHMYBUG_TIMEOUT_S defaults to 10800
  --story auto|private|never  the feed story of this hunt: auto (default) leaves it to the account and key
                             settings; private keeps any story private; never drafts and posts none

The base is --base, else $CI_MERGE_REQUEST_TARGET_BRANCH_NAME (GitLab merge request pipelines),
else origin/main. With --deep it is a branch name: --base, else $GITHUB_BASE_REF, else main.

Environment:
  OHMYBUG_API_KEY     required: a key from https://app.ohmybug.ai/me
  OHMYBUG_URL         default https://mcp.ohmybug.ai
  OHMYBUG_TIMEOUT_S   how long to wait for the review, 30 to 86400 seconds, default 1800 (10800 with --deep)
  OHMYBUG_STORY       the --story value when the flag is not given

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

export class Refusal extends Error {}
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
    else if (a === "--story" || a.startsWith("--story=")) {
      const v = a === "--story" ? argv[++i] : a.slice(8);
      if (!STORY.has(v)) return "--story needs auto, private or never";
      o.story = v;
    }
    else return `unknown argument: ${a}`;
  }
  if (o.uncommitted && o.base) return "--uncommitted and --base do not go together";
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

/** What the CI says about the change, as the server's optional labels; never repo or ref, so the server reads no host (only --deep adds them, deepTarget). */
export function ciMeta(env, git) {
  const cut = (v, n) => (typeof v === "string" ? v.slice(0, n).trim() : "");
  let branch = cut(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME || env.BITBUCKET_BRANCH, 200);
  if (!branch) { try { branch = git("rev-parse", "--abbrev-ref", "HEAD").trim(); } catch { branch = ""; } }
  const title = cut(env.CI_MERGE_REQUEST_TITLE, 300), body = cut(env.CI_MERGE_REQUEST_DESCRIPTION, 8000);
  return { ...(branch && branch !== "HEAD" ? { branch } : {}), ...(title ? { pr_title: title } : {}), ...(body ? { pr_body: body } : {}) };
}

/** 0, 1 or 2 for a finished review body. */
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
 * Where the deep hunt finds the change, read from git and the environment only (no local diff: a shallow CI clone
 * has no base): the github.com repository (the origin remote, which is the checkout's own, else GITHUB_REPOSITORY),
 * the pushed HEAD commit and the base branch. The service reads a public repository, or one with the OhMyBug App installed.
 */
export function deepTarget(opts, env, git) {
  const server = env.GITHUB_SERVER_URL;
  if (server && !/^https:\/\/github\.com\/?$/.test(server)) throw new Refusal(`--deep reads repositories on github.com, not on ${server}`);
  let url = "";
  try { url = git("remote", "get-url", "origin").trim(); } catch {}
  let repo = url.match(/^(?:[\w.+-]+:\/\/)?(?:[^@/]+@)?github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)?.[1] ?? "";
  if (!repo && /^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new Refusal("--deep needs a GitHub repository: an origin remote on github.com, or GITHUB_REPOSITORY=owner/name");
  const ref = git("rev-parse", "HEAD").trim();
  // In Actions the checked-out commit GITHUB_SHA is GitHub's own; any other HEAD must be on an origin branch.
  if (ref !== env.GITHUB_SHA && !git("branch", "-r", "--list", "origin/*", "--contains", ref).trim()) throw new Refusal("--deep reviews a pushed commit: no remote branch holds HEAD; push it first");
  const base = (opts.base || env.GITHUB_BASE_REF || "main").replace(/^(refs\/remotes\/)?origin\//, "");
  if (/^[0-9a-f]{7,40}$/i.test(base) || /[~^:\s]|\.\./.test(base)) throw new Refusal(`--deep needs the base as a branch name, not ${base}`);
  return { repo, ref, base_branch: base };
}

/** One review, start to end. Returns the exit code; never calls process.exit itself (the tests drive it). */
export async function run({ argv, env, cwd, out = (s) => process.stdout.write(s + "\n"), log = (s) => process.stderr.write(`ohmybug: ${s}\n`) }) {
  const opts = parseArgs(argv);
  if (typeof opts === "string") { log(opts); log("see ohmybug --help"); return 2; }
  if (opts.help) { out(USAGE); return 0; }
  if (opts.version) { out(VERSION); return 0; }
  if (!env.OHMYBUG_API_KEY) { log("OHMYBUG_API_KEY is not set: create a key at https://app.ohmybug.ai/me"); return 2; }
  // Under 30 s no poll fits before the deadline: refused before a paid hunt starts.
  const story = opts.story ?? (env.OHMYBUG_STORY || "auto");
  if (!STORY.has(story)) { log(`OHMYBUG_STORY must be auto, private or never, not ${env.OHMYBUG_STORY}`); return 2; }
  // Sent only to narrow: an absent meta.story is the account's and key's settings alone.
  const storyMeta = story === "auto" ? {} : { story };
  const timeoutS = Number(env.OHMYBUG_TIMEOUT_S || (opts.deep ? 10800 : 1800));
  if (!Number.isInteger(timeoutS) || timeoutS < 30 || timeoutS > 86400) { log(`OHMYBUG_TIMEOUT_S must be whole seconds from 30 to 86400, not ${env.OHMYBUG_TIMEOUT_S}`); return 2; }
  const api = (env.OHMYBUG_URL || "https://mcp.ohmybug.ai").replace(/\/$/, "");
  // The key and the code travel in this request: https, or plain http to this machine only (a local test server).
  let apiUrl;
  try { apiUrl = new URL(api); } catch { log(`OHMYBUG_URL is not a URL: ${api}`); return 2; }
  if (apiUrl.protocol !== "https:" && !(apiUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(apiUrl.hostname))) {
    log(`OHMYBUG_URL must be https (plain http only to this machine): ${api}`);
    return 2;
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
        throw new Refusal(`${body.error ?? name}: ${body.message ?? raw.slice(0, 300)}${once && body.error === "internal" ? `. ${MAYBE_STARTED}` : ""}`);
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

  let started, read;
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
      if (!change.diff.trim()) { out(`Nothing to review: no changes against ${change.base}.`); return 0; }
      read = fileReader(change, gitBuf);
      const diff = trimDiff(change.diff, log);
      // The reviewers can ask for any file by path; without the list they cannot name a caller to ask for.
      let listing = change.all.join("\n");
      if (Buffer.byteLength(listing) > MAX_TREE) {
        listing = Buffer.from(listing).subarray(0, MAX_TREE).toString();
        listing = `${listing.slice(0, listing.lastIndexOf("\n"))}\n# (list cut at ${MAX_TREE} bytes)`;
      }
      const tree = { path: ".review-client/tree.txt", content: `# Every file path in this repository at the reviewed head, one per line. Sent by the review client; request any of them.\n${listing}\n` };
      // Raw and escaped: a quote- or tab-heavy diff can pass the first and not the second. fitBody never drops the
      // listing, so the diff and the listing together, escaped, leave room for meta (8 KB at most).
      if (Buffer.byteLength(diff) > MAX_BYTES || Buffer.byteLength(JSON.stringify(diff)) + Buffer.byteLength(JSON.stringify(tree.content)) > MAX_BODY - 64 * 1024) {
        throw new Refusal(`the diff (${Buffer.byteLength(diff)} bytes) and the file list are over what the service takes once encoded: ${opts.uncommitted ? "commit part of it and review" : "review"} a smaller range with --base`);
      }
      const meta = { ...ciMeta(env, git), ...storyMeta };
      args = fitBody({ diff, files: [tree, ...pack(read, contextPaths(change.changed, change.all, git, change.rev), MAX_FILES - 1, MAX_BYTES - Buffer.byteLength(diff) - Buffer.byteLength(tree.content))], ...(Object.keys(meta).length ? { meta } : {}) });
      log(`reviewing ${change.changed.length} changed file(s) against ${change.base}`);
    }

    const sub = await tool("submit_review", args, true);
    if (!sub.review_id) throw new Refusal(`submit_review answered without a review id: ${JSON.stringify(sub).slice(0, 300)}. ${MAYBE_STARTED}`);
    started = sub;
    log(`review ${sub.review_id} started${sub.recent_median_minutes ? `; recent ones took about ${sub.recent_median_minutes} min` : ""}`);
    if (sub.live_url) log(`live progress: ${sub.live_url}`);

    const answered = new Set();
    for (;;) {
      // The long poll ends before the request's own abort, which is the time left.
      // 15 s are kept for the get_findings that follows a finished wait.
      const waitS = Math.min(45, Math.floor((deadline - Date.now()) / 1000) - 15);
      if (waitS < 1) throw new Deadline("timed out");
      let r = await tool("wait_review", { review_id: sub.review_id, timeout_s: waitS });
      // The findings and review_of_record are get_findings'; a finished wait_review carries neither in full.
      if (r.status === "done" || r.status === "failed") r = await tool("get_findings", { review_id: sub.review_id });
      if (r.status === "done" || r.status === "failed") {
        const findings = (r.findings ?? []).filter((f) => f && typeof f === "object");
        const code = exitCodeFor({ ...r, findings });
        if (r.status === "failed") log(`the review failed: ${String(r.error ?? r.summary ?? "no reason given").slice(0, 300)}`);
        else if (findings.length) out(formatFindings(findings));
        else out(code === 2 ? "No bugs found before the review was cut short." : "No bugs found.");
        if (code === 2 && r.status === "done") log("the review did not finish its protocol: this is not a clean result");
        if (typeof r.story?.note === "string") log(`story: ${r.story.note.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300)}`);
        if (r.billing) log(`billing: ${r.billing.charged_usd ? `$${r.billing.charged_usd}` : "nothing"} charged${r.billing.paid_by ? ` (${r.billing.paid_by})` : ""}`);
        if (r.live_url) out(`\nReport: ${r.live_url}`);
        if (code !== 2) out(code === 1 ? `\n${findings.filter(isBlocking).length} blocking bug(s): medium or worse, or unrated.` : "\nNo blocking bugs.");
        return code;
      }
      // One answer per request: the same address may serve a later request for other files. A failed answer is not
      // marked, so a re-ask is answered again, one poll interval later.
      const request = r.status === "needs_files" && r.files_url ? `${r.files_url} ${[...(r.requested_files ?? [])].sort().join("\0")}` : null;
      if (request && !answered.has(request)) {
        if (await answerFiles(r)) { answered.add(request); continue; }
      }
      if (Date.now() >= deadline) throw new Deadline("timed out");
      if (!r.timed_out) await sleep(5000);
    }
  } catch (e) {
    if (e instanceof Refusal) log(`could not review: ${e.message}`);
    else if (e instanceof Deadline) log(`could not review: no result within OHMYBUG_TIMEOUT_S (${timeoutS}s)`);
    else log(`could not review: ${e.message ?? e}`);
    if (started) log(`review ${started.review_id} may still be running${started.live_url ? `: ${started.live_url}` : ""}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  run({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }).then((code) => process.exit(code));
}
