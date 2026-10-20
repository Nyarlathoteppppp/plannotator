/**
 * Tag agents in a reply (approval "inbox-tag-agents", Lines variant), proved
 * through the server's real doors: the reply route's `tags`, the connections'
 * polls and acknowledgements, the taggable and sessions routes, Send now, and
 * the agent's MCP tools through the official SDK client. Every test uses its
 * own temp data dir.
 *
 * The bug the approval came with: a reply without `to` used to count as read
 * when ANY agent read the thread, so a tagged agent told to read the thread
 * first could swallow the owner's wake. A reply with tags is settled for each
 * recipient only by its own delivery or its own wait_for_reply.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxThread } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_TAGGED_INSTRUCTION,
  INBOX_WAKE_INSTRUCTION,
  INBOX_WAKES_META_KEY,
  inboxAlsoTaggedLine,
  inboxTaggedLine,
  inboxWakeText,
  parseInboxBridgeCommands,
} from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-tags-")));
  roots.push(root);
  const project = join(root, "billing-api");
  const infra = join(root, "infra");
  mkdirSync(project, { recursive: true });
  mkdirSync(infra, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-tags-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, infra };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

/** An agent's send, through a waking connection (`wakes`) or plain MCP. */
async function agentSends(client: Client, project: string, session: string, body: string, who: { host: string; name: string; wakes: boolean }) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: who.host, agent_name: who.name },
    ...(who.wakes ? { _meta: { [INBOX_WAKES_META_KEY]: true } } : {}),
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

function bridge(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body),
  });
}

/** One poll from a connection: `tags` true (a connection that understands tags) unless said otherwise. */
async function poll(server: InboxServer, session: string, host: string, project: string, extra: Record<string, unknown> = { tags: true }) {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, host, project_path: project, waitMs: 0, ...extra });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

async function delivered(server: InboxServer, session: string, host: string, id: string) {
  const response = await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session, host, type: "delivered", id });
  expect(response.status).toBe(200);
}

function reply(server: InboxServer, messageId: string, body: Record<string, unknown>) {
  return fetch(`${base(server)}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

async function row(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const list = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: InboxListRow[] }[] };
  return list.sections.flatMap((s) => s.threads).find((r) => r.thread_id === threadId)!;
}

const CLAUDE = { host: "claude-code", name: "Claude Code", wakes: true };
const CODEX = { host: "codex", name: "Codex", wakes: false };

describe("tags in a reply", () => {
  test("the owner and every tagged session are each handed the one reply once, with the right wake; a tagged agent's read never swallows the owner's wake", async () => {
    const { server, client, project, infra } = await setup();
    const asked = await agentSends(client, project, "ses-owner", "The webhook drops events. Should the queue own retries?", CLAUDE);
    // Pi works in another project; its connection understands tags.
    await poll(server, "ses-pi", "pi", infra);

    const response = await reply(server, asked.message_id, {
      idempotency_key: "k1",
      words: "Queue it. @Pi raise the visibility timeout to 30 s.",
      tags: [{ host: "pi", session: "ses-pi" }],
    });
    expect(response.status).toBe(200);
    const sent = ((await response.json()) as { reply: { id: string; tags: unknown } }).reply;
    expect(sent.tags).toEqual([{ host: "pi", session: "ses-pi", wakes: true }]);

    // THE BUG: the tagged agent reads the thread first (as its wake tells it to) before the owner's
    // connection delivers. That read must not settle the owner's copy.
    await client.callTool({ name: "read_thread", arguments: { thread_id: asked.thread_id, agent_session: "ses-pi" } });
    // Nor does any other agent's read.
    await client.callTool({ name: "read_thread", arguments: { thread_id: asked.thread_id, agent_session: "ses-bystander" } });

    const ownerCommands = await poll(server, "ses-owner", "claude-code", project);
    expect(ownerCommands).toHaveLength(1);
    expect(ownerCommands[0]).toMatchObject({ id: sent.id, also_tagged: ["Pi"] });
    expect(ownerCommands[0]!.tagged).toBeUndefined();
    const ownerWake = inboxWakeText(ownerCommands[0]!).split("\n");
    expect(ownerWake[1]).toBe(INBOX_WAKE_INSTRUCTION);
    expect(ownerWake[2]).toBe(inboxAlsoTaggedLine(["Pi"]));
    expect(ownerWake[2]).toBe("This reply also tags Pi (other sessions); each gets it too. Leave what is addressed to them to them.");

    const piCommands = await poll(server, "ses-pi", "pi", infra);
    expect(piCommands).toHaveLength(1);
    expect(piCommands[0]).toMatchObject({ id: sent.id, tagged: { owner: "Claude Code" } });
    const piWake = inboxWakeText(piCommands[0]!).split("\n");
    expect(piWake[1]).toBe(INBOX_TAGGED_INSTRUCTION);
    expect(piWake[2]).toBe(inboxTaggedLine("Claude Code", sent.id));
    expect(piWake[2]).toBe(
      `The thread belongs to another session (Claude Code); you have not seen it. Read it first with read_thread (message_id ${sent.id}). Answer only what is addressed to you, in the same thread: plannotator_inbox send_message with reply_to ${sent.id}.`,
    );
    expect(piWake.slice(4).join("\n")).toContain("@Pi raise the visibility timeout");

    // Each records its own delivery, once; the other's copy stays.
    await delivered(server, "ses-pi", "pi", sent.id);
    await delivered(server, "ses-pi", "pi", sent.id);
    expect(await poll(server, "ses-pi", "pi", infra)).toEqual([]);
    expect(await poll(server, "ses-owner", "claude-code", project)).toHaveLength(1);
    let message = (await thread(server, asked.thread_id)).messages.at(-1)!;
    expect(message.delivery ?? null).toBeNull();
    expect(message.tags?.[0]?.delivery).toMatchObject({ session: "ses-pi", host: "pi" });

    await delivered(server, "ses-owner", "claude-code", sent.id);
    expect(await poll(server, "ses-owner", "claude-code", project)).toEqual([]);
    message = (await thread(server, asked.thread_id)).messages.at(-1)!;
    expect(message.delivery).toMatchObject({ session: "ses-owner" });
    // A session the reply neither owns nor tags may not acknowledge it.
    const wrong = await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-bystander", host: "pi", type: "delivered", id: sent.id });
    expect(wrong.status).toBe(422);
  });

  test("without tags the old rule holds: any agent's read settles a plain reply", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-owner", "Ship it?", CLAUDE);
    expect((await reply(server, asked.message_id, { idempotency_key: "k1", words: "Yes." })).status).toBe(200);
    await client.callTool({ name: "read_thread", arguments: { thread_id: asked.thread_id, agent_session: "ses-other" } });
    expect(await poll(server, "ses-owner", "claude-code", project)).toEqual([]);
  });

  test("a connection that does not say it understands tags is never handed what it was only tagged in, and a live session on an older Plannotator can't be tagged", async () => {
    const { server, client, project, infra } = await setup();
    const asked = await agentSends(client, project, "ses-owner", "Ship it?", CLAUDE);
    await poll(server, "ses-pi", "pi", infra);
    await poll(server, "ses-old", "pi", infra, {});
    const taggable = (await (await fetch(`${base(server)}/api/inbox/threads/${asked.thread_id}/taggable`)).json()) as {
      owner: { session: string };
      sessions: { session: string; taggable: boolean; owner: boolean; kind: string }[];
    };
    expect(taggable.owner.session).toBe("ses-owner");
    expect(taggable.sessions.find((s) => s.session === "ses-old")).toMatchObject({ taggable: false, kind: "live" });
    expect(taggable.sessions.find((s) => s.session === "ses-pi")).toMatchObject({ taggable: true });

    const before = (await thread(server, asked.thread_id)).messages.length;
    const refused = await reply(server, asked.message_id, { idempotency_key: "k1", words: "Yes.", tags: [{ session: "ses-old" }] });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("tag_needs_update");
    expect((await thread(server, asked.thread_id)).messages).toHaveLength(before);

    // Tagged while its poll said tags; then the same session polls as an older connection would.
    expect((await reply(server, asked.message_id, { idempotency_key: "k2", words: "Yes.", tags: [{ session: "ses-pi" }] })).status).toBe(200);
    expect(await poll(server, "ses-pi", "pi", infra, {})).toEqual([]);
    expect(await poll(server, "ses-pi", "pi", infra)).toHaveLength(1);
  });

  test("a tag naming a session that is neither live nor a known MCP agent is refused, and nothing is written", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-owner", ":::question\nShip?\n\n- [ ] Yes\n- [ ] No\n:::", CLAUDE);
    const before = await thread(server, asked.thread_id);
    const response = await reply(server, asked.message_id, {
      idempotency_key: "k1",
      words: "Yes",
      questions: [{ key: before.messages[0]!.questions![0]!.key, revision: 0, answer: { selected: ["Yes"] } }],
      tags: [{ host: "pi", session: "ses-gone" }],
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("session_not_live");
    const after = await thread(server, asked.thread_id);
    expect(after.messages).toHaveLength(1);
    expect(after.messages[0]!.questions![0]!.state).toBe("open");
    // Malformed tags fail closed.
    expect((await reply(server, asked.message_id, { idempotency_key: "k2", words: "x", tags: "ses-pi" })).status).toBe(422);
    expect((await reply(server, asked.message_id, { idempotency_key: "k3", words: "x", tags: [{ session: 7 }] })).status).toBe(422);
  });

  test("any MCP agent can be tagged: never woken, its read records that it saw it without settling the owner, and its own wait_for_reply (no thread) returns it as a tag and records its delivery", async () => {
    const { server, client, project } = await setup();
    const docs = join(roots[0]!, "docs-site");
    mkdirSync(docs);
    // Codex reads the Inbox through MCP only, in another project, and never wrote in this thread.
    await agentSends(client, docs, "ses-codex", "Install page moved.", CODEX);
    const asked = await agentSends(client, project, "ses-owner", "Should the queue own retries?", CLAUDE);
    const taggable = (await (await fetch(`${base(server)}/api/inbox/threads/${asked.thread_id}/taggable`)).json()) as {
      sessions: { session: string; kind: string; host: string; wrote_thread: boolean; project: { name: string } | null }[];
    };
    expect(taggable.sessions.find((s) => s.session === "ses-codex")).toMatchObject({ kind: "mcp", host: "codex", wrote_thread: false, project: { name: "docs-site" } });

    const response = await reply(server, asked.message_id, { idempotency_key: "k1", words: "Queue it. @Codex the runbook needs the alert.", tags: [{ session: "ses-codex" }] });
    expect(response.status).toBe(200);
    const sent = ((await response.json()) as { reply: { id: string; tags: unknown } }).reply;
    expect(sent.tags).toEqual([{ host: "codex", session: "ses-codex", name: "Codex", wakes: false }]);

    // Its read_thread: it sees the tag (tagged_you) and the window learns it saw it; the owner still waits.
    const read = await client.callTool({ name: "read_thread", arguments: { thread_id: asked.thread_id, agent_session: "ses-codex" } });
    const seen = (read.structuredContent as { thread: InboxThread }).thread.messages.at(-1) as unknown as { tagged: unknown; tagged_you?: boolean; tags?: unknown };
    expect(seen.tagged).toEqual([{ agent: "Codex", session: "ses-codex" }]);
    expect(seen.tagged_you).toBe(true);
    expect(seen.tags).toBeUndefined();
    expect((await thread(server, asked.thread_id)).messages.at(-1)!.tags?.[0]?.read_at).toBeString();
    expect(await poll(server, "ses-owner", "claude-code", project)).toHaveLength(1);

    // Its list of threads names the thread it was tagged in, wherever it is.
    const listed = await client.callTool({ name: "read_thread", arguments: { project_path: docs, agent_session: "ses-codex" } });
    const rows = (listed.structuredContent as { threads: { thread_id: string; tagged_you?: boolean; unread: boolean }[] }).threads;
    expect(rows.find((r) => r.thread_id === asked.thread_id)).toMatchObject({ tagged_you: true, unread: true });

    // Its wait across its threads returns the tag, and records its own delivery only.
    const waited = await client.callTool({ name: "wait_for_reply", arguments: { agent_session: "ses-codex", project_path: docs, timeout_seconds: 1 } });
    const structured = waited.structuredContent as { status: string; tagged_you?: boolean; reply: { message_id: string } };
    expect(structured).toMatchObject({ status: "replied", tagged_you: true, reply: { message_id: sent.id } });
    expect(JSON.stringify(waited.content)).toContain("The person tagged you in thread");
    const message = (await thread(server, asked.thread_id)).messages.at(-1)!;
    expect(message.tags?.[0]?.delivery).toMatchObject({ session: "ses-codex" });
    expect(message.delivery ?? null).toBeNull();
    expect(await poll(server, "ses-owner", "claude-code", project)).toHaveLength(1);
  });

  test("the tagged agent answers with reply_to from another project and its answer lands in this thread; an untagged next reply goes to the agent that wrote last", async () => {
    const { server, client, project, infra } = await setup();
    const asked = await agentSends(client, project, "ses-owner", "Should the queue own retries?", CLAUDE);
    await poll(server, "ses-pi", "pi", infra);
    const sent = ((await (await reply(server, asked.message_id, { idempotency_key: "k1", words: "@Pi raise it", tags: [{ session: "ses-pi" }] })).json()) as { reply: { id: string } })
      .reply;
    await delivered(server, "ses-pi", "pi", sent.id);
    const answer = await client.callTool({
      name: "send_message",
      arguments: { body: "Raised to 30 s.", reply_to: sent.id, project_path: infra, agent_session: "ses-pi", agent_host: "pi", agent_name: "Pi" },
      _meta: { [INBOX_WAKES_META_KEY]: true },
    });
    const landed = answer.structuredContent as { thread_id: string; message_id: string };
    expect(landed.thread_id).toBe(asked.thread_id);
    // The next plain Send answers Pi's message: the latest writer gets it, nobody is tagged.
    expect((await reply(server, landed.message_id, { idempotency_key: "k2", words: "Thanks." })).status).toBe(200);
    expect((await poll(server, "ses-pi", "pi", infra)).map((c) => c.body)).toEqual([expect.stringContaining("Thanks.")]);
    // The row involves both agents.
    const r = await row(server, asked.thread_id);
    expect(r.participants?.map((p) => p.session)).toEqual(["ses-owner", "ses-pi"]);
  });

  test("each recipient has its own Send now and connection; the Sent row counts deliveries per recipient", async () => {
    const { server, client, project, infra } = await setup();
    const asked = await agentSends(client, project, "ses-owner", "Should the queue own retries?", CLAUDE);
    await poll(server, "ses-pi", "pi", infra, { tags: true, send_now: true, busy: true });
    const sent = ((await (await reply(server, asked.message_id, { idempotency_key: "k1", words: "@Pi now", tags: [{ session: "ses-pi" }] })).json()) as { reply: { id: string } })
      .reply;

    let r = await row(server, asked.thread_id);
    expect(r.section).toBe("sent");
    expect(r.sent?.recipients?.map((x) => [x.session, x.owner, x.delivered_at])).toEqual([
      ["ses-owner", true, null],
      ["ses-pi", false, null],
    ]);

    const sessions = (await (await fetch(`${base(server)}/api/inbox/threads/${asked.thread_id}/sessions?recipients=ses-pi,ses-nobody`)).json()) as {
      recipients: Record<string, { busy: boolean | null; send_now: boolean } | null>;
    };
    expect(sessions.recipients["ses-pi"]).toMatchObject({ busy: true, send_now: true });
    expect(sessions.recipients["ses-nobody"]).toBeNull();

    const now = await fetch(`${base(server)}/api/inbox/messages/${sent.id}/send-now`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "ses-pi" }),
    });
    expect(now.status).toBe(200);
    const message = (await thread(server, asked.thread_id)).messages.at(-1)!;
    expect(message.tags?.[0]?.deliver_now_at).toBeString();
    expect(message.deliver_now_at ?? null).toBeNull();
    const piCommands = await poll(server, "ses-pi", "pi", infra, { tags: true, send_now: true, busy: true });
    expect(piCommands[0]).toMatchObject({ id: sent.id, now: true, tagged: { owner: "Claude Code" } });
    // The owner's connection does not poll: Send now for it is refused.
    const ownerNow = await fetch(`${base(server)}/api/inbox/messages/${sent.id}/send-now`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(ownerNow.status).toBe(409);

    await delivered(server, "ses-pi", "pi", sent.id);
    r = await row(server, asked.thread_id);
    expect(r.section).toBe("sent");
    expect(r.sent?.recipients?.[1]?.delivered_at).toBeString();
    await delivered(server, "ses-owner", "claude-code", sent.id);
    r = await row(server, asked.thread_id);
    expect(r.section).not.toBe("sent");
  });
});
