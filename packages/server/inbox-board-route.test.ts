/**
 * What the Board page (approval "inbox-board", step 2) reads from
 * `GET /api/inbox/cards` beside the cards: each linked thread's list row
 * (`threads`, its subject and section, so the open card names its threads)
 * and each card's project (`projects`, its folder name). A real Inbox in a
 * temp data dir. Guards: a card whose thread was deleted naming a thread that
 * is gone, and a card pointing at a project the page cannot name.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("the cards answer names each linked thread (its list row) and each card's project; a deleted thread is left out", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-board-route-")));
  roots.push(root);
  const folder = join(root, "billing-app");
  mkdirSync(folder, { recursive: true });
  const server = await startInboxServer({ dataDir: join(root, "data"), phones: false });
  servers.push(server);
  const store = server.store;
  const project = store.ensureProject({ name: "billing-app", root: folder });
  const agent = { kind: "agent" as const, host: "claude-code", session: "ses_a", name: "Claude Code" };
  const kept = store.sendMessage({ project_id: project.id, author: agent, body: "The retry worker is ready for your look." }).message;
  const gone = store.sendMessage({ project_id: project.id, author: { ...agent, session: "ses_b" }, body: "An older thread." }).message;
  const card = store.createCard({ project_id: project.id, by: agent, title: "Retry worker", threads: [kept.id, gone.id] }).card;
  store.deleteThread(gone.id);

  const base = `http://127.0.0.1:${server.port}`;
  const answer = (await (await fetch(`${base}/api/inbox/cards`)).json()) as {
    cards: { id: string; threads: string[] }[];
    threads: Record<string, { subject: string | null; section: string; thread_id: string }>;
    projects: Record<string, { name: string; root: string }>;
  };
  expect(answer.cards.find((c) => c.id === card.id)!.threads).toEqual([kept.id]);
  expect(Object.keys(answer.threads)).toEqual([kept.id]);
  expect(answer.threads[kept.id]).toMatchObject({ thread_id: kept.id, subject: "The retry worker is ready for your look.", section: "new" });
  expect(answer.projects[project.id]).toEqual({ id: project.id, name: "billing-app", root: folder });
});
