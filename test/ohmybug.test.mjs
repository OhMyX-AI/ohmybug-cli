// Diff selection and exit codes, end to end: a throwaway git repository and a fake review server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, utimesSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciMeta, DECISION_WAIT_S, exitCodeFor, fitBody, parseArgs, resolveBase, resultMarkdown, resultOf, rpcMessage, run, silentBillLine, trimDiff, VERSION } from "../ohmybug.mjs";

// The tests own their git config: a developer's or a runner's own (a git-lfs filter, say) would change what they see.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ohmybug-cli-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "app.js"), "export const a = 1\n");
  git("add", ".");
  git("commit", "-qm", "base");
  // A CI clone has the target branch as a remote-tracking ref only.
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("update-ref", "refs/remotes/origin/develop", "HEAD");
  git("checkout", "-qb", "feature");
  return { dir, git };
}

/**
 * A review server that answers submit_review, wait_review and get_findings with `findings` and `status`. `requested`
 * makes the first wait_review a file request whose answer lands in `posted`; `sse` answers as an event stream;
 * `submitStatus` fails submit_review with that HTTP status; `toolError` answers every tool call with isError;
 * `faults` fails the first call of a tool: { wait_review: 503 | "reset" | "garble" | "internal" | "rate_limited" |
 * "slow429" (a 429 asking for 15 s) | a URL (a 307 there) | { error, message } (that tool error) | a list of these, one per call };
 * `filesStatus` answers the file upload with that status, or with each of a list in turn (a 307 goes to
 * `filesLocation`); `filesUrl` replaces the
 * file request's address; `submitExtra` adds fields to the submit answer; `requestedAgain` makes the second wait_review a second request at the same address.
 */
async function server({ findings = [], status = "done", review_of_record = true, httpStatus = 200, requested, requestedAgain, sse = false, submitStatus, toolError, faults = {}, filesStatus = 200, filesUrl, filesLocation, extra = {}, submitExtra = {}, ticket } = {}, port = 0) {
  const calls = [], posted = [], uploads = [];
  let url, asks = 0;
  const srv = createServer((req, res) => {
    let body = "";
    const chunks = [];
    req.on("data", (c) => { body += c; chunks.push(c); });
    req.on("end", () => {
      if (httpStatus !== 200) { res.writeHead(httpStatus); return res.end("no"); }
      // The upload doors: `ticket.repo` and `ticket.payload` answer with those statuses in turn (200 when the list is out).
      if (req.url.startsWith("/u/")) {
        const door = req.url.endsWith("/repo") ? "repo" : "payload";
        uploads.push({ door, path: req.url, type: req.headers["content-type"], body: Buffer.concat(chunks) });
        const st = (ticket?.[door] ?? []).shift() ?? 200;
        res.writeHead(st, { "content-type": "application/json" });
        return res.end(JSON.stringify(st === 200 ? { ok: true } : { error: `${door} refused: see https://app.ohmybug.ai/me/policy`, ...(st === 409 && door === "payload" ? { code: "snapshot_required" } : {}) }));
      }
      if (req.url === "/files") {
        posted.push(JSON.parse(body));
        res.writeHead(Array.isArray(filesStatus) ? filesStatus[posted.length - 1] ?? 200 : filesStatus, filesLocation ? { location: filesLocation } : {});
        return res.end("{}");
      }
      const msg = JSON.parse(body);
      const { name, arguments: args } = msg.params;
      calls.push({ name, args, auth: req.headers.authorization, follows: req.headers["x-ohmybug-follows"] });
      if (name === "submit_review" && submitStatus) { res.writeHead(submitStatus); return res.end("boom"); }
      // A list fails the calls of that tool in turn (null lets one through).
      let fault = Array.isArray(faults[name]) ? faults[name].shift() : faults[name];
      if (!Array.isArray(faults[name]) || !faults[name].length) delete faults[name];
      if (fault) {
        if (fault === "internal" || fault === "rate_limited" || typeof fault === "object") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(typeof fault === "object" ? fault : { error: fault, message: "blip" }) }] } }));
        }
        if (fault === "reset") return req.socket.destroy();
        if (fault === "slow429") { res.writeHead(429, { "retry-after": "15" }); return res.end("slow down"); }
        if (fault === "hour429") { res.writeHead(429, { "retry-after": "3600" }); return res.end("slow down"); }
        if (fault === "rpcerror") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal error" } }));
        }
        if (String(fault).startsWith("http")) { res.writeHead(307, { location: fault }); return res.end(); }
        if (fault === "garble") { res.writeHead(200, { "content-type": "application/json" }); return res.end("{\"jsonrpc\":"); }
        res.writeHead(fault); return res.end("busy");
      }
      const ask = name === "wait_review" && requested ? [requested, requestedAgain][asks] : undefined;
      if (ask) asks++;
      const result = toolError ? toolError
        : name === "submit_review" && args.upload ? { review_id: "rev_test", status: "awaiting_upload", ...(ticket?.url === null ? {} : { upload_url: ticket?.url ?? `${url}/u/tok${ticket?.slash ? "/" : ""}` }), ...(ticket?.snapshot ? { snapshot: ticket.snapshot } : {}) }
        : name === "submit_review" ? { review_id: "rev_test", status: "running", ...submitExtra }
        : ask ? { review_id: "rev_test", status: "needs_files", requested_files: ask, files_url: filesUrl ?? `${url}/files` }
        : name === "wait_review" ? { review_id: "rev_test", status }
        : { review_id: "rev_test", status, findings, review_of_record, live_url: "https://example.test/live/x", ...extra };
      const answer = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], ...(toolError ? { isError: true } : {}) } });
      res.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" });
      res.end(sse ? `event: message\ndata: ${answer}\n\n` : answer);
    });
  });
  // Node's 5 s default races the client's 5 s retry: a reused socket the server just closed reads as a reset.
  srv.keepAliveTimeout = 60_000;
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  url = `http://127.0.0.1:${srv.address().port}`;
  return { url, calls, posted, uploads, close: () => new Promise((r) => { srv.close(r); srv.closeIdleConnections?.(); }) };
}

async function cli(dir, argv, env, extra = {}) {
  const out = [], log = [];
  const code = await run({ argv, env: { OHMYBUG_API_KEY: "test-key", OHMYBUG_TIMEOUT_S: "60", ...env }, cwd: dir, out: (s) => out.push(s), log: (s) => log.push(s), ...extra });
  return { code, out: out.join("\n"), log: log.join("\n") };
}

const high = { severity: "high", file: "app.js", line: 1, title: "wrong constant", failure_scenario: "a is 2" };
const low = { severity: "low", file: "app.js", line: 1, title: "naming", failure_scenario: "a short name" };

test("parseArgs refuses unknown flags and --base with --uncommitted", () => {
  assert.equal(typeof parseArgs(["--nope"]), "string");
  assert.equal(typeof parseArgs(["--base"]), "string");
  assert.equal(typeof parseArgs(["--base", "x", "--uncommitted"]), "string");
  assert.deepEqual(parseArgs(["--base=dev"]), { base: "dev", uncommitted: false, deep: false, help: false, version: false });
  assert.equal(typeof parseArgs(["--deep", "--uncommitted"]), "string");
});

test("the base: --base, then the merge request target (remote-tracking when present), then origin/main", () => {
  const has = (refs) => (r) => refs.includes(r);
  assert.equal(resolveBase({ base: "v1" }, { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" }, has([])), "v1");
  assert.equal(resolveBase({}, { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" }, has(["origin/develop"])), "origin/develop");
  assert.equal(resolveBase({}, { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" }, has([])), "develop");
  assert.equal(resolveBase({}, {}, has([])), "origin/main");
});

test("exit codes: 1 on a medium or worse bug, 0 on lows or none, 2 on a failed or cut-short clean run", () => {
  assert.equal(exitCodeFor({ status: "done", findings: [high] }), 1);
  assert.equal(exitCodeFor({ status: "done", findings: [{ ...low, severity: "medium" }] }), 1);
  assert.equal(exitCodeFor({ status: "done", findings: [low] }), 0);
  assert.equal(exitCodeFor({ status: "done", findings: [] }), 0);
  assert.equal(exitCodeFor({ status: "failed", findings: [] }), 2);
  assert.equal(exitCodeFor({ status: "done", findings: [], review_of_record: false }), 2);
  // A cut-short run that still found a real bug blocks: the bug is there.
  assert.equal(exitCodeFor({ status: "done", findings: [high], review_of_record: false }), 1);
  for (const severity of ["critical", "Critical", "HIGH", "P0", "P1", "P2", "p2"]) {
    assert.equal(exitCodeFor({ status: "done", findings: [{ ...low, severity }] }), 1, severity);
  }
  assert.equal(exitCodeFor({ status: "done", findings: [{ ...low, severity: "P3" }] }), 0);
  // A design-level bug with no file still blocks; a severity the gate does not know, or none, blocks.
  assert.equal(exitCodeFor({ status: "done", findings: [{ severity: "high", title: "no file" }] }), 1);
  assert.equal(exitCodeFor({ status: "done", findings: [{ ...low, severity: "blocker" }] }), 1);
  assert.equal(exitCodeFor({ status: "done", findings: [{ title: "unrated" }] }), 1);
  // Lows from a cut-short run do not make it clean.
  assert.equal(exitCodeFor({ status: "done", findings: [low], review_of_record: false }), 2);
});

test("parseArgs: an empty --base= is refused; OHMYBUG_TIMEOUT_S must be whole seconds from 30 to 86400", async () => {
  assert.equal(typeof parseArgs(["--base="]), "string");
  const { dir } = repo();
  for (const t of ["30m", "600.5", "15", "100000"]) {
    const r = await cli(dir, [], { OHMYBUG_TIMEOUT_S: t });
    assert.equal(r.code, 2, t);
    assert.match(r.log, /OHMYBUG_TIMEOUT_S must be whole seconds/);
  }
});

test("ciMeta: an empty CI variable falls back to the next one", () => {
  const meta = ciMeta({ CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: "", CI_COMMIT_REF_NAME: "feat" }, () => "local\n");
  assert.equal(meta.branch, "feat");
});

test("trimDiff drops per-file entries over 160 KiB from a diff over 2 MiB, unless nothing would be left", () => {
  const entry = (name, bytes) => `diff --git a/${name} b/${name}\n+${"x".repeat(bytes)}\n`;
  const small = entry("small.js", 10);
  const bigs = Array.from({ length: 14 }, (_, i) => entry(`big${i}.lock`, 170 * 1024)).join("");
  assert.equal(trimDiff(small + bigs), small);
  assert.equal(trimDiff(bigs), bigs);
  assert.equal(trimDiff(small), small);
});

test("an empty diff exits 0 without submitting", async () => {
  const { dir } = repo();
  const s = await server();
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0);
    assert.match(r.out, /Nothing to review: no changes against origin\/main/);
    assert.equal(s.calls.length, 0);
  } finally { await s.close() }
});

test("base...HEAD: the branch's committed change is sent, a blocking bug exits 1 and prints the finding", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  writeFileSync(join(dir, "app.js"), "export const a = 3 // uncommitted, not reviewed\n");
  const s = await server({ findings: [high, low] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 1);
    const submit = s.calls.find((c) => c.name === "submit_review");
    assert.match(submit.args.diff, /\+export const a = 2/);
    assert.doesNotMatch(submit.args.diff, /uncommitted/);
    // Context files are the reviewed commit's, not the working tree's.
    assert.equal(submit.args.files[0].path, ".review-client/tree.txt");
    assert.equal(submit.args.files.find((f) => f.path === "app.js").content, "export const a = 2\n");
    assert.equal(submit.args.meta.branch, "feature");
    assert.equal(submit.args.meta.repo, undefined);
    assert.equal(s.calls[0].auth, "Bearer test-key");
    assert.match(r.out, /HIGH {2}app\.js:1 {2}wrong constant/);
    assert.match(r.out, /1 blocking bug/);
  } finally { await s.close() }
});

test("a file request is answered only with files of the reviewed commit: no ignored, untracked or .git path", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, "lib.js"), "export const l = 1\n");
  git("add", ".");
  git("commit", "-qm", "lib");
  writeFileSync(join(dir, "app.js"), "export const a = 9\n");
  git("commit", "-qam", "change");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "notes.txt"), "untracked\n");
  writeFileSync(join(dir, "lib.js"), "export const l = 2 // uncommitted\n");
  const requested = ["lib.js", "/app.js", ".env", "notes.txt", ".git/config", ".GIT/config", "../outside", "src/.git/config"];
  const s = await server({ requested });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0);
    assert.equal(s.posted.length, 1);
    assert.deepEqual(s.posted[0].files, [{ path: "lib.js", content: "export const l = 1\n" }, { path: "/app.js", content: "export const a = 9\n" }]);
  } finally { await s.close() }
});

test("--uncommitted answers a file request from the working tree, untracked included, ignored not", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "new.js"), "export const n = 2\n");
  const s = await server({ requested: ["new.js", ".env", "app.js"] });
  try {
    assert.equal((await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url })).code, 0);
    assert.deepEqual(s.posted[0].files.map((f) => f.path), ["new.js", "app.js"]);
  } finally { await s.close() }
});

test("a changed file named like a git option is a search term, and its referrers are sent", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "user.js"), 'import x from "./-Oecho.js"\n');
  git("add", ".");
  git("commit", "-qm", "user");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(dir, "-Oecho.js"), "export default 1\n");
  git("add", "--", "-Oecho.js");
  git("commit", "-qm", "dash");
  const s = await server();
  try {
    assert.equal((await cli(dir, [], { OHMYBUG_URL: s.url })).code, 0);
    const paths = s.calls.find((c) => c.name === "submit_review").args.files.map((f) => f.path);
    assert.ok(paths.includes("-Oecho.js") && paths.includes("user.js"), paths.join(","));
  } finally { await s.close() }
});

test("an event-stream answer is read like a JSON one", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 10\n");
  git("commit", "-qam", "c");
  const s = await server({ sse: true, findings: [high] });
  try { assert.equal((await cli(dir, [], { OHMYBUG_URL: s.url })).code, 1); } finally { await s.close() }
  assert.throws(() => rpcMessage("event: ping\n\n"), /unreadable/);
});

test("submit_review is sent once: a 5xx answer does not start a second hunt", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 11\n");
  git("commit", "-qam", "c");
  const s = await server({ submitStatus: 502 });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2);
    assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 1);
    assert.match(r.log, /HTTP 502/);
  } finally { await s.close() }
});

test("a tool error is reported with its code and message, without retrying", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 12\n");
  git("commit", "-qam", "c");
  const s = await server({ toolError: { error: "quota_exceeded" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2);
    assert.match(r.log, /could not review: quota_exceeded: \{/);
    assert.equal(s.calls.length, 1);
  } finally { await s.close() }
});

test("the GitLab merge request target branch is the base, and its title is sent", async () => {
  const { dir, git } = repo();
  // develop moves on; main stays at the base: only the change against develop is reviewed.
  writeFileSync(join(dir, "dev.js"), "export const d = 1\n");
  git("add", ".");
  git("commit", "-qm", "on develop");
  git("update-ref", "refs/remotes/origin/develop", "HEAD");
  writeFileSync(join(dir, "app.js"), "export const a = 5\n");
  git("commit", "-qam", "feature change");
  const s = await server({ findings: [low] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop", CI_MERGE_REQUEST_TITLE: "Fix a" });
    assert.equal(r.code, 0);
    const submit = s.calls.find((c) => c.name === "submit_review");
    assert.match(submit.args.diff, /\+export const a = 5/);
    assert.doesNotMatch(submit.args.diff, /dev\.js/);
    assert.equal(submit.args.meta.pr_title, "Fix a");
  } finally { await s.close() }
});

test("--base picks the base by hand", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 6\n");
  git("commit", "-qam", "one");
  const one = git("rev-parse", "HEAD").trim();
  writeFileSync(join(dir, "b.js"), "export const b = 1\n");
  git("add", ".");
  git("commit", "-qm", "two");
  const s = await server();
  try {
    const r = await cli(dir, ["--base", one], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0);
    const diff = s.calls.find((c) => c.name === "submit_review").args.diff;
    assert.match(diff, /b\.js/);
    assert.doesNotMatch(diff, /app\.js/);
  } finally { await s.close() }
});

test("--uncommitted reviews the working tree, untracked files included", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 7\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "new.js"), "export const n = 1\n");
  const s = await server();
  try {
    const r = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0);
    const diff = s.calls.find((c) => c.name === "submit_review").args.diff;
    assert.match(diff, /\+export const a = 7/);
    assert.match(diff, /\+export const n = 1/);
  } finally { await s.close() }
});

test("--uncommitted sees a same-size edit made in the second of the last index write (a racy entry)", async () => {
  // A whole-second clock, as git compares without nanoseconds: the entry, the file and the index all at T. Git
  // itself must re-read such an entry; a copied index with a fresh mtime would make it trust the stat and miss the edit.
  const { dir, git } = repo();
  const t = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
  const app = join(dir, "app.js");
  utimesSync(app, t, t);
  git("add", "app.js");
  writeFileSync(app, "export const a = 7\n");
  utimesSync(app, t, t);
  // A later atime, as an index read often but written rarely has: only its mtime may count. The mtime is T and a
  // fraction: the copy must keep second T, not round up. Limit: git also compares ctime, so a second boundary inside
  // this test, or a git built with nanoseconds, lets it pass without the race.
  utimesSync(join(dir, ".git", "index"), new Date(t.getTime() + 30_000), new Date(t.getTime() + 600));
  assert.match(git("diff", "HEAD"), /\+export const a = 7/, "git itself does not see the edit: the setup proves nothing");
  const s = await server();
  try {
    const r = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.match(s.calls.find((c) => c.name === "submit_review").args.diff, /\+export const a = 7/);
  } finally { await s.close() }
});

test("could not run: no key, a refused key, a failed review, a base the clone lacks — all exit 2", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 8\n");
  git("commit", "-qam", "c");
  assert.equal((await cli(dir, [], { OHMYBUG_API_KEY: "" })).code, 2);
  const nope = await cli(dir, ["--base", "nope"], { OHMYBUG_URL: "http://127.0.0.1:9" });
  assert.equal(nope.code, 2);
  assert.match(nope.log, /base nope is not a commit in this clone \(fetch it, or check the ref\)/);
  for (const [opts, why] of [[{ httpStatus: 401 }, /API key was refused/], [{ status: "failed" }, /the review failed/], [{ review_of_record: false }, /did not finish its protocol/]]) {
    const s = await server(opts);
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 2, JSON.stringify(opts));
      assert.match(r.log, why);
    } finally { await s.close() }
  }
});

test("--uncommitted sends a symlink as its target's name, never the target's content", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "app.js"), "export const a = 13\n");
  symlinkSync(".env", join(dir, "cfg"));
  symlinkSync("/etc/hosts", join(dir, "out"));
  const s = await server({ requested: ["cfg", "out", ".env"] });
  try {
    assert.equal((await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url })).code, 0);
    assert.deepEqual(s.posted[0].files, [{ path: "cfg", content: ".env" }, { path: "out", content: "/etc/hosts" }]);
  } finally { await s.close() }
});

test("submit_review: a 429 is sent again and starts one hunt; a reset or an internal error is not sent again", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 14\n");
  git("commit", "-qam", "c");
  for (const [opts, code, submits] of [
    [{ faults: { submit_review: 429 } }, 0, 2],
    [{ faults: { submit_review: "rate_limited" } }, 0, 2],
    [{ faults: { submit_review: "garble" } }, 2, 1],
    [{ submitStatus: 502 }, 2, 1],
    [{ faults: { submit_review: "reset" } }, 2, 1],
    [{ toolError: { error: "internal", message: "late failure" } }, 2, 1],
  ]) {
    const s = await server(opts);
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url });
      assert.equal(r.code, code, JSON.stringify(opts) + r.log);
      assert.equal(s.calls.filter((c) => c.name === "submit_review").length, submits, JSON.stringify(opts));
      // The server counts what it received: one hunt, however many attempts reached it.
      if (code === 2) assert.match(r.log, /A hunt may have started/);
    } finally { await s.close() }
  }
});

test("polling outlives a 5xx, a reset, a garbled answer and a transient tool error", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 15\n");
  git("commit", "-qam", "c");
  for (const fault of [503, "reset", "garble", "internal", "rate_limited", "rpcerror"]) {
    const s = await server({ findings: [high], faults: { wait_review: fault } });
    try { assert.equal((await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "60" })).code, 1, String(fault)); } finally { await s.close() }
  }
});

test("a review still running at OHMYBUG_TIMEOUT_S exits 2 and names the review", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 16\n");
  git("commit", "-qam", "c");
  const s = await server({ status: "running" });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" });
    assert.equal(r.code, 2);
    assert.match(r.log, /no result within OHMYBUG_TIMEOUT_S/);
    assert.match(r.log, /review rev_test may still be running/);
  } finally { await s.close() }
});

test("--uncommitted: a nested repository is left out and the user's index is untouched", async () => {
  const { dir, git } = repo();
  mkdirSync(join(dir, "sub"));
  execFileSync("git", ["-C", join(dir, "sub"), "init", "-q"]);
  writeFileSync(join(dir, "sub", "x.js"), "1\n");
  writeFileSync(join(dir, "new.js"), "export const n = 3\n");
  const status = git("status", "--porcelain");
  const s = await server({ requested: ["new.js", "sub/x.js"] });
  try {
    const r = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    const diff = s.calls.find((c) => c.name === "submit_review").args.diff;
    assert.match(diff, /\+export const n = 3/);
    assert.doesNotMatch(diff, /sub/);
    assert.deepEqual(s.posted[0].files, [{ path: "new.js", content: "export const n = 3\n" }]);
    assert.equal(git("status", "--porcelain"), status);
  } finally { await s.close() }
});

test("--uncommitted in a repository with no commit reviews every file against the empty tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ohmybug-cli-"));
  execFileSync("git", ["-C", dir, "init", "-q"]);
  writeFileSync(join(dir, "first.js"), "export const f = 1\n");
  const s = await server();
  try {
    assert.equal((await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url })).code, 0);
    assert.match(s.calls.find((c) => c.name === "submit_review").args.diff, /\+export const f = 1/);
  } finally { await s.close() }
});

test("fitBody drops context files from the end until the escaped JSON fits, never the first", () => {
  const quotes = '"'.repeat(1000);
  const body = { diff: "d", files: [{ path: "tree", content: "t" }, { path: "a", content: quotes }, { path: "b", content: quotes }] };
  assert.deepEqual(fitBody(body, 2500).files.map((f) => f.path), ["tree", "a"]);
  assert.deepEqual(fitBody(body, 10).files.map((f) => f.path), ["tree"]);
  assert.equal(fitBody(body, 1e6).files.length, 3);
});

test("a refused file answer does not stop the review; a file request to another host is not answered", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 17\n");
  git("commit", "-qam", "c");
  const refused = await server({ requested: ["app.js"], filesStatus: 413, findings: [high] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: refused.url });
    assert.equal(r.code, 1);
    assert.match(r.log, /the file answer was refused \(HTTP 413/);
  } finally { await refused.close() }
  const elsewhere = await server({ requested: ["app.js"], filesUrl: "http://169.254.169.254/files" });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: elsewhere.url });
    assert.equal(r.code, 0);
    assert.match(r.log, /named another host \(169\.254\.169\.254\); not answered/);
  } finally { await elsewhere.close() }
});

test("a host that never answers fails after four tries, not at the timeout", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 18\n");
  git("commit", "-qam", "c");
  const closed = createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const t = Date.now();
  const r = await cli(dir, [], { OHMYBUG_URL: `http://127.0.0.1:${port}`, OHMYBUG_TIMEOUT_S: "600" });
  assert.equal(r.code, 2);
  assert.match(r.log, new RegExp(`cannot reach 127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\)`));
  assert.ok(Date.now() - t < 60_000);
});

test("file answers: a 5xx or a redirect is not fatal, a redirect is not followed, a second request at the same address is answered", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "lib.js"), "export const l = 1\n");
  git("add", ".");
  git("commit", "-qm", "lib");
  writeFileSync(join(dir, "app.js"), "export const a = 19\n");
  git("commit", "-qam", "c");
  const busy = await server({ requested: ["app.js"], filesStatus: 503, findings: [high] });
  try { assert.equal((await cli(dir, [], { OHMYBUG_URL: busy.url })).code, 1); } finally { await busy.close() }
  const elsewhere = await server();
  const moved = await server({ requested: ["app.js"], filesStatus: 307, filesLocation: `${elsewhere.url}/files` });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: moved.url });
    assert.equal(r.code, 0);
    assert.equal(elsewhere.posted.length, 0);
    assert.match(r.log, /the file answer did not go through/);
  } finally { await moved.close(); await elsewhere.close() }
  const twice = await server({ requested: ["app.js"], requestedAgain: ["lib.js"] });
  try {
    assert.equal((await cli(dir, [], { OHMYBUG_URL: twice.url })).code, 0);
    assert.deepEqual(twice.posted.map((p) => p.files.map((f) => f.path)), [["app.js"], ["lib.js"]]);
  } finally { await twice.close() }
});

test("--uncommitted leaves out a nested repository inside an untracked folder", async () => {
  const { dir } = repo();
  mkdirSync(join(dir, "vendor", "lib"), { recursive: true });
  execFileSync("git", ["-C", join(dir, "vendor", "lib"), "init", "-q"]);
  writeFileSync(join(dir, "vendor", "lib", "x.js"), "1\n");
  writeFileSync(join(dir, "vendor", "a.js"), "export const v = 1\n");
  const s = await server();
  try {
    const r = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    const diff = s.calls.find((c) => c.name === "submit_review").args.diff;
    assert.match(diff, /\+export const v = 1/);
    assert.doesNotMatch(diff, /vendor\/lib/);
  } finally { await s.close() }
});

test("a diff whose escaped size is over the cap is refused before anything is sent", async () => {
  const { dir, git } = repo();
  for (let i = 0; i < 60; i++) writeFileSync(join(dir, `q${i}.txt`), `${'"'.repeat(99)}\n`.repeat(1400));
  git("add", ".");
  git("commit", "-qm", "quotes");
  const s = await server();
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2);
    assert.match(r.log, /over what the service takes/);
    assert.equal(s.calls.length, 0);
  } finally { await s.close() }
});

test("a service that goes away mid-review is waited for: the fail-fast is only for a host never reached", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 20\n");
  git("commit", "-qam", "c");
  const s = await server({ status: "running" });
  const port = Number(new URL(s.url).port);
  // Down for 25 s after the first poll: past the fourth refused try (5 s poll gap, then 2 + 4 + 8 s), where a host never reached would fail.
  const run = cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "120" });
  const down = (async () => {
    while (!s.calls.some((c) => c.name === "wait_review")) await new Promise((r) => setTimeout(r, 20));
    await s.close();
    await new Promise((r) => setTimeout(r, 25_000));
  })();
  await down;
  const again = await server({ findings: [high] }, port);
  try { assert.equal((await run).code, 1); } finally { await again.close() }
});

test("OHMYBUG_URL must be https, or http to this machine only", async () => {
  const { dir } = repo();
  for (const url of ["http://mcp.example.com", "mcp.example.com", "ftp://127.0.0.1"]) {
    const r = await cli(dir, [], { OHMYBUG_URL: url });
    assert.equal(r.code, 2, url);
    assert.match(r.log, /OHMYBUG_URL (must be https|is not a URL)/, url);
  }
});

test("a redirect on the paid call is not followed: the body never reaches the other host", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 21\n");
  git("commit", "-qam", "c");
  const other = await server();
  const s = await server({ faults: { submit_review: `${other.url}/mcp` } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2);
    assert.equal(other.calls.length, 0);
    assert.match(r.log, /A hunt may have started/);
  } finally { await s.close(); await other.close() }
});

test("a rate limit that would leave no time to poll stops before the hunt starts", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 22\n");
  git("commit", "-qam", "c");
  const s = await server({ faults: { submit_review: "slow429" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" });
    assert.equal(r.code, 2);
    assert.match(r.log, /nothing was started/);
    assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 1);
  } finally { await s.close() }
});

test("a file request whose answer failed is answered again when the service asks again", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 23\n");
  git("commit", "-qam", "c");
  const s = await server({ requested: ["app.js"], requestedAgain: ["app.js"], filesStatus: [503, 200] });
  try {
    assert.equal((await cli(dir, [], { OHMYBUG_URL: s.url })).code, 0);
    assert.equal(s.posted.length, 2);
  } finally { await s.close() }
});

test("the CLI runs when started through the symlink the installer makes", () => {
  const dir = mkdtempSync(join(tmpdir(), "ohmybug-cli-"));
  const link = join(dir, "ohmybug");
  symlinkSync(fileURLToPath(new URL("../ohmybug.mjs", import.meta.url)), link);
  assert.equal(execFileSync(process.execPath, [link, "--version"]).toString().trim(), VERSION);
});

test("a Retry-After longer than the time left stops at once, before a hunt starts", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 24\n");
  git("commit", "-qam", "c");
  const s = await server({ faults: { submit_review: "hour429" } });
  try {
    const t = Date.now();
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "1800" });
    assert.equal(r.code, 2);
    assert.match(r.log, /asks to wait 3600s.*nothing was started/);
    assert.ok(Date.now() - t < 10_000);
  } finally { await s.close() }
});

test("a file over 512 KiB is not sent, as context or on request", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "big.txt"), "z".repeat(600 * 1024) + "\n");
  git("add", ".");
  git("commit", "-qm", "big");
  writeFileSync(join(dir, "app.js"), "export const a = 25\n");
  git("commit", "-qam", "c");
  git("update-ref", "refs/remotes/origin/main", "HEAD~1");
  const s = await server({ requested: ["big.txt", "app.js"] });
  try {
    assert.equal((await cli(dir, [], { OHMYBUG_URL: s.url })).code, 0);
    assert.deepEqual(s.posted[0].files.map((f) => f.path), ["app.js"]);
  } finally { await s.close() }
});

test("--deep sends the pushed commit's coordinates and no payload; refuses what the service could not read; a refusal starts nothing", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 40\n");
  git("commit", "-qam", "c");
  const head = git("rev-parse", "HEAD").trim();
  const target = (s) => { const m = s.calls.find((c) => c.name === "submit_review")?.args.meta; return m && [m.repo, m.ref, m.base_branch].join(" ") };
  // Refused before any call: no GitHub repository, a remote that only mentions github.com, an unpushed HEAD,
  // GitHub Enterprise, a base that is not a branch name.
  for (const [setup, env, argv, why] of [
    [() => {}, {}, [], /--deep cannot run: no GitHub repository/],
    [() => git("remote", "add", "origin", "https://git.example.com/github.com/acme/app.git"), {}, [], /--deep cannot run: no GitHub repository/],
    [() => git("remote", "set-url", "origin", "git@github.com:acme/app.git"), {}, [], /push it first/],
    [() => git("update-ref", "refs/remotes/fork/feature", "HEAD"), { GITHUB_SHA: "0".repeat(40) }, [], /push it first/],
    [() => git("update-ref", "refs/remotes/origin/feature", "HEAD"), { GITHUB_SERVER_URL: "https://ghe.example.com" }, [], /not on https:\/\/ghe/],
    [() => {}, {}, ["--base", head.slice(0, 12)], /is not a branch name/],
    [() => {}, {}, ["--base", "HEAD~1"], /is not a branch name/],
  ]) {
    setup();
    const s = await server();
    try {
      const r = await cli(dir, ["--deep", ...argv], { OHMYBUG_URL: s.url, ...env });
      assert.equal(r.code, 2, r.log);
      assert.match(r.log, why);
      assert.equal(s.calls.length, 0);
    } finally { await s.close() }
  }
  // Pushed, ssh origin: the coordinates and nothing else; the deep budget is 10800 s unless set.
  const s = await server({ findings: [high] });
  try {
    const r = await cli(dir, ["--deep"], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: undefined });
    assert.equal(r.code, 1, r.log);
    const sub = s.calls.find((c) => c.name === "submit_review").args;
    assert.equal(sub.deep, true);
    assert.equal(sub.diff, undefined);
    assert.equal(sub.files, undefined);
    assert.equal(target(s), `acme/app ${head} main`);
    assert.match(r.log, /waiting up to 10800s/);
  } finally { await s.close() }
  // An https origin; Actions' base branch; --base wins over it; the origin wins over GITHUB_REPOSITORY, which is only
  // the fallback; in Actions GITHUB_SHA stands for the push.
  git("remote", "set-url", "origin", "https://github.com/acme/web");
  for (const [setup, env, argv, want] of [
    [() => {}, { GITHUB_BASE_REF: "develop", GITHUB_SERVER_URL: "https://github.com" }, [], `acme/web ${head} develop`],
    [() => {}, { GITHUB_BASE_REF: "develop" }, ["--base", "origin/release"], `acme/web ${head} release`],
    [() => git("update-ref", "-d", "refs/remotes/origin/feature"), { GITHUB_REPOSITORY: "acme/other", GITHUB_SHA: head }, [], `acme/web ${head} main`],
    [() => git("remote", "remove", "origin"), { GITHUB_REPOSITORY: "acme/other", GITHUB_SHA: head }, [], `acme/other ${head} main`],
  ]) {
    setup();
    const s = await server();
    try {
      const r = await cli(dir, ["--deep", ...argv], { OHMYBUG_URL: s.url, ...env });
      assert.equal(r.code, 0, r.log);
      assert.equal(target(s), want);
    } finally { await s.close() }
  }
  // The service turning the deep hunt down is a refusal: exit 2, its words, nothing polled.
  const busy = await server({ toolError: { error: "deep_at_capacity", message: "The deep hunt is not available right now." } });
  try {
    const r = await cli(dir, ["--deep"], { OHMYBUG_URL: busy.url, GITHUB_REPOSITORY: "acme/other", GITHUB_SHA: head });
    assert.equal(r.code, 2);
    assert.match(r.log, /deep_at_capacity: The deep hunt is not available right now/);
    assert.equal(busy.calls.filter((c) => c.name === "submit_review").length, 1);
    assert.equal(busy.calls.filter((c) => c.name !== "submit_review").length, 0);
  } finally { await busy.close() }
});

test("--story narrows the hunt's feed story: sent as meta.story on fast and deep, never for auto; the story note is printed", async () => {
  assert.deepEqual(parseArgs(["--story", "never"]).story, "never");
  assert.deepEqual(parseArgs(["--story=private"]).story, "private");
  for (const argv of [["--story"], ["--story="], ["--story", "ask"], ["--story=NEVER"], ["--story", "--deep"]]) {
    assert.equal(typeof parseArgs(argv), "string", argv.join(" "));
  }
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "c");
  const sent = (s) => s.calls.find((c) => c.name === "submit_review")?.args.meta?.story;
  for (const [argv, env, want] of [
    [["--story", "never"], {}, "never"],
    [[], { OHMYBUG_STORY: "private" }, "private"],
    [["--story=never"], { OHMYBUG_STORY: "private" }, "never"],
    [["--story", "auto"], { OHMYBUG_STORY: "never" }, undefined],
    [[], {}, undefined],
    [[], { OHMYBUG_STORY: "" }, undefined],
  ]) {
    const s = await server();
    try {
      const r = await cli(dir, argv, { OHMYBUG_URL: s.url, ...env });
      assert.equal(r.code, 0, r.log);
      assert.equal(sent(s), want, `${argv.join(" ")} ${JSON.stringify(env)}`);
    } finally { await s.close() }
  }
  // A bad variable is refused before any call.
  const bad = await server();
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: bad.url, OHMYBUG_STORY: "ask" });
    assert.equal(r.code, 2);
    assert.match(r.log, /OHMYBUG_STORY must be auto, private or never/);
    assert.equal(bad.calls.length, 0);
  } finally { await bad.close() }
  // The deep hunt carries it too.
  git("remote", "add", "origin", "https://github.com/acme/app");
  git("update-ref", "refs/remotes/origin/feature", "HEAD");
  const deep = await server();
  try {
    const r = await cli(dir, ["--deep", "--story", "private"], { OHMYBUG_URL: deep.url });
    assert.equal(r.code, 0, r.log);
    assert.equal(sent(deep), "private");
  } finally { await deep.close() }
  // The service's story note: one line on the log, the exit code untouched; none when absent or not text.
  for (const [story, line] of [
    [{ state: "drafting", note: "A story draft of this hunt will wait for your OK on /me." }, "story: A story draft of this hunt will wait for your OK on /me."],
    [{ state: "waiting", note: "A draft\nwaits\u001b[31m on /me. " }, "story: A draft waits [31m on /me."],
    [{ state: "off", note: 7 }, null],
    [undefined, null],
  ]) {
    const s = await server({ findings: [high], extra: story ? { story } : {} });
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 1, r.log);
      if (line) assert.ok(r.log.split("\n").includes(line), r.log);
      else assert.doesNotMatch(r.log, /^story:/m);
    } finally { await s.close() }
  }
});

test("silent_bill: one fixed line per form; a malformed deadline is never echoed; none for no object", () => {
  const at = "2026-11-11T04:00:00.000Z";
  assert.equal(silentBillLine({ at, terms: "x" }), `silent bill: bills on its own at ${at} unless every medium or worse finding is rejected (NOT_REAL) first`);
  assert.equal(silentBillLine({ at: null, terms: "x" }), "silent bill: may bill on its own; the deadline could not be read now");
  assert.equal(silentBillLine({ at, billed: true, terms: "x" }), `silent bill: billed on its own at ${at}`);
  // Server text in the deadline is not echoed: a pending one reads as unreadable, a billed one without its time.
  assert.equal(silentBillLine({ at: "soon\u001b[2J" }), "silent bill: may bill on its own; the deadline could not be read now");
  assert.equal(silentBillLine({ at: "x", billed: true }), "silent bill: billed on its own");
  for (const sb of [undefined, null, "at 4", 7, []].slice(0, 4)) assert.equal(silentBillLine(sb), null, String(sb));
});

test("a finished hunt with a silent bill prints its line on stderr after the billing line; the exit code is the findings'", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  const at = "2026-11-11T04:00:00.000Z";
  const s = await server({ findings: [high], extra: { billing: { charged_usd: 0 }, silent_bill: { at, terms: "$4 fast ..." } } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 1);
    assert.match(r.log, new RegExp(`billing: nothing charged\\nsilent bill: bills on its own at ${at.replace(/\./g, "\\.")} unless`));
    assert.doesNotMatch(r.out + r.log, /\$4 fast/);
  } finally { await s.close() }
  const clean = await server({ findings: [] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: clean.url });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.log, /silent bill/);
  } finally { await clean.close() }
});

test("a fast hunt of a pushed GitHub commit lets the service read the repository; a refused read sends the diff; no target sends the diff and says why", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 41\n");
  git("commit", "-qam", "c");
  const head = git("rev-parse", "HEAD").trim();
  const subs = (s) => s.calls.filter((c) => c.name === "submit_review").map((c) => c.args);
  // No target: one request with the diff, and the reason on the log.
  for (const [setup, argv, why, env = {}] of [
    [() => {}, [], /diff only, without the repository: no GitHub repository/],
    [() => git("remote", "add", "origin", "git@github.com:acme/app.git"), [], /diff only, without the repository: HEAD is not pushed/],
    [() => git("update-ref", "refs/remotes/origin/feature", "HEAD"), ["--base", "HEAD~1"], /diff only, without the repository: the base HEAD~1 is not a branch name/],
    [() => {}, ["--base", git("rev-parse", "HEAD~1").trim()], /diff only, without the repository: the base [0-9a-f]{40} is not a branch name/],
    // Another remote's branch, a local branch with no origin twin, an origin branch whose local copy moved: GitHub's
    // branch of that name is not the base diffed here.
    [() => git("update-ref", "refs/remotes/upstream/main", "HEAD~1"), ["--base", "upstream/main"], /the base upstream\/main is not an origin branch at the commit diffed here/],
    [() => git("branch", "dev", "HEAD~1"), ["--base", "dev"], /the base dev is not an origin branch/],
    [() => git("branch", "develop", "HEAD~1"), ["--base", "develop", "--story", "never"], null],
    [() => {}, ["--base", "refs/heads/dev"], /the base refs\/heads\/dev is not an origin branch/],
    [() => {}, [], /diff only, without the repository: the service reads repositories on github.com, not on https:\/\/ghe/, { GITHUB_SERVER_URL: "https://ghe.example.com" }],
    [() => writeFileSync(join(dir, "app.js"), "export const a = 42\n"), ["--uncommitted"], /diff only, without the repository: --uncommitted/],
  ]) {
    setup();
    const s = await server();
    try {
      const r = await cli(dir, argv, { OHMYBUG_URL: s.url, ...env });
      if (!why) {
        // origin/develop and the local develop are the same commit: the repository path, the story choice with it.
        assert.equal(r.code, 0, r.log);
        assert.deepEqual([subs(s)[0].diff, subs(s)[0].meta.base_branch, subs(s)[0].meta.story], ["", "develop", "never"]);
        continue;
      }
      assert.equal(r.code, 0, r.log);
      assert.match(r.log, why);
      assert.equal(subs(s).length, 1);
      assert.match(subs(s)[0].diff, /^diff --git a\/app\.js/);
      assert.equal(subs(s)[0].meta?.repo, undefined);
    } finally { await s.close() }
  }
  git("checkout", "-q", "app.js");
  // Readable: one request, an empty diff, the coordinates, the files as before.
  const s = await server({ findings: [high] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 1, r.log);
    const [sub] = subs(s);
    assert.equal(subs(s).length, 1);
    assert.equal(sub.diff, "");
    assert.deepEqual([sub.meta.repo, sub.meta.ref, sub.meta.base_branch, sub.meta.branch], ["acme/app", head, "main", "feature"]);
    assert.deepEqual(sub.files.map((f) => f.path), [".review-client/tree.txt", "app.js"]);
    assert.match(r.log, new RegExp(`the service reads acme/app at ${head.slice(0, 12)} against main from GitHub`));
  } finally { await s.close() }
  // A refused read: the same hunt again with the diff, said on the log; the App hint only where it helps.
  for (const code of ["diff_required", "repo_not_listed", "diff_fetch_failed", "empty_compare", "diff_too_large"]) {
    const s = await server({ faults: { submit_review: { error: code, message: "no" } } });
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 0, r.log);
      const [first, second] = subs(s);
      assert.equal(subs(s).length, 2);
      assert.equal(first.diff, "");
      assert.match(second.diff, /^diff --git a\/app\.js/);
      assert.equal(second.meta.repo, undefined);
      assert.deepEqual(second.files, first.files);
      assert.match(r.log, new RegExp(`did not take the change from GitHub \\(${code}\\): reviewing the diff only, without the repository`));
      assert.equal(/GitHub App installed/.test(r.log), code === "diff_required");
    } finally { await s.close() }
  }
  // The resend is the paid call too: no clear answer on it is not sent a third time.
  const resent = await server({ faults: { submit_review: [{ error: "diff_required", message: "no" }, "reset"] } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: resent.url });
    assert.equal(r.code, 2, r.log);
    assert.equal(subs(resent).length, 2);
    assert.match(r.log, /not sent again/);
  } finally { await resent.close() }
  // A diff over the cap: the repository path never trims or refuses it; the diff path still does.
  writeFileSync(join(dir, "big.txt"), "x".repeat(10 * 1024 * 1024) + "\n");
  git("add", "big.txt");
  git("commit", "-qm", "big");
  git("update-ref", "refs/remotes/origin/feature", "HEAD");
  for (const fallback of [false, true]) {
    const s = await server(fallback ? { faults: { submit_review: { error: "diff_required", message: "no" } } } : {});
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 0, r.log);
      assert.equal(subs(s).length, fallback ? 2 : 1);
      assert.equal(subs(s)[0].diff, "");
      assert.equal(/diff trimmed: left out 1 file/.test(r.log), fallback);
      if (fallback) assert.ok(!subs(s)[1].diff.includes("big.txt") && subs(s)[1].diff.includes("app.js"));
    } finally { await s.close() }
  }
  git("reset", "-q", "--hard", "HEAD~1");
  git("update-ref", "refs/remotes/origin/feature", "HEAD");
  // Any other refusal, or no clear answer, is not sent again.
  for (const fault of [{ error: "commit_required", message: "no" }, "internal", "reset"]) {
    const s = await server({ faults: { submit_review: fault } });
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 2, r.log);
      assert.equal(subs(s).length, 1);
    } finally { await s.close() }
  }
});

test("--format json: one object on stdout, the same exit code, every field present; text lines and logs stay off stdout", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 61\n");
  git("commit", "-qam", "c");
  const med = { finding_id: "rev_test:f2", severity: "MEDIUM", file: "b.js", line: 2, title: "t2", failure_scenario: "s2", suggested_fix: "fix it" };
  const odd = { severity: "", title: "no where" };
  const s = await server({ findings: [low, med, high, odd] });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 1);
    assert.equal(r.out.split("\n").length, 1, "one line");
    const j = JSON.parse(r.out);
    assert.deepEqual(Object.keys(j), ["schema", "cli_version", "exit_code", "outcome", "review", "live_url", "live_url_missing", "billing", "silent_bill", "findings", "counts", "error"]);
    assert.equal(j.schema, "ohmybug-cli/result/1");
    assert.equal(j.cli_version, VERSION);
    assert.deepEqual([j.exit_code, j.outcome], [1, "blocking"]);
    assert.deepEqual(j.review, { id: "rev_test", status: "done", deep: false, complete: true, continued_from: null, route_refused: null, route_state: null, ended_status: "done" });
    assert.deepEqual([j.live_url, j.live_url_missing], ["https://example.test/live/x", null]);
    assert.deepEqual(j.billing.tariff, "confirm");
    assert.equal(j.billing.charged_usd, null);
    assert.equal(j.silent_bill, null);
    assert.deepEqual(j.findings.map((f) => [f.severity, f.blocking]), [["high", true], ["medium", true], ["low", false], ["unrated", true]]);
    assert.deepEqual(j.findings[1], { id: "rev_test:f2", severity: "medium", blocking: true, file: "b.js", line: 2, title: "t2", body: "s2", suggested_fix: "fix it" });
    assert.deepEqual([j.findings[3].file, j.findings[3].line, j.findings[3].id], [null, null, null]);
    assert.deepEqual(j.counts, { total: 4, blocking: 3, critical: 0, high: 1, medium: 1, low: 1, unrated: 1 });
    assert.equal(j.error, null);
    assert.doesNotMatch(r.out, /blocking bug\(s\)|Report:/);
  } finally { await s.close() }
  // CI billing and a silent bill are carried; no live link says why; OHMYBUG_FORMAT picks json.
  const at = "2026-11-12T10:00:00.000Z";
  const ci = await server({ findings: [low], extra: { live_url: undefined, billing: { tariff: "ci", charged_usd: 0, paid_by: "free review" }, silent_bill: { at } } });
  try {
    const j = JSON.parse((await cli(dir, [], { OHMYBUG_URL: ci.url, OHMYBUG_FORMAT: "json" })).out);
    assert.deepEqual([j.exit_code, j.outcome], [0, "clean"]);
    assert.deepEqual(j.billing, { tariff: "ci", charged_usd: 0, paid_by: "free review", note: "CI billing: charged when the result holds a medium or worse finding" });
    assert.deepEqual([j.silent_bill.at, j.silent_bill.billed], [at, false]);
    assert.match(j.silent_bill.note, /bills on its own at 2026-11-12T10:00:00.000Z/);
    assert.equal(j.live_url, null);
    assert.match(j.live_url_missing, /live link setting is off/);
  } finally { await ci.close() }
});

test("--format json on every exit: not run, refused, timed out, cut short, failed, nothing to review", async () => {
  const { dir, git } = repo();
  const json = (r) => JSON.parse(r.out);
  // Nothing to review: exit 0, no review.
  let j = json(await cli(dir, ["--format=json"], { OHMYBUG_URL: "http://127.0.0.1:9" }));
  assert.deepEqual([j.exit_code, j.outcome, j.review.id, j.billing.tariff], [0, "no_changes", null, null]);
  writeFileSync(join(dir, "app.js"), "export const a = 62\n");
  git("commit", "-qam", "c");
  // Not run: a missing key, a bad setting.
  j = json(await cli(dir, ["--format", "json"], { OHMYBUG_API_KEY: "" }));
  assert.deepEqual([j.exit_code, j.outcome, j.review.status, j.live_url_missing], [2, "not_run", null, "nothing started"]);
  assert.match(j.error.message, /OHMYBUG_API_KEY is not set/);
  j = json(await cli(dir, ["--format", "json"], { OHMYBUG_TIMEOUT_S: "5" }));
  assert.deepEqual([j.outcome, j.error.code], ["not_run", null]);
  // Refused by the service: its code is kept.
  let s = await server({ toolError: { error: "quota_exceeded", message: "no" } });
  try {
    j = json(await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }));
    assert.deepEqual([j.exit_code, j.outcome, j.error.code], [2, "not_run", "quota_exceeded"]);
  } finally { await s.close() }
  // Still running at the timeout: the id and the live page are kept.
  s = await server({ status: "running" });
  try {
    j = json(await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" }));
    assert.deepEqual([j.exit_code, j.outcome, j.review.id, j.review.status, j.review.complete], [2, "timed_out", "rev_test", "running", false]);
    assert.equal(j.billing.tariff, null);
  } finally { await s.close() }
  // Done but not of record and clean: cut short; failed: failed.
  for (const [opts, outcome] of [[{ review_of_record: false }, "cut_short"], [{ status: "failed" }, "failed"]]) {
    s = await server(opts);
    try {
      j = json(await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }));
      assert.deepEqual([j.exit_code, j.outcome, j.review.complete], [2, outcome, false]);
    } finally { await s.close() }
  }
  // A bad format is refused before anything runs, with nothing on stdout.
  for (const [argv, env, why] of [[["--format", "yaml"], {}, /--format needs text, markdown or json/], [[], { OHMYBUG_FORMAT: "xml" }, /OHMYBUG_FORMAT must be text, markdown or json, not xml/]]) {
    const bad = await server();
    try {
      const r = await cli(dir, argv, { OHMYBUG_URL: bad.url, ...env });
      assert.deepEqual([r.code, r.out, bad.calls.length], [2, "", 0]);
      assert.match(r.log, why);
    } finally { await bad.close() }
  }
});

test("--format markdown and --step-summary: one block, server text escaped, the file appended; text output unchanged", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 63\n");
  git("commit", "-qam", "c");
  const evil = { severity: "high", file: "a|b.js", line: 1, title: "<img src=x onerror=alert(1)> | `x`\nnext", failure_scenario: "</pre><script>bad()</script>\nline two" };
  const s = await server({ findings: [evil, low] });
  try {
    const r = await cli(dir, ["--format", "markdown"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 1);
    assert.match(r.out, /^### OhMyBug review: 1 blocking bug\n/);
    // Table cells are code spans (literal: no markup, no links, no autolinks); only the table's pipe is escaped.
    assert.ok(r.out.includes("| HIGH | ` a\\|b.js:1 ` | `` <img src=x onerror=alert(1)> \\| `x` next `` |"), r.out);
    assert.match(r.out, /<pre>&lt;\/pre&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;\nline two<\/pre>/);
    const outsideSpans = r.out.replace(/(`+) [^\n]*? \1/g, "");
    assert.doesNotMatch(outsideSpans, /<img|<script|<\/pre><script/);
    assert.match(r.out, /Billing: charged only when someone confirms/);
    assert.match(r.out, /\n\nReport: <https:\/\/example\.test\/live\/x>$/);
    // --step-summary with text: stdout is the text output as before, the block goes to the file, appended.
    const file = join(mkdtempSync(join(tmpdir(), "ombsum-")), "summary.md");
    writeFileSync(file, "earlier\n");
    const t = await cli(dir, ["--step-summary"], { OHMYBUG_URL: s.url, GITHUB_STEP_SUMMARY: file });
    assert.equal(t.code, 1);
    assert.match(t.out, /HIGH {2}a\|b\.js:1/);
    assert.doesNotMatch(t.out, /### OhMyBug/);
    const written = readFileSync(file, "utf8");
    assert.match(written, /^earlier\n### OhMyBug review: 1 blocking bug\n/);
    // Unset or unwritable: one stderr line, the exit code is the review's.
    const u = await cli(dir, ["--step-summary"], { OHMYBUG_URL: s.url });
    assert.equal(u.code, 1);
    assert.match(u.log, /GITHUB_STEP_SUMMARY is not set/);
    const w = await cli(dir, ["--step-summary"], { OHMYBUG_URL: s.url, GITHUB_STEP_SUMMARY: join(tmpdir(), "no-such-dir-omb", "x.md") });
    assert.equal(w.code, 1);
    assert.match(w.log, /could not write/);
  } finally { await s.close() }
});

test("--format json: P0-P3 and unknown severities on the gate's scale; a maybe-started submit, an interrupted poll, a failed review's reason", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 64\n");
  git("commit", "-qam", "c");
  const json = (r) => JSON.parse(r.out);
  const sev = (severity) => ({ severity, file: "a.js", line: "7", title: severity });
  let s = await server({ findings: [sev("P3"), sev("p0"), sev("blocker"), sev("P2")] });
  try {
    const j = json(await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }));
    assert.deepEqual(j.findings.map((f) => [f.severity, f.blocking, f.line]), [["critical", true, 7], ["medium", true, 7], ["low", false, 7], ["unrated", true, 7]]);
    assert.deepEqual(j.counts, { total: 4, blocking: 3, critical: 1, high: 0, medium: 1, low: 1, unrated: 1 });
  } finally { await s.close() }
  // The paid call failed in a way that may have started a hunt: never "not_run" or "nothing charged".
  s = await server({ submitStatus: 500 });
  try {
    const j = json(await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }));
    assert.deepEqual([j.exit_code, j.outcome, j.review.id, j.billing.charged_usd], [2, "maybe_started", null, null]);
    assert.match(j.billing.note, /may have started and may be charged/);
    assert.match(j.live_url_missing, /start was not confirmed/);
  } finally { await s.close() }
  // Started, then a poll refused: interrupted, with the submit's live page.
  s = await server({ submitExtra: { live_url: "https://example.test/live/s" }, faults: { wait_review: { error: "not_found", message: "gone" } } });
  try {
    const j = json(await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }));
    assert.deepEqual([j.exit_code, j.outcome, j.review.id, j.review.status, j.live_url, j.error.code], [2, "interrupted", "rev_test", "running", "https://example.test/live/s", "not_found"]);
  } finally { await s.close() }
  // Timed out: the submit's live page is kept.
  s = await server({ status: "running", submitExtra: { live_url: "https://example.test/live/t" } });
  try {
    const j = json(await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" }));
    assert.deepEqual([j.outcome, j.live_url, j.live_url_missing], ["timed_out", "https://example.test/live/t", null]);
  } finally { await s.close() }
  // A failed review: its reason in error, and free.
  s = await server({ status: "failed", extra: { error: "the sandbox died" } });
  try {
    const j = json(await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }));
    assert.deepEqual([j.outcome, j.error.message, j.billing.note], ["failed", "the review failed: the sandbox died", "a failed review is free"]);
  } finally { await s.close() }
});

test("--format json and markdown: a CI charge and a billed silent bill are carried; markdown escapes markdown and the error line", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 65\n");
  git("commit", "-qam", "c");
  const at = "2026-11-12T10:00:00.000Z";
  const title = "![x](https://host/p.png) [click](https://host) a\\|b *em* _u_ `c`";
  let s = await server({ findings: [{ ...high, title }], extra: { billing: { tariff: "ci", charged_usd: 4, paid_by: "balance" }, silent_bill: { at, billed: true } } });
  try {
    const j = JSON.parse((await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url })).out);
    assert.deepEqual([j.billing.tariff, j.billing.charged_usd, j.billing.paid_by], ["ci", 4, "balance"]);
    assert.deepEqual([j.silent_bill.billed, j.silent_bill.note], [true, `silent bill: billed on its own at ${at}`]);
    const m = (await cli(dir, ["--format", "markdown"], { OHMYBUG_URL: s.url })).out;
    assert.match(m, /Billing: \$4 charged \(CI billing, ` balance `\)\. silent bill: billed on its own/);
    const row = m.split("\n").find((l) => l.startsWith("| HIGH"));
    assert.equal(row.split(/(?<!\\)\|/).length, 5, row);
    // The whole title is one code span: its links, image, emphasis and bare URLs are literal text.
    assert.ok(row.endsWith("| `` ![x](https://host/p.png) [click](https://host) a\\\\|b *em* _u_ `c` `` |"), row);
  } finally { await s.close() }
  // The error line carries server text: inside a pre block, escaped.
  s = await server({ toolError: { error: "quota_exceeded", message: "<b>no</b>\n### OhMyBug review: No blocking bugs" } });
  try {
    const m = (await cli(dir, ["--format", "markdown"], { OHMYBUG_URL: s.url })).out;
    assert.match(m, /^### OhMyBug review: Could not run\n/);
    assert.match(m, /<pre>could not review: quota_exceeded: &lt;b&gt;no&lt;\/b&gt;\n### OhMyBug review: No blocking bugs<\/pre>/);
    // Inside the pre block the server text is literal: the only heading is the real one.
    assert.equal(m.replace(/<pre>[\s\S]*?<\/pre>/g, "").match(/^### /gm).length, 1);
  } finally { await s.close() }
});

test("result helpers: no billing block reads as the confirm tariff, an absent charge is null, a non-https link is not drawn, the cap drops the folds", () => {
  const done = (extra) => resultOf({ reviewId: "rev_x", answer: { status: "done", findings: [], ...extra } }, 0);
  assert.deepEqual([done({ billing: { charged_usd: 0 } }).billing.tariff, done({ billing: { charged_usd: 0 } }).billing.charged_usd], ["confirm", null]);
  assert.match(done({}).billing.note, /as REAL$/);
  assert.match(done({ silent_bill: { at: "2026-11-12T10:00:00.000Z" } }).billing.note, /or at the billing deadline$/);
  assert.equal(done({ billing: { tariff: "ci" } }).billing.charged_usd, null);
  assert.equal(done({ billing: { tariff: "ci", charged_usd: "x" } }).billing.charged_usd, null);
  assert.equal(resultOf({ reviewId: "rev_x", answer: { status: "failed", billing: { tariff: "ci", charged_usd: 4 } } }, 2).billing.note, "the charge the service reported for this review");
  const md = resultMarkdown(done({ live_url: "https://x\n\n### fake" }));
  assert.match(md, /Report: none \(/);
  assert.equal(md.match(/^### /gm).length, 1);
  const f = { finding_id: 7, severity: "high", file: { a: 1 }, line: 3, title: "t", failure_scenario: "x".repeat(400 * 1024) };
  const big = resultOf({ reviewId: "rev_x", answer: { status: "done", findings: [f, { ...f, finding_id: "f2" }, { ...f, finding_id: "f3" }] } }, 1);
  assert.deepEqual([big.findings[0].id, big.findings[0].file], ["7", null]);
  const capped = resultMarkdown(big);
  assert.ok(Buffer.byteLength(capped) < 900 * 1024, String(Buffer.byteLength(capped)));
  assert.doesNotMatch(capped, /<details>/);
  assert.match(capped, /Failure scenarios left out/);
});

test("parseArgs: --format needs a value; the flag wins over OHMYBUG_FORMAT", async () => {
  for (const argv of [["--format"], ["--format="], ["--format", "--deep"]]) assert.equal(typeof parseArgs(argv), "string", argv.join(" "));
  const { dir } = repo();
  const r = await cli(dir, ["--format", "json"], { OHMYBUG_FORMAT: "markdown", OHMYBUG_URL: "http://127.0.0.1:9" });
  assert.equal(JSON.parse(r.out).outcome, "no_changes");
});

test("a large json result reaches a pipe whole: the CLI process exits after stdout drains", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 66\n");
  git("commit", "-qam", "c");
  const s = await server({ findings: [{ severity: "low", title: "t", failure_scenario: "y".repeat(2_000_000) }] });
  try {
    // The real entry point, through a pipe: its exit must wait for the 2 MB write.
    const { execFile } = await import("node:child_process");
    const out = await new Promise((resolve, reject) => execFile(process.execPath, [fileURLToPath(new URL("../ohmybug.mjs", import.meta.url)), "--format", "json"],
      { cwd: dir, env: { ...process.env, OHMYBUG_API_KEY: "test-key", OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "60" }, maxBuffer: 64 * 1024 * 1024 },
      (e, stdout) => (e && e.code !== 0 ? reject(e) : resolve(stdout))));
    assert.equal(JSON.parse(out).findings[0].body.length, 2_000_000);
  } finally { await s.close() }
});
test("--mode and OHMYBUG_MODE: sent as the top-level mode of a fast hunt, never with --deep; refused locally where it cannot run", async () => {
  // Parsing: the three modes, both spellings; the rest refused before anything is sent.
  assert.equal(parseArgs(["--mode", "lite"]).mode, "lite");
  assert.equal(parseArgs(["--mode=snap"]).mode, "snap");
  assert.equal(parseArgs(["--mode", "fast", "--uncommitted"]).mode, "fast");
  for (const argv of [["--mode"], ["--mode", "deep"], ["--mode=full"], ["--mode", "lite", "--deep"], ["--mode", "fast", "--deep"], ["--mode", "snap", "--uncommitted"]]) {
    assert.equal(typeof parseArgs(argv), "string", argv.join(" "));
  }
  const { dir, git } = repo();
  git("remote", "add", "origin", "https://github.com/acme/app.git");
  writeFileSync(join(dir, "app.js"), "export const a = 51\n");
  git("commit", "-qam", "c");
  git("update-ref", "refs/remotes/origin/feature", "HEAD");
  const subs = (s) => s.calls.filter((c) => c.name === "submit_review").map((c) => c.args);
  for (const [argv, env, want] of [
    [["--mode", "lite"], {}, "lite"],
    [[], { OHMYBUG_MODE: "snap" }, "snap"],
    [["--mode", "fast"], { OHMYBUG_MODE: "lite" }, "fast"],
    [[], {}, undefined],
    [[], { OHMYBUG_MODE: "" }, undefined],
  ]) {
    const s = await server({ submitExtra: want ? { hunt_mode: want } : {} });
    try {
      const r = await cli(dir, argv, { OHMYBUG_URL: s.url, ...env });
      assert.equal(r.code, 0, r.log);
      assert.equal(subs(s).length, 1);
      assert.equal(subs(s)[0].mode, want, argv.join(" ") + JSON.stringify(env));
      assert.equal(subs(s)[0].meta.hunt_mode, undefined);
      // Exactly one start line, and it names the mode only when the service echoed a known one.
      assert.deepEqual(r.log.match(/review rev_test started[^\n]*/g), [want ? `review rev_test started in ${want} mode` : "review rev_test started"]);
    } finally { await s.close() }
  }
  // A mode the service echoes but this client does not know is not printed.
  const odd = await server({ submitExtra: { hunt_mode: "x\u001b[2J" } });
  try { assert.deepEqual((await cli(dir, [], { OHMYBUG_URL: odd.url })).log.match(/review rev_test started[^\n]*/g), ["review rev_test started"]) } finally { await odd.close() }
  // --deep: the env default is not sent (the service refuses a mode with deep).
  const deep = await server();
  try {
    const r = await cli(dir, ["--deep"], { OHMYBUG_URL: deep.url, OHMYBUG_MODE: "lite" });
    assert.equal(r.code, 0, r.log);
    assert.equal(subs(deep)[0].deep, true);
    assert.equal("mode" in subs(deep)[0], false);
  } finally { await deep.close() }
  // Nothing is sent: a bad env value; a repository mode from the env with --uncommitted.
  for (const [argv, env, why] of [
    [[], { OHMYBUG_MODE: "turbo" }, /OHMYBUG_MODE must be lite, snap or fast, not turbo/],
    [["--uncommitted"], { OHMYBUG_MODE: "lite" }, /OHMYBUG_MODE=lite reads the repository/],
    [["--mode", "lite", "--uncommitted"], {}, /--mode lite reads the repository/],
  ]) {
    const s = await server();
    try {
      const r = await cli(dir, argv, { OHMYBUG_URL: s.url, ...env });
      assert.equal(r.code, 2);
      assert.match(r.log, why);
      assert.equal(s.calls.length, 0);
    } finally { await s.close() }
  }
  // fast from the env with --uncommitted runs, the mode sent.
  const unc = await server();
  try {
    writeFileSync(join(dir, "app.js"), "export const a = 52\n");
    const r = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: unc.url, OHMYBUG_MODE: "fast" });
    assert.equal(r.code, 0, r.log);
    assert.equal(subs(unc)[0].mode, "fast");
    git("checkout", "-q", "app.js");
  } finally { await unc.close() }
  // A refused GitHub read: lite and snap are not resent as a diff alone (the service would refuse it);
  // fast, explicit or by default, is resent with its mode.
  for (const [argv, resent] of [[["--mode", "lite"], false], [["--mode", "snap"], false], [["--mode", "fast"], true], [[], true]]) {
    const s = await server({ faults: { submit_review: { error: "repo_not_listed", message: "no" } } });
    try {
      const r = await cli(dir, argv, { OHMYBUG_URL: s.url });
      assert.equal(subs(s).length, resent ? 2 : 1, argv.join(" "));
      if (resent) {
        assert.equal(r.code, 0, r.log);
        assert.match(subs(s)[1].diff, /^diff --git/);
        assert.equal(subs(s)[1].mode, argv[1]);
      } else {
        assert.equal(r.code, 2);
        assert.match(r.log, new RegExp(`repo_not_listed: no; --mode ${argv[1]} needs the repository, so the diff was not sent alone: use --mode fast`));
      }
    } finally { await s.close() }
  }
  // The service's mode refusals are printed with their code and message; nothing is resent.
  for (const code of ["mode_unavailable", "mode_needs_repo", "mode_too_large", "mode_with_deep"]) {
    const s = await server({ faults: { submit_review: { error: code, message: "send mode: fast" } } });
    try {
      const r = await cli(dir, ["--mode", "snap"], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 2);
      assert.match(r.log, new RegExp(`${code}: send mode: fast`));
      assert.equal(subs(s).length, 1);
    } finally { await s.close() }
  }
});

/**
 * A routing service : `script` maps a review id to its answers in turn. Each wait_review takes the next one (the
 * last repeats), and get_findings answers the one wait_review last gave. `heads` records each submit's headers.
 */
async function routeServer(script, submitted = { review_id: "rev_step1", status: "running", live_url: "https://example.test/live/step1" }) {
  const calls = [], heads = [], at = {};
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const { name, arguments: args } = msg.params;
      calls.push({ name, id: args.review_id, follows: req.headers["x-ohmybug-follows"] });
      let result;
      if (name === "submit_review") { heads.push(req.headers); result = submitted; }
      else {
        const list = script[args.review_id] ?? [{ status: "failed", error: "unknown review" }];
        if (name === "wait_review") at[args.review_id] = Math.min((at[args.review_id] ?? -1) + 1, list.length - 1);
        const a = list[at[args.review_id] ?? 0];
        const { findings, ...head } = a;
        result = name === "wait_review" ? { review_id: args.review_id, ...head }
          : { review_id: args.review_id, findings: [], review_of_record: true, ...a };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } }));
    });
  });
  srv.keepAliveTimeout = 60_000;
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, heads, close: () => new Promise((r) => { srv.close(r); srv.closeIdleConnections?.(); }) };
}

// A pushed GitHub commit: the submit the service may route.
function routedRepo() {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 41\n");
  git("commit", "-qam", "c");
  git("remote", "add", "origin", "git@github.com:acme/app.git");
  git("update-ref", "refs/remotes/origin/feature", "HEAD");
  return dir;
}

test("route: a running step 1, pending, then continued: the child's result and exit code, both reviews named, the header on submit only", async () => {
  const dir = routedRepo();
  const s = await routeServer({
    rev_step1: [
      { status: "running", route_state: "snap_running", final: false },
      { status: "done", findings: [low], route_state: "pending", final: false },
      { status: "done", findings: [low], route_state: "continued", continued_by: "rev_child", final: false },
    ],
    rev_child: [{ status: "done", findings: [high], live_url: "https://example.test/live/child" }],
  });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 1, r.log);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.review.id, j.review.continued_from, j.review.route_refused, j.counts.total, j.findings[0].severity, j.live_url],
      ["rev_child", "rev_step1", null, 1, "high", "https://example.test/live/child"]);
    assert.match(r.log, /review rev_step1 continues as review rev_child/);
    assert.equal(s.heads.length, 1);
    assert.deepEqual(s.calls.map((c) => [c.name, c.follows ?? null]).filter(([n, f]) => n === "submit_review" ? f !== "continued_by" : f !== null), []);
    assert.ok(s.calls.some((c) => c.name === "get_findings"));
    const text = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.match(text.out, /Reviews: rev_step1 continued as rev_child; the result is review rev_child's\./);
    assert.doesNotMatch(text.out, /naming/);
  } finally { await s.close(); }
});

test("route: final with continuation_refused prints step 1 and its reason; awaiting_verdicts stops on step 1 (this client never judges)", async () => {
  const dir = routedRepo();
  let s = await routeServer({ rev_step1: [{ status: "done", findings: [low], route_state: "final", final: true, continuation_refused: "waited_out" }] });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.review.id, j.review.continued_from, j.review.route_refused, j.counts.low], ["rev_step1", null, "waited_out", 1]);
    assert.match(r.log, /no fast hunt followed it \(waited_out\)/);
  } finally { await s.close(); }
  s = await routeServer({ rev_step1: [{ status: "done", findings: [high], route_state: "awaiting_verdicts", final: false }] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 1, r.log);
    assert.match(r.log, /this client does not judge/);
    assert.equal(s.calls.filter((c) => c.name === "get_findings").length, 1);
  } finally { await s.close(); }
});

test("route: a failed step 1 the service continues is not the result; a continuation that loops or is malformed is refused", async () => {
  const dir = routedRepo();
  let s = await routeServer({
    rev_step1: [{ status: "failed", route_state: "pending", final: false }, { status: "failed", route_state: "continued", continued_by: "rev_child", final: false }],
    rev_child: [{ status: "done", findings: [] }],
  });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.doesNotMatch(r.log, /the review failed/);
  } finally { await s.close(); }
  for (const next of ["rev_step1", "../x", 7, "\u001b[2Jrev", "rev_child/../x"]) {
    s = await routeServer({ rev_step1: [{ status: "done", route_state: "continued", continued_by: next, final: false }] });
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 2, `${next}: ${r.log}`);
      assert.match(r.log, /which this client does not follow/);
      assert.doesNotMatch(r.log, /may still be running/);
      assert.ok(!r.log.includes("\u001b"), "a control character reached the log");
    } finally { await s.close(); }
  }
});

test("route: a clock per hunt: a child that starts late gets its full OHMYBUG_TIMEOUT_S, though step 1's has run out", async () => {
  const dir = routedRepo();
  // Step 1 is read pending at once and continues 10 s later; the child then runs about 20 s. One 40 s clock for both
  // would end the wait at about 25 s, when 15 s are left (the reserve for the last read).
  const s = await routeServer({
    rev_step1: [
      { status: "done", route_state: "pending", final: false },
      { status: "done", route_state: "continued", continued_by: "rev_child", final: false },
    ],
    rev_child: [{ status: "running" }, { status: "running" }, { status: "running" }, { status: "running" }, { status: "done", findings: [] }],
  });
  try {
    const t0 = Date.now();
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "40" });
    assert.equal(r.code, 0, r.log);
    assert.ok(Date.now() - t0 > 26_000, `the run ended before one shared clock would have (${Date.now() - t0} ms): the test proves nothing`);
  } finally { await s.close(); }
});

test("route: the chain stops at two hunts; an unknown state with final false is not a result", async () => {
  const dir = routedRepo();
  const cont = (next) => ({ status: "done", route_state: "continued", continued_by: next, final: false });
  const s3 = await routeServer({ rev_step1: [cont("rev_a")], rev_a: [cont("rev_b")], rev_b: [{ status: "done" }] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s3.url });
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /continued as "rev_b", which this client does not follow/);
    assert.ok(!s3.calls.some((c) => c.id === "rev_b"), "a third hunt was read");
  } finally { await s3.close(); }
  // A state this client does not know, with final false, is read again until the route ends.
  const s = await routeServer({ rev_step1: [{ status: "done", findings: [high], route_state: "deciding", final: false }, { status: "done", findings: [low], route_state: "final", final: true }] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.equal(s.calls.filter((c) => c.name === "wait_review").length, 2);
  } finally { await s.close(); }
});

test("route: a malformed or absent refusal reason stays out of the log and the result", async () => {
  const dir = routedRepo();
  for (const reason of ["\u001b[2Jbad", "Waited Out", 7, undefined]) {
    const s = await routeServer({ rev_step1: [{ status: "done", route_state: "final", final: true, ...(reason === undefined ? {} : { continuation_refused: reason }) }] });
    try {
      const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 0, r.log);
      assert.equal(JSON.parse(r.out).review.route_refused, null);
      assert.doesNotMatch(r.log, /no fast hunt followed/);
    } finally { await s.close(); }
  }
});

test("route: a child still running at its clock names the child, not step 1, and no step 1 link", async () => {
  const dir = routedRepo();
  const s = await routeServer({
    rev_step1: [{ status: "done", route_state: "continued", continued_by: "rev_child", final: false }],
    rev_child: [{ status: "running" }],
  });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" });
    assert.equal(r.code, 2, r.log);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.outcome, j.review.id, j.review.continued_from, j.live_url], ["timed_out", "rev_child", "rev_step1", null]);
    assert.match(r.log, /review rev_child may still be running/);
    assert.doesNotMatch(r.log, /review rev_step1 may still be running/);
  } finally { await s.close(); }
});

test("route: the wait for the service's decision has its own clock, and its timeout names no ended review as running", async () => {
  const dir = routedRepo();
  // Step 1 ends at about 10 s of a 30 s clock: on step 1's clock no 10 s look would fit; on its own one, one does.
  const s = await routeServer({ rev_step1: [{ status: "running" }, { status: "running" }, { status: "done", route_state: "pending", final: false }] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" }, { decisionWaitS: 1 });
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /review rev_step1 ended; waiting up to 30s for the service to decide whether a fast hunt follows it/);
    assert.match(r.log, /no result within OHMYBUG_TIMEOUT_S \(30s\)/);
    assert.equal(s.calls.filter((c) => c.name === "wait_review").length, 4);
    assert.doesNotMatch(r.log, /may still be running/);
  } finally { await s.close(); }
});

test("route: the decision wait is never shorter than the service's window, whatever OHMYBUG_TIMEOUT_S says", async () => {
  // The service's worst case is about 1520 s from step 1's end; the floor covers it and the loop's last look before it.
  assert.ok(DECISION_WAIT_S >= 1520 + 16 + 10 && DECISION_WAIT_S <= 1800, `${DECISION_WAIT_S}`);
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "done", route_state: "pending", final: false }, { status: "done", route_state: "pending", final: false }, { status: "done", route_state: "final", final: true }] });
  try {
    // On a 30 s clock the second pending read (at 10 s) leaves no room for another 10 s look; on the 45 s floor it does,
    // and the route ends final.
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" }, { decisionWaitS: 45 });
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /waiting up to 45s for the service to decide/);
  } finally { await s.close(); }
});

test("route: with nothing injected, the decision wait is the default floor, not OHMYBUG_TIMEOUT_S", async () => {
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "done", route_state: "pending", final: false }, { status: "done", route_state: "pending", final: false }, { status: "done", route_state: "final", final: true }] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" });
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, new RegExp(`waiting up to ${DECISION_WAIT_S}s for the service to decide`));
  } finally { await s.close(); }
});

test("route result shape: a refused continuation reports the ended step 1 as done, with its route state", async () => {
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "done", route_state: "continued", continued_by: "../x", final: false }] });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2, r.log);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.review.id, j.review.status, j.review.ended_status, j.review.route_state, j.outcome], ["rev_step1", "running", "done", "continued", "interrupted"]);
  } finally { await s.close(); }
});

test("route result shape: a decision-wait timeout names the window that ran, and step 1 as done", async () => {
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "done", route_state: "pending", final: false }] });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" }, { decisionWaitS: 45 });
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /no result within the service's decision window \(45s\)/);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.review.status, j.review.ended_status, j.review.route_state, j.outcome], ["running", "done", "pending", "timed_out"]);
  } finally { await s.close(); }
});

test("route result shape: the child's live link is printed as soon as a read carries it, and kept on a timeout", async () => {
  const dir = routedRepo();
  const s = await routeServer({
    rev_step1: [{ status: "done", route_state: "continued", continued_by: "rev_child", final: false }],
    rev_child: [{ status: "running", live_url: "https://example.test/live/child" }],
  });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" });
    assert.equal(r.code, 2, r.log);
    assert.equal(r.log.match(/live progress: https:\/\/example\.test\/live\/child/g)?.length, 1, r.log);
    assert.match(r.log, /review rev_child may still be running: https:\/\/example\.test\/live\/child/);
    assert.equal(JSON.parse(r.out).live_url, "https://example.test/live/child");
  } finally { await s.close(); }
});

test("route result shape: markdown names the chain and the refusal, and claims the result only for an outcome that has one", () => {
  const base = { outcome: "clean", counts: { blocking: 0 }, findings: [], error: null, billing: { tariff: "ci", charged_usd: 0, paid_by: null, note: "" }, silent_bill: null, live_url: null, live_url_missing: "x" };
  const md = (review) => resultMarkdown({ ...base, review });
  assert.match(md({ id: "rev_b", continued_from: "rev_a", route_refused: null, route_state: "continued" }), /Reviews: ` rev_a ` continued as ` rev_b `; the result is the last one's\./);
  assert.match(md({ id: "rev_a", continued_from: null, route_refused: "waited_out", route_state: "final" }), /No fast hunt followed the first step: ` waited_out `\./);
  assert.doesNotMatch(md({ id: "rev_a", continued_from: null, route_refused: null, route_state: null }), /Reviews:|No fast hunt/);
  for (const outcome of ["blocking", "failed", "cut_short"]) {
    const m = resultMarkdown({ ...base, outcome, counts: { blocking: 1 }, review: { id: "rev_b", continued_from: "rev_a", route_refused: null, route_state: "final" } });
    assert.match(m, /the result is the last one's/, outcome);
  }
  // No result was read: the chain is named, no result is claimed.
  const cut = resultMarkdown({ ...base, outcome: "timed_out", billing: { tariff: null, charged_usd: null, paid_by: null, note: "" },
    review: { id: "rev_b", continued_from: "rev_a", route_refused: null, route_state: "continued" } });
  assert.match(cut, /Reviews: ` rev_a ` continued as ` rev_b `\./);
  assert.doesNotMatch(cut, /the result is/);
});

test("route result shape: pending, then continued, then a child timeout: the child running, on OHMYBUG_TIMEOUT_S", async () => {
  const dir = routedRepo();
  const s = await routeServer({
    rev_step1: [{ status: "done", route_state: "pending", final: false }, { status: "done", route_state: "continued", continued_by: "rev_child", final: false }],
    rev_child: [{ status: "running" }],
  });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" }, { decisionWaitS: 45 });
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /no result within OHMYBUG_TIMEOUT_S \(30s\)/);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.review.id, j.review.status, j.review.ended_status, j.review.route_state, j.review.continued_from, j.outcome], ["rev_child", "running", null, null, "rev_step1", "timed_out"]);
  } finally { await s.close(); }
});

test("route result shape: a link with a control character is not kept in the result; an odd route state is not kept", async () => {
  const dir = routedRepo();
  const s = await routeServer({
    rev_step1: [{ status: "done", route_state: "continued", continued_by: "rev_child", final: false }],
    rev_child: [{ status: "done", findings: [], route_state: "Final\u001b[2J", live_url: "https://example.test/\u001b[2Jx" }],
  });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.ok(!r.log.includes("\u001b"), "a control character reached the log");
    const j = JSON.parse(r.out);
    assert.deepEqual([j.live_url, j.review.route_state], [null, null]);
    assert.match(j.live_url_missing, /^the service sent no live link/);
  } finally { await s.close(); }
});

test("route result shape: step 1's link is logged from a running read when submit carried none", async () => {
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "running", live_url: "https://example.test/live/late" }, { status: "done", findings: [], route_state: "final", final: true, live_url: "https://example.test/live/late" }] },
    { review_id: "rev_step1", status: "running" });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.equal(r.log.match(/live progress: https:\/\/example\.test\/live\/late/g)?.length, 1, r.log);
  } finally { await s.close(); }
});

test("route result shape: markdown of a child stopped by its clock names the chain and claims no result", async () => {
  const dir = routedRepo();
  const s = await routeServer({
    rev_step1: [{ status: "done", route_state: "continued", continued_by: "rev_child", final: false }],
    rev_child: [{ status: "running" }],
  });
  try {
    const r = await cli(dir, ["--format", "markdown"], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" });
    assert.equal(r.code, 2, r.log);
    assert.match(r.out, /### OhMyBug review: Timed out before a result/);
    assert.match(r.out, /Reviews: ` rev_step1 ` continued as ` rev_child `\./);
    assert.doesNotMatch(r.out, /the result is/);
  } finally { await s.close(); }
});

test("route: a route state that is not a plain code still holds an ended step 1 with final false", async () => {
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "done", findings: [high], route_state: "Step-2", final: false }, { status: "done", findings: [low], route_state: "final", final: true }] });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, { decisionWaitS: 45 });
    assert.equal(r.code, 0, r.log);
    assert.equal(s.calls.filter((c) => c.name === "wait_review").length, 2);
    assert.equal(JSON.parse(r.out).review.route_state, "final");
  } finally { await s.close(); }
});

test("live links: only a plain ASCII https URL is a link, in the JSON result and in markdown", () => {
  const bad = ["https://e.test/a b", "https://e.test/a\tb", "https://e.test/\u001b[2J", "https://e.test/\u009b2J", "https://e.test/؜x", "https://e.test/​x", "https://e.test/‎x",
    "https://e.test/‮x", "https://e.test/⁦x", "https://e.test/﻿x", "https://e.test/é", "https://e.test/a<b", "https://e.test/a>b", "https://e.test/a(b", "https://e.test/a)b",
    "https://e.test/a[b", "https://e.test/a]b", "https://e.test/a`b", "http://e.test/x", "javascript:alert(1)", "https://", 7];
  for (const u of bad) {
    assert.equal(resultOf({ reviewId: "rev_x", live: u }, 2).live_url, null, JSON.stringify(u));
    assert.equal(resultOf({ reviewId: "rev_x", answer: { status: "done", findings: [], live_url: u } }, 0).live_url, null, JSON.stringify(u));
    const res = { ...resultOf({ reviewId: "rev_x", answer: { status: "done", findings: [] } }, 0), live_url: u };
    assert.match(resultMarkdown(res), /Report: none/, JSON.stringify(u));
  }
  const ok = "https://app.ohmybug.ai/live/aB-_9.~?x=1&y=%20#f";
  assert.equal(resultOf({ reviewId: "rev_x", live: ok }, 2).live_url, ok);
  assert.match(resultMarkdown(resultOf({ reviewId: "rev_x", answer: { status: "done", findings: [], live_url: ok } }, 0)), /Report: <https:\/\/app\.ohmybug\.ai\/live\/aB/);
});

test("live links: a bad link is not printed from the submit answer, a running read or a finished read", async () => {
  const dir = routedRepo();
  const bad = "https://example.test/‮x";
  // Submit: no progress line, and the timeout's "may still be running" line carries no link.
  let s = await routeServer({ rev_step1: [{ status: "running" }] }, { review_id: "rev_step1", status: "running", live_url: bad });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" });
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /review rev_step1 may still be running$/m);
    assert.doesNotMatch(r.log, /live progress|example\.test/);
    assert.equal(JSON.parse(r.out).live_url, null);
  } finally { await s.close(); }
  // A running read, then a finished one, in text mode: no progress line, no Report line.
  s = await routeServer({ rev_step1: [{ status: "running", live_url: bad }, { status: "done", findings: [], route_state: "final", final: true, live_url: bad }] }, { review_id: "rev_step1", status: "running" });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.equal(s.calls.filter((c) => c.name === "wait_review").length, 2);
    assert.doesNotMatch(r.out + r.log, /live progress|Report:|example\.test/);
  } finally { await s.close(); }
});

test("live links: an ended review's link is the report, never logged as live progress", async () => {
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "done", findings: [], route_state: "final", final: true, live_url: "https://example.test/live/late" }] }, { review_id: "rev_step1", status: "running" });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.doesNotMatch(r.log, /live progress/);
    assert.match(r.out, /Report: https:\/\/example\.test\/live\/late/);
  } finally { await s.close(); }
});

test("route result shape: route_state and ended_status are the last read's, of the review the result names", async () => {
  // A child that was never read reports nothing of step 1.
  const never = resultOf({ reviewId: "rev_child", continuedFrom: "rev_step1", read: { id: "rev_step1", status: "done", route: "continued" } }, 2).review;
  assert.deepEqual([never.status, never.ended_status, never.route_state], ["running", null, null]);
  // A running step 1: its state from wait_review, no ended status.
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "running", route_state: "snap_running", final: false }] });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" });
    assert.equal(r.code, 2, r.log);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.review.status, j.review.ended_status, j.review.route_state, j.outcome], ["running", null, "snap_running", "timed_out"]);
  } finally { await s.close(); }
});

test("route: the chain cap's refusal reports the child, step 1, the child's ended status and route state", async () => {
  const dir = routedRepo();
  const cont = (next) => ({ status: "done", route_state: "continued", continued_by: next, final: false });
  const s = await routeServer({ rev_step1: [cont("rev_a")], rev_a: [cont("rev_b")] });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2, r.log);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.review.id, j.review.continued_from, j.review.status, j.review.ended_status, j.review.route_state, j.outcome],
      ["rev_a", "rev_step1", "running", "done", "continued", "interrupted"]);
  } finally { await s.close(); }
});

test("route result shape: a failed review reports ended_status failed", async () => {
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "failed", route_state: "final", final: true }] });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2, r.log);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.review.status, j.review.ended_status, j.outcome], ["failed", "failed", "failed"]);
  } finally { await s.close(); }
});

test("a wait_review that showed the review ended is kept when the get_findings after it fails", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 9\n");
  const s = await server({ faults: { get_findings: { error: "not_found", message: "gone" } } });
  try {
    const r = await cli(dir, ["--uncommitted", "--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2, r.log);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.review.status, j.review.ended_status, j.outcome], ["running", "done", "interrupted"]);
  } finally { await s.close() }
});

test("text mode: the Report line falls back to the hunt's link from a running read", async () => {
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "running", live_url: "https://example.test/live/r" }, { status: "done", findings: [], route_state: "final", final: true }] },
    { review_id: "rev_step1", status: "running" });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.match(r.out, /Report: https:\/\/example\.test\/live\/r/);
  } finally { await s.close(); }
});

test("--deep ignores route fields: a deep review the service marks continued is still the result", async () => {
  const dir = routedRepo();
  const s = await routeServer({ rev_step1: [{ status: "done", findings: [], route_state: "continued", continued_by: "rev_child", final: false }] });
  try {
    const r = await cli(dir, ["--deep", "--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.ok(!s.calls.some((c) => c.id === "rev_child"), "a deep review was followed");
    const j = JSON.parse(r.out);
    assert.deepEqual([j.review.id, j.review.route_state, j.review.continued_from], ["rev_step1", null, null]);
  } finally { await s.close(); }
});

test("every submit carries the follows header: --mode, --deep and the diff-only resend; no other call does", async () => {
  const dir = routedRepo();
  const check = (s) => {
    const subs = s.calls.filter((c) => c.name === "submit_review");
    assert.ok(subs.length >= 1);
    assert.deepEqual(subs.map((c) => c.follows), subs.map(() => "continued_by"));
    assert.deepEqual(s.calls.filter((c) => c.name !== "submit_review" && c.follows !== undefined), []);
  };
  for (const [argv, faults, n] of [[["--mode", "fast"], {}, 1], [["--deep"], {}, 1], [[], { submit_review: { error: "diff_required", message: "no" } }, 2]]) {
    const s = await server({ faults });
    try {
      const r = await cli(dir, argv, { OHMYBUG_URL: s.url });
      assert.equal(r.code, 0, `${argv.join(" ")}: ${r.log}`);
      assert.equal(s.calls.filter((c) => c.name === "submit_review").length, n);
      check(s);
    } finally { await s.close() }
  }
});

test("--uncommitted: an index that cannot be read is a refusal, never a review of an empty index", async () => {
  // A directory fails the copy; a link to itself fails the stat (ELOOP).
  for (const broken of [(p) => mkdirSync(p), (p) => symlinkSync(p, p)]) {
    const { dir } = repo();
    writeFileSync(join(dir, "app.js"), "export const a = 3\n");
    rmSync(join(dir, ".git", "index"));
    broken(join(dir, ".git", "index"));
    const s = await server();
    try {
      const r = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 2, r.log);
      assert.match(r.log, /could not snapshot the working tree for --uncommitted/);
      assert.ok(!s.calls.some((c) => c.name === "submit_review"));
    } finally { await s.close() }
  }
});

test("the decision floor seam refuses a value that would disable the deadline", async () => {
  const { dir } = repo();
  for (const bad of [NaN, 0, 1.5, "45"]) await assert.rejects(cli(dir, [], {}, { decisionWaitS: bad }), /decisionWaitS must be a whole number/);
});

// The service refuses a diff sent alone with snapshot_required unless the account reviews diffs only: the diff goes
// again by upload, after a tar.gz of the reviewed tree, and nothing is sent twice that starts a hunt.
const NEEDS_SNAPSHOT = { submit_review: { error: "snapshot_required", message: "send a snapshot: https://app.ohmybug.ai/me/policy" } };
const tarList = (buf) => execFileSync("tar", ["-tzf", "-"], { input: buf }).toString().split("\n").filter(Boolean).sort();
const tarRead = (buf, path) => execFileSync("tar", ["-xzOf", "-", path], { input: buf }).toString();

test("snapshot_required: a ticket, the reviewed tree as a tar.gz, then the same diff and files; the result is read as usual", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  writeFileSync(join(dir, "app.js"), "export const a = 3 // uncommitted, not reviewed\n");
  const s = await server({ findings: [high], faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 1, r.log);
    const subs = s.calls.filter((c) => c.name === "submit_review");
    assert.equal(subs.length, 2);
    assert.match(subs[0].args.diff, /\+export const a = 2/);
    assert.equal(subs[1].args.upload, true);
    assert.equal(subs[1].args.diff, undefined);
    assert.equal(subs[1].args.meta.branch, "feature");
    assert.deepEqual(s.uploads.map((u) => [u.door, u.type]), [["repo", "application/gzip"], ["payload", "application/json"]]);
    assert.deepEqual(tarList(s.uploads[0].body), ["app.js"]);
    assert.equal(tarRead(s.uploads[0].body, "app.js"), "export const a = 2\n");
    const payload = JSON.parse(s.uploads[1].body);
    assert.equal(payload.diff, subs[0].args.diff);
    assert.deepEqual(payload.files, subs[0].args.files);
    assert.match(r.out, /HIGH {2}app\.js:1 {2}wrong constant/);
  } finally { await s.close() }
});

test("snapshot_required with --uncommitted: the snapshot is the working tree, untracked files included", async () => {
  const { dir } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 5\n");
  writeFileSync(join(dir, "new.js"), "export const b = 1\n");
  const s = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(tarList(s.uploads[0].body), ["app.js", "new.js"]);
    assert.equal(tarRead(s.uploads[0].body, "app.js"), "export const a = 5\n");
  } finally { await s.close() }
});

test("a ticket that does not say snapshot required (off, or no flag) gets the diff and files only: the repository is never uploaded", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  for (const snapshot of ["off", undefined]) {
  const s = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot } });
  try {
    const r = await cli(dir, ["--mode", "fast"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(s.uploads.map((u) => u.door), ["payload"], String(snapshot));
    assert.equal(s.calls.filter((c) => c.name === "submit_review")[1].args.mode, "fast");
    assert.match(r.log, /the repository is not uploaded/);
    assert.doesNotMatch(r.log, /uploading the repository snapshot/);
  } finally { await s.close() }
  }
});

test("the snapshot door: 409 (already has it) goes on to the diff; a refusal is printed whole and the diff is not sent", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  let s = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required", repo: [409] } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(s.uploads.map((u) => u.door), ["repo", "payload"]);
  } finally { await s.close() }
  for (const st of [413, 410, 403]) {
    s = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required", repo: [st] } });
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url });
      assert.equal(r.code, 2, String(st));
      assert.match(r.log, new RegExp(`HTTP ${st} repo refused: see https://app\\.ohmybug\\.ai/me/policy`));
      assert.deepEqual(s.uploads.map((u) => u.door), ["repo"], String(st));
      assert.equal(s.calls.filter((c) => c.name === "wait_review").length, 0);
    } finally { await s.close() }
  }
});

test("the diff upload refused with snapshot_required is final: printed whole, never sent again, nothing polled", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  const s = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required", payload: [409] } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2);
    assert.match(r.log, /HTTP 409 payload refused: see https:\/\/app\.ohmybug\.ai\/me\/policy/);
    assert.equal(JSON.parse(r.out).error.code, "snapshot_required");
    assert.deepEqual(s.uploads.map((u) => u.door), ["repo", "payload"]);
    assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 2);
    assert.equal(s.calls.filter((c) => c.name === "wait_review").length, 0);
  } finally { await s.close() }
});

test("an upload address on another host is refused before the repository leaves the machine", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  const s = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required", url: "https://elsewhere.example/u/tok" } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2);
    assert.match(r.log, /without a usable upload address/);
    assert.equal(s.uploads.length, 0);
    assert.equal(JSON.parse(r.out).outcome, "not_run");
  } finally { await s.close() }
  // No address at all: `new URL(undefined, base)` would resolve to <base>/undefined.
  const s2 = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required", url: null } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s2.url });
    assert.equal(r.code, 2);
    assert.match(r.log, /without a usable upload address/);
    assert.equal(s2.uploads.length, 0);
  } finally { await s2.close() }
});

test("without snapshot_required nothing changes: a diff refused for another reason is not sent again and no ticket is asked for", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  const s = await server({ faults: { submit_review: { error: "diff_too_large", message: "too big" } } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2);
    assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 1);
    assert.equal(s.uploads.length, 0);
  } finally { await s.close() }
});

test("the snapshot door: a 503 or 429 is sent again; a trailing slash on the ticket address still reaches /repo", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  const s = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required", repo: [503, 429] } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(s.uploads.map((u) => u.door), ["repo", "repo", "repo", "payload"]);
  } finally { await s.close() }
  const s2 = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required", slash: true } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s2.url });
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(s2.uploads.map((u) => [u.door, u.path]), [["repo", "/u/tok/repo"], ["payload", "/u/tok/"]]);
  } finally { await s2.close() }
});

test("the diff upload starts the hunt: a 503 or a reset there is never sent again, and the run names the review that may be running", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  const s = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required", payload: [503] } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 2);
    assert.deepEqual(s.uploads.map((u) => u.door), ["repo", "payload"]);
    assert.match(r.log, /A hunt may have started/);
    assert.match(r.log, /review rev_test may still be running/);
    assert.equal(JSON.parse(r.out).review.id, "rev_test");
  } finally { await s.close() }
});

test("a diff resent after a refused GitHub read takes the snapshot path too; a GitHub submit refused with snapshot_required uploads nothing", async () => {
  const dir = routedRepo();
  const s = await server({ faults: { submit_review: [{ error: "diff_required", message: "no app" }, NEEDS_SNAPSHOT.submit_review] }, ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    const subs = s.calls.filter((c) => c.name === "submit_review");
    assert.deepEqual(subs.map((c) => [!!c.args.meta?.repo, !!c.args.diff, !!c.args.upload]), [[true, false, false], [false, true, false], [false, false, true]]);
    assert.deepEqual(s.uploads.map((u) => u.door), ["repo", "payload"]);
  } finally { await s.close() }
  const s2 = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s2.url });
    assert.equal(r.code, 2);
    assert.equal(s2.calls.filter((c) => c.name === "submit_review").length, 1);
    assert.equal(s2.uploads.length, 0);
  } finally { await s2.close() }
});

test("a snapshot over the limit is refused before a ticket is asked for: nothing is uploaded and nothing started", async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  const s = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, { maxSnapshot: 10 });
    assert.equal(r.code, 2);
    assert.match(r.log, /the repository snapshot is 1 MiB compressed, over the 0 MiB the service takes; nothing was started/);
    assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 1);
    assert.equal(s.uploads.length, 0);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.outcome, j.error.code], ["not_run", "snapshot_required"]);
  } finally { await s.close() }
});

// GIT_ATTR_SOURCE is read by recent git (2.42 here, to be safe); an older git applies the tree's export-ignore.
const gitVersion = execFileSync("git", ["--version"]).toString().match(/(\d+)\.(\d+)/).slice(1).map(Number);
test("export-ignore does not leave a reviewed file out of the snapshot", { skip: gitVersion[0] < 2 || (gitVersion[0] === 2 && gitVersion[1] < 42) ? "git before 2.42" : false }, async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, ".gitattributes"), "tests/ export-ignore\n");
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "tests", "a.test.js"), "test\n");
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("add", ".");
  git("commit", "-qm", "change");
  const s = await server({ faults: { ...NEEDS_SNAPSHOT }, ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url });
    assert.equal(r.code, 0, r.log);
    assert.ok(tarList(s.uploads[0].body).includes("tests/a.test.js"), tarList(s.uploads[0].body).join(","));
  } finally { await s.close() }
});
