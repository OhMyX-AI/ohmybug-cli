// Diff selection and exit codes, end to end: a throwaway git repository and a fake review server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, utimesSync, rmSync, statSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciMeta, contextDenied, DECISION_WAIT_S, exitCodeFor, fileReader, formatFindings, fitBody, packTree, snapshotDenied, parseArgs, resolveBase, resultMarkdown, resultOf, rpcMessage, run, silentBillLine, trimDiff, VERSION, selectPartial, addedNames, PARTIAL, PARTIAL_SEARCH, PARTIAL_LIST_MS, OS_MANIFEST, OS_KW, OS_SKIP, OS_DOC1, OS_DOC2, NAME } from "../ohmybug.mjs";

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
 * file request's address; `huntMs` keeps wait_review running that long after its first call, each answer after up to 1 s; `submitExtra` adds fields to the submit answer; `requestedAgain` makes the second wait_review a second request at the same address.
 */
async function server({ huntMs = 0, findings = [], status = "done", review_of_record = true, httpStatus = 200, requested, requestedAgain, sse = false, submitStatus, submitBody, toolError, faults = {}, filesStatus = 200, filesUrl, filesLocation, extra = {}, submitExtra = {}, ticket } = {}, port = 0) {
  const calls = [], posted = [], uploads = [], deletes = [];
  let url, asks = 0, huntFrom;
  const srv = createServer((req, res) => {
    let body = "";
    const chunks = [];
    req.on("data", (c) => { body += c; chunks.push(c); });
    req.on("end", () => {
      if (httpStatus !== 200) { res.writeHead(httpStatus); return res.end("no"); }
      // The upload doors: ticket.repo / ticket.payload answer with those statuses in turn ("reset" drops the socket),
      // 200 once the list is out; ticket.body overrides a door's answer text, ticket.delayMs delays the snapshot door's answer.
      // DELETE <upload_url> (#3676): ticket.del answers with "retired" (200 {retired: true}), "hang" (never), "reset", or a
      // status; 404 by default, as a server without the door.
      if (req.url.startsWith("/u/") && req.method === "DELETE") {
        deletes.push(req.url);
        const d = ticket?.del ?? 404;
        if (d === "hang") return;
        if (d === "reset") return req.socket.destroy();
        res.writeHead(d === "retired" ? 200 : d, { "content-type": "application/json" });
        return res.end(JSON.stringify(d === "retired" ? { ok: true, retired: true, review_id: "rev_test" } : { error: "not found" }));
      }
      if (req.url.startsWith("/u/")) {
        const door = /\/repo(\?|$)/.test(req.url) ? "repo" : "payload";
        uploads.push({ door, path: req.url, type: req.headers["content-type"], body: Buffer.concat(chunks) });
        const st = (ticket?.[door] ?? []).shift() ?? 200;
        if (st === "reset") return req.socket.destroy();
        if (String(st).startsWith("http")) { res.writeHead(307, { location: st }); return res.end(); }
        const answer = ticket?.body?.[door] ?? JSON.stringify(st === 200
          ? (door === "payload" ? { ok: true, review_id: ticket?.payloadId ?? "rev_test", status: "running", live_url: "https://example.test/live/up", hunt_mode: "fast" } : { ok: true })
          : { error: `${door} refused: see https://app.ohmybug.ai/me/policy`, ...(st === 409 && door === "payload" ? { code: "snapshot_required" } : {}) });
        const send = () => { res.writeHead(st, { "content-type": "application/json", ...(st !== 200 && ticket?.retryAfter ? { "retry-after": ticket.retryAfter } : {}) }); res.end(answer); };
        return ticket?.delayMs && door === "repo" ? setTimeout(send, ticket.delayMs) : send();
      }
      if (req.url === "/files") {
        posted.push(JSON.parse(body));
        res.writeHead(Array.isArray(filesStatus) ? filesStatus[posted.length - 1] ?? 200 : filesStatus, filesLocation ? { location: filesLocation } : {});
        return res.end("{}");
      }
      const msg = JSON.parse(body);
      const { name, arguments: args } = msg.params;
      calls.push({ name, args, auth: req.headers.authorization, follows: req.headers["x-ohmybug-follows"] });
      if (name === "submit_review" && submitStatus) { res.writeHead(submitStatus); return res.end(submitBody ?? "boom"); }
      // A list fails the calls of that tool in turn (null lets one through).
      let fault = Array.isArray(faults[name]) ? faults[name].shift() : faults[name];
      if (!Array.isArray(faults[name]) || !faults[name].length) delete faults[name];
      if (fault) {
        if (fault === "internal" || fault === "rate_limited" || typeof fault === "object") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(typeof fault === "object" ? fault : { error: fault, message: "blip" }) }] } }));
        }
        if (fault === "reset") return req.socket.destroy();
        if (fault === "slow1") { res.writeHead(429, { "retry-after": "1" }); return res.end("slow down"); }
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
        : name === "submit_review" && args.upload ? { ...(ticket?.noId ? {} : { review_id: "rev_test" }), status: "awaiting_upload", ...(ticket?.live ? { live_url: ticket.live } : {}), ...(ticket?.url === null ? {} : { upload_url: ticket?.url ?? `${url}/u/tok-secret${ticket?.slash ? "/" : ""}` }), ...(ticket?.snapshot ? { snapshot: ticket.snapshot } : {}), ...(ticket?.pack ? { pack: ticket.pack } : {}) }
        : name === "submit_review" ? { review_id: "rev_test", status: "running", ...submitExtra }
        : ask ? { review_id: "rev_test", status: "needs_files", requested_files: ask, files_url: filesUrl ?? `${url}/files` }
        : name === "wait_review" ? { review_id: "rev_test", status: Date.now() - (huntFrom ??= Date.now()) < huntMs ? "running" : status }
        : { review_id: "rev_test", status, findings, review_of_record, live_url: "https://example.test/live/x", ...extra };
      const answer = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result) }], ...(toolError ? { isError: true } : {}) } });
      const send = () => {
        res.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" });
        res.end(sse ? `event: message\ndata: ${answer}\n\n` : answer);
      };
      return result.status === "running" && name === "wait_review" && huntMs ? setTimeout(send, 1000) : send();
    });
  });
  // Node's 5 s default races the client's 5 s retry: a reused socket the server just closed reads as a reset.
  srv.keepAliveTimeout = 60_000;
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  url = `http://127.0.0.1:${srv.address().port}`;
  return { url, calls, posted, uploads, deletes, close: () => new Promise((r) => { srv.close(r); srv.closeIdleConnections?.(); }) };
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
  assert.match(parseArgs(["--deep", "--uncommitted"]), /commit, then push and run ohmybug --deep on GitHub, or run ohmybug --deep --snapshot off github\.com/);
});

test("the base: --base, then the merge request target (remote-tracking when present), then origin/main", () => {
  const has = (refs) => (r) => refs.includes(r);
  assert.equal(resolveBase({ base: "v1" }, { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" }, has([])), "v1");
  assert.equal(resolveBase({}, { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" }, has(["origin/develop"])), "origin/develop");
  assert.equal(resolveBase({}, { CI_MERGE_REQUEST_TARGET_BRANCH_NAME: "develop" }, has([])), "develop");
  assert.equal(resolveBase({}, {}, has([])), "origin/main");
});

// #3403: a medium judged real and marked tracked in the client's own ticket (#3382) does not block; nothing else changes.
test("exit codes: a known medium does not block; still_open, a high, a bad mark or no REAL verdict still do", () => {
  const med = { severity: "medium", title: "m", file: "a.js", line: 1 };
  const known = { ...med, verdict: "REAL", known: { kind: "deferred", ref: "#12" } };
  assert.equal(exitCodeFor({ status: "done", findings: [known] }), 0);
  assert.equal(exitCodeFor({ status: "done", findings: [{ ...known, known: { kind: "accepted", ref: "https://t.example/1" } }] }), 0);
  assert.equal(exitCodeFor({ status: "done", findings: [{ ...known, severity: "P2" }] }), 0, "P2 is medium");
  assert.equal(exitCodeFor({ status: "done", findings: [known, low] }), 0);
  assert.equal(exitCodeFor({ status: "done", findings: [known, high] }), 1, "another major still blocks");
  const blocks = {
    "still_open keeps blocking (#3384)": { ...known, known: { kind: "still_open", of: { id: "f-1", round: 1 } } },
    "a high is never known": { ...known, severity: "high" },
    "a critical is never known": { ...known, severity: "critical" },
    "an unrated finding fails closed": { ...known, severity: "blocker" },
    "no verdict": { ...known, verdict: undefined },
    "NOT_REAL is not read here": { ...known, verdict: "NOT_REAL" },
    "UNCLEAR": { ...known, verdict: "UNCLEAR" },
    "an unknown kind": { ...known, known: { kind: "later", ref: "#1" } },
    "no ref": { ...known, known: { kind: "deferred" } },
    "a blank ref": { ...known, known: { kind: "deferred", ref: "  " } },
    "a string mark": { ...known, known: "deferred" },
  };
  for (const [why, f] of Object.entries(blocks)) assert.equal(exitCodeFor({ status: "done", findings: [f] }), 1, why);
  // A cut-short run is still not clean when its only medium is known.
  assert.equal(exitCodeFor({ status: "done", findings: [known], review_of_record: false }), 2);
  // The outputs: a known finding is tagged, never blocking, left out of the count; the ref (server text) is not echoed.
  const res = resultOf({ reviewId: "rev_x", answer: { status: "done", findings: [known, { ...med, finding_id: "f2" }] } }, 1);
  assert.deepEqual(res.findings.map((f) => [f.blocking, f.known]), [[false, true], [true, false]]);
  assert.equal(res.counts.blocking, 1);
  assert.equal(res.counts.medium, 2);
  const md = resultMarkdown(res);
  assert.match(md, /\| MEDIUM \(known: tracked in your ticket\) \| ` a\.js:1 ` \|/);
  assert.doesNotMatch(md, /#12/);
  assert.match(formatFindings([known]), /^MEDIUM  a\.js:1  m  \(known: tracked in your ticket\)$/m);
  assert.doesNotMatch(formatFindings([{ ...med }]), /known/);
});

test("a note: shown last under Notes, never blocking, carried as kind; a raised one is a regular finding", () => {
  const note = { finding_id: "n1", severity: "low", file: "a.js", line: 3, title: "could validate the input", failure_scenario: "s", kind: "note" };
  const low = { finding_id: "l1", severity: "low", file: "a.js", line: 9, title: "off by one", failure_scenario: "s" };
  const med = { finding_id: "m1", severity: "medium", file: "b.js", line: 1, title: "crash", failure_scenario: "s" };
  const raised = { ...note, finding_id: "n2", severity: "medium", title: "raised note" };
  const text = formatFindings([note, med, low]);
  assert.match(text, /^MEDIUM  b\.js:1  crash[\s\S]*^LOW  a\.js:9  off by one[\s\S]*^Notes \(1\): [^\n]*\n\nLOW  a\.js:3  could validate the input/m);
  assert.doesNotMatch(formatFindings([low, med]), /Notes/);
  assert.match(formatFindings([note]), /^Notes \(1\)/);
  assert.equal(exitCodeFor({ status: "done", findings: [note] }), 0);
  assert.equal(exitCodeFor({ status: "done", findings: [raised] }), 1);
  const res = resultOf({ reviewId: "rev_x", answer: { status: "done", findings: [note, raised, low, { ...low, finding_id: "t1", kind: "test" }, { ...low, finding_id: "x1", kind: "other" }] } }, 1);
  assert.deepEqual(res.findings.map((f) => [f.id, f.kind, f.blocking]), [["n2", null, true], ["n1", "note", false], ["l1", null, false], ["t1", "test", false], ["x1", null, false]]);
  assert.match(resultMarkdown(res), /\| LOW \(note\) \| ` a\.js:3 ` \|/);
  assert.doesNotMatch(formatFindings([raised]), /Notes/);
});

// A second read of the change (the service's `second_read`): a moved low goes last under the service's heading with its
// sentence, a doubt stays in place with its sentence; `says` is never printed; nothing changes which findings block.
const HEADING = "Likely not defects: 3. A read of the change found each of these handled or already present at the place named. Not a proof: judge them like any finding.";
const moved = (at) => ({ says: "likely_not_a_defect", why: `A read of the change found the case handled at ${at}.`, at });
const READ_ANSWER = [
  { finding_id: "p1", severity: "low", file: "p.js", line: 1, title: "plain low", failure_scenario: "sp" },
  { finding_id: "n1", severity: "low", file: "n.js", line: 2, title: "own note", failure_scenario: "sn", kind: "note" },
  { finding_id: "m1", severity: "low", file: "m.js", line: 3, title: "moved low", failure_scenario: "sm", second_read: moved("m.js:9") },
  { finding_id: "m2", severity: "low", file: "o.js", line: 4, title: "moved own note", failure_scenario: "so", kind: "note", second_read: moved("o.js:8") },
  { finding_id: "m3", severity: "low", file: "t.js", line: 5, title: "moved test row", failure_scenario: "st", kind: "test", reported_severity: "medium", second_read: { says: "likely_not_a_defect", why: "A read of the change found what is reported missing at t.js:7.", at: "t.js:7" } },
  { finding_id: "d1", severity: "medium", file: "d.js", line: 6, title: "medium in doubt", failure_scenario: "sd", second_read: { says: "doubted", why: "A second read doubts this: the task asks for this behaviour.", at: null } },
];

test("a second read: moved lows last under the service's heading with the sentence, a doubt in place; text, summary and JSON", () => {
  assert.equal(formatFindings(READ_ANSWER), [
    "MEDIUM  d.js:6  medium in doubt  · A second read doubts this: the task asks for this behaviour.\n    sd",
    "LOW  p.js:1  plain low\n    sp",
    "Notes (1): lows that name no failing input today; they never fail the run",
    "LOW  n.js:2  own note\n    sn",
    HEADING,
    "LOW  m.js:3  moved low  · A read of the change found the case handled at m.js:9.\n    sm\n\n"
      + "LOW  o.js:4  moved own note  · A read of the change found the case handled at o.js:8.\n    so\n\n"
      + "LOW  t.js:5  moved test row  · A read of the change found what is reported missing at t.js:7.\n    st",
  ].join("\n\n"));
  // The moved rows never block: the medium in doubt alone does.
  assert.equal(exitCodeFor({ status: "done", findings: READ_ANSWER }), 1);
  assert.equal(exitCodeFor({ status: "done", findings: READ_ANSWER.filter((f) => f.finding_id !== "d1") }), 0);
  const res = resultOf({ reviewId: "rev_x", answer: { status: "done", findings: READ_ANSWER } }, 1);
  assert.equal(res.counts.blocking, 1);
  const by = Object.fromEntries(res.findings.map((f) => [f.id, f]));
  assert.deepEqual(by.m1.second_read, { says: "likely_not_a_defect", why: "A read of the change found the case handled at m.js:9.", at: "m.js:9" });
  assert.deepEqual(by.d1.second_read, { says: "doubted", why: "A second read doubts this: the task asks for this behaviour.", at: null });
  assert.equal(by.m2.kind, "note");
  assert.equal(by.m3.kind, "test");
  assert.equal("second_read" in by.p1, false);
  const md = resultMarkdown(res);
  const [mainTable, rest] = md.split(`**Likely not defects: 3.** A read of the change found each of these handled or already present at the place named. Not a proof: judge them like any finding.`);
  assert.ok(rest, "the heading line is printed once");
  assert.match(mainTable, /\| MEDIUM \| ` d\.js:6 ` \| ` medium in doubt ` \|/);
  assert.match(mainTable, /\| LOW \(note\) \| ` n\.js:2 ` \| ` own note ` \|/);
  assert.doesNotMatch(mainTable, /moved/);
  const movedTable = rest.split("<details>")[0];
  for (const t of ["moved low", "moved own note", "moved test row"]) assert.match(movedTable, new RegExp(`\` ${t} \``));
  assert.match(movedTable, /\| LOW \(note\) \| ` o\.js:4 `/);
  assert.match(md, /<summary>LOW m\.js:3: moved low<\/summary>\n\n<p>A read of the change found the case handled at m\.js:9\.<\/p>\n\n<pre>sm<\/pre>/);
  assert.match(md, /<summary>MEDIUM d\.js:6: medium in doubt<\/summary>\n\n<p>A second read doubts this: the task asks for this behaviour\.<\/p>/);
  // `says` is for programs: only the JSON carries its machine value, never the text or the summary.
  for (const out of [formatFindings(READ_ANSWER), md]) assert.doesNotMatch(out, /likely_not_a_defect|doubted/);
  assert.match(JSON.stringify(res), /"says":"likely_not_a_defect"/);
  assert.match(JSON.stringify(res), /"says":"doubted"/);
  // Over the summary's size bound the folds go and both tables stay whole: the heading always has its rows under it.
  const big = READ_ANSWER.map((f) => ({ ...f, failure_scenario: "x".repeat(200 * 1024) }));
  const cut = resultMarkdown(resultOf({ reviewId: "rev_x", answer: { status: "done", findings: big } }, 1));
  assert.doesNotMatch(cut, /<details>/);
  const after = cut.split("**Likely not defects: 3.**")[1];
  for (const t of ["moved low", "moved own note", "moved test row"]) assert.match(after, new RegExp(`\` ${t} \``));
  // A malformed read is ignored, as before; a moved word on a non-low row keeps its place with its sentence.
  assert.equal(formatFindings([{ ...READ_ANSWER[0], second_read: { says: "likely_not_a_defect" } }]), formatFindings([READ_ANSWER[0]]));
  assert.match(formatFindings([{ ...READ_ANSWER[5], second_read: moved("d.js:1") }]), /^MEDIUM  d\.js:6  medium in doubt  · A read of the change found the case handled at d\.js:1\.$/m);
});

test("with no second read anywhere, the text, the summary and the JSON are 0.12.0's byte for byte", async (t) => {
  let old;
  try { old = execFileSync("git", ["show", "v0.12.0:ohmybug.mjs"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return t.skip("tag v0.12.0 not fetched"); }
  const dir = mkdtempSync(join(tmpdir(), "ohmybug-old-"));
  writeFileSync(join(dir, "old.mjs"), old);
  const was = await import(new URL(`file://${join(dir, "old.mjs")}`).href);
  const answersBase = (i) => { const { second_read, ...f } = READ_ANSWER[i]; return f; };
  const answers = [READ_ANSWER.map(({ second_read, ...f }) => f), [], [READ_ANSWER[1]], [{ ...answersBase(5), known: { kind: "deferred", ref: "#1" }, verdict: "REAL" }]];
  for (const findings of answers) {
    assert.equal(formatFindings(findings), was.formatFindings(findings));
    const rec = { reviewId: "rev_x", answer: { status: "done", findings } };
    const now = resultOf(rec, 1), then = was.resultOf(rec, 1);
    assert.deepEqual({ ...now, cli_version: null }, { ...then, cli_version: null });
    assert.equal(JSON.stringify({ ...now, cli_version: null }), JSON.stringify({ ...then, cli_version: null }));
    assert.equal(resultMarkdown(now), was.resultMarkdown(then));
  }
  rmSync(dir, { recursive: true, force: true });
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

test("a diff-only review: a secret or credential store is in the diff but never sent as a file; code named like secrets.ts is", async () => {
  const { dir, git } = repo();
  for (const p of ["src/secrets.ts", ".env.example", ".env", ".npmrc", "lib.js"]) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), `// ${p}\n`); }
  git("add", ".");
  git("commit", "-qm", "secret-named");
  const s = await server({ requested: ["src/secrets.ts", ".env.example", ".env", ".npmrc", "lib.js"] });
  try {
    assert.equal((await cli(dir, [], { OHMYBUG_URL: s.url })).code, 0);
    const sub = s.calls.find((c) => c.name === "submit_review").args;
    assert.match(sub.diff, /b\/\.env\n/);
    const context = sub.files.map((f) => f.path);
    assert.ok(!context.includes(".env") && !context.includes(".npmrc"), context.join(","));
    assert.ok(context.includes("src/secrets.ts") && context.includes(".env.example"), context.join(","));
    assert.deepEqual(s.posted[0].files.map((f) => f.path), ["src/secrets.ts", ".env.example", "lib.js"]);
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
  for (const [opts, code, submits, outcome = "maybe_started"] of [
    [{ faults: { submit_review: 429 } }, 0, 2],
    [{ faults: { submit_review: "rate_limited" } }, 0, 2],
    [{ faults: { submit_review: "garble" } }, 2, 1],
    [{ submitStatus: 502 }, 2, 1],
    [{ faults: { submit_review: "reset" } }, 2, 1],
    [{ toolError: { error: "internal", message: "late failure" } }, 2, 1],
    [{ submitExtra: { review_id: undefined } }, 2, 1],
    // A refusal that only quotes the sentence is not a maybe: the fate decides, not the text.
    [{ toolError: { error: "bad_input", message: "A hunt may have started: see https://app.ohmybug.ai/me" } }, 2, 1, "not_run"],
  ]) {
    const s = await server(opts);
    try {
      const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url });
      assert.equal(r.code, code, JSON.stringify(opts) + r.log);
      assert.equal(s.calls.filter((c) => c.name === "submit_review").length, submits, JSON.stringify(opts));
      // The server counts what it received: one hunt, however many attempts reached it. The result says so too: a
      // refusal's fate, not its text, makes the outcome (a dropped fate on any of these throws reads not_run).
      if (code === 2) {
        assert.match(r.log, /A hunt may have started/);
        assert.equal(JSON.parse(r.out).outcome, outcome, JSON.stringify(opts));
      }
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
  // No Retry-After: the wait is this client's own backoff, and the text does not say the service asked for it.
  const bare = await server({ submitStatus: 429 });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: bare.url, OHMYBUG_TIMEOUT_S: "30" });
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /HTTP 429: the next try would be in \d+s, more than OHMYBUG_TIMEOUT_S leaves; nothing was started/);
    assert.doesNotMatch(r.log, /asks to wait/);
  } finally { await bare.close() }
  // A Retry-After shorter than the backoff it lost to is not the service's ask either.
  const short = await server({ faults: { submit_review: ["slow1", "slow1", "slow1", "slow1"] } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: short.url, OHMYBUG_TIMEOUT_S: "30" });
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /the next try would be in \d+s/);
    assert.doesNotMatch(r.log, /asks to wait/);
  } finally { await short.close() }
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
  // Refused before any call: off github.com (no GitHub repository, a remote that only mentions github.com) with the
  // snapshot kept here (the snapshot path itself is tested below), an unpushed HEAD, GitHub Enterprise kept here too,
  // a base that is not a branch name.
  const kept = { OHMYBUG_SNAPSHOT: "off" }, keptWhy = /not on github\.com uploads a snapshot of it, and OHMYBUG_SNAPSHOT=off keeps the repository on this machine; nothing was sent/;
  for (const [setup, env, argv, why] of [
    [() => {}, kept, [], keptWhy],
    [() => git("remote", "add", "origin", "https://git.example.com/github.com/acme/app.git"), kept, [], keptWhy],
    [() => git("remote", "set-url", "origin", "git@github.com:acme/app.git"), {}, [], /push it first/],
    [() => git("update-ref", "refs/remotes/fork/feature", "HEAD"), { GITHUB_SHA: "0".repeat(40) }, [], /push it first/],
    [() => git("update-ref", "refs/remotes/origin/feature", "HEAD"), { GITHUB_SERVER_URL: "https://ghe.example.com", ...kept }, [], keptWhy],
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
  // --snapshot on a github.com repository is said to be unused.
  git("remote", "set-url", "origin", "https://github.com/acme/web");
  for (const [setup, env, argv, want] of [
    [() => {}, {}, ["--snapshot"], `acme/web ${head} main`],
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
      assert.equal(/--snapshot is not used: the service reads this repository from GitHub/.test(r.log), argv.includes("--snapshot"), r.log);
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
    assert.deepEqual(Object.keys(j), ["schema", "cli_version", "exit_code", "outcome", "review", "live_url", "live_url_missing", "billing", "silent_bill", "findings", "counts", "error", "upload_ticket"]);
    assert.equal(j.schema, "ohmybug-cli/result/1");
    assert.equal(j.cli_version, VERSION);
    assert.deepEqual([j.exit_code, j.outcome], [1, "blocking"]);
    assert.deepEqual(j.review, { id: "rev_test", status: "done", deep: false, complete: true, continued_from: null, route_refused: null, route_state: null, ended_status: "done" });
    assert.deepEqual([j.live_url, j.live_url_missing], ["https://example.test/live/x", null]);
    assert.deepEqual(j.billing.tariff, "confirm");
    assert.equal(j.billing.charged_usd, null);
    assert.equal(j.silent_bill, null);
    assert.deepEqual(j.findings.map((f) => [f.severity, f.blocking]), [["high", true], ["medium", true], ["low", false], ["unrated", true]]);
    assert.deepEqual(j.findings[1], { id: "rev_test:f2", severity: "medium", blocking: true, known: false, kind: null, file: "b.js", line: 2, title: "t2", body: "s2", suggested_fix: "fix it" });
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

// ---- The repository snapshot (snapshot_required) ----

const hasTar = (() => { try { execFileSync("tar", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const untar = (buf) => {
  const d = mkdtempSync(join(tmpdir(), "ohmybug-untar-"));
  execFileSync("tar", ["-xzf", "-", "-C", d], { input: buf });
  return d;
};
const tarNames = (buf) => execFileSync("tar", ["-tzf", "-"], { input: buf }).toString().split("\n").filter(Boolean).sort();
const NEEDS_SNAPSHOT = () => ({ submit_review: { error: "snapshot_required", message: "send a snapshot: https://app.ohmybug.ai/me/policy" } });
const SNAP = { snapshot: { waitS: 60, minTryMs: 500 } };
function changed() {
  const { dir, git } = repo();
  writeFileSync(join(dir, "app.js"), "export const a = 2\n");
  git("commit", "-qam", "change");
  return { dir, git };
}

test("packTree: the stored blobs, raw: no filter, export rule or eol rule runs; exec bit kept; a symlink is its target's name; long paths whole; submodules out; same bytes twice", { skip: !hasTar && "no tar" }, async () => {
  const { dir, git } = repo();
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin", "run.sh"), "#!/bin/sh\n");
  execFileSync("chmod", ["+x", join(dir, "bin", "run.sh")]);
  symlinkSync("app.js", join(dir, "link.js"));
  const p100 = `${"a".repeat(96)}.txt`, p101 = `${"b".repeat(97)}.txt`, p300 = `${"c".repeat(150)}/${"d".repeat(145)}.txt`;
  for (const p of [p100, p101, p300]) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), `${p.length}\n`); }
  // The service's snapshot list, every entry, files and folders, any depth and case.
  const secret = [".env", ".env.example", "web/.env.local", "up/.ENV.Prod", "src/secrets.ts", "a/Credentials.json", "certs/server.pem", "certs2/Server.PEM",
    "c.p12", "d.PFX", "tls.key", "k.ppk", "a.jks", "b.keystore", "deploy/id_ed25519", "id_rsa", "id_rsa.pub", "k/ID_DSA", "k2/id_ecdsa", "k3/id_ed25519_sk",
    "infra/prod.tfstate", "infra/prod.tfstate.backup", "vars.tfvars.json", ".npmrc", "sub/.netrc", ".pgpass", ".pypirc", ".git-credentials", "kubeconfig",
    ".kube/config", ".docker/config.json", ".ssh/known_hosts", ".aws/config", ".gnupg/pubring.kbx",
    // Folder cases: whatever is inside a folder so named stays out.
    "secrets/db.yml", "prod-credentials/x.js", ".env.d/x", "id_rsa.d/x", "certs.pem/x", "keys.key/x", "store.jks/x", "x.tfstate.d/y", "y.tfvars.d/z",
    "n/.npmrc/x", "kc/kubeconfig/x", "deep/.SSH/x",
    // Judged per file name: kubeconfig under any name, env files by suffix; source-code names stay (below).
    "kubeconfig.yaml", "app.env", "notkubeconfig", "deploy/k8s/prod-kubeconfig.yaml", "admin.kubeconfig", "kubeconfig_prod", "kubeconfig.bak",
    "kube_config_x.yml", "Kube-Config.json", "Kubeconfig.GO", "prod.env.local", "prod.env-local", "up2/App.ENV"];
  // Near misses, as the service's globs keep them: a listed name with more characters before or after it.
  const kept = ["web/envelope.js", "keys.md", "key.js", "docs/kube.md", "tfstate.md", "menv/x.js", "ssh.md", "my.npmrc", ".dockerignore",
    ".sshrc", "server.pem.bak", "x.keys", "myid_rsa", ".github/x.yml", "a.keymap.ts", ".awsrc", "src/kubeconfig.go", "src/kubeconfig-loader.ts",
    "src/config.env.ts", "src/app.env.d.ts", "pkg/kubeconfig-loader/README.md", "deploy/app.envoy.yaml", "deploy/prod.environment.yaml"];
  for (const p of [...secret, ...kept]) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), "x\n"); }
  writeFileSync(join(dir, "crypted.bin"), "ciphertext\n");
  writeFileSync(join(dir, "crlf.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "ver.txt"), "$Format:%H$\n");
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "tests", "t.js"), "test\n");
  writeFileSync(join(dir, "big.bin"), "version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 9\n");
  writeFileSync(join(dir, ".gitattributes"), "crypted.bin filter=boom\ncrlf.txt eol=crlf\nver.txt export-subst\ntests/ export-ignore\n");
  git("config", "filter.boom.smudge", `touch ${join(dir, "SMUDGED")}; tr a-z A-Z`);
  git("config", "core.autocrlf", "true");
  git("add", ".");
  git("commit", "-qm", "tree");
  // A submodule entry (a gitlink) in the tree.
  git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD").trim()},vendor/sub`);
  git("commit", "-qm", "sub");
  const rev = git("rev-parse", "HEAD^{tree}").trim();
  const caps = { maxBytes: 1 << 30, maxUnpacked: 1 << 30, timeoutMs: 60_000 };
  const a = await packTree(dir, rev, caps), b = await packTree(dir, rev, caps);
  assert.ok(a.tgz && !a.cannot, a.cannot);
  assert.equal(a.gitlinks, 1);
  assert.equal(a.secrets, secret.length);
  for (const p of secret) assert.ok(!tarNames(a.tgz).includes(p), `${p} is left out`);
  for (const p of kept) assert.ok(tarNames(a.tgz).includes(p), `${p} is kept`);
  assert.ok(a.tgz.equals(b.tgz), "a tree packs to the same bytes");
  const out = untar(a.tgz);
  const stored = (p) => execFileSync("git", ["-C", dir, "cat-file", "blob", `${rev}:${p}`]);
  for (const p of ["app.js", "bin/run.sh", "crypted.bin", "crlf.txt", "ver.txt", "tests/t.js", "big.bin", p100, p101, p300, ".gitattributes"]) {
    assert.ok(readFileSync(join(out, p)).equals(stored(p)), p);
  }
  assert.equal(readFileSync(join(out, "link.js"), "utf8"), "app.js");
  assert.equal(statSync(join(out, "bin", "run.sh")).mode & 0o777, 0o755);
  assert.equal(statSync(join(out, "app.js")).mode & 0o777, 0o644);
  assert.ok(!tarNames(a.tgz).some((n) => n.startsWith("vendor")), "the submodule is left out");
  assert.ok(!tarNames(a.tgz).some((n) => n.includes("PaxHeader")), "pax headers are not files");
  assert.ok(!existsSafe(join(dir, "SMUDGED")), "the filter never ran");
});
function existsSafe(p) { try { readFileSync(p); return true; } catch { return false; } }

test("packTree: over the compressed or the unpacked cap, or an empty tree, is a reason, not a throw", async () => {
  const { dir, git } = repo();
  const rev = git("rev-parse", "HEAD^{tree}").trim();
  assert.match((await packTree(dir, rev, { maxBytes: 10, maxUnpacked: 1 << 30, timeoutMs: 60_000 })).cannot, /over 1 MiB compressed/);
  // Just over the tar trailer: only the files' own headers and blocks can go over it.
  assert.match((await packTree(dir, rev, { maxBytes: 1 << 30, maxUnpacked: 1025, timeoutMs: 60_000 })).cannot, /MiB unpacked, over the 1 MiB/);
  const empty = git("hash-object", "-t", "tree", "/dev/null").trim();
  assert.match((await packTree(dir, empty, { maxBytes: 1 << 30, maxUnpacked: 1 << 30, timeoutMs: 60_000 })).cannot, /no files/);
});

test("snapshot_required: a ticket, the stored tree as gzip, then the same diff and files; the result follows the diff upload's answer", { skip: !hasTar && "no tar" }, async () => {
  const { dir } = changed();
  const s = await server({ findings: [high], faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 1, r.log);
    const subs = s.calls.filter((c) => c.name === "submit_review");
    assert.deepEqual(subs.map((c) => [!!c.args.diff, !!c.args.upload]), [[true, false], [false, true]]);
    assert.equal(subs[1].args.meta.branch, "feature");
    assert.deepEqual(s.uploads.map((u) => [u.door, u.type]), [["repo", "application/gzip"], ["payload", "application/json"]]);
    assert.equal(readFileSync(join(untar(s.uploads[0].body), "app.js"), "utf8"), "export const a = 2\n");
    assert.deepEqual(Object.keys(JSON.parse(s.uploads[1].body)).sort(), ["diff", "files"]);
    assert.equal(JSON.parse(s.uploads[1].body).diff, subs[0].args.diff);
    assert.deepEqual(JSON.parse(s.uploads[1].body).files, subs[0].args.files);
    assert.ok(subs[0].args.files.some((f) => f.path === ".review-client/tree.txt"));
    const j = JSON.parse(r.out);
    assert.equal(j.review.id, "rev_test");
    assert.match(r.log, /started in fast mode/);
    assert.match(r.log, /live progress: https:\/\/example\.test\/live\/up/);
  } finally { await s.close() }
});

test("--deep off github.com: a deep upload ticket with no repo or ref, the stored HEAD tree as gzip, then the diff and files; nothing else first", { skip: !hasTar && "no tar" }, async () => {
  const { dir } = changed();
  const s = await server({ findings: [high], ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--deep", "--snapshot", "--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 1, r.log);
    const subs = s.calls.filter((c) => c.name === "submit_review");
    // One submit, the ticket: deep and upload, no payload, no mode, and meta without the commit key the GitHub path takes.
    assert.equal(subs.length, 1);
    assert.equal(subs[0].args.deep, true);
    assert.equal(subs[0].args.upload, true);
    assert.equal(subs[0].args.diff, undefined);
    assert.equal(subs[0].args.mode, undefined);
    assert.equal(subs[0].args.meta.repo, undefined);
    assert.equal(subs[0].args.meta.ref, undefined);
    assert.equal(subs[0].args.meta.branch, "feature");
    assert.deepEqual(s.uploads.map((u) => [u.door, u.type]), [["repo", "application/gzip"], ["payload", "application/json"]]);
    assert.equal(readFileSync(join(untar(s.uploads[0].body), "app.js"), "utf8"), "export const a = 2\n");
    const body = JSON.parse(s.uploads[1].body);
    assert.deepEqual(Object.keys(body).sort(), ["diff", "files"]);
    assert.match(body.diff, /export const a = 2/);
    assert.ok(body.files.some((f) => f.path === ".review-client/tree.txt"));
    assert.equal(JSON.parse(r.out).review.deep, true);
    assert.match(r.log, /deep hunt over a snapshot of this repository \(it is not on github\.com\)/);
  } finally { await s.close() }
});

test("--deep off github.com: a deep ticket that does not ask for the snapshot is refused; the diff is never sent alone", async () => {
  const { dir } = changed();
  const s = await server({ findings: [high], ticket: {} });
  try {
    const r = await cli(dir, ["--deep", "--snapshot"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /the deep upload ticket did not ask for the repository snapshot; nothing was uploaded and nothing started\. The upload ticket \(review rev_test\) is still open/);
    assert.deepEqual(s.uploads, []);
    assert.deepEqual(s.calls.map((c) => c.name), ["submit_review"]);
  } finally { await s.close() }
});

test("--deep off github.com: the base is --base, else $GITHUB_BASE_REF (origin/<it>), else the fast rule", async () => {
  const { dir, git } = changed();
  git("update-ref", "refs/remotes/origin/develop", "HEAD");
  git("branch", "-q", "local-base", "HEAD");
  for (const [argv, env, base] of [[[], { GITHUB_BASE_REF: "develop" }, "origin/develop"], [["--base", "local-base"], { GITHUB_BASE_REF: "nope" }, "local-base"]]) {
    const s = await server({ ticket: { snapshot: "required" } });
    try {
      // Both bases are HEAD: nothing to review, and nothing is asked of the service.
      const r = await cli(dir, ["--deep", "--snapshot", ...argv], { OHMYBUG_URL: s.url, ...env }, SNAP);
      assert.equal(r.code, 0, r.log);
      assert.match(r.out, new RegExp(`Nothing to review: no changes against ${base}\\.`));
      assert.equal(s.calls.length, 0);
    } finally { await s.close() }
  }
});

test("--deep on GitHub Enterprise (GITHUB_SERVER_URL another host) takes the snapshot path", { skip: !hasTar && "no tar" }, async () => {
  const { dir } = changed();
  const s = await server({ findings: [high], ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--deep"], { OHMYBUG_URL: s.url, GITHUB_SERVER_URL: "https://ghe.example.com", OHMYBUG_SNAPSHOT: "on", GITHUB_REPOSITORY: "acme/app" }, SNAP);
    assert.equal(r.code, 1, r.log);
    const sub = s.calls.find((c) => c.name === "submit_review");
    assert.deepEqual([sub.args.deep, sub.args.upload, sub.args.meta.repo], [true, true, undefined]);
    assert.deepEqual(s.uploads.map((u) => u.door), ["repo", "payload"]);
  } finally { await s.close() }
});

test("--deep off github.com: the tree is packed before the ticket (a failed pack asks nothing), and the ticket is asked once", async () => {
  const { dir } = changed();
  let s = await server({ ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--deep", "--snapshot"], { OHMYBUG_URL: s.url }, { snapshot: { waitS: 60, minTryMs: 500, maxBytes: 10 } });
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /compressed.*nothing was sent and nothing started/);
    assert.equal(s.calls.length, 0);
  } finally { await s.close() }
  // An open deep ticket counts against the account: an unclear answer is not resent. Mutation: ask it with retries -> 2 calls.
  s = await server({ faults: { submit_review: 503 }, ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--deep", "--snapshot", "--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.notEqual(r.code, 0, r.log);
    assert.deepEqual(JSON.parse(r.out).upload_ticket, { review_id: null, state: "unknown" });
    assert.equal(s.deletes.length, 0);
    assert.match(r.log, /A deep upload ticket may have been opened: if so, it counts as one running review/);
    assert.doesNotMatch(r.log, /A hunt may have started/);
    assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 1);
    assert.deepEqual(s.uploads, []);
  } finally { await s.close() }
});

test("--deep off github.com is opt-in: without --snapshot or OHMYBUG_SNAPSHOT=on it refuses, names the flag and sends nothing", async () => {
  assert.equal(typeof parseArgs(["--snapshot"]), "string");
  assert.equal(parseArgs(["--deep", "--snapshot"]).snapshot, true);
  const { dir } = changed();
  const s = await server({ findings: [high], ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--deep"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /--deep cannot run: no GitHub repository.*ohmybug --deep --snapshot \(or set OHMYBUG_SNAPSHOT=on\).*nothing was sent and nothing started/);
    const bad = await cli(dir, ["--deep"], { OHMYBUG_URL: s.url, OHMYBUG_SNAPSHOT: "yes" }, SNAP);
    assert.equal(bad.code, 2, bad.log);
    assert.match(bad.log, /OHMYBUG_SNAPSHOT must be off, on or unset/);
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.uploads, []);
  } finally { await s.close() }
});

// The #3676 table: every stop after a deep ticket's answer names the ticket, retires it when no hunt can have started,
// and says one of retired / open / gone. Each row: the server, the expected sentence and JSON, and how many DELETEs.
const DEEP = ["--deep", "--snapshot", "--format", "json"];
const RETIRED = /The upload ticket \(review rev_test\) was retired: nothing runs, nothing is charged/;
const OPEN = /The upload ticket( \(review rev_test\))? is still open and could not be retired from here: it counts as one running review/;
const GONE = /The upload ticket \(review rev_test\) is used or expired; this run started nothing on it/;
test("--deep --snapshot: every stop after the ticket's answer retires or names the ticket (#3676 table)", { skip: !hasTar && "no tar" }, async () => {
  const rows = [
    // G3 (M1): the payload door refuses after the snapshot landed. Mutation: the catch ends before the payload.
    ["payload 400, DELETE retires", { snapshot: "required", payload: [400], del: "retired" }, RETIRED, { review_id: "rev_test", state: "retired" }, 1],
    // G3 on a server without DELETE (prod before #3670): any answer but 200 + retired is open.
    ["payload 400, DELETE 404", { snapshot: "required", payload: [400] }, OPEN, { review_id: "rev_test", state: "open" }, 1],
    ["payload 400, DELETE 200 without retired", { snapshot: "required", payload: [400], del: 200 }, OPEN, { review_id: "rev_test", state: "open" }, 1],
    // D4: no snapshot ask. D3: no review id (DELETE tried; open here, named without an id).
    ["no snapshot ask", { del: "retired" }, RETIRED, { review_id: "rev_test", state: "retired" }, 1],
    ["no review id", { snapshot: "required", noId: true }, /The upload ticket is still open/, { review_id: null, state: "open" }, 1],
    // E4: the snapshot door refuses. E5 and G4: a door says the ticket is gone, so no DELETE.
    ["snapshot 413", { snapshot: "required", repo: [413], del: "retired" }, RETIRED, { review_id: "rev_test", state: "retired" }, 1],
    ["snapshot 404", { snapshot: "required", repo: [404] }, GONE, { review_id: "rev_test", state: "gone" }, 0],
    ["payload 410", { snapshot: "required", payload: [410] }, GONE, { review_id: "rev_test", state: "gone" }, 0],
    // #3688: the service's own capacity 503 (its code) started nothing: retired, not "may have started", sent once.
    ["payload 503 deep_at_capacity", { snapshot: "required", payload: [503], retryAfter: "120", del: "retired",
      body: { payload: JSON.stringify({ error: "the deep hunt is at capacity right now", code: "deep_at_capacity" }) } }, RETIRED, { review_id: "rev_test", state: "retired" }, 1],
    // #3722: the same answer whose retire fails leaves the ticket open, and still says nothing started.
    ["payload 503 deep_at_capacity, DELETE 404", { snapshot: "required", payload: [503], retryAfter: "120",
      body: { payload: JSON.stringify({ error: "the deep hunt is at capacity right now", code: "deep_at_capacity" }) } }, OPEN, { review_id: "rev_test", state: "open" }, 1],
    // D2: an address on another host is never called, not even to retire it.
    ["address on another host", { snapshot: "required", url: "https://elsewhere.example/u/tok" }, OPEN, { review_id: "rev_test", state: "open" }, 0],
  ];
  const { dir } = changed();
  for (const [name, ticket, sentence, state, deletes] of rows) {
    const s = await server({ findings: [high], ticket });
    try {
      const r = await cli(dir, DEEP, { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 2, `${name}: ${r.log}`);
      assert.match(r.log, sentence, name);
      assert.equal(r.log.match(/The upload ticket/g).length, 1, `${name}: exactly one ticket sentence`);
      assert.doesNotMatch(r.log, /deep slot/, name);
      assert.doesNotMatch(r.log, /may have started/, name)
      if (name.includes("deep_at_capacity")) {
        assert.match(r.log, /every deep-hunt slot is busy right now and nothing started: run it again in a few minutes/)
        assert.equal(r.log.match(/charged/g).length, 1, `${name}: one word on charging, the ticket sentence's`)
        assert.equal(s.uploads.filter((u) => u.door === "payload").length, 1, name)
        // #3722: the code reaches the JSON; the service's words (for a client that resends) do not.
        assert.equal(JSON.parse(r.out).error.code, "deep_at_capacity", name)
        assert.doesNotMatch(r.log + r.out, /at capacity right now/, name)
      }
      const j = JSON.parse(r.out);
      assert.deepEqual([j.outcome, j.upload_ticket], ["not_run", state], name);
      assert.equal(s.deletes.length, deletes, name);
      if (deletes) assert.equal(s.deletes[0], "/u/tok-secret", name);
    } finally { await s.close() }
  }
});

test("--deep --snapshot: a retire that hangs costs one short try and leaves the ticket open", { skip: !hasTar && "no tar" }, async () => {
  const { dir } = changed();
  const s = await server({ ticket: { snapshot: "required", payload: [400], del: "hang" } });
  try {
    const t0 = Date.now();
    const r = await cli(dir, DEEP, { OHMYBUG_URL: s.url }, { snapshot: { ...SNAP.snapshot, retireMs: 300 } });
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, OPEN);
    assert.equal(s.deletes.length, 1);
    assert.match(r.log, /the upload ticket was not retired \(/);
    assert.ok(Date.now() - t0 < 5_000);
  } finally { await s.close() }
});

test("--deep --snapshot: a hunt that may have started is named, never retired, and the diff is never sent twice", { skip: !hasTar && "no tar" }, async () => {
  const { dir } = changed();
  // G7: a proxy's 502 or a reset at the payload: a hunt may run. Mutation: retire it, or call it "not started".
  // A 502, a 503 or a reset at the diff upload: a hunt may have started, so the diff is not sent again.
  for (const payload of [[502], [503], ["reset"]]) {
    const s = await server({ ticket: { snapshot: "required", payload, del: "retired", body: payload[0] !== "reset" ? { payload: "<html>bad gateway</html>" } : undefined } });
    try {
      const r = await cli(dir, DEEP, { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 2, r.log);
      assert.match(r.log, /A hunt may have started: see https:\/\/app\.ohmybug\.ai\/me \(review rev_test\)/);
      const j = JSON.parse(r.out);
      assert.deepEqual([j.outcome, j.upload_ticket], ["maybe_started", { review_id: "rev_test", state: "unknown" }]);
      assert.equal(s.deletes.length, 0);
      assert.equal(s.uploads.filter((u) => u.door === "payload").length, 1);
    } finally { await s.close() }
  }
  // Any 503, even the service's own JSON one, is sent once (one attempt at the door that starts the hunt).
  const s = await server({ ticket: { snapshot: "required", payload: [503], retryAfter: "1", del: "retired" } });
  try {
    const r = await cli(dir, DEEP, { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 2, r.log);
    assert.equal(s.uploads.filter((u) => u.door === "payload").length, 1);
    assert.equal(s.deletes.length, 0);
    assert.deepEqual(JSON.parse(r.out).upload_ticket, { review_id: "rev_test", state: "unknown" });
  } finally { await s.close() }
});

test("--deep --snapshot: the ticket has its own clock, so a slow ticket leaves the upload its whole time (M2)", { skip: !hasTar && "no tar" }, async () => {
  const { dir } = changed();
  // The ticket answers 429 twice (2 s, then 4 s of backoff: more than the 3 s the snapshot door gets). The door's clock
  // starts at its first try, so the upload still runs. Mutation: one clock over the ticket and the upload -> refused.
  const s = await server({ findings: [high], faults: { submit_review: [429, 429] }, ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, DEEP, { OHMYBUG_URL: s.url }, { snapshot: { waitS: 3, minTryMs: 500, ticketS: 30 } });
    assert.equal(r.code, 1, r.log);
    assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 3);
    assert.deepEqual(s.uploads.map((u) => u.door), ["repo", "payload"]);
  } finally { await s.close() }
});

test("--deep --snapshot: an unclear ticket answer from the tool says a ticket, not a hunt, may be open; the fast payload's 503 is not sent again", { skip: !hasTar && "no tar" }, async () => {
  const { dir } = changed();
  for (const fault of ["garble", "internal", "reset"]) {
    const s = await server({ faults: { submit_review: fault }, ticket: { snapshot: "required" } });
    try {
      const r = await cli(dir, DEEP, { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 2, r.log);
      assert.match(r.log, /A deep upload ticket may have been opened/, fault);
      assert.doesNotMatch(r.log, /A hunt may have started/, fault);
      assert.deepEqual([JSON.parse(r.out).outcome, JSON.parse(r.out).upload_ticket], ["not_run", { review_id: null, state: "unknown" }], fault);
      assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 1, fault);
    } finally { await s.close() }
  }
  // busy503 is the deep payload's only: a fast payload's 503 (even with a JSON error, even with the deep door's capacity
  // code, #3688) may have started a hunt.
  const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", payload: [503], retryAfter: "1",
    body: { payload: JSON.stringify({ error: "at capacity", code: "deep_at_capacity" }) } } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 2, r.log);
    assert.equal(s.uploads.filter((u) => u.door === "payload").length, 1);
    assert.equal(JSON.parse(r.out).outcome, "maybe_started");
  } finally { await s.close() }
});

test("the fast upload path never retires its ticket and keeps its texts", { skip: !hasTar && "no tar" }, async () => {
  const { dir } = changed();
  const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", payload: [400], del: "retired" } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 2, r.log);
    assert.match(r.log, /could not review: HTTP 400 payload refused: see https:\/\/app\.ohmybug\.ai\/me\/policy$/m);
    assert.doesNotMatch(r.log, /upload ticket \(review/);
    assert.equal(s.deletes.length, 0);
    assert.equal(JSON.parse(r.out).upload_ticket, null);
  } finally { await s.close() }
});

test("an upload address ending in / still takes the snapshot at <address>/repo and the diff at the address", async () => {
  const { dir } = changed();
  const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", slash: true } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(s.uploads.map((u) => u.path), ["/u/tok-secret/repo", "/u/tok-secret/"]);
  } finally { await s.close() }
});

test("packTree: a git call that stalls (a blobless clone fetching blobs) ends with the snapshot's clock", async () => {
  const { dir, git } = repo();
  const rev = git("rev-parse", "HEAD^{tree}").trim();
  const bin = mkdtempSync(join(tmpdir(), "omb-git-"));
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "$OMB_SLOW" ] && exec sleep 20; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    for (const [slow, said] of [["ls-tree", /could not list the reviewed tree within 2s/], ["cat-file", /could not pack the repository snapshot within 2s \(git was still reading the blobs\)/]]) {
      process.env.OMB_SLOW = slow;
      const t0 = Date.now();
      const r = await packTree(dir, rev, { maxBytes: 1 << 30, maxUnpacked: 1 << 30, timeoutMs: 2000 });
      assert.match(r.cannot ?? "", said, slow);
      assert.ok(Date.now() - t0 < 10_000, `${slow} took ${Date.now() - t0} ms`);
    }
  } finally { process.env.PATH = path; delete process.env.OMB_SLOW; }
});

test("contextDenied: the snapshot list per path part; only the file's own name may pass, as an exact example or key, or as code named only like a secret", () => {
  const denied = [".env.secrets.js", ".env.credentials.py", "id_rsa_secret.rb", "prod.tfvars.secret.py", "x.tfstate.credentials.js", "secrets.tfvars.py",
    "credentials.tfstate.backup.js", "credentials.json", "secrets.yml", "client_secret.json", "credentials.xml", "secrets.sh", "secrets.sql", "secret",
    "secret.key", "secret.pem", "x.secret.keystore", "secrets.ts.bak", "secrets.ts.enc", "secrets/db.yml", "secrets/manager.ts", "src/secrets.js/index.js",
    "secrets.js/prod.yml", "credentials.go/x.go", "id_rsa.pub/id_rsa", "id_rsa.pub/readme.md", ".env.example/x", "src/.env.example/readme.md",
    ".env.secret/app.ts", ".git-credentials/helper.go", "a/.ssh/keys.go", ".kube/secrets.go", "kubeconfig/a.go", ".Docker/config.json", ".aws/config",
    ".env", ".envrc", ".env.example.bak", ".env.examples", ".env.local.example", ".env.js", ".env.example.js", ".env.example.ts", "id_rsa",
    "id_rsa.pub.bak", "id_rsa.ts", "id_rsa.pub.ts", "id_ed25519_sk", "id_ed25519_sk.pub", ".npmrc", ".git-credentials", "kubeconfig", "server.pem", "tls.key",
    "kubeconfig.yaml", "app.env", "example.env", "prod-kubeconfig.yaml", "kube_config_x.yml", "Kubeconfig.GO", "prod.env-local", "app.env_backup"];
  const allowed = ["secrets.ts", "src/Secrets.ts", "lib/credentials.go", "SECRETS.TS", "secrets.d.ts", "secrets.json.js", "src/auth/secretManager.test.ts",
    "src/credential_store.py", "secretsecret.go", "secsecretret.go", "id_secretrsa.ts", "secret.key.go", "secrets.pem.js", "x.keystore.secret.java",
    "kubeconfig.secret.go", ".git-credentials.js", ".npmrc.secret.js", ".env.example", ".ENV.Sample", ".env.template", ".env.dist", "id_rsa.pub",
    "ID_ED25519.PUB", "k/id_dsa.pub", "k/id_ecdsa.pub", "my.npmrc", ".dockerignore", "server.pem.ts",
    "tls.key.ts", "app.js", "kubeconfig-loader.ts", "config.env.ts", "pkg/kubeconfig-loader/README.md", "app.envoy.yaml", "prod.environment.yaml"];
  for (const p of denied) assert.equal(contextDenied(p), true, p);
  for (const p of allowed) assert.equal(contextDenied(p), false, p);
});

test("fileReader: secrets and credential stores are never read, in any case; code named like secrets, examples and public keys are", () => {
  const { dir, git } = repo();
  const out = [".env", "web/.env.local", ".envrc", ".env.example.bak", "Prod.PEM", "c.p12", "cert.pfx", "tls.key", "k.ppk", "a.jks", "b.keystore",
    "id_rsa", "id_dsa", "id_ecdsa", "k/ID_ED25519", "k2/id_ed25519_sk", "id_rsa.bak", ".npmrc", ".git-credentials", ".netrc", ".pgpass", ".pypirc",
    "kubeconfig", ".aws/config", ".kube/config", ".docker/config.json", ".ssh/known_hosts", ".gnupg/x", "infra/x.tfstate", "v.tfvars.json",
    // Secret-named data files and folders stay out; only source code named like secrets is context.
    "a/credentials.json", "secrets.yml", "client_secret.json", "secrets/db.yml", "secrets/manager.ts", "prod-credentials/x.js", "id_rsa.pub.bak", "app.env", "k8s/prod-kubeconfig.yaml"];
  const kept = [".env.example", ".env.sample", "w/.env.template", "w2/.env.DIST", "src/Secrets.ts", "lib/credentials.go", "id_rsa.pub",
    "k3/ID_ED25519.PUB", "conf.js", "my.npmrc", ".dockerignore", "src/kubeconfig-loader.ts"];
  for (const p of [...out, ...kept]) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), "x\n"); }
  git("add", ".");
  git("commit", "-qm", "secrets");
  const read = fileReader({ all: [...out, ...kept], rev: git("rev-parse", "HEAD").trim() }, (...a) => execFileSync("git", ["-C", dir, ...a]));
  for (const p of out) assert.equal(read(p), null, p);
  for (const p of kept) assert.equal(read(p), "x\n", p);
  // Beside a snapshot the reader takes the snapshot's list: the context-only names are not read either.
  const beside = fileReader({ all: [...out, ...kept], rev: git("rev-parse", "HEAD").trim() }, (...a) => execFileSync("git", ["-C", dir, ...a]), snapshotDenied);
  for (const p of [".env.example", "src/Secrets.ts", "lib/credentials.go", "id_rsa.pub", "app.env"]) assert.equal(beside(p), null, p);
  assert.equal(beside("conf.js"), "x\n");
  assert.equal(beside("src/kubeconfig-loader.ts"), "x\n");
});

test("--uncommitted: the snapshot is the working tree with untracked files, never ignored ones, and the index is untouched", { skip: !hasTar && "no tar" }, async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, ".gitignore"), ".env\nnode_modules/\n");
  git("add", ".gitignore");
  git("commit", "-qm", "ignore");
  writeFileSync(join(dir, "app.js"), "export const a = 5\n");
  writeFileSync(join(dir, "new.js"), "export const b = 1\n");
  writeFileSync(join(dir, ".env"), "TOKEN=x\n");
  mkdirSync(join(dir, "node_modules", "m"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "m", "i.js"), "x\n");
  const index = git("ls-files", "-s");
  const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--uncommitted"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(tarNames(s.uploads[0].body), [".gitignore", "app.js", "new.js"]);
    assert.equal(git("ls-files", "-s"), index);
  } finally { await s.close() }
});

test("a ticket that does not say required (off, absent, unknown) gets the diff alone; a pack that cannot go stops only a required ticket", async () => {
  const { dir } = changed();
  for (const snapshot of ["off", undefined, "maybe"]) {
    const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot } });
    try {
      const r = await cli(dir, ["--mode", "fast"], { OHMYBUG_URL: s.url }, { snapshot: { ...SNAP.snapshot, maxBytes: 10 } });
      assert.equal(r.code, 0, `${snapshot}: ${r.log}`);
      assert.deepEqual(s.uploads.map((u) => u.door), ["payload"], String(snapshot));
      assert.equal(s.calls.filter((c) => c.name === "submit_review")[1].args.mode, "fast");
      assert.doesNotMatch(r.log, /uploading the repository snapshot/);
    } finally { await s.close() }
  }
  const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, { snapshot: { ...SNAP.snapshot, maxBytes: 10 } });
    assert.equal(r.code, 2);
    assert.match(r.log, /over 1 MiB compressed, the most the service takes; no snapshot was sent, nothing started, and the upload ticket expires unused/);
    assert.equal(s.uploads.length, 0);
    const j = JSON.parse(r.out);
    assert.deepEqual([j.outcome, j.error.code], ["not_run", null]);
  } finally { await s.close() }
});

test("the upload address is a capability: another host, none, or no review id stops with nothing sent, and the address is never printed", async () => {
  const { dir } = changed();
  for (const ticket of [{ snapshot: "required", url: "https://elsewhere.example/u/tok-secret" }, { snapshot: "required", url: null }, { snapshot: "required", noId: true }]) {
    const s = await server({ faults: NEEDS_SNAPSHOT(), ticket });
    try {
      const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 2, JSON.stringify(ticket));
      assert.equal(s.uploads.length, 0);
      assert.doesNotMatch(r.log + r.out, /tok-secret/);
      assert.equal(JSON.parse(r.out).outcome, "not_run");
    } finally { await s.close() }
  }
});

test("the snapshot door: a 409 is our earlier try only after a try that may have arrived (5xx, reset), never after a 429 or a 408", async () => {
  const { dir } = changed();
  for (const repo of [[500, 409], ["reset", 409]]) {
    const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", repo } });
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 0, `${repo}: ${r.log}`);
      assert.deepEqual(s.uploads.map((u) => u.door), ["repo", "repo", "payload"]);
      assert.match(r.log, /arrived on an earlier try/);
    } finally { await s.close() }
  }
  for (const repo of [[409], [429, 409], [408, 409]]) {
    const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", repo } });
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 2, String(repo));
      assert.match(r.log, /already holds a snapshot this run did not send; nothing was started/);
      assert.ok(!s.uploads.some((u) => u.door === "payload"));
    } finally { await s.close() }
  }
});

test("the snapshot door: a refusal stops before the diff, cleaned and capped; a JSON body from /mcp is not read as a door's", async () => {
  const { dir } = changed();
  for (const st of [413, 400, 404, 410, 401]) {
    const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", repo: [st] } });
    try {
      const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 2, String(st));
      assert.match(r.log, new RegExp(`HTTP ${st} repo refused`));
      assert.doesNotMatch(r.log, /API key was refused/);
      assert.deepEqual(s.uploads.map((u) => u.door), ["repo"]);
      assert.equal(JSON.parse(r.out).outcome, "not_run");
    } finally { await s.close() }
  }
  let s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", repo: [413], body: { repo: JSON.stringify({ error: `big\u001b[2J\u009b2J${"x".repeat(5000)}` }) } } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
    assert.doesNotMatch(r.log, /[\u001b\u009b]/);
    assert.match(r.log, /HTTP 413 big \[2J 2Jx{100}/);
    assert.ok(!r.log.includes("x".repeat(300)));
  } finally { await s.close() }
  s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", repo: [413], body: { repo: `<p>\u001b[31m${"y".repeat(1000)}` } } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
    assert.doesNotMatch(r.log, /\u001b/);
    assert.ok(!r.log.includes("y".repeat(300)));
  } finally { await s.close() }
  // A redirect from the snapshot door is a refusal: the tree never goes to the host it names.
  const other = await server();
  s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", repo: [`${other.url}/u/steal/repo`] } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 2);
    assert.match(r.log, /the snapshot upload was redirected, and a redirect is not followed; nothing was started/);
    assert.equal(other.uploads.length, 0);
    assert.deepEqual(s.uploads.map((u) => u.door), ["repo"]);
  } finally { await s.close(); await other.close() }
  // An HTTP refusal on /mcp whose body happens to be JSON with a code is not the service's snapshot_required.
  s = await server({ submitStatus: 400, submitBody: JSON.stringify({ error: "x", code: "snapshot_required" }), ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 2);
    assert.equal(s.uploads.length, 0);
    assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 1);
  } finally { await s.close() }
});

test("a snapshot that never lands stops on its own clock with a snapshot refusal, and never starts a try with too little left", async () => {
  const { dir } = changed();
  const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", repo: Array(50).fill(503) } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, { snapshot: { waitS: 5, minTryMs: 1000 } });
    assert.equal(r.code, 2);
    assert.match(r.log, /the repository snapshot did not finish uploading on the snapshot's clock of 5s \(last: HTTP 503\); nothing was started/);
    assert.doesNotMatch(r.log, /no result within/);
    assert.ok(s.uploads.length <= 3, String(s.uploads.length));
    assert.equal(JSON.parse(r.out).outcome, "not_run");
  } finally { await s.close() }
  // A 429 with no Retry-After (or a shorter one) is the client's backoff running out, not the door's ask; a longer one is.
  for (const [retryAfter, want] of [[undefined, /did not finish uploading on the snapshot's clock of 5s \(last: HTTP 429\)/], ["1", /did not finish uploading on the snapshot's clock of 5s \(last: HTTP 429\)/], ["3600", /the snapshot door asks to wait 3600s, more than the snapshot's clock leaves \(last: HTTP 429\)/]]) {
    const t = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", repo: Array(50).fill(429), retryAfter } });
    try {
      const r = await cli(dir, [], { OHMYBUG_URL: t.url }, { snapshot: { waitS: 5, minTryMs: 1000 } });
      assert.equal(r.code, 2, r.log);
      assert.match(r.log, want, String(retryAfter));
      assert.equal(/door asks to wait/.test(r.log), retryAfter === "3600", String(retryAfter));
    } finally { await t.close() }
  }
});

test("the hunt's clock is paused while the snapshot goes: a slow upload does not leave the hunt too little time", async () => {
  const { dir } = changed();
  const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", delayMs: 12_000 } });
  try {
    // 30 s for the review: without the pause, the 12 s snapshot would leave under POLL_ROOM (20 s) to start the hunt.
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "30" }, SNAP);
    assert.equal(r.code, 0, r.log);
    assert.doesNotMatch(r.log, /too little of OHMYBUG_TIMEOUT_S/);
  } finally { await s.close() }
});

test("after the snapshot the hunt has its own time left, not what is left of the snapshot's clock", async () => {
  const { dir } = changed();
  const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required" }, huntMs: 4000 });
  try {
    // A 2 s snapshot clock: a hunt that kept it would end before the 4 s the review runs.
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_TIMEOUT_S: "40" }, { snapshot: { waitS: 2, minTryMs: 100 } });
    assert.equal(r.code, 0, r.log);
    assert.ok(s.calls.filter((c) => c.name === "wait_review").length >= 2);
  } finally { await s.close() }
});

test("the ticket starts nothing and is retried; the diff upload starts the hunt: sent once, an unclear answer names the review", async () => {
  const { dir } = changed();
  let s = await server({ faults: { submit_review: [NEEDS_SNAPSHOT().submit_review, 503] }, ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 0, r.log);
    assert.equal(s.calls.filter((c) => c.name === "submit_review").length, 3);
    assert.doesNotMatch(r.log, /may have started/);
  } finally { await s.close() }
  for (const payload of [[500], ["reset"]]) {
    s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", payload } });
    try {
      const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 2, String(payload));
      assert.equal(s.uploads.filter((u) => u.door === "payload").length, 1);
      assert.match(r.log, /A hunt may have started: see https:\/\/app\.ohmybug\.ai\/me \(review rev_test\)/);
      assert.equal(JSON.parse(r.out).outcome, "maybe_started");
    } finally { await s.close() }
  }
  s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", body: { payload: "<html>gateway</html>" } } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 2);
    assert.match(r.log, /answered unclearly .*\(review rev_test\)/);
    assert.equal(JSON.parse(r.out).outcome, "maybe_started");
  } finally { await s.close() }
  s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", payload: [429] } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 0, r.log);
    assert.equal(s.uploads.filter((u) => u.door === "payload").length, 2);
  } finally { await s.close() }
});

test("the diff upload: a refusal is final and not_run with its code; the same payload already hunted is followed", async () => {
  const { dir } = changed();
  for (const st of [409, 404, 410, 401, 403]) {
    const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "off", payload: [st] } });
    try {
      const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 2, String(st));
      const j = JSON.parse(r.out);
      assert.deepEqual([j.outcome, j.error.code], ["not_run", st === 409 ? "snapshot_required" : null]);
      assert.deepEqual(s.uploads.map((u) => u.door), ["payload"]);
      assert.doesNotMatch(r.log, /may still be running|may have started|API key was refused/);
      assert.match(r.log, new RegExp(`HTTP ${st} payload refused`));
    } finally { await s.close() }
  }
  // The followed review's answer carries no link: the ticket's link, for the ticket's own review, is not shown for it.
  const bare = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "off", live: "https://example.test/live/ticket", body: { payload: JSON.stringify({ ok: true, review_id: "rev_other", status: "running" }) } } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: bare.url }, SNAP);
    assert.equal(r.code, 0, r.log);
    assert.doesNotMatch(r.log + r.out, /live\/ticket/);
  } finally { await bare.close() }
  const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "off", payloadId: "rev_other" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /already being hunted as review rev_other: following it/);
    assert.equal(s.calls.find((c) => c.name === "wait_review").args.review_id, "rev_other");
  } finally { await s.close() }
});

test("a diff resent after a refused GitHub read takes the snapshot path; a GitHub submit refused with snapshot_required uploads nothing", async () => {
  const dir = routedRepo();
  let s = await server({ faults: { submit_review: [{ error: "diff_required", message: "no app" }, NEEDS_SNAPSHOT().submit_review] }, ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(s.calls.filter((c) => c.name === "submit_review").map((c) => [!!c.args.meta?.repo, !!c.args.diff, !!c.args.upload]), [[true, false, false], [false, true, false], [false, false, true]]);
    assert.deepEqual(s.uploads.map((u) => u.door), ["repo", "payload"]);
  } finally { await s.close() }
  s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 2);
    assert.equal(s.uploads.length, 0);
  } finally { await s.close() }
});

test("OHMYBUG_SNAPSHOT=off: a ticket that asks for the snapshot stops with nothing sent; a diff-only ticket still goes; another value is refused", async () => {
  const { dir } = changed();
  let s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required" } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url, OHMYBUG_SNAPSHOT: "off" }, SNAP);
    assert.equal(r.code, 2);
    assert.match(r.log, /OHMYBUG_SNAPSHOT=off keeps it on this machine; no snapshot was sent, nothing started/);
    assert.equal(s.uploads.length, 0);
    assert.equal(JSON.parse(r.out).outcome, "not_run");
  } finally { await s.close() }
  s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "off" } });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url, OHMYBUG_SNAPSHOT: "off" }, SNAP);
    assert.equal(r.code, 0, r.log);
    assert.deepEqual(s.uploads.map((u) => u.door), ["payload"]);
  } finally { await s.close() }
  const r = await cli(dir, [], { OHMYBUG_SNAPSHOT: "0" });
  assert.equal(r.code, 2);
  assert.match(r.log, /OHMYBUG_SNAPSHOT must be off, on or unset, not 0/);
});

test("a review that uploads a snapshot leaves out of its files whatever the snapshot leaves out, sent with the diff or on request", async () => {
  const { dir, git } = repo();
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  for (const p of ["src/secrets.ts", ".env.example", "id_rsa.pub", "lib.js"]) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), `// ${p}\n`); }
  git("add", ".");
  git("commit", "-qm", "secret-named");
  const s = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required" }, requested: ["src/secrets.ts", ".env.example", "id_rsa.pub", "lib.js"] });
  try {
    const r = await cli(dir, [], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 0, r.log);
    const first = s.calls.find((c) => c.name === "submit_review").args.files.map((f) => f.path);
    assert.ok(first.includes("src/secrets.ts"), "the diff-only try sends it");
    const sent = JSON.parse(s.uploads.find((u) => u.door === "payload").body).files.map((f) => f.path);
    for (const p of ["src/secrets.ts", ".env.example", "id_rsa.pub"]) assert.ok(!sent.includes(p), `${p}: ${sent.join(",")}`);
    if (hasTar) assert.ok(!tarNames(s.uploads.find((u) => u.door === "repo").body).includes("src/secrets.ts"));
    assert.deepEqual(s.posted[0].files.map((f) => f.path), ["lib.js"]);
  } finally { await s.close() }
  // A ticket that takes the diff alone keeps those files beside it.
  const off = await server({ faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "off" }, requested: ["src/secrets.ts", "lib.js"] });
  try {
    assert.equal((await cli(dir, [], { OHMYBUG_URL: off.url }, SNAP)).code, 0);
    const sent = JSON.parse(off.uploads.find((u) => u.door === "payload").body).files.map((f) => f.path);
    assert.ok(sent.includes("src/secrets.ts"), sent.join(","));
    assert.deepEqual(off.posted[0].files.map((f) => f.path), ["src/secrets.ts", "lib.js"]);
  } finally { await off.close() }
});

test("the README budget names the snapshot's 15 minutes", () => {
  const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
  assert.match(readme, /plus 15 minutes when the run uploads a repository snapshot/);
});

test("--deep --snapshot: the capacity code on a status other than 503 may have started a hunt (#3722)", { skip: !hasTar && "no tar" }, async () => {
  const { dir } = changed();
  const s = await server({ findings: [high], ticket: { snapshot: "required", payload: [502], del: "retired",
    body: { payload: JSON.stringify({ error: "bad gateway", code: "deep_at_capacity" }) } } });
  try {
    const r = await cli(dir, DEEP, { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 2, r.log);
    assert.equal(JSON.parse(r.out).outcome, "maybe_started");
    assert.match(r.log, /may have started/);
    assert.equal(s.deletes.length, 0, "a hunt may run: the ticket is not retired");
    assert.equal(s.uploads.filter((u) => u.door === "payload").length, 1);
  } finally { await s.close() }
});


// ---- The partial copy (OhMyBug#3856): the plugin's omb_paths.py rule, its test rows ported -----------------------

/** A repository with a base commit and a head commit, written by `base` and `head` (path -> text or Buffer). */
function twoCommits(base, head, remove = [], rename = []) {
  const dir = mkdtempSync(join(tmpdir(), "ohmybug-partial-"));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20 });
  const w = (files) => { for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), c); } };
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  w(base); git("add", "-A"); git("commit", "-qm", "base");
  w(head);
  for (const p of remove) rmSync(join(dir, p));
  for (const [a, b] of rename) git("mv", a, b);
  git("add", "-A"); git("commit", "-qm", "head");
  return { dir, git };
}
/** The list for HEAD~1..HEAD, in rank order, as selectChange and packTree would feed it. */
async function partialOf(dir, limits, selectEnv = {}) {
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { maxBuffer: 256 << 20 });
  const range = ["HEAD~1", "HEAD"];
  const rev = git("rev-parse", "HEAD^{tree}").toString().trim();
  const changed = git("diff", ...range, "--name-only", "--diff-filter=d", "-z").toString().split("\0").filter(Boolean);
  const files = [];
  const ls = git("ls-tree", "-r", "-l", "-z", rev);
  for (let at = 0; at < ls.length;) {
    let end = ls.indexOf(0, at); if (end < 0) end = ls.length;
    const rec = ls.subarray(at, end); at = end + 1;
    if (!rec.length) continue;
    const tab = rec.indexOf(9);
    const [mode, type, oid, size] = rec.subarray(0, tab).toString().trim().split(/\s+/);
    const path = rec.subarray(tab + 1);
    if (type === "blob" && !snapshotDenied(path.toString())) files.push({ mode, oid, size: Number(size), path });
  }
  const diff = git("diff", ...range, "--no-color", "--no-ext-diff", "--no-textconv").toString();
  const saved = Object.fromEntries(Object.keys(selectEnv).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(selectEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  let r;
  try { r = await selectPartial(dir, diff, rev, changed, files, Date.now() + 60_000, limits); }
  finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return { list: [...r.keep].map((k) => Buffer.from(k, "latin1").toString()).join(" "), stats: r.stats };
}

test("partial: the rule's constants equal the written-out copy (the plugin's omb_paths.py, the service's own rule)", () => {
  assert.deepEqual(PARTIAL, { changed: 60, callers: 20, bytes: 16 * 1024 * 1024, file: 4 << 20, names: 40, perName: 8, nulScan: 8000 });
  assert.deepEqual(PARTIAL_SEARCH, { files: 200000, bytes: 512 * 1024 * 1024 });
  assert.equal(OS_MANIFEST.source, String.raw`^(package\.json|.*\.gemspec|Gemfile|pyproject\.toml|setup\.py|setup\.cfg|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|composer\.json|requirements\.txt|tsconfig\.json)$`);
  assert.equal(OS_SKIP.source, String.raw`(^|\/)(node_modules|vendor|third_party|dist|build|\.yarn)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock|Gemfile\.lock|uv\.lock|Pipfile\.lock|bun\.lockb?)$|\.(min\.js|min\.css|map|png|jpe?g|gif|ico|svg|webp|pdf|zip|gz|jar|woff2?|ttf|eot|mp4|mp3|lock|snap)$|_pb2\.py$|\.pb\.go$`);
  assert.equal(OS_DOC1.source + "/" + OS_DOC1.flags, String.raw`\.(md|mdx|rst|txt|adoc)$|(^|\/)(licen[cs]e|changelog|notice)$/i`);
  assert.equal(OS_DOC2.source + "/" + OS_DOC2.flags, String.raw`(^|\/)(LICEN[CS]E|CHANGELOG|NOTICE)([-_.][^/]*)?$/`);
  assert.equal(NAME.source, String.raw`(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]{3,})\s*\(|(?:def|function|class|interface|fn|func|fun)\s+([A-Za-z_][A-Za-z0-9_]{3,})`);
  assert.deepEqual([...OS_KW].sort(), `self this that true false null none None True False return const function class import from export default async await
while for else elif then case break continue public private protected static final void string number boolean object print
length value values items index error errors result results data type name test tests assert expect equal should params props`.split(/\s+/).sort());
});

test("partial L2: four fixtures give the service rule's lists, in its order (the plugin's reference lists)", async () => {
  // A: ranking. Names in 1 to 9 files, keywords, short names, skipped and doc paths, more than 20 callers.
  const a = {
    "package.json": '{"name": "a", "main": "alpha_one"}\n', "src/app/pyproject.toml": "[x]\nalpha_one = 1\n", "src/setup.cfg": "[x]\n",
    "other/Cargo.toml": "[x]\n", "src/app/main.py": "def main():\n    pass\n",
    "node_modules/dep/alpha_one.js": "alpha_one()\n", "vendor/x/beta.go": "beta_two()\n", "dist/app.min.js": "gamma_three()\n",
    "docs/guide.md": "gamma_three()\n", "CHANGELOG": "gamma_three()\n", "LICENSE-MIT": "gamma_three()\n",
    "lib/shared.py": "alpha_one(); beta_two(); epsilon_five()\n", "lib/upper.py": "ALPHA_ONE()\n", "lib/partword.py": "xalpha_one(); alpha_one_x()\n",
  };
  for (const [name, n] of [["alpha_one", 2], ["beta_two", 3], ["gamma_three", 1], ["DeltaFour", 8], ["common_nine", 9], ["epsilon_five", 4], ["zeta_six", 5],
    ["eta_seven", 6], ["theta_eight", 7], ["iota_ten", 3], ["kappa_x", 2], ["lambda_y", 3]]) for (let j = 0; j < n; j++) a[`lib/${name}/f${j}.py`] = `from x import ${name}\n${name}(1)\n`;
  const ra = twoCommits(a, {
    "src/app/main.py": "def main():\n    pass\n" + ["alpha_one", "beta_two", "common_nine", "epsilon_five", "zeta_six", "eta_seven", "theta_eight",
      "iota_ten", "kappa_x", "lambda_y", "print", "return", "ab", "values", "self.result"].map((n) => `    ${n}(1)\n`).join("") + "def gamma_three():\n    pass\nclass DeltaFour:\n    pass\n",
    "src/app/new_mod.py": "def brand_new():\n    alpha_one (2)\n",
  });
  // B: caps. A changed file over 4 MiB, a caller with a NUL byte, callers past 16 MiB together, a small one that still fits.
  const b = { "big.py": "x = 1\n", "mod.py": "pass\n", "c1_nul.py": Buffer.from("\0binary_name_here()\n"), "c7_small.py": "big_caller_name()\nbinary_name_here()\n", "c8_exact.py": "edge_name_four()\n" };
  for (let i = 0; i < 5; i++) b[`c${i + 2}_big.py`] = "big_caller_name()\n" + "#".repeat(3900 * 1024) + "\n";
  const rb = twoCommits(b, { "big.py": "x = 2\n" + "#".repeat(4 * 1024 * 1024) + "\n", "mod.py": "pass\nbig_caller_name()\nbinary_name_here()\nedge_name_four()\n" });
  // C: folders. 62 changed files (60 count), nested manifests, a changed manifest, a deletion and a rename.
  const c = { "Gemfile": "x\n", "a/package.json": "{}\n", "a/b/go.mod": "x\n", "a/b/c/foo.gemspec": "x\n", "a/b/c/requirements.txt": "x\n", "a/b/c/setup.py": "x\n",
    "a/b/c/x.py": "x\n", "a/y.go": "x\n", "d/pom.xml": "x\n", "d/old_name.py": Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n", "gone.py": "x\n",
    "z/build.gradle.kts": "x\n", "q/user.py": "deep_helper_name()\n" };
  const ch = { "a/b/c/x.py": "x\ndeep_helper_name()\n", "a/b/c/setup.py": "y\n", "a/y.go": "y\n" };
  for (let i = 0; i < 62; i++) { const p = `z/f${String(i).padStart(2, "0")}.py`; c[p] = "x\n"; ch[p] = "y\n"; }
  const rc = twoCommits(c, ch, ["gone.py"], [["d/old_name.py", "d/new_name.py"]]);
  // D: more than 40 names of many lengths: the 40 longest are searched. A changed git-lfs pointer is left out.
  const names = Array.from({ length: 48 }, (_, i) => `n${"x".repeat(i % 9)}_${i}`);
  const d = { "m.py": "pass\n", "asset.bin": `version https://git-lfs.github.com/spec/v1\\noid sha256:${"0".repeat(64)}\\nsize 10\\n` };
  names.forEach((n, i) => { d[`u/f${String(i).padStart(2, "0")}.py`] = `${n}()\n`; });
  const rd = twoCommits(d, { "m.py": "pass\n" + names.map((n) => `${n}(1)\n`).join(""), "asset.bin": `version https://git-lfs.github.com/spec/v1\noid sha256:${"1".repeat(64)}\nsize 11\n` });
  const want = {
    a: "src/app/main.py src/app/new_mod.py src/app/pyproject.toml src/setup.cfg package.json lib/gamma_three/f0.py lib/shared.py lib/kappa_x/f0.py lib/kappa_x/f1.py lib/iota_ten/f0.py lib/iota_ten/f1.py lib/iota_ten/f2.py lib/lambda_y/f0.py lib/lambda_y/f1.py lib/lambda_y/f2.py lib/beta_two/f0.py lib/beta_two/f1.py lib/beta_two/f2.py lib/alpha_one/f0.py lib/alpha_one/f1.py lib/epsilon_five/f0.py lib/epsilon_five/f1.py lib/epsilon_five/f2.py lib/epsilon_five/f3.py lib/zeta_six/f0.py",
    b: "mod.py c7_small.py c8_exact.py c2_big.py c3_big.py c4_big.py c5_big.py",
    c: "a/b/c/setup.py a/b/c/x.py a/y.go d/new_name.py " + Array.from({ length: 56 }, (_, i) => `z/f${String(i).padStart(2, "0")}.py`).join(" ") + " a/package.json Gemfile a/b/c/foo.gemspec a/b/c/requirements.txt a/b/go.mod d/pom.xml z/build.gradle.kts q/user.py",
    d: "m.py u/f03.py u/f04.py u/f05.py u/f06.py u/f07.py u/f08.py u/f10.py u/f11.py u/f12.py u/f13.py u/f14.py u/f15.py u/f16.py u/f17.py u/f19.py u/f20.py u/f21.py u/f22.py u/f23.py u/f24.py",
  };
  for (const [k, r] of Object.entries({ a: ra, b: rb, c: rc, d: rd })) assert.equal((await partialOf(r.dir)).list, want[k], `fixture ${k}`);
});

test("partial L1: an added line whose text starts with '++' gives a name; a context line that looks like a header does not", async () => {
  const { dir } = twoCommits({ "m.py": "x = 1\n+++ fake_name_here()\n", "u1.py": "call_me_now()\n", "u2.py": "fake_name_here()\n" }, { "m.py": "x = 1\n+++ fake_name_here()\n++ call_me_now()\n" });
  assert.equal((await partialOf(dir)).list, "m.py u1.py");
  assert.deepEqual(addedNames(Buffer.from("diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/fake_header_name(x).py\n@@ -1,0 +2,3 @@\n++ call_me_now()\n+def made_here(): pass\n+print(x)\n-gone_name_here()\n")), ["call_me_now", "made_here"]);
});

test("partial L4: a NUL by byte 8000 is binary, past it is not; 4 MiB kept, one byte over skipped", async () => {
  const { dir } = twoCommits({ "m.py": "pass\n", "early.py": Buffer.concat([Buffer.alloc(7999, 0x61), Buffer.from("\0\nnul_name_here()\n")]),
    "late.py": Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from("\0\nnul_name_here()\n")]) },
  { "m.py": "pass\nnul_name_here()\n", "four.txt.py": "#".repeat(4 << 20), "over.py": "#".repeat((4 << 20) + 1) });
  // early.py has a NUL inside the first 8000 bytes (git grep -I and the rule both call it binary); late.py at byte
  // 8000, past the window: a caller.
  const list = (await partialOf(dir)).list.split(" ");
  assert.deepEqual([list.includes("four.txt.py"), list.includes("over.py"), list.includes("late.py"), list.includes("early.py")], [true, false, true, false], list.join(" "));
});

test("partial L5: a name in 8 files adds them; in 9, none", async () => {
  const base = { "m.py": "pass\n" };
  for (let i = 0; i < 8; i++) base[`e/f${i}.py`] = "eight_files_name()\n";
  for (let i = 0; i < 9; i++) base[`n/f${i}.py`] = "nine_files_name()\n";
  const { dir } = twoCommits(base, { "m.py": "pass\neight_files_name()\nnine_files_name()\n" });
  assert.equal((await partialOf(dir)).list, ["m.py", ...Array.from({ length: 8 }, (_, i) => `e/f${i}.py`)].join(" "));
});

test("partial L6: a symlink is no caller and no manifest; a changed symlink stays", async () => {
  const { dir, git } = twoCommits({ "m.py": "pass\n", "real.py": "link_name_here()\n" }, { "m.py": "pass\n\n" });
  symlinkSync("real.py", join(dir, "alias.py")); symlinkSync("real.py", join(dir, "package.json"));
  git("add", "-A"); git("commit", "-qm", "links");
  writeFileSync(join(dir, "m.py"), "pass\nlink_name_here()\n"); rmSync(join(dir, "alias.py")); symlinkSync("m.py", join(dir, "alias.py"));
  git("add", "-A"); git("commit", "-qm", "head");
  assert.equal((await partialOf(dir)).list, "alias.py m.py real.py");
});

test("partial L7: past the search line no caller search runs: changed files and manifests only, the stats say why", async () => {
  const base = { "m.py": "pass\n", "package.json": "{}\n" };
  for (let i = 0; i < 5; i++) base[`u/f${i}.py`] = "far_name_here()\n";
  const { dir } = twoCommits(base, { "m.py": "pass\nfar_name_here()\n" });
  const under = await partialOf(dir, { files: 7, bytes: 1 << 30 });
  assert.equal(under.stats.cut, "-"); assert.ok(under.stats.callers > 0);
  const files = await partialOf(dir, { files: 6, bytes: 1 << 30 });
  assert.deepEqual([files.list, files.stats.cut], ["m.py package.json", "files"]);
  const bytes = await partialOf(dir, { files: 1000, bytes: 10 });
  assert.deepEqual([bytes.list, bytes.stats.cut], ["m.py package.json", "bytes"]);
});

test("partial: a partial (promisor) clone runs no caller search, where one grep would fetch every file; promisor=false is none", async () => {
  for (const [key, value, cut] of [["remote.origin.promisor", "true", "partial clone"], ["extensions.partialClone", "origin", "partial clone"], ["remote.origin.promisor", "false", "-"]]) {
    const { dir, git } = twoCommits({ "m.py": "pass\n", "u.py": "clone_name_here()\n" }, { "m.py": "pass\nclone_name_here()\n" });
    git("config", key, value);
    const r = await partialOf(dir);
    assert.deepEqual([r.list, r.stats.cut], [cut === "-" ? "m.py u.py" : "m.py", cut], `${key}=${value}`);
  }
});

test("partial: no user, system or repository git setting changes the list (color, pager, grep settings, attributes from every source)", async () => {
  const { dir, git } = twoCommits({ "m.py": "pass\n", "u.py": "color_name_here()\n", ".gitattributes": "u.py binary\n" }, { "m.py": "pass\ncolor_name_here()\n" });
  // The repository's own config and attributes: color, a pager, and u.py (an unchanged caller) called binary three ways.
  git("config", "color.ui", "always"); git("config", "color.grep", "always"); git("config", "core.pager", "sed s/^/X/");
  git("config", "pager.grep", "true");
  writeFileSync(join(dir, ".git", "info", "attributes"), "u.py binary\n");
  const home = mkdtempSync(join(tmpdir(), "ohmybug-hostile-"));
  writeFileSync(join(home, "attributes"), "u.py binary\n");
  git("config", "core.attributesFile", join(home, "attributes"));
  // A user's global config where git before 2.32 looks for it ($HOME/.gitconfig, $XDG_CONFIG_HOME/git/config):
  // color, a regex grep, line numbers, the same attributes.
  const hostile = `[color]\n\tui = always\n[grep]\n\tpatternType = perl\n\tlineNumber = true\n[core]\n\tattributesFile = ${join(home, "attributes")}\n`;
  writeFileSync(join(home, ".gitconfig"), hostile);
  mkdirSync(join(home, "git")); writeFileSync(join(home, "git", "config"), hostile); writeFileSync(join(home, "git", "attributes"), "u.py binary\n");
  assert.equal((await partialOf(dir, undefined, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: undefined })).list, "m.py u.py");
});

test("partial: a checkout owned by another user, which the user's git trusts, gets its list on any git: the list's own folder has no ownership check", async () => {
  const { dir } = twoCommits({ "m.py": "pass\n", "u.py": "owner_name_here()\n" }, { "m.py": "pass\nowner_name_here()\n" });
  // git's own test switch makes every repository look foreign-owned; under an empty global config git refuses it.
  const foreign = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const refused = (() => { try { execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { env: foreign, stdio: "pipe" }); return false; } catch { return true; } })();
  assert.ok(refused, "this git honours GIT_TEST_ASSUME_DIFFERENT_OWNER");
  // As on a CI runner: the user's own global config trusts the checkout (else ls-tree, before the list, fails).
  const trust = join(mkdtempSync(join(tmpdir(), "ohmybug-trust-")), "gitconfig");
  writeFileSync(trust, "[safe]\n\tdirectory = *\n");
  assert.equal((await partialOf(dir, undefined, { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1", GIT_CONFIG_GLOBAL: trust })).list, "m.py u.py");
});

test("partial: the list's content calls run in a private git folder with no config source, and the folder is gone after, on success and on failure", async () => {
  const { dir } = twoCommits({ "m.py": "pass\n", "u.py": "env_name_here()\n" }, { "m.py": "pass\nenv_name_here()\n" });
  const bin = mkdtempSync(join(tmpdir(), "ohmybug-envgit-"));
  const log = join(bin, "log");
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" grep "*|*" cat-file "*) { echo "ARGS $*"; env; echo "---"; } >> "${log}";; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const sneak = { PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "color.ui", GIT_CONFIG_VALUE_0: "always", GIT_PAGER: "false" };
  assert.equal((await partialOf(dir, undefined, sneak)).list, "m.py u.py");
  const calls = readFileSync(log, "utf8").split("---\n").filter((c) => c.trim());
  assert.ok(calls.some((c) => / grep /.test(c)) && calls.some((c) => / cat-file /.test(c)), "both content calls ran");
  const vars = (c) => Object.fromEntries(c.split("\n").filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  for (const c of calls) {
    const v = vars(c);
    assert.doesNotMatch(c.split("\n")[0], / -C /);
    assert.ok(v.GIT_DIR && v.HOME === v.GIT_DIR && v.XDG_CONFIG_HOME === v.GIT_DIR && !v.GIT_DIR.startsWith(dir), c.split("\n")[0]);
    assert.deepEqual([v.GIT_CONFIG_NOSYSTEM, v.GIT_ATTR_NOSYSTEM, v.GIT_CONFIG_GLOBAL, v.GIT_CONFIG_COUNT, v.GIT_PAGER], ["1", "1", undefined, undefined, undefined]);
    assert.throws(() => statSync(v.GIT_DIR), "the private folder is removed");
  }
  // A blob git lacks answers "missing" (no fetch): the list fails, and its folder is removed all the same.
  writeFileSync(log, "");
  const rev = execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"]).toString().trim();
  const path = process.env.PATH; process.env.PATH = sneak.PATH;
  try {
    await assert.rejects(selectPartial(dir, "", rev, ["m.py"], [{ mode: "100644", oid: "1".repeat(40), size: 3, path: Buffer.from("m.py") }], Date.now() + 60_000), /missing/);
  } finally { process.env.PATH = path; }
  const gitDir = vars(readFileSync(log, "utf8")).GIT_DIR;
  assert.ok(gitDir); assert.throws(() => statSync(gitDir));
});

test("partial: a sha256 repository and a linked worktree get their lists", async () => {
  const { dir, git } = twoCommits({ "m.py": "pass\n", "u.py": "wt_name_here()\n" }, { "m.py": "pass\nwt_name_here()\n" });
  const wt = join(mkdtempSync(join(tmpdir(), "ohmybug-wt-")), "wt");
  git("worktree", "add", "-q", "--detach", wt, "HEAD");
  assert.equal((await partialOf(wt)).list, "m.py u.py");
  const sha = mkdtempSync(join(tmpdir(), "ohmybug-sha256-"));
  try { execFileSync("git", ["init", "-q", "--object-format=sha256", sha], { stdio: "ignore" }); } catch { return; } // a git with no sha256
  const g = (...a) => execFileSync("git", ["-C", sha, "-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { stdio: ["ignore", "pipe", "pipe"] });
  writeFileSync(join(sha, "m.py"), "pass\n"); writeFileSync(join(sha, "u.py"), "sha_name_here()\n"); g("add", "-A"); g("commit", "-qm", "base");
  writeFileSync(join(sha, "m.py"), "pass\nsha_name_here()\n"); g("commit", "-qam", "head");
  assert.equal((await partialOf(sha)).list, "m.py u.py");
});

test("partial: a git that cannot name the object folder (before 2.5) sends the whole tree with the reason", async () => {
  const { dir } = twoCommits({ "m.py": "pass\n", "u.py": "old_name_here()\n" }, { "m.py": "pass\nold_name_here()\n" });
  const rev = execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"]).toString().trim();
  const diff = execFileSync("git", ["-C", dir, "diff", "HEAD~1", "HEAD", "--no-color"]).toString();
  const bin = mkdtempSync(join(tmpdir(), "ohmybug-oldgit-"));
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  // An old git echoes the unknown option back and exits 0.
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = --git-path ] && { printf -- '--git-path\\nobjects\\n'; exit 0; }; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  try {
    const t = await packTree(dir, rev, { maxBytes: 1 << 30, maxUnpacked: 1 << 30, timeoutMs: 60_000, select: (fs, until) => selectPartial(dir, diff, rev, ["m.py"], fs, until) });
    assert.ok(t.tgz); assert.equal(t.files, 2); assert.equal(t.partial, undefined);
    assert.match(t.partialWhy, /object folder was not found/);
  } finally { process.env.PATH = path; }
});

test("partial: a whole tree refused after a failed list keeps the list's reason", async () => {
  const { dir } = twoCommits({ "m.py": "pass\n" }, { "m.py": "pass\n\n" });
  const rev = execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"]).toString().trim();
  const boom = () => { throw new Error("boom"); };
  for (const caps of [{ maxBytes: 1 << 30, maxUnpacked: 1025 }, { maxBytes: 10, maxUnpacked: 1 << 30 }]) {
    const t = await packTree(dir, rev, { ...caps, timeoutMs: 60_000, select: boom });
    assert.match(t.cannot, caps.maxBytes === 10 ? /compressed/ : /unpacked, over/);
    assert.match(t.partialWhy, /could not be built \(boom\)/);
  }
});

test("partial: the list keeps the run's object-store variables (GIT_ALTERNATE_OBJECT_DIRECTORIES), as selectChange and the pack do", async () => {
  const { dir, git } = twoCommits({ "m.py": "pass\n", "u.py": "store_name_here()\n" }, { "m.py": "pass\nstore_name_here()\n" });
  git("repack", "-a", "-d", "-q"); git("prune-packed");
  const store = mkdtempSync(join(tmpdir(), "ohmybug-store-"));
  renameSync(join(dir, ".git", "objects", "pack"), join(store, "pack"));
  mkdirSync(join(dir, ".git", "objects", "pack"));
  const saved = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = store;
  try { assert.equal((await partialOf(dir)).list, "m.py u.py"); }
  finally { if (saved === undefined) delete process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES; else process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = saved; }
});

test("partial: the list gets half of the snapshot clock, at most PARTIAL_LIST_MS; the rest is the pack's", async () => {
  const { dir } = twoCommits({ "m.py": "pass\n" }, { "m.py": "pass\n\n" });
  const rev = execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"]).toString().trim();
  for (const [timeoutMs, most] of [[10_000, 5_000], [3_600_000, PARTIAL_LIST_MS]]) {
    let given;
    const t = await packTree(dir, rev, { maxBytes: 1 << 30, maxUnpacked: 1 << 30, timeoutMs, select: (fs, until) => { given = until - Date.now(); return { keep: new Set(), stats: { changedInTree: 1 } }; } });
    assert.ok(given <= most && given > most - 1_000, `timeout ${timeoutMs}: the list got ${given} ms`);
    assert.ok(t.tgz, "the whole tree still packs");
  }
  assert.equal(PARTIAL_LIST_MS, 120_000);
});

test("partial: the unpacked cap measures the partial copy, not the whole tree it was cut from", async () => {
  const { dir } = twoCommits({ "m.py": "pass\n", "big.txt": "#".repeat(2 << 20) }, { "m.py": "pass\n\n" });
  const rev = execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"]).toString().trim();
  const opts = { maxBytes: 1 << 30, maxUnpacked: 1 << 20, timeoutMs: 60_000 };
  assert.match((await packTree(dir, rev, opts)).cannot, /unpacked, over the 1 MiB/);
  const t = await packTree(dir, rev, { ...opts, select: (fs) => ({ keep: new Set(fs.filter((f) => f.path.toString() === "m.py").map((f) => f.path.toString("latin1"))), stats: { kept: 1 } }) });
  assert.equal(t.files, 1);
  assert.ok(t.partial);
});

test("partial L10: files named like secrets are never listed and take no slot", async () => {
  const { dir } = twoCommits({ "m.py": "pass\n", "config/secrets.py": "secret_name_here()\n", ".env.local": "x\n", "ok.py": "secret_name_here()\n" },
    { "m.py": "pass\nsecret_name_here()\n", ".env.local": "y\n" });
  assert.equal((await partialOf(dir)).list, "m.py ok.py");
});

test("partial L9: a git grep that fails fails the list, and the pack then sends the whole tree with the reason", async () => {
  const { dir } = twoCommits({ "m.py": "pass\n", "u.py": "grep_name_here()\n" }, { "m.py": "pass\ngrep_name_here()\n" });
  const rev = execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"]).toString().trim();
  // A tree id git does not have: the grep exits 128, not 1 (no match).
  const t = await packTree(dir, rev, { maxBytes: 1 << 30, maxUnpacked: 1 << 30, timeoutMs: 60_000,
    select: (fs, until) => selectPartial(dir, "diff --git a/m.py b/m.py\n@@ -1 +1,2 @@\n pass\n+grep_name_here()\n", "0".repeat(40), ["m.py"], fs, until) });
  assert.equal(t.partial, undefined);
  assert.match(t.partialWhy, /the file list could not be built \(git grep failed: fatal: /);
  assert.equal(t.files, 2);
});

test("partial upload: a fast ticket asking pack: partial gets the list as the snapshot, marked ?pack=partial", { skip: !hasTar && "no tar" }, async () => {
  // An unchanged file on the base: in the whole tree, not in the partial list (no name of the change uses it).
  const { dir, git } = repo();
  writeFileSync(join(dir, "unrelated.js"), "export const z = 9\n"); git("add", "-A"); git("commit", "-qm", "more");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(dir, "app.js"), "export const a = 2\n"); git("commit", "-qam", "change");
  const s = await server({ findings: [high], faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", pack: "partial" } });
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 1, r.log);
    assert.deepEqual(s.uploads.map((u) => u.door), ["repo", "payload"]);
    assert.match(s.uploads[0].path, /\/repo\?pack=partial$/);
    const root = untar(s.uploads[0].body);
    assert.equal(readFileSync(join(root, "app.js"), "utf8"), "export const a = 2\n");
    assert.throws(() => statSync(join(root, "unrelated.js")));
    assert.match(r.log, /uploading a partial repository snapshot \(1 of \d+ file\(s\): 1 changed/);
  } finally { await s.close() }
});

test("partial upload: no pack on the ticket, or a list with nothing in it, sends the whole tree unmarked", { skip: !hasTar && "no tar" }, async () => {
  for (const [ticket, why] of [[{ snapshot: "required" }, null], [{ snapshot: "required", pack: "whole" }, null], [{ snapshot: "required", pack: "partial" }, /every changed file is over 4 MiB, binary or a git-lfs pointer/]]) {
    const { dir, git } = changed();
    if (why) { writeFileSync(join(dir, "app.js"), Buffer.from("\0binary\n")); git("add", "-A"); git("commit", "-qm", "binary"); }
    const s = await server({ findings: [high], faults: NEEDS_SNAPSHOT(), ticket });
    try {
      const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 1, r.log);
      assert.match(s.uploads[0].path, /\/repo$/, JSON.stringify(ticket));
      assert.match(r.log, /uploading the repository snapshot/);
      if (why) assert.match(r.log, why); else assert.doesNotMatch(r.log, /partial copy/);
    } finally { await s.close() }
  }
});

test("partial upload: a list that fails (git grep exits 128) sends the whole tree unmarked and says why", { skip: !hasTar && "no tar" }, async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "other.js"), "fail_name_here()\n"); git("add", "-A"); git("commit", "-qm", "caller");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(dir, "app.js"), "export const a = fail_name_here()\n"); git("commit", "-qam", "change");
  const bin = mkdtempSync(join(tmpdir(), "ohmybug-badgit-"));
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = grep ] && exit 128; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const s = await server({ findings: [high], faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", pack: "partial" } });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 1, r.log);
    assert.match(s.uploads[0].path, /\/repo$/);
    assert.match(r.log, /the file list could not be built \(git grep failed\)/);
    assert.match(r.log, /uploading the repository snapshot/);
    statSync(join(untar(s.uploads[0].body), "other.js"));
  } finally { process.env.PATH = path; await s.close(); }
});

test("partial upload: when the list fails and the whole tree is then too large, the refusal says a partial copy was asked for and why none was built", { skip: !hasTar && "no tar" }, async () => {
  const { dir, git } = repo();
  writeFileSync(join(dir, "other.js"), "fail_name_here()\n"); git("add", "-A"); git("commit", "-qm", "caller");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  writeFileSync(join(dir, "app.js"), "export const a = fail_name_here()\n"); git("commit", "-qam", "change");
  const bin = mkdtempSync(join(tmpdir(), "ohmybug-badgit-"));
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = grep ] && exit 128; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const s = await server({ findings: [high], faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", pack: "partial" } });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const r = await cli(dir, ["--format", "json"], { OHMYBUG_URL: s.url }, { snapshot: { ...SNAP.snapshot, maxBytes: 10 } });
    assert.notEqual(r.code, 0, r.log);
    assert.deepEqual(s.uploads.filter((u) => u.door === "repo"), []);
    assert.match(r.log, /compressed, the most the service takes; the upload ticket asks for a partial copy of the repository and none was built \(the file list could not be built \(git grep failed\)\), so the whole tree was tried/);
  } finally { process.env.PATH = path; await s.close(); }
});

test("partial upload: --deep packs the whole tree before its ticket and never marks it, whatever the ticket says", { skip: !hasTar && "no tar" }, async () => {
  const { dir } = changed();
  const s = await server({ findings: [high], ticket: { snapshot: "required", pack: "partial" } });
  try {
    const r = await cli(dir, ["--deep", "--snapshot", "--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
    assert.equal(r.code, 1, r.log);
    assert.match(s.uploads[0].path, /\/repo$/);
    assert.doesNotMatch(r.log, /partial/);
  } finally { await s.close() }
});

test("partial: a file the 16 MiB cap skips does not stop the list: a later one that fits still goes", async () => {
  const big = "#".repeat(3900 * 1024) + "\n";
  const { dir } = twoCommits({ "a1.py": "x\n", "a2.py": "x\n", "a3.py": "x\n", "a4.py": "x\n", "b5.py": "x\n", "c6.py": "x\n" },
    { "a1.py": big, "a2.py": big, "a3.py": big, "a4.py": big, "b5.py": "#".repeat(1 << 20) + "\n", "c6.py": "y\n" });
  assert.equal((await partialOf(dir)).list, "a1.py a2.py a3.py a4.py c6.py");
});

test("partial upload: base...HEAD and --uncommitted both bring a caller of the change, and leave an unrelated file out", { skip: !hasTar && "no tar" }, async () => {
  for (const uncommitted of [false, true]) {
    const { dir, git } = repo();
    writeFileSync(join(dir, "use.js"), "export const u = compute_total_sum(1)\n");
    writeFileSync(join(dir, "unrelated.js"), "export const z = 9\n");
    git("add", "-A"); git("commit", "-qm", "more"); git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(dir, "app.js"), "export function compute_total_sum(x) { return x }\n");
    if (!uncommitted) git("commit", "-qam", "change");
    const s = await server({ findings: [high], faults: NEEDS_SNAPSHOT(), ticket: { snapshot: "required", pack: "partial" } });
    try {
      const r = await cli(dir, [...(uncommitted ? ["--uncommitted"] : []), "--format", "json"], { OHMYBUG_URL: s.url }, SNAP);
      assert.equal(r.code, 1, r.log);
      assert.match(s.uploads[0].path, /\/repo\?pack=partial$/);
      const root = untar(s.uploads[0].body);
      assert.equal(readFileSync(join(root, "use.js"), "utf8"), "export const u = compute_total_sum(1)\n", `uncommitted=${uncommitted}`);
      assert.throws(() => statSync(join(root, "unrelated.js")));
      assert.match(r.log, /1 changed, 0 build manifest\(s\), 1 caller\(s\)/);
    } finally { await s.close() }
  }
});

test("partial: a real list that outruns its share of the clock is cut there, and the whole tree still packs in the rest", async () => {
  const { dir } = twoCommits({ "m.py": "pass\n", "u.py": "slow_name_here()\n" }, { "m.py": "pass\nslow_name_here()\n" });
  const rev = execFileSync("git", ["-C", dir, "rev-parse", "HEAD^{tree}"]).toString().trim();
  const diff = execFileSync("git", ["-C", dir, "diff", "HEAD~1", "HEAD", "--no-color"]).toString();
  // A git whose grep takes 30 s: the list must stop at its share (half of 6 s), not wait for it.
  const bin = mkdtempSync(join(tmpdir(), "ohmybug-slowgit-"));
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = grep ] && exec sleep 30; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const from = Date.now();
    const t = await packTree(dir, rev, { maxBytes: 1 << 30, maxUnpacked: 1 << 30, timeoutMs: 6_000,
      select: (fs, until) => selectPartial(dir, diff, rev, ["m.py"], fs, until) });
    const took = Date.now() - from;
    assert.ok(t.tgz, `the whole tree packs: ${t.cannot}`);
    assert.equal(t.partial, undefined);
    assert.match(t.partialWhy, /out of time/);
    assert.equal(t.files, 2);
    assert.ok(took < 5_000, `the list stopped at its share: ${took} ms`);
  } finally { process.env.PATH = path; }
});
