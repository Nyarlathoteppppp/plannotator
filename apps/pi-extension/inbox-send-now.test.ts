/**
 * Pi's Send now: the person pressed Send now on a reply while a Pi run goes.
 * The extension's own Inbox code (setupPiInbox) against a real Inbox under a
 * temp data dir, with a stand-in for Pi's ExtensionAPI that records
 * `sendUserMessage` and raises `message_start` the way Pi does when it starts
 * the user message. The failure this catches: Send now that waits for idle
 * anyway, that delivers as a follow-up, or that counts as delivered before Pi
 * started the message. The real Pi proofs are inbox.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setupPiInbox } from "./inbox.ts";
import {
	createInboxWorld,
	destroyInboxWorld,
	personSends,
	pressSendNow,
	QUESTION,
	registry,
	removeStubbedHtml,
	sendNowOffered,
	startInbox,
	stubBuiltHtml,
	waitFor,
	type InboxWorld,
} from "../../tests/helpers/inbox-world.ts";

let stubs: string[] = [];
const worlds: InboxWorld[] = [];
const saved = { ...process.env };
const ends: (() => void)[] = [];

beforeAll(() => {
	stubs = stubBuiltHtml();
});
afterAll(() => {
	removeStubbedHtml(stubs);
});
afterEach(async () => {
	for (const end of ends.splice(0)) end();
	for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_BIN"]) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	for (const w of worlds.splice(0)) await destroyInboxWorld(w);
});

/** A stand-in for Pi's ExtensionAPI and one session's context. */
function fakePi(project: string) {
	const handlers = new Map<string, ((event: any, ctx?: any) => unknown)[]>();
	const sent: { text: string; deliverAs: string | undefined }[] = [];
	let tool: { execute: (...args: any[]) => Promise<{ content: { text: string }[] }> } | null = null;
	let idle = false;
	const ctx = {
		mode: "interactive",
		hasUI: true,
		cwd: project,
		isIdle: () => idle,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => "pi-session-now", getBranch: () => [] },
		ui: { notify: () => {} },
	};
	const emit = (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const pi = {
		on: (event: string, handler: (event: any, ctx?: any) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (definition: never) => {
			tool = definition;
		},
		getActiveTools: () => [] as string[],
		setActiveTools: () => {},
		sendUserMessage: (text: string, options?: { deliverAs?: string }) => {
			sent.push({ text, deliverAs: options?.deliverAs });
		},
	};
	return {
		pi,
		ctx,
		sent,
		emit,
		setIdle: (value: boolean) => {
			idle = value;
		},
		tool: () => tool!,
	};
}

describe.skipIf(process.platform === "win32")("Pi: Send now", () => {
	test("while a run goes, Send now steers the reply in; it counts as delivered when Pi starts that user message", async () => {
		const w = createInboxWorld("plannotator-inbox-pi-now-", "pi-send-now", "pi");
		worlds.push(w);
		startInbox(w);
		mkdirSync(w.dataDir, { recursive: true });
		writeFileSync(join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { pi: true } }));
		process.env.PLANNOTATOR_DATA_DIR = w.dataDir;
		process.env.PLANNOTATOR_BIN = join(w.bin, "plannotator");

		const fake = fakePi(w.project);
		await setupPiInbox(fake.pi as never, { isAskActive: () => false });
		fake.emit("session_start", {});
		ends.push(() => fake.emit("session_shutdown", {}));
		// A run goes (Pi is not idle) when the agent sends and the person answers.
		fake.emit("agent_start", {});
		const result = await fake.tool().execute("call-1", { action: "send_message", body: QUESTION }, undefined, undefined, fake.ctx);
		const text = result.content[0]!.text;
		const asked = JSON.parse(text.slice(text.indexOf("{"))) as { message_id: string; thread_id: string };
		const replyId = await personSends(w, asked.message_id, "Retry with the same key.");
		await sendNowOffered(w, asked.thread_id, "pi-session-now");
		await Bun.sleep(1_500);
		expect(fake.sent).toEqual([]);

		await pressSendNow(w, replyId);
		const steer = await waitFor("the steer", () => fake.sent[0]);
		expect(steer.deliverAs).toBe("steer");
		expect(steer.text.split("\n", 1)[0]!.endsWith(`(${replyId})`)).toBe(true);
		const deliveryOf = async () =>
			((await (await fetch(`http://127.0.0.1:${registry(w).port}/api/inbox/threads/${asked.thread_id}`)).json()) as { thread: { messages: { id: string; delivery?: unknown }[] } }).thread.messages.find((m) => m.id === replyId)?.delivery;
		await Bun.sleep(800);
		// Not delivered until Pi starts the message.
		expect(await deliveryOf()).toBeUndefined();
		fake.emit("message_start", { message: { role: "user", content: steer.text } });
		expect(await waitFor("the delivery record", deliveryOf)).toMatchObject({ host: "pi", session: "pi-session-now" });
		await Bun.sleep(1_500);
		expect(fake.sent).toHaveLength(1);
	}, 60_000);
});
