/**
 * PROTOTYPE (proto/inbox-fixed-address): the fixed address's rules and its
 * routes, against a real Inbox server on loopback. Every effect goes through
 * a scripted runner and probe: no real portless, npm, osascript, pkexec,
 * sudo or `security` ever runs, and nothing outside temp folders is written.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import {
  aliasCommand,
  aliasRemoveCommand,
  assertSafePath,
  checkNameRequest,
  explainPrivilegedFailure,
  INBOX_NAME_HOST,
  isLoopbackAddress,
  nodeMajor,
  npmInstallCommand,
  privilegedInstallCommand,
  type CommandLine,
  type NameRunner,
  type PrivilegedContext,
} from "./inbox-name";

type Json = Record<string, any>;

const roots: string[] = [];
const nodeLookups = { count: 0 };
/** The rig runs the module as macOS would, or as Windows on a Windows runner (its temp paths are Windows paths). */
const PLATFORM: NodeJS.Platform = process.platform === "win32" ? "win32" : "darwin";
const isPrivileged = (line: CommandLine) => line.command === "/usr/bin/osascript" || line.command === "pkexec" || line.command === "powershell.exe";
const CANCELLED = PLATFORM === "win32" ? ["The operation was canceled by the user.", "You cancelled the Windows prompt. Nothing changed."] : ["0:300: execution error: User canceled. (-128)", "You cancelled the password prompt. Nothing changed."];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const headers = (init: Record<string, string>) => new Headers(init);

describe("the name listener's request check", () => {
  test("loopback addresses, in every spelling portless or a socket gives", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) expect(isLoopbackAddress(ip)).toBe(true);
    for (const ip of ["192.168.1.5", "10.0.0.2", "100.64.0.1", "::ffff:192.168.1.5", "fe80::1", "", "localhost", "127.0.0.256", "1270.0.0.1"]) expect(isLoopbackAddress(ip)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
  });

  test("lets in the name from this computer, as portless forwards it", () => {
    expect(checkNameRequest(headers({ host: INBOX_NAME_HOST, "x-forwarded-for": "127.0.0.1" }), "/", "127.0.0.1")).toEqual({ ok: true });
    expect(checkNameRequest(headers({ host: INBOX_NAME_HOST, "x-forwarded-for": "::1" }), "/api/inbox/threads", "::1")).toEqual({ ok: true });
    expect(checkNameRequest(headers({ host: `${INBOX_NAME_HOST}:443` }), "/", "127.0.0.1")).toEqual({ ok: true });
    expect(checkNameRequest(headers({ host: "INBOX.Plannotator.localhost" }), "/", "127.0.0.1")).toEqual({ ok: true });
  });

  test("refuses another Host, a LAN or tailnet hop, Tailscale headers and a non-loopback socket", () => {
    const refused = (h: Record<string, string>, path = "/", peer: string | null = "127.0.0.1") => {
      const verdict = checkNameRequest(headers(h), path, peer);
      return verdict.ok ? "ok" : verdict.code;
    };
    expect(refused({ host: "localhost:5000" })).toBe("forbidden_host");
    expect(refused({ host: "evil.localhost" })).toBe("forbidden_host");
    expect(refused({ host: `${INBOX_NAME_HOST}.evil.example` })).toBe("forbidden_host");
    expect(refused({})).toBe("forbidden_host");
    // portless in LAN mode forwards the Wi-Fi peer's address.
    expect(refused({ host: INBOX_NAME_HOST, "x-forwarded-for": "192.168.1.5" })).toBe("local_only");
    expect(refused({ host: INBOX_NAME_HOST, "x-forwarded-for": "127.0.0.1, 10.0.0.2" })).toBe("local_only");
    expect(refused({ host: INBOX_NAME_HOST, "x-forwarded-for": "" })).toBe("local_only");
    expect(refused({ host: INBOX_NAME_HOST, "tailscale-user-login": "ramos@example.com" })).toBe("local_only");
    expect(refused({ host: INBOX_NAME_HOST, "Tailscale-Headers-Info": "x" })).toBe("local_only");
    expect(refused({ host: INBOX_NAME_HOST }, "/", "192.168.1.5")).toBe("local_only");
  });

  test("never hands an agent's surface to the name: /mcp, connection routes, the device door", () => {
    for (const path of ["/mcp", "/mcp/", "/api/inbox/control/stop", "/api/inbox/control/name", "/api/inbox/bridge/poll", "/api/inbox/device", "/api/inbox/device/pair"]) {
      const verdict = checkNameRequest(headers({ host: INBOX_NAME_HOST, "x-forwarded-for": "127.0.0.1" }), path, "127.0.0.1");
      expect(verdict.ok ? path : (verdict as { code: string }).code).toBe("local_only");
    }
    expect(checkNameRequest(headers({ host: INBOX_NAME_HOST }), "/mcpx", "127.0.0.1")).toEqual({ ok: true });
  });
});

const MAC: PrivilegedContext = {
  node: "/Users/ramos/.local/share/fnm/node-versions/v24.15.0/installation/bin/node",
  cli: "/Users/ramos/Library/Application Support/plannotator/portless/node_modules/portless/dist/cli.js",
  stateDir: "/Users/ramos/.portless",
  user: "ramos",
  uid: "501",
  gid: "20",
  home: "/Users/ramos",
};
const WIN: PrivilegedContext = {
  node: "C:\\Program Files\\nodejs\\node.exe",
  cli: "C:\\Users\\ramos\\.plannotator\\portless\\node_modules\\portless\\dist\\cli.js",
  stateDir: "C:\\Users\\ramos\\.portless",
  user: "ramos",
  uid: "-1",
  gid: "-1",
  home: "C:\\Users\\ramos",
};

/** Hostile values a path or user name must never smuggle into a privileged command. */
const HOSTILE = ["'", '"', "$(id)", "`id`", "\n", ";", "&", "|", "\\", "..", "%PATH%", "\u0000"];

describe("the privileged command", () => {
  test("macOS: osascript with administrator privileges, every word single-quoted, the person's identity handed to portless, never --force", () => {
    const line = privilegedInstallCommand("darwin", MAC);
    expect(line.command).toBe("/usr/bin/osascript");
    expect(line.args[0]).toBe("-e");
    const script = line.args[1]!;
    expect(script.startsWith(`do shell script "'/usr/bin/env' 'SUDO_USER=ramos' 'SUDO_UID=501' 'SUDO_GID=20' 'HOME=/Users/ramos' 'PORTLESS_STATE_DIR=/Users/ramos/.portless' '${MAC.node}' '${MAC.cli}' 'service' 'install' '--state-dir' '/Users/ramos/.portless'"`)).toBe(true);
    expect(script).toContain("with administrator privileges with prompt");
    // The AppleScript string holds no quote or backslash of its own beyond the delimiters.
    const inner = script.slice('do shell script "'.length, script.indexOf('" with administrator'));
    expect(inner).not.toMatch(/["\\]/);
    expect(line.args.join(" ")).not.toContain("--force");
  });

  test("Linux: pkexec with an argv (no shell); CI modes sudo -n and direct", () => {
    const linux = { ...MAC, node: "/usr/bin/node", cli: "/home/ramos/.plannotator/portless/node_modules/portless/dist/cli.js", stateDir: "/home/ramos/.portless", home: "/home/ramos", uid: "1000", gid: "1000" };
    const prompt = privilegedInstallCommand("linux", linux);
    expect(prompt.command).toBe("pkexec");
    expect(prompt.args).toEqual(["/usr/bin/env", "SUDO_USER=ramos", "SUDO_UID=1000", "SUDO_GID=1000", "HOME=/home/ramos", "PORTLESS_STATE_DIR=/home/ramos/.portless", "/usr/bin/node", linux.cli, "service", "install", "--state-dir", "/home/ramos/.portless"]);
    expect(privilegedInstallCommand("linux", linux, "sudo")).toEqual({ command: "sudo", args: ["-n", ...prompt.args] });
    expect(privilegedInstallCommand("darwin", MAC, "direct").command).toBe("/usr/bin/env");
  });

  test("Windows: Start-Process -Verb RunAs, paths in double quotes inside one single-quoted string", () => {
    const line = privilegedInstallCommand("win32", WIN);
    expect(line.command).toBe("powershell.exe");
    const script = line.args.at(-1)!;
    expect(script).toBe(
      `$p = Start-Process -FilePath 'C:\\Program Files\\nodejs\\node.exe' -ArgumentList '"C:\\Users\\ramos\\.plannotator\\portless\\node_modules\\portless\\dist\\cli.js" service install --state-dir "C:\\Users\\ramos\\.portless"' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode`,
    );
    expect(privilegedInstallCommand("win32", WIN, "direct")).toEqual({ command: WIN.node, args: [WIN.cli, "service", "install", "--state-dir", WIN.stateDir] });
  });

  test("no value can carry a quote, a substitution, a separator or a line break into it", () => {
    for (const bad of HOSTILE) {
      for (const field of ["node", "cli", "stateDir", "home"] as const) {
        expect(() => privilegedInstallCommand("darwin", { ...MAC, [field]: `${MAC[field]}${bad}x` })).toThrow();
        expect(() => privilegedInstallCommand("linux", { ...MAC, [field]: `${MAC[field]}${bad}x` })).toThrow();
      }
      for (const field of ["node", "cli", "stateDir"] as const) {
        if (bad === "\\" || bad === "&" ) continue; // a Windows path separator; & is refused below by the rule anyway
        expect(() => privilegedInstallCommand("win32", { ...WIN, [field]: `${WIN[field]}${bad}x` })).toThrow();
      }
      if (bad !== "..") expect(() => privilegedInstallCommand("darwin", { ...MAC, user: `ramos${bad}` })).toThrow();
    }
    expect(() => privilegedInstallCommand("darwin", { ...MAC, uid: "501; id" })).toThrow();
    expect(() => privilegedInstallCommand("darwin", { ...MAC, user: "root", uid: "0" })).toThrow();
    expect(() => privilegedInstallCommand("darwin", { ...MAC, node: "node" })).toThrow();
    expect(() => assertSafePath("C:\\a&b", "win32")).toThrow();
  });

  test("the person's commands: alias with a port only, never --force; npm pins the version", () => {
    expect(aliasCommand("/n", "/c.js", 51234)).toEqual({ command: "/n", args: ["/c.js", "alias", "inbox.plannotator", "51234"] });
    expect(() => aliasCommand("/n", "/c.js", 0)).toThrow();
    expect(() => aliasCommand("/n", "/c.js", 70000)).toThrow();
    expect(aliasRemoveCommand("/n", "/c.js").args).toEqual(["/c.js", "alias", "--remove", "inbox.plannotator"]);
    expect(npmInstallCommand("/n", "/npm-cli.js", "/h").args).toContain("portless@0.15.8");
    for (const line of [aliasCommand("/n", "/c.js", 1), aliasRemoveCommand("/n", "/c.js"), npmInstallCommand("/n", "/m", "/h")]) expect(line.args).not.toContain("--force");
  });

  test("Node versions and failure messages", () => {
    expect(nodeMajor("v24.15.0\n")).toBe(24);
    expect(nodeMajor("v22.1.0")).toBe(22);
    expect(nodeMajor("nonsense")).toBeNull();
    expect(explainPrivilegedFailure("darwin", 1, "0:191: execution error: User canceled. (-128)")).toBe("You cancelled the password prompt. Nothing changed.");
    expect(explainPrivilegedFailure("linux", 126, "Error executing command as another user: Request dismissed")).toBe("You cancelled the password prompt. Nothing changed.");
    expect(explainPrivilegedFailure("darwin", 1, "boom")).toContain("boom");
  });
});

// ── The routes, against a real Inbox ──

interface Rig {
  inbox: InboxServer;
  dataDir: string;
  stateDir: string;
  home: string;
  calls: CommandLine[];
  proxy: { up: boolean };
  privileged: { code: number; stderr: string };
}

/** A temp world: data dir, a portless home and state dir, and seams that record every command instead of running it. */
async function rig(options: { off?: boolean; node?: string | null; config?: Json; dataDir?: string; tailscale?: TailscaleRunner; carry?: Rig } = {}): Promise<Rig> {
  const dataDir = options.dataDir ?? realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-name-")));
  if (!options.dataDir) roots.push(dataDir);
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(options.config ?? {}));
  const home = join(dataDir, "portless-home");
  const stateDir = join(dataDir, "portless-state");
  const calls: CommandLine[] = options.carry?.calls ?? [];
  const proxy = options.carry?.proxy ?? { up: false };
  const privileged = options.carry?.privileged ?? { code: 0, stderr: "" };
  const self: { inbox?: InboxServer } = {};
  const runner: NameRunner = async (line) => {
    calls.push(line);
    const joined = line.args.join(" ");
    if (joined.includes("npm-cli.js")) {
      const cli = join(home, "node_modules", "portless", "dist", "cli.js");
      mkdirSync(dirname(cli), { recursive: true });
      writeFileSync(cli, "// fake portless\n");
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    if (isPrivileged(line)) {
      if (privileged.code === 0) {
        proxy.up = true;
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "ca.pem"), "fake");
      }
      return { code: privileged.code, stdout: "", stderr: privileged.stderr, timedOut: false };
    }
    if (line.args.includes("alias")) {
      const port = Number(line.args.at(-1));
      mkdirSync(stateDir, { recursive: true });
      const routes = line.args.includes("--remove") ? [] : [{ hostname: INBOX_NAME_HOST, port, pid: 0 }];
      writeFileSync(join(stateDir, "routes.json"), JSON.stringify(routes));
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${line.command} ${joined}`, timedOut: false };
  };
  // A fake node next to a fake npm-cli.js, so the module finds npm where Node ships it.
  const nodeDir = join(dataDir, "node", "bin");
  mkdirSync(join(nodeDir, "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"), "");
  const node = options.node === undefined ? "v24.15.0" : options.node;
  // The probe goes through the real name listener, as portless would hand it a request.
  const probe = async (_stateDir: string, serverSession: string) => {
    const routes = existsSync(join(stateDir, "routes.json")) ? (JSON.parse(readFileSync(join(stateDir, "routes.json"), "utf8")) as { port: number }[]) : [];
    const target = routes[0]?.port;
    if (!proxy.up || !target) return { ok: false, detail: "no route" };
    const response = await fetch(`http://127.0.0.1:${target}/api/inbox/health`, { headers: { host: INBOX_NAME_HOST, "x-forwarded-for": "127.0.0.1" } });
    const body = (await response.json()) as Json;
    return { ok: body.serverSession === serverSession, detail: `status ${response.status}` };
  };
  const inbox = await startInboxServer({
    dataDir,
    binaryPath: null,
    phones: false,
    ...(options.tailscale ? { tailscale: options.tailscale } : {}),
    name: {
      platform: PLATFORM,
      proxyWaitMs: 400,
      env: { HOME: dataDir, USERPROFILE: dataDir, PATH: "/usr/bin:/bin", PLANNOTATOR_PROTO_FIXED_ADDRESS: options.off ? undefined : "1", PLANNOTATOR_PROTO_PORTLESS_HOME: home, PLANNOTATOR_PROTO_PORTLESS_STATE_DIR: stateDir },
      runner,
      probe,
      findNode: async () => {
        nodeLookups.count++;
        return node === null ? null : { node: join(nodeDir, "node"), version: node };
      },
      proxyAnswers: async () => proxy.up,
      osTrust: async () => true,
      user: () => ({ username: "ramos", uid: 501, gid: 20 }),
      pollMs: 10,
      pollTries: 20,
    },
  });
  self.inbox = inbox;
  servers.push(inbox);
  return { inbox, dataDir, stateDir, home, calls, proxy, privileged };
}

const post = (r: Rig, path: string, body: Json, init: { origin?: string; site?: string } = {}) =>
  fetch(`http://localhost:${r.inbox.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(init.origin ? { Origin: init.origin } : {}), ...(init.site ? { "Sec-Fetch-Site": init.site } : {}) },
    body: JSON.stringify(body),
  });

async function waitFor<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

describe("the fixed address's routes", () => {
  test("off by default: no Node lookup, no process, no listener, no offer, and the window gets prototype: false", async () => {
    nodeLookups.count = 0;
    const r = await rig({ off: true });
    const state = ((await (await fetch(`http://localhost:${r.inbox.port}/api/inbox/name`)).json()) as Json).name;
    expect(state).toMatchObject({ status: "unavailable", prototype: false, dialog_due: false, listener_port: null });
    expect(((await (await post(r, "/api/inbox/name/dialog", { serverSession: r.inbox.serverSession })).json()) as Json).show).toBe(false);
    expect(((await (await post(r, "/api/inbox/name", { on: true, serverSession: r.inbox.serverSession })).json()) as Json).name.status).toBe("unavailable");
    await Bun.sleep(50);
    expect(nodeLookups.count).toBe(0);
    expect(r.calls).toEqual([]);
    expect(existsSync(join(r.dataDir, "inbox", "name.json"))).toBe(false);
  });

  test("off and offered when Node 24+ is here; unavailable (never offered) without it or on an older Node", async () => {
    const ok = await rig();
    const state = ((await (await fetch(`http://localhost:${ok.inbox.port}/api/inbox/name`)).json()) as Json).name;
    expect(state).toMatchObject({ status: "off", dialog_due: true, host: INBOX_NAME_HOST, url: `https://${INBOX_NAME_HOST}/` });

    const none = await rig({ node: null });
    const noNode = ((await (await fetch(`http://localhost:${none.inbox.port}/api/inbox/name`)).json()) as Json).name;
    expect(noNode).toMatchObject({ status: "unavailable", dialog_due: false });
    expect(noNode.reason).toContain("Node 24");
    expect(((await (await post(none, "/api/inbox/name/dialog", { serverSession: none.inbox.serverSession })).json()) as Json).show).toBe(false);

    const old = await rig({ node: "v22.11.0" });
    expect(((await (await fetch(`http://localhost:${old.inbox.port}/api/inbox/name`)).json()) as Json).name.status).toBe("unavailable");
  });

  test("the one-time dialog: the first ask gets it, every later one does not", async () => {
    const r = await rig();
    expect(((await (await post(r, "/api/inbox/name/dialog", { serverSession: r.inbox.serverSession })).json()) as Json).show).toBe(true);
    expect(((await (await post(r, "/api/inbox/name/dialog", { serverSession: r.inbox.serverSession })).json()) as Json).show).toBe(false);
    expect(JSON.parse(readFileSync(join(r.dataDir, "inbox", "name.json"), "utf8")).dialog_shown).toBe(true);
  });

  test("guards: another site, a stale tab and a malformed body change nothing and run nothing", async () => {
    const r = await rig();
    expect((await post(r, "/api/inbox/name", { on: true }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(r, "/api/inbox/name", { on: true }, { site: "cross-site" })).status).toBe(403);
    expect((await post(r, "/api/inbox/name", { on: true }, { site: "same-site" })).status).toBe(403);
    expect((await post(r, "/api/inbox/name/dialog", {}, { origin: "http://localhost:1" })).status).toBe(403);
    expect((await post(r, "/api/inbox/name", { on: true, serverSession: "stale" })).status).toBe(409);
    expect((await post(r, "/api/inbox/name", { on: "yes", serverSession: r.inbox.serverSession })).status).toBe(422);
    expect((await post(r, "/api/inbox/name", { on: true, cmd: "id", serverSession: r.inbox.serverSession })).status).toBe(422);
    expect(r.calls).toEqual([]);
    // The page's own origin passes.
    expect((await post(r, "/api/inbox/name/dialog", { serverSession: r.inbox.serverSession }, { origin: `http://localhost:${r.inbox.port}` })).status).toBe(200);
  });

  test("Sure: installs portless as the person, one privileged step, the alias, then verifies through the name listener", async () => {
    const r = await rig();
    const started = ((await (await post(r, "/api/inbox/name", { on: true, serverSession: r.inbox.serverSession })).json()) as Json).name;
    expect(started.status).toBe("working");
    const on = await waitFor("on", () => (r.inbox.name.state().status === "on" ? r.inbox.name.state() : null));
    expect(on.reason).toBeNull();
    expect(on.os_trust).toBe(true);
    const listener = r.inbox.name.listenerPort()!;
    expect(listener).toBeGreaterThan(0);
    expect(listener).not.toBe(r.inbox.port);

    const kinds = r.calls.map((c) => (c.args.some((a) => a.endsWith("npm-cli.js")) ? "npm" : isPrivileged(c) ? "privileged" : c.args.includes("alias") ? "alias" : c.command));
    expect(kinds).toEqual(["npm", "privileged", "alias"]);
    const aliasCall = r.calls.find((c) => c.args.includes("alias"))!;
    expect(aliasCall.args.slice(1)).toEqual(["alias", "inbox.plannotator", String(listener)]);
    for (const call of r.calls) expect(call.args.join(" ")).not.toContain("--force");
    expect(JSON.parse(readFileSync(join(r.dataDir, "inbox", "name.json"), "utf8"))).toMatchObject({ on: true, port: listener });

    // Through the name listener: the window, and a same-origin write from the name's page.
    const viaName = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
      fetch(`http://127.0.0.1:${listener}${path}`, { ...init, headers: { host: INBOX_NAME_HOST, "x-forwarded-for": "127.0.0.1", ...(init.headers ?? {}) } });
    expect((await viaName("/api/inbox/threads")).status).toBe(200);
    expect((await viaName("/api/inbox/settings")).status).toBe(200);
    const write = await viaName("/api/inbox/threads/msg_00000000000000000000000000/seen", {
      method: "POST",
      headers: { Origin: `https://${INBOX_NAME_HOST}`, "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: r.inbox.serverSession }),
    });
    expect(write.status).not.toBe(403);
    // ...and nothing an agent uses, nor another host or a LAN hop.
    expect((await viaName("/mcp", { method: "POST", body: "{}" })).status).toBe(403);
    expect((await viaName("/api/inbox/control/stop", { method: "POST", headers: { Authorization: `Bearer ${r.inbox.token}` } })).status).toBe(403);
    expect((await viaName("/api/inbox/threads", { headers: { "x-forwarded-for": "192.168.1.5" } })).status).toBe(403);
    expect((await fetch(`http://127.0.0.1:${listener}/api/inbox/threads`, { headers: { host: `localhost:${listener}` } })).status).toBe(403);
    // The window's own port still refuses anything forwarded.
    expect((await fetch(`http://localhost:${r.inbox.port}/api/inbox/threads`, { headers: { "x-forwarded-for": "127.0.0.1" } })).status).toBe(403);
  });

  test("a cancelled password prompt: failed, said plainly, nothing switched on, Try again works", async () => {
    const r = await rig();
    r.privileged.code = 1;
    r.privileged.stderr = CANCELLED[0]!;
    await post(r, "/api/inbox/name", { on: true, serverSession: r.inbox.serverSession });
    const failed = await waitFor("failed", () => (r.inbox.name.state().status === "failed" ? r.inbox.name.state() : null));
    expect(failed.reason).toBe(CANCELLED[1]!);
    expect(r.calls.some((c) => c.args.includes("alias"))).toBe(false);
    const file = join(r.dataDir, "inbox", "name.json");
    expect(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).on : false).toBe(false);
    r.privileged.code = 0;
    await post(r, "/api/inbox/name", { on: true, serverSession: r.inbox.serverSession });
    await waitFor("on after retry", () => r.inbox.name.state().status === "on");
  });

  test("the next start keeps the name: alias re-pointed with no prompt, same listener port when free; a new window port changes nothing", async () => {
    const first = await rig();
    await post(first, "/api/inbox/name", { on: true, serverSession: first.inbox.serverSession });
    await waitFor("on", () => first.inbox.name.state().status === "on");
    const listener = first.inbox.name.listenerPort()!;
    const windowPort = first.inbox.port;
    first.inbox.stop();
    servers.splice(servers.indexOf(first.inbox), 1);
    // Hold the window's old port, so the next run must move (the real-world case the name is for).
    const squatter = Bun.serve({ hostname: "127.0.0.1", port: windowPort, fetch: () => new Response("someone else") });
    try {
      first.calls.length = 0;
      const second = await rig({ dataDir: first.dataDir, carry: first });
      await waitFor("on again", () => second.inbox.name.state().status === "on");
      expect(second.inbox.port).not.toBe(windowPort);
      expect(second.inbox.name.listenerPort()).toBe(listener);
      expect(first.calls.some(isPrivileged)).toBe(false);
      expect(first.calls.filter((c) => c.args.includes("alias")).map((c) => c.args.at(-1))).toEqual([String(listener)]);
      const health = (await (await fetch(`http://127.0.0.1:${listener}/api/inbox/health`, { headers: { host: INBOX_NAME_HOST } })).json()) as Json;
      expect(health.serverSession).toBe(second.inbox.serverSession);
    } finally {
      squatter.stop(true);
    }
  });

  test("off removes only our alias and closes the listener", async () => {
    const r = await rig();
    await post(r, "/api/inbox/name", { on: true, serverSession: r.inbox.serverSession });
    await waitFor("on", () => r.inbox.name.state().status === "on");
    const listener = r.inbox.name.listenerPort()!;
    const off = ((await (await post(r, "/api/inbox/name", { on: false, serverSession: r.inbox.serverSession })).json()) as Json).name;
    expect(off.status).toBe("off");
    expect(r.calls.at(-1)!.args.slice(1)).toEqual(["alias", "--remove", "inbox.plannotator"]);
    expect(r.inbox.name.listenerPort()).toBeNull();
    // The answer to the request that turned it off may come through the listener; it closes a moment later.
    await Bun.sleep(600);
    await expect(fetch(`http://127.0.0.1:${listener}/`, { headers: { host: INBOX_NAME_HOST } })).rejects.toThrow();
    // Someone else's alias for the name (another port): left alone.
    writeFileSync(join(r.stateDir, "routes.json"), JSON.stringify([{ hostname: INBOX_NAME_HOST, port: 1, pid: 0 }]));
    r.calls.length = 0;
    await post(r, "/api/inbox/name", { on: false, serverSession: r.inbox.serverSession });
    expect(r.calls).toEqual([]);
  });

  test("never through the tailnet, even for the owner", async () => {
    const MAGIC = "mac.tail0000.ts.net";
    const OWNER = "ramos@example.com";
    const serve = new Map<number, string>();
    const run: TailscaleRunner = (args) => {
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
      if (args[1] === "status") {
        if (serve.size === 0) return ok("{}");
        return ok(JSON.stringify({ TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])), Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])) }));
      }
      const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) {
        serve.delete(httpsPort);
        return ok();
      }
      serve.set(httpsPort, args.at(-1)!);
      return ok(`https://${MAGIC}:${httpsPort}/\n`);
    };
    const r = await rig({ config: { inboxTailscale: true }, tailscale: run });
    const tailnet = r.inbox.tailscale.listenerPort()!;
    expect(tailnet).toBeGreaterThan(0);
    const through = (path: string, init: { method?: string; body?: string } = {}) =>
      fetch(`http://127.0.0.1:${tailnet}${path}`, {
        method: init.method ?? "GET",
        headers: { Host: `${MAGIC}:${r.inbox.port}`, "Tailscale-User-Login": OWNER, Origin: `https://${MAGIC}:${r.inbox.port}`, "Content-Type": "application/json" },
        body: init.body,
      });
    expect((await through("/api/inbox/threads")).status).toBe(200);
    for (const [path, method, body] of [
      ["/api/inbox/name", "GET", undefined],
      ["/api/inbox/name", "POST", JSON.stringify({ on: true, serverSession: r.inbox.serverSession })],
      ["/api/inbox/name/dialog", "POST", JSON.stringify({ serverSession: r.inbox.serverSession })],
    ] as const) {
      const response = await through(path, { method, body });
      expect([response.status, ((await response.json()) as Json).code]).toEqual([403, "local_only"]);
    }
    expect(r.calls).toEqual([]);
    r.inbox.tailscale.stop();
  });
});
