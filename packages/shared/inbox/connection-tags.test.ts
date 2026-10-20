/**
 * The tagged wake (approval "inbox-tag-agents"): a session the person tagged
 * in a thread another session owns reads that, reads the thread first and
 * answers only its part; the owner is told who else got it. The names go into
 * a prompt, so they are cleaned and capped.
 */
import { expect, test } from "bun:test";
import {
  INBOX_REDIRECTED_NAME_MAX,
  INBOX_TAGGED_INSTRUCTION,
  INBOX_WAKE_INSTRUCTION,
  inboxAlsoTaggedLine,
  inboxTaggedLine,
  inboxWakeText,
  parseInboxBridgeCommands,
} from "./connection";

const base = { type: "reply" as const, id: "msg_R", thread_id: "msg_T", reply_to: "msg_A", subject: "Dead-letter queue", body: "@Pi raise it to 30 s.", url: "http://x" };

test("a tagged session's wake: its own instruction, whose thread it is, read first, answer only your part", () => {
  const text = inboxWakeText({ ...base, tagged: { owner: "Claude Code" } });
  expect(text).toBe(
    [
      "Plannotator Inbox: Dead-letter queue (msg_R)",
      INBOX_TAGGED_INSTRUCTION,
      "The thread belongs to another session (Claude Code); you have not seen it. Read it first with read_thread (message_id msg_R). Answer only what is addressed to you, in the same thread: plannotator_inbox send_message with reply_to msg_R.",
      "",
      "@Pi raise it to 30 s.",
    ].join("\n"),
  );
  expect(text).not.toContain(INBOX_WAKE_INSTRUCTION);
  // Never the redirected or continues line, whatever else the command carries.
  expect(inboxWakeText({ ...base, tagged: { owner: "Claude Code" }, redirected_from: "Pi", continues_thread: true })).toBe(text);
});

test("the owner's wake names who else was tagged, after its own instruction", () => {
  const lines = inboxWakeText({ ...base, also_tagged: ["Pi", "Codex"] }).split("\n");
  expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION);
  expect(lines[2]).toBe(inboxAlsoTaggedLine(["Pi", "Codex"]));
  expect(lines[2]).toBe("This reply also tags Pi and Codex (other sessions); each gets it too. Leave what is addressed to them to them.");
  expect(inboxAlsoTaggedLine(["Pi", "Codex", "OpenCode"])).toBe(
    "This reply also tags Pi, Codex and OpenCode (other sessions); each gets it too. Leave what is addressed to them to them.",
  );
});

test("names are cleaned and capped: a control character or a long name never shapes the prompt", () => {
  const long = "x".repeat(200);
  const text = inboxWakeText({ ...base, tagged: { owner: `Claude\nCode\u0007 ${long}` } });
  const line = text.split("\n")[2]!;
  const owner = /another session \((.*)\); you/.exec(line)![1]!;
  expect(owner.length).toBeLessThanOrEqual(INBOX_REDIRECTED_NAME_MAX);
  expect(owner.startsWith("Claude Code")).toBe(true);
  expect(inboxTaggedLine("Pi", "msg_1")).toContain("(Pi)");
  // Junk in also_tagged is dropped; an empty owner reads as another agent.
  expect(inboxWakeText({ ...base, also_tagged: [7, "", "Pi"] }).split("\n")[2]).toBe(inboxAlsoTaggedLine(["Pi"]));
  expect(inboxWakeText({ ...base, tagged: { owner: "" } })).toContain("another session (another agent)");
});

test("a bridge command carrying the tag fields still parses as the reply it is (an older connection ignores them)", () => {
  const [command] = parseInboxBridgeCommands(JSON.stringify({ commands: [{ ...base, tagged: { owner: "Claude Code" } }] }));
  expect(command).toMatchObject({ type: "reply", id: "msg_R", tagged: { owner: "Claude Code" } });
});
