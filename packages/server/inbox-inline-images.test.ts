/**
 * Images in a message captured as files of the thread (approval
 * "inbox-image-viewer", 2026-10-15), against a real Inbox on loopback under a
 * temp data dir and a temp git project: capture at send under the
 * message-image route's rules, the attachment routes by id, the listing's
 * additive `inline_images`, "changed since sent", the capture on first read
 * for a message sent before this, comments on an inline image, and the blob
 * sweep when its thread is deleted.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { inboxMessageImageRefsInOrder } from "@plannotator/shared/inbox/message-images";
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES } from "@plannotator/shared/diff-paths";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
let previousDataDir: string | undefined;

beforeEach(() => {
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
});

/** A PNG's signature and IHDR (w x h): enough for the sniffer and the dimension read; `salt` makes distinct bytes. */
function png(w = 2, h = 3, salt = 0): Uint8Array {
  const bytes = new Uint8Array(34);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, (w >> 8) & 0xff, w & 0xff, 0, 0, (h >> 8) & 0xff, h & 0xff, 8, 6, 0, 0, 0]);
  bytes[33] = salt;
  return bytes;
}

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-inline-")));
  roots.push(root);
  const project = join(root, "shop");
  mkdirSync(join(project, "design"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(project, "design", "a.png"), png(4, 3, 1));
  writeFileSync(join(project, "design", "b.png"), png(4, 3, 2));
  writeFileSync(join(project, "design", "fake.png"), "not an image");
  writeFileSync(join(root, "outside.png"), png(4, 3, 9));
  const dataDir = join(root, "data");
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  return { root, project, dataDir };
}

async function start(dataDir: string): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, phones: false });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-inline-images-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

async function send(client: Client, args: Record<string, unknown>): Promise<Record<string, any>> {
  const result = (await client.callTool({ name: "send_message", arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  return result.structuredContent;
}

const get = (server: InboxServer, path: string) => fetch(`http://127.0.0.1:${server.port}${path}`);
const post = (server: InboxServer, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const BODY = [
  "Three directions:",
  "",
  "![B](design/b.png)",
  "",
  "`![not an image](design/a.png)` in code is code.",
  "",
  "```",
  "![fenced](design/a.png)",
  "```",
  "",
  "![A](design/a.png) ![fake](design/fake.png) ![up](../outside.png) ![gone](design/missing.png) ![remote](https://example.com/x.png)",
  "",
  '<img src="design/b.png" alt="again">',
].join("\n");

test("the body's image references in text order, each once, outside code", () => {
  expect(inboxMessageImageRefsInOrder(BODY)).toEqual(["design/b.png", "design/a.png", "design/fake.png", "../outside.png", "design/missing.png"]);
  expect(inboxMessageImageRefsInOrder('<img src="z.png"> then ![y](y.png)')).toEqual(["z.png", "y.png"]);
  expect(inboxMessageImageRefsInOrder("no images")).toEqual([]);
});

test("a message's images are captured at send under the image route's rules, served by id, and listed apart from attachments", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: BODY });

  const thread = (await (await get(server, `/api/inbox/threads/${sent.thread_id}`)).json()) as any;
  const message = thread.thread.messages[0];
  // b then a: text order, each once; fake (not an image), outside the project, missing and remote are left out.
  expect(message.inline_images.map((i: any) => i.ref)).toEqual(["design/b.png", "design/a.png"]);
  const [b, a] = message.inline_images;
  expect(b.id).toMatch(/^att_[0-9A-Z]{26}$/);
  expect(b).toMatchObject({ kind: "image", media_type: "image/png", width: 4, height: 3, name: "b.png", path: join(project, "design", "b.png"), sent_sha256: sha(png(4, 3, 2)), size: 34 });
  expect(b.captured).toBeUndefined();
  expect(b.sent_at).toBe(message.created_at);
  expect(existsSync(inboxBlobPath(join(dataDir, "inbox"), b.sent_sha256))).toBe(true);
  // Never an attachment of the message.
  expect(message.attachments).toBeUndefined();

  const listing = (await (await get(server, `/api/inbox/threads/${sent.thread_id}/attachments`)).json()) as any;
  expect(listing.attachments).toEqual([]);
  expect(listing.inline_images.map((i: any) => [i.id, i.ref, i.message_id, i.changed_since_sent])).toEqual([
    [b.id, "design/b.png", message.id, false],
    [a.id, "design/a.png", message.id, false],
  ]);

  // The attachment routes reach it by id: the image (current and sent) and the download.
  const current = await get(server, `/api/inbox/attachments/${a.id}/image`);
  expect(current.status).toBe(200);
  expect(current.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await current.arrayBuffer())).toEqual(png(4, 3, 1));
  expect((await get(server, `/api/inbox/attachments/${a.id}/download`)).status).toBe(200);

  // The agent overwrites a.png: changed since sent, and the sent version still opens.
  writeFileSync(join(project, "design", "a.png"), png(8, 6, 5));
  const later = (await (await get(server, `/api/inbox/threads/${sent.thread_id}/attachments`)).json()) as any;
  expect(later.inline_images.find((i: any) => i.id === a.id).changed_since_sent).toBe(true);
  expect(new Uint8Array(await (await get(server, `/api/inbox/attachments/${a.id}/image?version=sent`)).arrayBuffer())).toEqual(png(4, 3, 1));
  expect(new Uint8Array(await (await get(server, `/api/inbox/attachments/${a.id}/image`)).arrayBuffer())).toEqual(png(8, 6, 5));

  // Grown past the image route's cap: the current file is refused, the sent one still opens.
  writeFileSync(join(project, "design", "a.png"), Buffer.concat([Buffer.from(png(8, 6, 5)), Buffer.alloc(MAX_REVIEW_IMAGE_PREVIEW_BYTES)]));
  const big = await get(server, `/api/inbox/attachments/${a.id}/image`);
  expect(big.status).toBe(413);
  expect(((await big.json()) as any).code).toBe("image_too_large");
  expect((await get(server, `/api/inbox/attachments/${a.id}/image?version=sent`)).status).toBe(200);
});

test("a body with no local image gets no field; one whose images cannot be read gets an empty list", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const client = await agent(server);
  const plain = await send(client, { project_path: project, body: "Just words.", thread: "a" });
  const unreadable = await send(client, { project_path: project, body: "![x](design/missing.png) ![y](../outside.png)", thread: "b" });
  const read = async (threadId: string) => ((await (await get(server, `/api/inbox/threads/${threadId}`)).json()) as any).thread.messages[0];
  expect((await read(plain.thread_id)).inline_images).toBeUndefined();
  expect((await read(unreadable.thread_id)).inline_images).toEqual([]);
});

test("a comment on an inline image is an attachment annotation, and the thread's deletion sweeps its blob", async () => {
  const { project, dataDir } = world();
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: project, body: "![B](design/b.png)" });
  const listing = (await (await get(server, `/api/inbox/threads/${sent.thread_id}/attachments`)).json()) as any;
  const b = listing.inline_images[0];
  const annotation = { id: "ann-img-1", blockId: "image", startOffset: 0, endOffset: 0, type: "COMMENT", text: "Make step 1 bold.", originalText: "b.png", createdA: 1 };
  const saved = await post(server, "/api/inbox/annotations", { attachment_id: b.id, version: "current", annotation });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as any).annotation).toMatchObject({ attachment_id: b.id, path: b.path, version: "current", message_id: sent.message_id });
  const pending = (await (await get(server, `/api/inbox/threads/${sent.thread_id}/attachments`)).json()) as any;
  expect(pending.annotations.map((r: any) => r.id)).toEqual(["ann-img-1"]);

  const blob = inboxBlobPath(join(dataDir, "inbox"), b.sent_sha256);
  expect(existsSync(blob)).toBe(true);
  expect((await post(server, `/api/inbox/threads/${sent.thread_id}/delete`, {})).status).toBe(200);
  expect(existsSync(blob)).toBe(false);
  expect((await get(server, `/api/inbox/attachments/${b.id}/image`)).status).toBe(404);
});

test("a message sent before capture gets its copies on the thread's first read, marked on_open, once", async () => {
  const { project, dataDir } = world();
  // An older Inbox's message: written by the store with no inline_images.
  const old = InboxStore.open(dataDir);
  const projectRecord = old.ensureProject({ name: "shop", root: project });
  const { message } = old.sendMessage({ project_id: projectRecord.id, author: { kind: "agent", host: "claude-code", session: "s1", name: null }, body: "Before:\n\n![A](design/a.png)" });
  expect(message.inline_images).toBeUndefined();

  const server = await start(dataDir);
  const first = (await (await get(server, `/api/inbox/threads/${message.thread_id}`)).json()) as any;
  const captured = first.thread.messages[0].inline_images;
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({ ref: "design/a.png", captured: "on_open", sent_at: message.created_at, sent_sha256: sha(png(4, 3, 1)) });
  expect(typeof captured[0].captured_at).toBe("string");
  // The capture keeps the message's place: its seq is its first line's.
  expect(first.thread.messages[0].seq).toBe(old.messageCursor(message.id));
  const cursor = first.cursor;

  // A second read writes nothing.
  const second = (await (await get(server, `/api/inbox/threads/${message.thread_id}`)).json()) as any;
  expect(second.cursor).toBe(cursor);
  expect(second.thread.messages[0].inline_images[0].id).toBe(captured[0].id);

  // Changed since you first opened it: the agent's later edit reads as changed.
  writeFileSync(join(project, "design", "a.png"), png(4, 3, 7));
  const listing = (await (await get(server, `/api/inbox/threads/${message.thread_id}/attachments`)).json()) as any;
  expect(listing.inline_images[0]).toMatchObject({ captured: "on_open", changed_since_sent: true });
});

test("the capture follows the worktree a message was sent from and never reads outside the project", async () => {
  const { project, dataDir } = world();
  mkdirSync(join(project, "packages", "web", "shots"), { recursive: true });
  writeFileSync(join(project, "packages", "web", "shots", "home.png"), png(5, 5, 3));
  const server = await start(dataDir);
  const sent = await send(await agent(server), { project_path: join(project, "packages", "web"), body: "![home](shots/home.png) ![esc](../../../outside.png)" });
  const thread = (await (await get(server, `/api/inbox/threads/${sent.thread_id}`)).json()) as any;
  expect(thread.thread.messages[0].inline_images.map((i: any) => [i.ref, i.path])).toEqual([["shots/home.png", join(project, "packages", "web", "shots", "home.png")]]);
});
