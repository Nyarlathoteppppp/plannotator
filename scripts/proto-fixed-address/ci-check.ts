/**
 * PROTOTYPE (proto/inbox-fixed-address): the whole fixed-address flow on a CI
 * runner (ubuntu-latest, windows-latest, macos-latest), everything except a
 * human typing a password: the runner is already admin (passwordless sudo,
 * or an elevated Windows session), so the Inbox runs its privileged step
 * with PLANNOTATOR_PROTO_NAME_ELEVATE=sudo (Linux, macOS) or =direct (Windows).
 *
 *   bun scripts/proto-fixed-address/ci-check.ts <shots dir>
 *
 * Steps, each recorded (a JSON summary on stdout and in $GITHUB_STEP_SUMMARY):
 *   1. start a scratch Inbox (temp data dir, prototype on)
 *   2. click Sure in its window (headless Chromium, ui-flow.ts --click-sure):
 *      portless installed into the data dir, `service install`, alias, verify
 *   3. https://inbox.plannotator.localhost/api/inbox/health answers this
 *      Inbox, checked against portless's CA (Bun fetch, tls.ca)
 *   4. the OS's own trust: browsers load it with certificate checks on
 *      (browser-check.ts; Linux first adds the CA to Chromium's NSS store,
 *      which `update-ca-certificates` does not reach: a finding, recorded)
 *   5. port change: the Inbox stopped, its old port held, started again on a
 *      new port; the name answers the new Inbox with no privileged step
 *   6. --name off: the alias goes and the name no longer answers this Inbox
 */
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");
const shots = resolve(process.argv[2] ?? "proto-shots");
mkdirSync(shots, { recursive: true });
const data = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "pn-fixed-address-"));
const NAME = "https://inbox.plannotator.localhost";
const portlessState = join(homedir(), ".portless");
const env = {
  ...process.env,
  PLANNOTATOR_DATA_DIR: data,
  PLANNOTATOR_INBOX_CONNECT: "0",
  PLANNOTATOR_INBOX_NOTES: "0",
  PLANNOTATOR_UPDATE_CHECK: "0",
  PLANNOTATOR_AUTO_UPDATE: "0",
  PLANNOTATOR_PROTO_FIXED_ADDRESS: "1",
  PLANNOTATOR_PROTO_NAME_ELEVATE: process.platform === "win32" ? "direct" : "sudo",
};

const results: { step: string; ok: boolean; finding?: boolean; detail: string }[] = [];
const record = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
};
/** Something this run exists to find out, expected on this OS: shown, not counted as a failure. */
const finding = (step: string, detail: string) => {
  results.push({ step, ok: true, finding: true, detail });
  console.log(`FINDING ${step}: ${detail}`);
};
const run = (args: string[], options: SpawnSyncOptions = {}) => {
  const result = spawnSync(process.execPath, args, { cwd: repo, env, encoding: "utf8", timeout: 10 * 60_000, ...options });
  return { code: result.status, out: `${result.stdout ?? ""}`, err: `${result.stderr ?? ""}` };
};
/**
 * Playwright under Node: under Bun on Windows, Chromium's launch never
 * finishes (Playwright talks to it over extra stdio pipes; the first CI run
 * timed out at 180 s). Node 24 runs these .ts files by stripping types.
 */
const runNode = (args: string[]) => {
  const result = spawnSync("node", args, { cwd: repo, env, encoding: "utf8", timeout: 10 * 60_000 });
  return { code: result.status, out: `${result.stdout ?? ""}`, err: `${result.stderr ?? ""}` };
};
const registry = () => JSON.parse(readFileSync(join(data, "inbox", "inbox.json"), "utf8")) as { port: number; token: string; serverSession: string; url: string };
const nameState = async (port: number) => ((await (await fetch(`http://127.0.0.1:${port}/api/inbox/name`)).json()) as { name: Record<string, unknown> }).name;
const httpsSession = async (): Promise<string> => {
  try {
    const ca = readFileSync(join(portlessState, "ca.pem"));
    const response = await fetch(`${NAME}/api/inbox/health`, { tls: { ca }, signal: AbortSignal.timeout(5000) } as RequestInit);
    return ((await response.json()) as { serverSession?: string }).serverSession ?? `HTTP ${response.status}`;
  } catch (error) {
    return `error: ${String(error)}`;
  }
};
const startInbox = () => {
  const started = run([join(repo, "apps/hook/server/index.ts"), "inbox", "--background"], { cwd: data });
  if (started.code !== 0) throw new Error(`inbox --background failed: ${started.err}`);
  return started.out.trim();
};
const stopInbox = async () => {
  const { port, token } = registry();
  await fetch(`http://127.0.0.1:${port}/api/inbox/control/stop`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  for (let i = 0; i < 50; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/api/inbox/health`).then(() => true, () => false);
    if (!up) return;
    await Bun.sleep(200);
  }
};

try {
  // 1.
  const url = startInbox();
  const first = registry();
  record("start scratch inbox", true, `${url} (data ${data})`);

  // 2.
  const flow = runNode([join(repo, "scripts/proto-fixed-address/ui-flow.ts"), url, shots, "--click-sure"]);
  console.log(flow.out, flow.err);
  const afterSure = await nameState(first.port);
  record("Sure in the window -> on", afterSure.status === "on", `status ${afterSure.status}; reason ${afterSure.reason}; probe ${afterSure.probe}; os_trust ${afterSure.os_trust}`);
  console.log("commands run:\n" + ((afterSure.log as string[] | undefined) ?? []).join("\n"));
  if (afterSure.os_trust === false) finding("macOS: the OS does not trust portless's CA (root could not add trust without a person)", String(afterSure.reason));
  const moved = /tab moved to the name: true/.test(flow.out);
  const movedLine = (/tab moved to the name: .*/.exec(flow.out) ?? ["(no line)"])[0];
  if (!moved && process.platform === "linux" && afterSure.status === "on") {
    finding("linux: the tab could not move (Chromium reads NSS, which update-ca-certificates does not reach)", movedLine);
  } else if (!moved && process.platform === "win32" && afterSure.status === "on") {
    finding("windows: the tab could not move (the CA is not trusted yet: see the certutil finding below)", movedLine);
  } else {
    record("the tab moved itself to the name", moved, movedLine);
  }

  // 3.
  const session1 = await httpsSession();
  record("https name answers this Inbox (portless CA)", session1 === first.serverSession, session1);

  // 4.
  if (process.platform === "linux" && existsSync(join(portlessState, "ca.pem"))) {
    const nss = join(homedir(), ".pki", "nssdb");
    mkdirSync(nss, { recursive: true });
    spawnSync("certutil", ["-d", `sql:${nss}`, "-N", "--empty-password"], { encoding: "utf8" });
    const added = spawnSync("certutil", ["-d", `sql:${nss}`, "-A", "-t", "C,,", "-n", "portless Local CA", "-i", join(portlessState, "ca.pem")], { encoding: "utf8" });
    record("linux: CA added to Chromium's NSS store (portless does not do this)", added.status === 0, (added.stderr || "ok").trim());
  }
  let browsers = runNode([join(repo, "scripts/proto-fixed-address/browser-check.ts"), first.serverSession, NAME]);
  console.log(browsers.out, browsers.err);
  if (browsers.code !== 0 && process.platform === "win32" && existsSync(join(portlessState, "ca.pem"))) {
    // portless trusts its CA with `certutil -addstore -user Root`, which shows Windows' own
    // "Security Warning: install this certificate?" dialog; with no one to click Yes it times
    // out (the first CI run). A person clicks it. CI adds it to the machine store instead
    // (admin, no dialog), then checks the browsers again.
    finding("windows: trusting the CA needs a click on Windows' Security Warning dialog (certutil -user Root timed out here)", browsers.out.trim().split("\n")[0] ?? "");
    const added = spawnSync("certutil", ["-addstore", "-f", "Root", join(portlessState, "ca.pem")], { encoding: "utf8" });
    record("windows (CI only): CA added to the machine Root store", added.status === 0, (added.stdout || added.stderr).trim().split("\n").slice(-1)[0] ?? "");
    browsers = runNode([join(repo, "scripts/proto-fixed-address/browser-check.ts"), first.serverSession, NAME]);
    console.log(browsers.out, browsers.err);
  }
  record("a browser loads the name with certificate checks on", browsers.code === 0, browsers.out.trim().split("\n").join(" | "));

  // 5.
  const listener = afterSure.listener_port;
  await stopInbox();
  const squatter = Bun.serve({ hostname: "127.0.0.1", port: first.port, fetch: () => new Response("held") });
  try {
    startInbox();
    const second = registry();
    record("restarted on a new port", second.port !== first.port, `${first.port} -> ${second.port}`);
    let state = await nameState(second.port);
    for (let i = 0; i < 60 && state.status === "working"; i++) {
      await Bun.sleep(500);
      state = await nameState(second.port);
    }
    record("name on again after the move, no privileged step", state.status === "on", `status ${state.status}; listener ${state.listener_port} (was ${listener}); ${state.reason ?? ""}`);
    console.log("commands run after the move:\n" + ((state.log as string[] | undefined) ?? []).join("\n"));
    const session2 = await httpsSession();
    record("https name answers the restarted Inbox", session2 === second.serverSession, session2);

    // 6.
    const off = run([join(repo, "apps/hook/server/index.ts"), "inbox", "--name", "off"]);
    // portless reloads routes.json on a file watch, and the listener closes a moment after the answer.
    let session3 = await httpsSession();
    for (let i = 0; i < 30 && session3 === second.serverSession; i++) {
      await Bun.sleep(200);
      session3 = await httpsSession();
    }
    record("--name off: the name no longer answers this Inbox", off.code === 0 && session3 !== second.serverSession, session3);
    await stopInbox();
  } finally {
    squatter.stop(true);
  }
} catch (error) {
  record("unexpected", false, String(error));
}

const lines = [`### Fixed address on ${process.platform}`, "", "| | step | detail |", "|---|---|---|", ...results.map((r) => `| ${r.finding ? "⚠️" : r.ok ? "✅" : "❌"} | ${r.step} | ${r.detail.replace(/\|/g, "\\|").slice(0, 400)} |`)];
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
console.log(JSON.stringify({ platform: process.platform, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
