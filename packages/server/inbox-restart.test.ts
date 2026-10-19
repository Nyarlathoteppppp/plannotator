/**
 * The restart warning (owner approval "restart-warning", 2026-10-19): which
 * polling agent sessions run an older Plannotator plugin than a restart would
 * load. First the rules alone (packages/server/inbox-restart.ts), then over a
 * real Inbox with a temp data dir and a scratch CLAUDE_CONFIG_DIR holding a
 * fake `plugins/installed_plugins.json`: the sessions route's
 * `asker.connection.outdated`, Settings → Agents' `sessions`, and the list
 * model's `restart_claude_code`. Nothing reads the real ~/.claude.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxAgentsModel } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_POLL_PATH, INBOX_SEND_NOW_POLL_FIELD, INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";
import {
  claudeRestartCommand,
  CLAUDE_PLUGIN_UPDATE_COMMAND,
  claudeSessionOutdated,
  parseClaudePluginInstall,
  piSessionOutdated,
  PLUGIN_REPORTS_LOADED_SINCE,
  type ClaudePluginInstall,
  type LoadedPlugin,
} from "./inbox-restart";

const PLUGINS = "/home/me/.claude/plugins";
const folder = (version: string) => `${PLUGINS}/cache/plannotator/plannotator/${version}`;
const UPDATED_AT = Date.parse("2026-10-17T05:27:07.299Z");
const install = (version: string, overrides: Partial<ClaudePluginInstall> = {}): ClaudePluginInstall => ({
  version,
  installPath: folder(version),
  lastUpdated: UPDATED_AT,
  ...overrides,
});
const loaded = (version: string, overrides: Partial<LoadedPlugin> = {}): LoadedPlugin => ({
  version,
  root: folder(version),
  loadedAt: UPDATED_AT + 60_000,
  ...overrides,
});
const judge = (plugin: LoadedPlugin | null, record: ClaudePluginInstall | null, cliVersion = "0.28.25") =>
  claudeSessionOutdated({ loaded: plugin, install: record, cliVersion, pluginsDir: PLUGINS });

describe("claudeSessionOutdated: the rules", () => {
  test("up to date: the installed plugin, from its folder, loaded after the update", () => {
    expect(judge(loaded("0.28.25"), install("0.28.25"))).toBeNull();
  });

  test("the versions differ: restart", () => {
    expect(judge(loaded("0.28.24"), install("0.28.25"))).toEqual({ loaded: "0.28.24", installed: "0.28.25", fix: "restart" });
  });

  test("the folder differs (same version reported): restart", () => {
    expect(judge(loaded("0.28.25", { root: `${PLUGINS}/marketplaces/plannotator/apps/hook` }), install("0.28.25"))).toEqual({
      loaded: "0.28.25",
      installed: "0.28.25",
      fix: "restart",
    });
  });

  test("an update that reused the folder and kept the version: only loaded_at < lastUpdated catches it", () => {
    expect(judge(loaded("0.28.25", { loadedAt: UPDATED_AT - 1 }), install("0.28.25"))).toEqual({ loaded: "0.28.25", installed: "0.28.25", fix: "restart" });
    expect(judge(loaded("0.28.25", { loadedAt: UPDATED_AT }), install("0.28.25"))).toBeNull();
  });

  test("no plugin field while the installed plugin reports it: outdated, version unknown", () => {
    expect(judge(null, install(PLUGIN_REPORTS_LOADED_SINCE), PLUGIN_REPORTS_LOADED_SINCE)).toEqual({
      loaded: null,
      installed: PLUGIN_REPORTS_LOADED_SINCE,
      fix: "restart",
    });
    expect(judge(null, install("0.28.25"))?.fix).toBe("restart");
  });

  test("no plugin field while the installed plugin predates the field: the Inbox cannot tell", () => {
    expect(judge(null, install("0.28.23"), "0.28.23")).toBeNull();
  });

  test("the installed plugin is behind this Inbox: update the plugin, not restart", () => {
    // The session runs the installed (old) plugin: a restart loads the same one.
    expect(judge(loaded("0.28.23"), install("0.28.23"))).toEqual({ loaded: "0.28.23", installed: "0.28.23", fix: "update_plugin", update_command: CLAUDE_PLUGIN_UPDATE_COMMAND });
    // Older still than the installed one: a restart helps only part way, so the plugin update is the fix.
    expect(judge(loaded("0.28.21"), install("0.28.23"))?.fix).toBe("update_plugin");
    // No field, installed predates it and is behind this Inbox.
    expect(judge(null, install("0.28.23"))).toMatchObject({ loaded: null, installed: "0.28.23", fix: "update_plugin" });
    // A development Inbox never says the plugin is behind it.
    expect(judge(loaded("0.28.23"), install("0.28.23"), "dev")).toBeNull();
  });

  test("a plugin loaded with --plugin-dir (outside Claude Code's plugin folder) reloads that folder: never outdated", () => {
    expect(judge(loaded("0.28.20", { root: "/home/me/code/plannotator/apps/hook", loadedAt: 1 }), install("0.28.25"))).toBeNull();
  });

  test("no installed record: nothing to compare", () => {
    expect(judge(loaded("0.28.20"), null)).toBeNull();
    expect(judge(null, null)).toBeNull();
  });

  test("Pi: the extension behind this Inbox's release", () => {
    expect(piSessionOutdated({ version: "0.28.20", root: null, loadedAt: null }, "0.28.25")).toEqual({ loaded: "0.28.20", installed: "0.28.25", fix: "update_extension" });
    expect(piSessionOutdated({ version: "0.28.25", root: null, loadedAt: null }, "0.28.25")).toBeNull();
    expect(piSessionOutdated(null, "0.28.25")).toBeNull();
    expect(piSessionOutdated({ version: "0.28.20", root: null, loadedAt: null }, "dev")).toBeNull();
  });
});

describe("parseClaudePluginInstall", () => {
  test("v2: the user-scope record of plannotator@*", () => {
    const text = JSON.stringify({
      version: 2,
      plugins: {
        "other@x": [{ scope: "user", version: "9.9.9", installPath: "/x", lastUpdated: "2026-01-01T00:00:00Z" }],
        "plannotator@plannotator": [
          { scope: "project", version: "0.28.1", installPath: "/p", lastUpdated: "2026-01-01T00:00:00Z" },
          { scope: "user", version: "0.28.23", installPath: folder("0.28.23"), installedAt: "2026-10-04T22:07:24.658Z", lastUpdated: "2026-10-17T05:27:07.299Z" },
        ],
      },
    });
    expect(parseClaudePluginInstall(text)).toEqual({ version: "0.28.23", installPath: folder("0.28.23"), lastUpdated: UPDATED_AT });
  });

  test("v1 (an object per id), installedAt when lastUpdated is missing; junk is null", () => {
    expect(parseClaudePluginInstall(JSON.stringify({ "plannotator@plannotator": { version: "0.27.1", installPath: "/a", installedAt: "2026-10-17T05:27:07.299Z" } }))).toEqual({
      version: "0.27.1",
      installPath: "/a",
      lastUpdated: UPDATED_AT,
    });
    expect(parseClaudePluginInstall("{")).toBeNull();
    expect(parseClaudePluginInstall(JSON.stringify({ plugins: {} }))).toBeNull();
  });
});

describe("claudeRestartCommand", () => {
  test("the same session again, in its folder; unusual folders quoted, ~ kept", () => {
    expect(claudeRestartCommand("~/code/billing-api", "6f2c9e14-8b0d-4c5a-9e27-1d3b7a0c4f81")).toBe(
      "cd ~/code/billing-api && claude --resume 6f2c9e14-8b0d-4c5a-9e27-1d3b7a0c4f81",
    );
    expect(claudeRestartCommand("~/my code/it's", "abc")).toBe("cd ~/'my code/it'\\''s' && claude --resume abc");
    expect(claudeRestartCommand("/srv/a b", "x;rm")).toBe("cd '/srv/a b' && claude --resume 'x;rm'");
  });
});

// ── Over a real Inbox ──

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world(options: { inboxVersion: string; installed: { version: string; lastUpdated?: string } | null }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-restart-")));
  roots.push(root);
  const home = join(root, "home");
  const claudeDir = join(home, ".claude");
  const pluginsDir = join(claudeDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const project = join(home, "code", "billing-api");
  mkdirSync(project, { recursive: true });
  const installPath = (version: string) => join(pluginsDir, "cache", "plannotator", "plannotator", version);
  if (options.installed) {
    writeFileSync(
      join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "plannotator@plannotator": [
            {
              scope: "user",
              installPath: installPath(options.installed.version),
              version: options.installed.version,
              installedAt: "2026-10-04T22:07:24.658Z",
              lastUpdated: options.installed.lastUpdated ?? "2026-10-17T05:27:07.299Z",
            },
          ],
        },
      }),
    );
  }
  const agentEnvironment = createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, CLAUDE_CONFIG_DIR: claudeDir, PATH: "" } });
  const server = await startInboxServer({
    dataDir: join(root, "data"),
    version: options.inboxVersion,
    binaryPath: null,
    agentEnvironment,
    updates: { fetchRelease: async () => ({ ok: false, error: "offline in tests" }), isManaged: () => false, listSessions: () => [] },
  });
  servers.push(server);
  const client = new Client({ name: "inbox-restart-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, installPath };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function poll(server: InboxServer, session: string, body: Record<string, unknown>) {
  const response = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", waitMs: 0, ...body }),
  });
  expect(response.status).toBe(200);
}

async function asked(client: Client, project: string, session: string) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body: "Shipped it. Anything else?", project_path: project, agent_session: session, agent_host: "claude-code" },
    _meta: { [INBOX_WAKES_META_KEY]: true },
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

async function connection(server: InboxServer, threadId: string, session: string) {
  const body = (await (await fetch(`${base(server)}/api/inbox/threads/${threadId}/sessions?asker=${session}`)).json()) as {
    asker: { connection: { busy: boolean | null; send_now: boolean; outdated: unknown; engine: string | null; restart_command: string | null } | null };
  };
  return body.asker.connection;
}

const agents = async (server: InboxServer) => (await (await fetch(`${base(server)}/api/inbox/agents`)).json()) as InboxAgentsModel;
const list = async (server: InboxServer) => (await (await fetch(`${base(server)}/api/inbox/threads?archived=exclude`)).json()) as { restart_claude_code?: number };

describe("over a real Inbox", () => {
  test("a busy session on an older plugin: its connection says outdated (with the engine); Settings and the sidebar count it; up to date it clears", async () => {
    const { server, client, project, installPath } = await world({ inboxVersion: "0.28.25", installed: { version: "0.28.25" } });
    const thread = await asked(client, project, "ses-old");
    const old = { version: "0.28.24", root: installPath("0.28.24"), loaded_at: Date.parse("2026-10-16T00:00:00Z") };
    await poll(server, "ses-old", { project_path: project, busy: true, plugin: old, engine: "2.1.305" });
    expect(await connection(server, thread.thread_id, "ses-old")).toMatchObject({
      busy: true,
      send_now: false,
      outdated: { loaded: "0.28.24", installed: "0.28.25", fix: "restart" },
      engine: "2.1.305",
      restart_command: "cd ~/code/billing-api && claude --resume ses-old",
    });
    // Another, up to date (loaded after the update, from the installed folder).
    await poll(server, "ses-new", { project_path: project, busy: false, plugin: { version: "0.28.25", root: installPath("0.28.25"), loaded_at: Date.now() }, [INBOX_SEND_NOW_POLL_FIELD]: true });
    const model = await agents(server);
    const cc = model.sessions?.["claude-code"];
    expect(cc).toMatchObject({ running: 2, outdated: 1, installed: "0.28.25", update_command: null });
    const stale = cc!.sessions.find((s) => s.session === "ses-old")!;
    expect(stale).toMatchObject({ project: "billing-api", folder: "~/code/billing-api", plugin: "0.28.24", busy: true });
    expect(stale.restart_command).toBe("cd ~/code/billing-api && claude --resume ses-old");
    expect(cc!.sessions.find((s) => s.session === "ses-new")!.outdated).toBeNull();
    expect((await list(server)).restart_claude_code).toBe(1);
    // It restarts (same session id), now on the installed plugin: the line, the row and the count clear.
    await poll(server, "ses-old", { project_path: project, busy: true, plugin: { version: "0.28.25", root: installPath("0.28.25"), loaded_at: Date.now() } });
    expect((await connection(server, thread.thread_id, "ses-old"))!.outdated).toBeNull();
    expect((await list(server)).restart_claude_code).toBe(0);
  });

  test("an older mod that sends no plugin field, while the installed plugin reports it: outdated, version unknown", async () => {
    const { server, client, project } = await world({ inboxVersion: "0.28.25", installed: { version: "0.28.25" } });
    const thread = await asked(client, project, "ses-legacy");
    await poll(server, "ses-legacy", { project_path: project, busy: true });
    expect((await connection(server, thread.thread_id, "ses-legacy"))!.outdated).toEqual({ loaded: null, installed: "0.28.25", fix: "restart" });
    expect((await list(server)).restart_claude_code).toBe(1);
  });

  test("the same version reinstalled into the same folder after the session loaded it: outdated by the load time alone", async () => {
    const { server, client, project, installPath } = await world({ inboxVersion: "0.28.25", installed: { version: "0.28.25", lastUpdated: "2026-10-18T12:00:00.000Z" } });
    const thread = await asked(client, project, "ses-same");
    await poll(server, "ses-same", { project_path: project, busy: true, plugin: { version: "0.28.25", root: installPath("0.28.25"), loaded_at: Date.parse("2026-10-18T11:00:00.000Z") } });
    expect((await connection(server, thread.thread_id, "ses-same"))!.outdated).toEqual({ loaded: "0.28.25", installed: "0.28.25", fix: "restart" });
  });

  test("the installed plugin is behind this Inbox: update the plugin (the command), and no restart in the sidebar", async () => {
    const { server, client, project, installPath } = await world({ inboxVersion: "0.28.25", installed: { version: "0.28.23" } });
    const thread = await asked(client, project, "ses-behind");
    await poll(server, "ses-behind", { project_path: project, busy: true, plugin: { version: "0.28.23", root: installPath("0.28.23"), loaded_at: Date.now() } });
    expect((await connection(server, thread.thread_id, "ses-behind"))!.outdated).toMatchObject({ loaded: "0.28.23", installed: "0.28.23", fix: "update_plugin", update_command: CLAUDE_PLUGIN_UPDATE_COMMAND });
    const cc = (await agents(server)).sessions?.["claude-code"];
    expect(cc?.update_command).toBe("claude plugin marketplace update plannotator && claude plugin update plannotator@plannotator --scope user");
    expect((await list(server)).restart_claude_code).toBe(0);
  });

  test("Pi reports its extension version; behind the Inbox it needs an update", async () => {
    const { server, project } = await world({ inboxVersion: "0.28.25", installed: null });
    const response = await fetch(`${base(server)}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session: "pi-1", host: "pi", waitMs: 0, project_path: project, plugin: { version: "0.28.20" } }),
    });
    expect(response.status).toBe(200);
    const pi = (await agents(server)).sessions?.pi;
    expect(pi).toMatchObject({ running: 1, outdated: 1, installed: "0.28.25" });
    expect(pi!.sessions[0]).toMatchObject({ plugin: "0.28.20", outdated: { fix: "update_extension" }, restart_command: null });
  });

  test("no installed record and an older Inbox's poll: nothing is said", async () => {
    const { server, client, project } = await world({ inboxVersion: "0.28.25", installed: null });
    const thread = await asked(client, project, "ses-x");
    await poll(server, "ses-x", { project_path: project, busy: true });
    expect((await connection(server, thread.thread_id, "ses-x"))!.outdated).toBeNull();
    expect((await list(server)).restart_claude_code).toBe(0);
  });
});
