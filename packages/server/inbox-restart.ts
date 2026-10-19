/**
 * Plannotator Inbox: which agent sessions need a restart after an update
 * (owner approval "restart-warning", 2026-10-19; design record not in this
 * repo).
 *
 * The Claude Code mod reports what it loaded on every bridge poll
 * (`plugin: { version, root, loaded_at }`, read once when the module loads,
 * and `engine`). A restart of that Claude Code would load the plugin Claude
 * Code has installed now, which its registry records
 * (`<CLAUDE_CONFIG_DIR>/plugins/installed_plugins.json`: `version`,
 * `installPath`, `lastUpdated`). A session is outdated when what it loaded is
 * not what a restart loads:
 *  - the versions differ;
 *  - its plugin folder is not the installed one (an update into a new folder);
 *  - it loaded the plugin before the registry's `lastUpdated` (an update that
 *    reused the folder and kept the version: only this rule catches it).
 * A session that polls with no `plugin` field runs a mod older than the field
 * (`PLUGIN_REPORTS_LOADED_SINCE`); when the installed plugin is at least that
 * release, a restart loads a newer one, so it is outdated with its version
 * unknown.
 *
 * When the installed plugin is itself behind this Inbox's Plannotator (the
 * plugin was not updated: `--skip-claude-plugin`, a marketplace not updated),
 * a restart does not help: `fix: "update_plugin"`, with the command.
 *
 * Only the rules above are judged for a plugin loaded from Claude Code's own
 * plugin folder. A session started with `claude --plugin-dir <dir>` (a
 * checkout) reloads that folder when restarted, so the installed record says
 * nothing about it: never outdated.
 *
 * Pi reports its extension's version only (it has no registry the Inbox can
 * read): behind this Inbox's own release it is `fix: "update_extension"`
 * (`pi update --extensions`, then `/reload`).
 */

import { readAgentFile } from "./agent-files";
import { claudeConfigDir, type AgentEnvironment } from "./inbox-agents";
import { compareStableVersions, parseStableVersion, CLAUDE_PLUGIN_UPDATE_COMMANDS } from "@plannotator/shared/update-check";
import type { InboxSessionOutdated } from "@plannotator/core/inbox-types";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * The first Plannotator release whose Claude Code mod reports `plugin` on its
 * poll. An installed plugin at least this new, polled by a session that sends
 * no `plugin`, means a restart loads a newer plugin than the session runs.
 */
export const PLUGIN_REPORTS_LOADED_SINCE = "0.28.24";

/** What a session's poll said it loaded (validated). */
export interface LoadedPlugin {
  version: string | null;
  root: string | null;
  /** When the module loaded, ms. */
  loadedAt: number | null;
}

/** Plannotator's record in Claude Code's plugin registry. */
export interface ClaudePluginInstall {
  version: string | null;
  installPath: string | null;
  /** `lastUpdated` (else `installedAt`), ms. */
  lastUpdated: number | null;
}

const CLAUDE_PLUGIN_ID = /^plannotator@/;
const MAX_FIELD = 4096;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() && value.length <= MAX_FIELD ? value.trim() : null);
const ms = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
};

/** A poll's `plugin` field: null when absent or not an object. */
export function parseLoadedPlugin(value: unknown): LoadedPlugin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const root = str(record.root);
  return { version: str(record.version), root: root && isAbsolute(root) ? root : null, loadedAt: ms(record.loaded_at) };
}

/** A poll's `engine` field (Claude Code's own version). */
export function parseEngine(value: unknown): string | null {
  const text = str(value);
  return text && text.length <= 64 ? text : null;
}

/** The record from `installed_plugins.json` (v2 `{ plugins: { id: [records] } }`, or the v1 object); the user-scope record first. */
export function parseClaudePluginInstall(text: string): ClaudePluginInstall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as { plugins?: unknown } & Record<string, unknown>;
  const table = (root.plugins && typeof root.plugins === "object" ? root.plugins : root) as Record<string, unknown>;
  const candidates: Record<string, unknown>[] = [];
  for (const [id, value] of Object.entries(table)) {
    if (!CLAUDE_PLUGIN_ID.test(id)) continue;
    for (const record of Array.isArray(value) ? value : [value]) {
      if (record && typeof record === "object" && !Array.isArray(record)) candidates.push(record as Record<string, unknown>);
    }
  }
  if (candidates.length === 0) return null;
  const record = candidates.find((candidate) => candidate.scope === undefined || candidate.scope === "user") ?? candidates[0]!;
  const installPath = str(record.installPath);
  return {
    version: str(record.version),
    installPath: installPath && isAbsolute(installPath) ? installPath : null,
    lastUpdated: ms(record.lastUpdated) ?? ms(record.installedAt),
  };
}

/** How long a read of the registry is reused: every poll and every window read asks. */
const INSTALL_FRESH_MS = 2_000;

/** Reads Claude Code's plugin registry for Plannotator's record, at most once per `INSTALL_FRESH_MS`. */
export function createClaudePluginInstallReader(environment: AgentEnvironment, now: () => number = Date.now) {
  let cached: { at: number; value: ClaudePluginInstall | null } | null = null;
  const read = (): ClaudePluginInstall | null => {
    if (cached && now() - cached.at < INSTALL_FRESH_MS) return cached.value;
    const file = readAgentFile(join(claudeConfigDir(environment), "plugins", "installed_plugins.json"));
    const value = file.kind === "file" ? parseClaudePluginInstall(file.text) : null;
    cached = { at: now(), value };
    return value;
  };
  return { read, pluginsDir: () => join(claudeConfigDir(environment), "plugins") };
}

const isRelease = (version: string | null | undefined): version is string => !!version && parseStableVersion(version) !== null;
const isUnder = (path: string, dir: string) => {
  const a = resolve(path);
  const b = resolve(dir);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

/** Whether `a` is older than `b`, both releases; false when either is not one. */
const older = (a: string | null, b: string | null) => isRelease(a) && isRelease(b) && compareStableVersions(a, b) === -1;

/**
 * Claude Code: whether a session that polls with `loaded` (null: it sent no
 * `plugin`) runs an older plugin than a restart loads, or than this Inbox.
 * `cliVersion` is this Inbox's version (`dev` and other non-releases skip the
 * plugin-behind-Inbox rule); `pluginsDir` is Claude Code's plugin folder.
 */
export function claudeSessionOutdated(input: Parameters<typeof judgeClaudeSession>[0]): InboxSessionOutdated | null {
  const outdated = judgeClaudeSession(input);
  return outdated?.fix === "update_plugin" ? { ...outdated, update_command: CLAUDE_PLUGIN_UPDATE_COMMAND } : outdated;
}

function judgeClaudeSession(input: {
  loaded: LoadedPlugin | null;
  install: ClaudePluginInstall | null;
  cliVersion: string;
  pluginsDir: string;
}): InboxSessionOutdated | null {
  const { loaded, install, cliVersion } = input;
  if (!install) return null;
  const installed = install.version;
  const installedBehindInbox = older(installed, cliVersion);
  if (!loaded) {
    // A mod older than the field. It runs at most the installed plugin; when that is new enough to report, a restart brings it.
    if (isRelease(installed) && compareStableVersions(installed, PLUGIN_REPORTS_LOADED_SINCE)! >= 0) {
      return { loaded: null, installed, fix: installedBehindInbox ? "update_plugin" : "restart" };
    }
    return installedBehindInbox ? { loaded: null, installed, fix: "update_plugin" } : null;
  }
  // A plugin loaded from elsewhere (`--plugin-dir`): a restart reloads that folder, not the installed one.
  if (loaded.root && !isUnder(loaded.root, input.pluginsDir)) return null;
  const versionDiffers = !!loaded.version && !!installed && loaded.version !== installed;
  const folderDiffers = !!loaded.root && !!install.installPath && resolve(loaded.root) !== resolve(install.installPath);
  const loadedBefore = loaded.loadedAt !== null && install.lastUpdated !== null && loaded.loadedAt < install.lastUpdated;
  // Behind this Inbox, and the installed plugin too: a restart alone loads another old plugin.
  if (installedBehindInbox && (older(loaded.version, cliVersion) || !loaded.version)) return { loaded: loaded.version, installed, fix: "update_plugin" };
  if (versionDiffers || folderDiffers || loadedBefore) return { loaded: loaded.version, installed, fix: "restart" };
  return null;
}

/** Whether Claude Code's installed plugin is behind this Inbox's release (a restart alone would not help). */
export function claudePluginBehindInbox(install: ClaudePluginInstall | null, cliVersion: string): boolean {
  return !!install && older(install.version, cliVersion);
}

/** Pi: the extension's version behind this Inbox's release (`pi update --extensions`, then `/reload`). */
export function piSessionOutdated(loaded: LoadedPlugin | null, cliVersion: string): InboxSessionOutdated | null {
  if (!loaded?.version || !older(loaded.version, cliVersion)) return null;
  return { loaded: loaded.version, installed: cliVersion, fix: "update_extension" };
}

/** The command that updates the Claude Code plugin itself (the install script's two steps). */
export const CLAUDE_PLUGIN_UPDATE_COMMAND = `${CLAUDE_PLUGIN_UPDATE_COMMANDS.join(" && ")} --scope user`;

/** A folder for a shell line: `~` kept unquoted at the start, anything unusual single-quoted. */
export function shellFolder(folder: string): string {
  const safe = /^[A-Za-z0-9_./+@:,=-]+$/;
  if (folder === "~") return "~";
  if (folder.startsWith("~/")) {
    const rest = folder.slice(2);
    return rest === "" || safe.test(rest) ? folder : `~/${singleQuote(rest)}`;
  }
  return safe.test(folder) ? folder : singleQuote(folder);
}

const singleQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** `cd <folder> && claude --resume <session>`: the same Claude Code session again, in its folder. */
export function claudeRestartCommand(folder: string, session: string): string {
  const id = /^[A-Za-z0-9._-]+$/.test(session) ? session : singleQuote(session);
  return `cd ${shellFolder(folder)} && claude --resume ${id}`;
}
