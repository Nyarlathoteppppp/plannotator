/**
 * The list row's delivery (approval "inbox-row-delivery", "Ticks"): where
 * the person's latest sent item is, decided by the rule the thread's line
 * uses (`inboxDeliveryState`) from the store and the live sessions. Proved
 * on a real store in a temp dir with a stand-in for the server's live
 * sessions (`setDeliveryPresence`): every state, for a reply, a message
 * the person addressed to a session, and a 👍.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxDeliveryConnection } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agent = (session: string, host = "claude-code"): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host, session, name: null });

/** The server's live sessions, as the rows read them: a connection per session, and who has ended. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-row-delivery-"));
  roots.push(dir);
  const clock = { now: Date.parse("2026-10-20T15:00:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const connections = new Map<string, InboxDeliveryConnection | null>();
  const ended = new Set<string>();
  store.setDeliveryPresence({ connection: (s) => connections.get(s) ?? null, askerLive: (s) => !ended.has(s) });
  const row = (threadId: string) => store.listRow(threadId)!;
  return { store, clock, project, connections, ended, row };
}

describe("the row's delivery", () => {
  test("a reply to a waking session: queued while it works (with Send now when it can take it), sending while idle, sending now once pressed, delivered with its time", () => {
    const { store, project, connections, row } = world();
    const asked = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Shipped. Anything else?", wakes: true }).message;
    expect(row(asked.id).delivery).toBeNull();
    const reply = store.sendReply(asked.id, { words: "Bump the version too.", idempotency_key: "k1" }).reply!;

    // The session does not poll now: queued until it is back.
    expect(row(asked.id).delivery).toMatchObject({ kind: "reply", state: "queued", reason: "away", send_now: false, message_id: reply.id, host: "claude-code", at: null });
    connections.set("ses_a", { busy: true, send_now: true });
    expect(row(asked.id).delivery).toMatchObject({ state: "queued", reason: "working", send_now: true });
    connections.set("ses_a", { busy: true, send_now: false });
    expect(row(asked.id).delivery).toMatchObject({ state: "queued", reason: "working", send_now: false });
    connections.set("ses_a", { busy: null, send_now: false });
    expect(row(asked.id).delivery).toMatchObject({ state: "queued", reason: "next_turn" });
    connections.set("ses_a", { busy: false, send_now: false });
    expect(row(asked.id).delivery).toMatchObject({ state: "sending", reason: "idle" });

    connections.set("ses_a", { busy: true, send_now: true });
    store.requestDeliverNow(reply.id);
    expect(row(asked.id).delivery).toMatchObject({ state: "sending", reason: "sending_now", send_now: false });

    const delivered = store.recordDelivery(reply.id, { host: "claude-code", session: "ses_a" });
    const d = row(asked.id).delivery!;
    expect(d).toMatchObject({ state: "delivered", reason: "delivered", host: "claude-code" });
    expect(d.at).toBe(delivered.delivery!.at);
  });

  test("a reply to an agent that only reads the thread is saved, then delivered once an agent read it", () => {
    const { store, project, row } = world();
    const asked = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "codex", session: "ses_mcp", name: "Codex" }, body: "Which target?" }).message;
    store.sendReply(asked.id, { words: "The ARM one.", idempotency_key: "k1" });
    expect(row(asked.id).delivery).toMatchObject({ state: "saved", reason: "reads", name: "Codex", host: "codex" });
    store.markAgentChecked(asked.id);
    expect(row(asked.id).delivery).toMatchObject({ state: "delivered", reason: "delivered" });
    expect(row(asked.id).delivery!.at).toBe(row(asked.id).sent!.checked_at);
  });

  test("a reply whose asking session ended is saved for the next agent; the session coming back makes it queued again", () => {
    const { store, project, ended, row } = world();
    const asked = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Done. Merge?", wakes: true }).message;
    store.sendReply(asked.id, { words: "Merge it.", idempotency_key: "k1" });
    ended.add("ses_a");
    expect(row(asked.id).delivery).toMatchObject({ state: "saved", reason: "ended" });
    ended.delete("ses_a");
    expect(row(asked.id).delivery).toMatchObject({ state: "queued" });
  });

  test("a thread the person started: queued, not delivered once its session stopped before it took it, delivered after", () => {
    const { store, project, connections, ended, row } = world();
    const started = store.startPersonThread({ project_id: project.id, body: "Look at the flaky test.", to: { host: "pi", session: "ses_pi" }, idempotency_key: "c1" }).message;
    connections.set("ses_pi", { busy: true, send_now: false });
    expect(row(started.id).delivery).toMatchObject({ kind: "message", state: "queued", reason: "working", host: "pi", message_id: started.id });
    ended.add("ses_pi");
    expect(row(started.id).delivery).toMatchObject({ state: "undelivered", reason: "undelivered" });
    ended.delete("ses_pi");
    store.recordDelivery(started.id, { host: "pi", session: "ses_pi" });
    expect(row(started.id).delivery).toMatchObject({ state: "delivered" });
  });

  test("a reply sent to another session of the asker's host says so (\"(another session)\")", () => {
    const { store, project, row } = world();
    const asked = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Ok?", wakes: true }).message;
    store.sendReply(asked.id, { words: "Yes.", idempotency_key: "k1", to: { host: "claude-code", session: "ses_b" } });
    expect(row(asked.id).delivery).toMatchObject({ kind: "reply", host: "claude-code", another_session: true });
  });

  test("an agent writing after the person's reply clears it; the Inbox's own notes are read past", () => {
    const { store, project, row } = world();
    const asked = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Ok?", wakes: true }).message;
    store.sendReply(asked.id, { words: "Yes.", idempotency_key: "k1" });
    store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "On it.", reply_to: asked.id, wakes: true });
    expect(row(asked.id).delivery).toBeNull();
  });

  test("a 👍: queued in its Undo window, queued or sending once sent through to a waking session, delivered; a 👍 not sent has none", () => {
    const { store, clock, project, connections, row } = world();
    const sent = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Merged #12.", wakes: true }).message;
    store.ackMessage(sent.id, true);
    expect(row(sent.id).delivery).toMatchObject({ kind: "ack", state: "queued", reason: "ack_pending", message_id: sent.id, send_now: false });
    clock.now += 10_000;
    const [settled] = store.settleAcks(10_000);
    connections.set("ses_a", { busy: true, send_now: true });
    // A 👍 never offers Send now: it waits for the turn to end.
    expect(row(sent.id).delivery).toMatchObject({ state: "queued", reason: "working", send_now: false });
    connections.set("ses_a", { busy: false, send_now: false });
    expect(row(sent.id).delivery).toMatchObject({ state: "sending", reason: "idle" });
    store.recordDelivery(settled!.ack!.note_id!, { host: "claude-code", session: "ses_a" });
    expect(row(sent.id).delivery).toMatchObject({ state: "delivered" });

    const other = store.sendMessage({ project_id: project.id, author: agent("ses_c"), body: "Plain update." }).message;
    store.ackMessage(other.id, true);
    store.sendReply(other.id, { words: "Actually, one more thing.", idempotency_key: "k2" });
    clock.now += 10_000;
    store.settleAcks(10_000);
    // The person's reply is the latest item: the row tells the reply's delivery, not the 👍's.
    expect(row(other.id).delivery).toMatchObject({ kind: "reply" });
  });

  test("a 👍 to an agent that only reads the thread is saved", () => {
    const { store, clock, project, row } = world();
    const sent = store.sendMessage({ project_id: project.id, author: agent("ses_mcp", "codex"), body: "Done." }).message;
    store.ackMessage(sent.id, true);
    clock.now += 10_000;
    store.settleAcks(10_000);
    expect(row(sent.id).delivery).toMatchObject({ kind: "ack", state: "saved", reason: "reads" });
  });

  test("without the live sessions (no presence), a waking reply reads queued for its next turn and nobody counts as ended", () => {
    const { store, project } = world();
    store.setDeliveryPresence(null);
    const asked = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "Ok?", wakes: true }).message;
    store.sendReply(asked.id, { words: "Yes.", idempotency_key: "k1" });
    expect(store.listRow(asked.id)!.delivery).toMatchObject({ state: "queued", reason: "next_turn" });
  });
});
