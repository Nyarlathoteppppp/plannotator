/**
 * Naming a thread the person started (approval "inbox-agent-names-own-thread"):
 * the person may give it a name in compose; otherwise the first reply from the
 * session it is addressed to that carries `thread` names it, once. The name is
 * the thread's chip (`thread_name`), and later sends with that name join it.
 * What can regress: another session renaming it, a second name replacing the
 * first, the person's name being replaced, the subject changing, routing
 * after a replay, and an invalid name being stored.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-naming-"));
  roots.push(dir);
  return dir;
}

function world() {
  const dir = scratch();
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "repo", root: "/work/repo" });
  return { dir, store, project };
}

const claude = { host: "claude-code", session: "ses_live" };
const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: null });
const IDEA =
  "I want to explore what adding a board would look like. Kanban specifically. And the kanban needs to be well thought out.";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  return "ok";
}

describe("naming a thread the person started", () => {
  test("the addressed session's first reply with `thread` names it, once; the subject stays the short name", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    expect(store.canNameThread(root.id, "ses_live")).toBe(true);
    expect(store.canNameThread(root.id, "ses_other")).toBe(false);

    // A reply with no name: still nameable, and the result says so.
    const first = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "On it.", reply_to: root.id });
    expect(first.naming).toEqual({ status: "unnamed" });
    expect(store.canNameThread(root.id, "ses_live")).toBe(true);

    // An invalid name is refused (nothing stored); the thread stays nameable.
    const bad = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "x", reply_to: root.id, thread: "line\nbreak" });
    expect(bad.naming?.status).toBe("refused");
    expect(store.message(root.id)!.thread_name ?? null).toBeNull();

    // The first valid name sets the chip and `named_by`; the bold subject is unchanged.
    const named = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "Sketch below.", reply_to: root.id, thread: "Kanban board" });
    expect(named.naming).toEqual({ status: "named", name: "Kanban board" });
    const after = store.message(root.id)!;
    expect(after.thread_name).toBe("Kanban board");
    expect(after.subject).toBe("I want to explore what adding a board would look like");
    expect(after.named_by).toMatchObject({ kind: "agent", session: "ses_live", message_id: named.message.id });
    expect(store.listRow(root.id)!.thread_name).toBe("Kanban board");
    expect(store.canNameThread(root.id, "ses_live")).toBe(false);

    // Once: a later name is ignored, and the result no longer mentions naming.
    const again = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "More.", reply_to: root.id, thread: "Something else" });
    expect(again.naming).toBeUndefined();
    expect(store.message(root.id)!.thread_name).toBe("Kanban board");
  });

  test("`subject` on the reply names it too, when `thread` is absent", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    const named = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, subject: "Board view" });
    expect(named.naming).toEqual({ status: "named", name: "Board view" });
    expect(store.message(root.id)!.thread_name).toBe("Board view");
  });

  test("only the addressed session may name it; another session's name is ignored", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    const other = store.sendMessage({ project_id: project.id, author: agent("ses_other"), body: "hi", reply_to: root.id, thread: "Hijack" });
    expect(other.naming).toBeUndefined();
    expect(store.message(root.id)!.thread_name ?? null).toBeNull();
    expect(store.canNameThread(root.id, "ses_live")).toBe(true);
  });

  test("once the address moved, the new addressee and the first agent to reply may name it", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    store.readdressMessage(root.id, { host: "pi", session: "ses_pi" });
    expect(store.threadNamers(root.id)).toEqual(["ses_pi"]);
    // The old session replies first (it read the thread): now it may name it too.
    store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "I saw it.", reply_to: root.id });
    expect(store.threadNamers(root.id)).toEqual(["ses_pi", "ses_live"]);
    expect(store.canNameThread(root.id, "ses_third")).toBe(false);
    const named = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "pi", session: "ses_pi", name: null }, body: "ok", reply_to: root.id, thread: "Board" });
    expect(named.naming?.status).toBe("named");
  });

  test("a name the person gave in compose is the chip from the start, and no agent replaces it", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k", thread_name: "  Board  " });
    expect(root.thread_name).toBe("Board");
    expect(root.named_by).toMatchObject({ kind: "person" });
    expect(store.canNameThread(root.id, "ses_live")).toBe(false);
    const reply = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, thread: "Kanban" });
    expect(reply.naming).toBeUndefined();
    expect(store.message(root.id)!.thread_name).toBe("Board");
    // An invalid name refuses the Send, writing nothing; an empty one is no name.
    expect(code(() => store.startPersonThread({ project_id: project.id, body: "x", to: claude, idempotency_key: "k2", thread_name: "a‮b" }))).toBe("validation_error");
    expect(store.personThreadByKey("k2")).toBeNull();
    const empty = store.startPersonThread({ project_id: project.id, body: "y", to: claude, idempotency_key: "k3", thread_name: "   " });
    expect(empty.message.thread_name ?? null).toBeNull();
    // A replay with another name is a different Send.
    expect(code(() => store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k", thread_name: "Other" }))).toBe("idempotency_key_reused");
    expect(store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k", thread_name: "Board" }).replayed).toBe(true);
  });

  test("a named thread takes later sends with its name, as the newest open thread of that name, and a replay routes the same", () => {
    const { dir, store, project } = world();
    // An agent's thread already has the name.
    const older = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "older", thread: "board" });
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, thread: "Board" });
    const joined = store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "joins", thread: "BOARD" });
    expect(joined.message.thread_id).toBe(root.id);
    expect(joined.message.thread_id).not.toBe(older.message.thread_id);

    // A person-named thread routes the same way.
    const { message: named } = store.startPersonThread({ project_id: project.id, body: "another idea", to: claude, idempotency_key: "k2", thread_name: "Relay" });
    expect(store.sendMessage({ project_id: project.id, author: agent("ses_c"), body: "x", thread: "relay" }).message.thread_id).toBe(named.id);

    // The store reopened from its files routes the next sends the same.
    const copy = scratch();
    cpSync(dir, copy, { recursive: true });
    const replayed = InboxStore.open(copy);
    expect(replayed.message(root.id)!.thread_name).toBe("Board");
    expect(replayed.canNameThread(root.id, "ses_live")).toBe(false);
    for (const name of ["board", "Relay"]) {
      const probe = { project_id: project.id, author: agent("ses_probe"), body: "probe", thread: name };
      expect(replayed.sendMessage(probe).message.thread_id).toBe(store.sendMessage(probe).message.thread_id);
    }
    // Once the named thread is archived, the name falls back to the older open one.
    store.resolveThread(root.id, true);
    expect(store.sendMessage({ project_id: project.id, author: agent("ses_d"), body: "x", thread: "board" }).message.thread_id).toBe(older.message.thread_id);
  });

  test("an idempotent replay of the naming reply writes nothing more", () => {
    const { store, project } = world();
    const { message: root } = store.startPersonThread({ project_id: project.id, body: IDEA, to: claude, idempotency_key: "k" });
    const input = { project_id: project.id, author: agent("ses_live"), body: "ok", reply_to: root.id, thread: "Board", idempotency_key: "r1" };
    store.sendMessage(input);
    const cursor = store.cursor();
    const again = store.sendMessage(input);
    expect(again.replayed).toBe(true);
    expect(store.cursor()).toBe(cursor);
  });

  test("agent-started threads are unchanged: a reply's `thread` and `subject` are ignored", () => {
    const { store, project } = world();
    const first = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "news", subject: "Relay retries" });
    expect(store.canNameThread(first.message.id, "ses_live")).toBe(false);
    const reply = store.sendMessage({ project_id: project.id, author: agent("ses_live"), body: "more", reply_to: first.message.id, thread: "x", subject: "y" });
    expect(reply.naming).toBeUndefined();
    expect(store.message(first.message.id)!).toMatchObject({ subject: "Relay retries", thread_name: null });
  });
});
