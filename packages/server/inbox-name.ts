/**
 * PROTOTYPE (branch proto/inbox-fixed-address, not for merge): a fixed
 * address for the Plannotator Inbox, `https://inbox.plannotator.localhost`,
 * through portless (https://github.com/vercel-labs/portless, pinned 0.15.8).
 * Research and findings: .product/drafts/portless-local-url/ (BRIEF.md and
 * one-click/README.md).
 *
 * What "Sure" does, in order (`enable`):
 *  1. Find Node 24+ (portless needs it). None: the offer is never shown.
 *  2. Install portless into `<data dir>/portless/` with that Node's own npm,
 *     as the person, never globally. Skipped when it is already there.
 *  3. Skipped when portless's proxy already answers. Otherwise the ONE
 *     privileged step, `portless service install`: the proxy on 443 at boot
 *     plus its local CA trusted. The OS asks for the password itself:
 *     macOS `osascript … with administrator privileges`, Linux `pkexec`,
 *     Windows `Start-Process -Verb RunAs`. The command line is built from
 *     fixed words and validated paths only (`privilegedInstallCommand`);
 *     nothing a request carries reaches it.
 *  4. As the person (never root, so `~/.portless` stays theirs):
 *     `portless alias inbox.plannotator <name listener port>`. Never
 *     `--force` (it kills the caller's process group), always detached.
 *  5. Verify: `https://inbox.plannotator.localhost/api/inbox/health`,
 *     checked against portless's CA, answers THIS Inbox's `serverSession`.
 *
 * The name listener: a second loopback listener (the "Over your tailnet"
 * pattern) that portless points at, so the window's own port keeps refusing
 * every forwarded request (`X-Forwarded-For` -> 403 local_only). It hands a
 * request to the window's handler only when Host is the name, every
 * `X-Forwarded-For` hop is loopback, no `Tailscale-*` header is present, and
 * the path is not an agent or connection route (`checkNameRequest`).
 *
 * The fallback is always `http://localhost:<port>`: nothing an agent or
 * connection uses changes, and a failure leaves the Inbox exactly as it was.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { inboxDir } from "@plannotator/shared/inbox/schema";

/** The name portless registers; it adds `.localhost`. */
export const INBOX_NAME_LABEL = "inbox.plannotator";
export const INBOX_NAME_HOST = "inbox.plannotator.localhost";
export const INBOX_NAME_URL = `https://${INBOX_NAME_HOST}/`;
/** The portless release this prototype was read against (BRIEF.md). */
export const PORTLESS_VERSION = "0.15.8";
export const PORTLESS_MIN_NODE_MAJOR = 24;
/** The password prompt's reason line (macOS only shows it; the title says "osascript"). */
export const INBOX_NAME_PROMPT =
  "Plannotator wants to give the Inbox a fixed address, inbox.plannotator.localhost. This installs a local HTTPS proxy (portless) and trusts its certificate on this Mac.";

const NAME_FILE = "name.json";
const PRIVILEGED_TIMEOUT_MS = 5 * 60_000;
const NPM_TIMEOUT_MS = 3 * 60_000;
const ALIAS_TIMEOUT_MS = 20_000;

// ── Pure rules (unit-tested) ────────────────────────────────────────────────

/** A literal loopback address as a socket or `X-Forwarded-For` names it. */
export function isLoopbackAddress(value: string | null | undefined): boolean {
  if (!value) return false;
  let ip = value.trim().toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  const parts = ip.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Paths that never answer through the name: an agent's surface, not a browser's. */
const AGENT_PATHS = [/^\/mcp(\/|$)/, /^\/api\/inbox\/control\//, /^\/api\/inbox\/bridge\//, /^\/api\/inbox\/device(\/|$)/];

export type NameRequestCheck = { ok: true } | { ok: false; status: number; code: string; error: string };

/**
 * Whether the name listener hands a request to the window. `peer` is the
 * socket's remote address (always loopback: the listener binds 127.0.0.1;
 * checked anyway). portless always adds `X-Forwarded-For` with the browser's
 * address; in portless's LAN mode that would be a Wi-Fi address, refused.
 */
export function checkNameRequest(headers: Headers, path: string, peer: string | null, host: string = INBOX_NAME_HOST): NameRequestCheck {
  if (peer !== null && !isLoopbackAddress(peer)) return { ok: false, status: 403, code: "local_only", error: "The fixed address answers only this computer." };
  const rawHost = (headers.get("host") ?? "").trim().toLowerCase();
  const named = rawHost === host || rawHost === `${host}:443` || rawHost === `${host}:80`;
  if (!named) return { ok: false, status: 403, code: "forbidden_host", error: `This listener answers only ${host}.` };
  for (const name of headers.keys()) {
    if (name.toLowerCase().startsWith("tailscale-")) return { ok: false, status: 403, code: "local_only", error: "The fixed address answers only this computer." };
  }
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const hops = forwarded.split(",").map((hop) => hop.trim());
    if (hops.length === 0 || hops.some((hop) => !isLoopbackAddress(hop))) {
      return { ok: false, status: 403, code: "local_only", error: "The fixed address answers only this computer." };
    }
  }
  if (AGENT_PATHS.some((pattern) => pattern.test(path))) {
    return { ok: false, status: 403, code: "local_only", error: "Agents reach the Inbox at http://localhost:<port>, never through the fixed address." };
  }
  return { ok: true };
}

/** `v24.15.0` -> 24. */
export function nodeMajor(version: string): number | null {
  const match = /^v?(\d+)\.\d+\.\d+/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

const POSIX_PATH = /^\/[A-Za-z0-9 ._+@,:\/-]*$/;
const WINDOWS_PATH = /^[A-Za-z]:\\[A-Za-z0-9 ._+@,()~\\-]*$/;
const USER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const NUMERIC_ID = /^\d{1,10}$/;

/** Throws unless `value` is a path that needs no escaping beyond single quotes (POSIX) or double quotes (Windows). */
export function assertSafePath(value: string, platform: NodeJS.Platform): string {
  const rule = platform === "win32" ? WINDOWS_PATH : POSIX_PATH;
  if (!rule.test(value) || value.includes("..")) throw new Error(`Refusing an unusual path in a privileged command: ${JSON.stringify(value)}`);
  return value;
}

export interface PrivilegedContext {
  /** Absolute, real path of Node 24+. */
  node: string;
  /** portless's `dist/cli.js`. */
  cli: string;
  /** PORTLESS_STATE_DIR: `~/.portless`, owned by the person. */
  stateDir: string;
  /** The person (osascript and pkexec do not set SUDO_USER; portless reads it to give its files back). */
  user: string;
  uid: string;
  gid: string;
  home: string;
}

/** How the privileged step asks: the OS prompt (default), `sudo -n` (CI), or as-is (an elevated CI runner). */
export type ElevationMode = "prompt" | "sudo" | "direct";

export interface CommandLine {
  command: string;
  args: string[];
}

/** POSIX `env` words handing portless the person's identity and state dir. */
function posixEnvWords(ctx: PrivilegedContext): string[] {
  return [`SUDO_USER=${ctx.user}`, `SUDO_UID=${ctx.uid}`, `SUDO_GID=${ctx.gid}`, `HOME=${ctx.home}`, `PORTLESS_STATE_DIR=${ctx.stateDir}`];
}

function validate(ctx: PrivilegedContext, platform: NodeJS.Platform): void {
  assertSafePath(ctx.node, platform);
  assertSafePath(ctx.cli, platform);
  assertSafePath(ctx.stateDir, platform);
  if (platform !== "win32") {
    assertSafePath(ctx.home, platform);
    if (!USER_NAME.test(ctx.user)) throw new Error(`Refusing an unusual user name: ${JSON.stringify(ctx.user)}`);
    if (!NUMERIC_ID.test(ctx.uid) || !NUMERIC_ID.test(ctx.gid)) throw new Error("Refusing a non-numeric uid or gid.");
    if (ctx.user === "root" || ctx.uid === "0") throw new Error("The Inbox runs as root; the fixed address needs the person's own account.");
  }
}

/**
 * The one privileged command: `portless service install --state-dir <dir>`.
 * Every value is validated (`assertSafePath`, `USER_NAME`, `NUMERIC_ID`), so
 * it carries no quote, backslash (POSIX), `$`, backtick or line break, and
 * is then quoted. Never `--force`.
 */
export function privilegedInstallCommand(platform: NodeJS.Platform, ctx: PrivilegedContext, mode: ElevationMode = "prompt"): CommandLine {
  validate(ctx, platform);
  const portlessWords = [ctx.cli, "service", "install", "--state-dir", ctx.stateDir];
  if (platform === "win32") {
    if (mode !== "prompt") return { command: ctx.node, args: portlessWords };
    // Start-Process -ArgumentList joins its words with spaces, so each path is wrapped in double quotes
    // (validated to hold none); the whole is one single-quoted PowerShell string (validated to hold no ').
    const argumentList = `"${ctx.cli}" service install --state-dir "${ctx.stateDir}"`;
    const script = `$p = Start-Process -FilePath '${ctx.node}' -ArgumentList '${argumentList}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`;
    return { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script] };
  }
  const argv = ["/usr/bin/env", ...posixEnvWords(ctx), ctx.node, ...portlessWords];
  if (mode === "direct") return { command: argv[0]!, args: argv.slice(1) };
  if (mode === "sudo") return { command: "sudo", args: ["-n", ...argv] };
  if (platform === "darwin") {
    // `do shell script` runs /bin/sh: every word single-quoted. The AppleScript string then holds no `"` or `\`.
    const shell = argv.map((word) => `'${word}'`).join(" ");
    return { command: "/usr/bin/osascript", args: ["-e", `do shell script "${shell}" with administrator privileges with prompt "${INBOX_NAME_PROMPT}"`] };
  }
  // Linux: pkexec takes an argv (no shell); the polkit agent names the binary, not our reason.
  return { command: "pkexec", args: argv };
}

/** `portless alias inbox.plannotator <port>`: run as the person. A port number is the only variable. */
export function aliasCommand(node: string, cli: string, port: number): CommandLine {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Not a port: ${port}`);
  return { command: node, args: [cli, "alias", INBOX_NAME_LABEL, String(port)] };
}

export function aliasRemoveCommand(node: string, cli: string): CommandLine {
  return { command: node, args: [cli, "alias", "--remove", INBOX_NAME_LABEL] };
}

/** `npm install --prefix <home> portless@<pinned>` through the found Node's own npm-cli.js (no shell, no .cmd). */
export function npmInstallCommand(node: string, npmCli: string, home: string): CommandLine {
  return { command: node, args: [npmCli, "install", "--prefix", home, `portless@${PORTLESS_VERSION}`, "--no-save", "--no-audit", "--no-fund", "--loglevel=error"] };
}

/** What an osascript / pkexec / UAC refusal looks like, said plainly. */
export function explainPrivilegedFailure(platform: NodeJS.Platform, code: number | null, stderr: string): string {
  const text = stderr.trim();
  if (platform === "darwin" && /-128|User canceled/i.test(text)) return "You cancelled the password prompt. Nothing changed.";
  if (platform === "linux" && (code === 126 || code === 127) && /dismiss|not authorized|Request dismissed/i.test(text)) return "You cancelled the password prompt. Nothing changed.";
  if (platform === "win32" && /canceled by the user|cancelled by the user/i.test(text)) return "You cancelled the Windows prompt. Nothing changed.";
  return text ? `The privileged step failed: ${text.split("\n").slice(-3).join(" ")}` : `The privileged step failed (exit ${code ?? "?"}).`;
}

// ── Effects ─────────────────────────────────────────────────────────────────

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type NameRunner = (line: CommandLine, options: { env: Record<string, string | undefined>; timeoutMs: number }) => Promise<RunResult>;

/**
 * Run a command DETACHED (its own process group), so nothing it does to its
 * group (portless's `--force` path signals group 0) can reach the Inbox.
 * Output is capped; the group is killed at the time limit.
 */
export const runDetached: NameRunner = (line, { env, timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(line.command, line.args, { env: env as NodeJS.ProcessEnv, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    const cap = (acc: string, chunk: Buffer) => (acc.length > 64_000 ? acc : acc + chunk.toString("utf8"));
    child.stdout?.on("data", (chunk: Buffer) => (stdout = cap(stdout, chunk)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = cap(stderr, chunk)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

export type NameStatus = "unavailable" | "off" | "working" | "on" | "failed";
export type NameStep = "installing" | "password" | "alias" | "verifying";

export interface InboxNameState {
  status: NameStatus;
  url: string;
  host: string;
  /** unavailable: why; failed: what went wrong (and that nothing changed when so). */
  reason: string | null;
  step: NameStep | null;
  /** The name listener's loopback port while on. */
  listener_port: number | null;
  /** The one-time dialog may show (available, off, never shown). */
  dialog_due: boolean;
  /** The prototype is switched on in this Inbox's environment (PLANNOTATOR_PROTO_FIXED_ADDRESS=1). Off: nothing runs and the window shows nothing. */
  prototype: boolean;
  verified_at: string | null;
  /** How the last probe went, for the checklist and CI. */
  probe: string | null;
  /** The commands run for it, newest last: what ran, its exit, the end of its output (for the checklist, CI and Try again). */
  log: string[];
  /**
   * Whether the OS trusts portless's CA (macOS: `security verify-cert`; null
   * elsewhere or before a check). The probe trusts the CA explicitly, so a
   * failed trust step still verifies; this says whether browsers will warn.
   */
  os_trust: boolean | null;
  portless: { node: string | null; cli: string | null; state_dir: string; home: string };
}

interface NameFile {
  v: 1;
  on: boolean;
  port: number | null;
  dialog_shown: boolean;
}

export interface ProbeResult {
  ok: boolean;
  detail: string;
}

export type NameProbe = (stateDir: string, serverSession: string) => Promise<ProbeResult>;

/** HTTPS to the name, verified against portless's CA, answering this Inbox's serverSession. */
export const probeName: NameProbe = async (stateDir, serverSession) => {
  const caPath = join(stateDir, "ca.pem");
  let ca: Buffer;
  try {
    ca = readFileSync(caPath);
  } catch {
    return { ok: false, detail: `no portless CA at ${caPath}` };
  }
  try {
    const response = await fetch(`${INBOX_NAME_URL}api/inbox/health`, { tls: { ca }, signal: AbortSignal.timeout(4000) } as RequestInit);
    if (!response.ok) return { ok: false, detail: `https answered HTTP ${response.status}` };
    const body = (await response.json()) as { serverSession?: unknown };
    if (body.serverSession !== serverSession) return { ok: false, detail: "https answered another Inbox (serverSession differs)" };
    return { ok: true, detail: `https ok (portless ${response.headers.get("x-portless") ? "header seen" : "header absent"})` };
  } catch (error) {
    const https = error instanceof Error ? error.message : String(error);
    // Tell a name that does not resolve from a proxy without our route: portless accepts plain HTTP on its TLS port.
    try {
      const port = readProxyPort(stateDir);
      const plain = await fetch(`http://127.0.0.1:${port}/api/inbox/health`, { headers: { host: INBOX_NAME_HOST }, redirect: "manual", signal: AbortSignal.timeout(3000) });
      return { ok: false, detail: `https failed (${https}); plain http to 127.0.0.1:${port} answered ${plain.status}${plain.headers.get("x-portless") ? " from portless" : ""}` };
    } catch (plainError) {
      return { ok: false, detail: `https failed (${https}); proxy not answering (${plainError instanceof Error ? plainError.message : String(plainError)})` };
    }
  }
};

function readProxyPort(stateDir: string): number {
  try {
    const port = Number(readFileSync(join(stateDir, "proxy.port"), "utf8").trim());
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  } catch {
    // The default below.
  }
  return 443;
}

/**
 * portless's proxy answers on its port: the service is installed and running.
 * Plain HTTP on its TLS port gets a 302 to https carrying `X-Portless`; never
 * follow it (Bun's own CA store does not trust portless's CA; CI on macOS
 * found this), the header on the 302 is the answer.
 */
async function proxyAnswers(stateDir: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${readProxyPort(stateDir)}/`, { headers: { host: INBOX_NAME_HOST }, redirect: "manual", signal: AbortSignal.timeout(2000) });
    return response.headers.get("x-portless") !== null;
  } catch {
    return false;
  }
}

export interface InboxNameOptions {
  dataDir: string;
  serverSession: string;
  /** The window's handler (requests the name listener let in). */
  dispatch: (req: Request) => Promise<Response>;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  runner?: NameRunner;
  probe?: NameProbe;
  /** Tests: Node's path and version without running it. */
  findNode?: () => Promise<{ node: string; version: string } | null>;
  /** Tests: whether the proxy already answers. */
  proxyAnswers?: (stateDir: string) => Promise<boolean>;
  /** Tests: the person running the Inbox. Default: `os.userInfo()`. */
  user?: () => { username: string; uid: number; gid: number };
  /** Tests: whether the OS trusts the CA. Default: macOS `security verify-cert`, null elsewhere. */
  osTrust?: (stateDir: string) => Promise<boolean | null>;
  /** Tests: shorten the waits for the proxy and the route. */
  pollMs?: number;
  pollTries?: number;
  /** How long to wait for portless's proxy after the privileged step. Default 90 s (a CI Mac took over 15). */
  proxyWaitMs?: number;
}

export interface InboxName {
  /** At Inbox start: if on, open the listener, re-register the alias, probe. Never throws. */
  start(): Promise<void>;
  state(): InboxNameState;
  /** Refresh availability (Node lookup); cheap after the first call. */
  refresh(): Promise<InboxNameState>;
  /** Sure / `--name on`: runs in the background; poll `state()`. */
  enable(): InboxNameState;
  disable(): Promise<InboxNameState>;
  /** Compare-and-set: the first ask while due gets true. */
  claimDialog(): boolean;
  listenerPort(): number | null;
  stop(): void;
}

export function createInboxName(options: InboxNameOptions): InboxName {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const runner = options.runner ?? runDetached;
  const probe = options.probe ?? probeName;
  const pollMs = options.pollMs ?? 500;
  const pollTries = options.pollTries ?? 30;
  const proxyWaitMs = options.proxyWaitMs ?? 90_000;
  const log: string[] = [];
  /** Run a command and keep a line about it (never its environment). */
  const exec: NameRunner = async (line, opts) => {
    const result = await (options.runner ?? runDetached)(line, opts);
    const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-4).join(" | ").slice(0, 600);
    log.push(`${new Date().toISOString()} ${[line.command, ...line.args].join(" ").slice(0, 300)} -> ${result.timedOut ? "timed out" : `exit ${result.code}`}${tail ? `: ${tail}` : ""}`);
    if (log.length > 20) log.splice(0, log.length - 20);
    return result;
  };
  const file = join(inboxDir(options.dataDir), NAME_FILE);
  const home = env.PLANNOTATOR_PROTO_PORTLESS_HOME || join(options.dataDir, "portless");
  const userHome = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  const stateDir = env.PLANNOTATOR_PROTO_PORTLESS_STATE_DIR || join(userHome, ".portless");
  const cli = join(home, "node_modules", "portless", "dist", "cli.js");
  // Zero footprint unless switched on: no Node lookup, no listener, no process, no window row.
  const enabledHere = env.PLANNOTATOR_PROTO_FIXED_ADDRESS === "1";
  const elevation: ElevationMode = env.PLANNOTATOR_PROTO_NAME_ELEVATE === "sudo" ? "sudo" : env.PLANNOTATOR_PROTO_NAME_ELEVATE === "direct" ? "direct" : "prompt";

  const readFile = (): NameFile => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as Partial<NameFile>;
      return { v: 1, on: value.on === true, port: typeof value.port === "number" ? value.port : null, dialog_shown: value.dialog_shown === true };
    } catch {
      return { v: 1, on: false, port: null, dialog_shown: false };
    }
  };
  const writeFile = (next: NameFile) => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  };

  let saved = readFile();
  let status: NameStatus = "off";
  let step: NameStep | null = null;
  let reason: string | null = null;
  let verifiedAt: string | null = null;
  let probeDetail: string | null = null;
  let osTrusted: boolean | null = null;
  let node: { node: string; version: string } | null = null;
  let nodeChecked = false;
  let listener: ReturnType<typeof Bun.serve> | null = null;
  let job: Promise<void> | null = null;
  let stopped = false;

  const childEnv = (): Record<string, string | undefined> => ({
    ...env,
    PORTLESS_STATE_DIR: stateDir,
    PATH: node ? `${dirname(node.node)}${delimiter}${env.PATH ?? ""}` : env.PATH,
    // Never let a portless child think it is a CI or non-interactive context it is not.
    PORTLESS: undefined,
  });

  const findNode =
    options.findNode ??
    (async () => {
      const candidates = [env.PLANNOTATOR_PROTO_NODE, Bun.which("node", { PATH: env.PATH ?? "" }) ?? undefined].filter((c): c is string => !!c);
      for (const candidate of candidates) {
        let real: string;
        try {
          real = realpathSync(candidate);
        } catch {
          continue;
        }
        const result = await runner({ command: real, args: ["--version"] }, { env: { ...env }, timeoutMs: 5000 });
        if (result.code === 0) return { node: real, version: result.stdout.trim() };
      }
      return null;
    });

  const ensureNode = async (): Promise<string | null> => {
    if (!nodeChecked) {
      nodeChecked = true;
      node = await findNode().catch(() => null);
    }
    if (!node) return "Needs Node 24 or newer on this computer (portless runs on it). None was found on PATH.";
    const major = nodeMajor(node.version);
    if (major === null || major < PORTLESS_MIN_NODE_MAJOR) return `Needs Node 24 or newer; found ${node.version} at ${node.node}.`;
    return null;
  };

  const openListener = (): number => {
    if (listener) return listener.port as number;
    const serve = (port: number) =>
      Bun.serve({
        hostname: "127.0.0.1",
        port,
        idleTimeout: 0,
        fetch(req: Request, server: { requestIP(r: Request): { address: string } | null }) {
          const url = new URL(req.url, `http://${INBOX_NAME_HOST}`);
          const verdict = checkNameRequest(req.headers, url.pathname, server.requestIP(req)?.address ?? null);
          if (!verdict.ok) {
            return new Response(JSON.stringify({ error: verdict.error, code: verdict.code }), {
              status: verdict.status,
              headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
            });
          }
          return options.dispatch(req);
        },
      } as Parameters<typeof Bun.serve>[0]);
    if (saved.port) {
      try {
        listener = serve(saved.port);
      } catch {
        listener = null;
      }
    }
    if (!listener) listener = serve(0);
    return listener.port as number;
  };

  /** `later`: the request that turned it off may have come through this listener; let its answer go first. */
  const closeListener = (later = false) => {
    const closing = listener;
    listener = null;
    if (!closing) return;
    if (!later) return void closing.stop(true);
    setTimeout(() => closing.stop(true), 300);
  };

  const checkTrust =
    options.osTrust ??
    (async (dir: string): Promise<boolean | null> => {
      if (platform !== "darwin") return null;
      const result = await runner({ command: "/usr/bin/security", args: ["verify-cert", "-c", join(dir, "ca.pem"), "-p", "ssl", "-L"] }, { env: { ...env }, timeoutMs: 10_000 });
      return result.code === 0;
    });
  const untrustedNote = "The address works, but this computer does not trust portless's certificate, so browsers will warn. Run: portless trust";

  const lanMode = () => existsSync(join(stateDir, "proxy.lan"));

  const alias = async (port: number): Promise<string | null> => {
    if (!node) return "Node is missing.";
    if (lanMode()) return "portless runs in LAN mode (proxy.lan): the alias would put the Inbox on the network. Refused.";
    const result = await exec(aliasCommand(node.node, cli, port), { env: childEnv(), timeoutMs: ALIAS_TIMEOUT_MS });
    if (result.code !== 0) return `portless alias failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`;
    return null;
  };

  const verify = async (): Promise<boolean> => {
    for (let i = 0; i < pollTries && !stopped; i++) {
      const result = await probe(stateDir, options.serverSession);
      probeDetail = result.detail;
      if (result.ok) {
        verifiedAt = new Date().toISOString();
        return true;
      }
      await Bun.sleep(pollMs);
    }
    return false;
  };

  const fail = (message: string) => {
    status = "failed";
    reason = message;
    step = null;
  };

  const run = async (): Promise<void> => {
    reason = null;
    const missing = await ensureNode();
    if (missing) {
      status = "unavailable";
      reason = missing;
      step = null;
      return;
    }
    const port = openListener();
    // 2. portless into <data dir>/portless, as the person.
    if (!existsSync(cli)) {
      step = "installing";
      const npmCli = [join(dirname(node!.node), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(node!.node), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((p) => existsSync(p));
      if (!npmCli) return fail(`npm was not found next to ${node!.node}.`);
      mkdirSync(home, { recursive: true });
      const installed = await exec(npmInstallCommand(node!.node, npmCli, home), { env: childEnv(), timeoutMs: NPM_TIMEOUT_MS });
      if (installed.code !== 0 || !existsSync(cli)) return fail(`Installing portless ${PORTLESS_VERSION} failed: ${(installed.stderr || installed.stdout).trim().slice(-400) || `exit ${installed.code}`}`);
    }
    // 3. The one privileged step, only when the proxy is not already up.
    const answers = options.proxyAnswers ?? proxyAnswers;
    if (!(await answers(stateDir))) {
      step = "password";
      let line: CommandLine;
      try {
        const me = options.user ? options.user() : platform === "win32" ? { username: env.USERNAME ?? "", uid: -1, gid: -1 } : userInfo();
        line = privilegedInstallCommand(
          platform,
          { node: node!.node, cli, stateDir, user: me.username, uid: String(me.uid), gid: String(me.gid), home: userHome },
          elevation,
        );
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      const result = await exec(line, { env: childEnv(), timeoutMs: PRIVILEGED_TIMEOUT_MS });
      if (result.timedOut) return fail("The password prompt timed out. Nothing changed.");
      if (result.code !== 0) return fail(explainPrivilegedFailure(platform, result.code, result.stderr || result.stdout));
      let up = false;
      const until = Date.now() + proxyWaitMs;
      while (!stopped && Date.now() < until) {
        if (await answers(stateDir)) {
          up = true;
          break;
        }
        await Bun.sleep(pollMs);
      }
      if (!up) return fail(`portless was installed but its proxy did not answer on port 443 within ${Math.round(proxyWaitMs / 1000)} s. Run: portless doctor`);
    }
    // 4. The alias, as the person.
    step = "alias";
    const aliasError = await alias(port);
    if (aliasError) return fail(aliasError);
    // 5. Verify.
    step = "verifying";
    if (!(await verify())) return fail(`The address does not answer this Inbox yet: ${probeDetail ?? "no answer"}. localhost still works.`);
    saved = { ...readFile(), on: true, port };
    writeFile(saved);
    osTrusted = await checkTrust(stateDir).catch(() => null);
    status = "on";
    step = null;
    reason = osTrusted === false ? untrustedNote : null;
  };

  const state = (): InboxNameState => ({
    status,
    url: INBOX_NAME_URL,
    host: INBOX_NAME_HOST,
    reason,
    step,
    listener_port: listener ? (listener.port as number) : null,
    dialog_due: enabledHere && status === "off" && !readFile().dialog_shown,
    prototype: enabledHere,
    verified_at: verifiedAt,
    probe: probeDetail,
    log: [...log],
    os_trust: osTrusted,
    portless: { node: node?.node ?? null, cli: existsSync(cli) ? cli : null, state_dir: stateDir, home },
  });

  const refresh = async (): Promise<InboxNameState> => {
    if (!enabledHere) {
      status = "unavailable";
      reason = "Prototype off: start the Inbox with PLANNOTATOR_PROTO_FIXED_ADDRESS=1.";
      return state();
    }
    if (status === "off" || status === "unavailable") {
      const missing = await ensureNode();
      if (missing) {
        status = "unavailable";
        reason = missing;
      } else if (status === "unavailable") {
        status = "off";
        reason = null;
      }
    }
    return state();
  };

  return {
    async start() {
      try {
        await refresh();
        if (!saved.on || status === "unavailable") return;
        // On at the last run: same listener port when free, the alias re-pointed (no prompt), then the probe.
        status = "working";
        step = "alias";
        const port = openListener();
        if (!existsSync(cli)) return fail("portless is no longer installed; turn the fixed address on again.");
        const aliasError = await alias(port);
        if (aliasError) return fail(aliasError);
        step = "verifying";
        if (!(await verify())) return fail(`The address does not answer this Inbox: ${probeDetail ?? "no answer"}. localhost still works.`);
        if (saved.port !== port) {
          saved = { ...readFile(), on: true, port };
          writeFile(saved);
        }
        osTrusted = await checkTrust(stateDir).catch(() => null);
        status = "on";
        step = null;
        reason = osTrusted === false ? untrustedNote : null;
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    },
    state,
    refresh,
    enable() {
      if (!enabledHere || status === "working" || status === "on") return state();
      status = "working";
      step = null;
      reason = null;
      job = run()
        .catch((error) => fail(error instanceof Error ? error.message : String(error)))
        .finally(() => {
          job = null;
        });
      return state();
    },
    async disable() {
      if (!enabledHere) return state();
      if (job) await job;
      // Remove the alias only when it is ours: the hostname, a static route (pid 0), our listener's port.
      const port = listener ? (listener.port as number) : saved.port;
      if (node && existsSync(cli) && port !== null) {
        try {
          const routes = JSON.parse(readFileSync(join(stateDir, "routes.json"), "utf8")) as { hostname?: string; port?: number; pid?: number }[];
          const ours = Array.isArray(routes) && routes.some((r) => r.hostname === INBOX_NAME_HOST && r.pid === 0 && r.port === port);
          if (ours) await exec(aliasRemoveCommand(node.node, cli), { env: childEnv(), timeoutMs: ALIAS_TIMEOUT_MS });
        } catch {
          // No routes file: nothing to remove.
        }
      }
      closeListener(true);
      saved = { ...readFile(), on: false, port: saved.port };
      writeFile(saved);
      status = "off";
      step = null;
      reason = null;
      verifiedAt = null;
      return refresh();
    },
    claimDialog() {
      const current = readFile();
      if (!enabledHere || status !== "off" || current.dialog_shown) return false;
      writeFile({ ...current, dialog_shown: true });
      saved = { ...saved, dialog_shown: true };
      return true;
    },
    listenerPort: () => (listener ? (listener.port as number) : null),
    stop() {
      stopped = true;
      // A clean stop keeps the alias: the sticky port comes back next run.
      closeListener();
    },
  };
}
