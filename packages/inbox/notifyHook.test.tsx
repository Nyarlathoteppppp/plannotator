/**
 * useInboxNotifications against a recording Notification constructor and a
 * scripted "tab in front" (approval "inbox-notify-every-thread"): a new
 * thread notifies in front or away, a question notifies in front unless its
 * thread is open and visible, plain news in a known thread never notifies, a
 * later line of a root the page already listed is never a new thread, and a
 * burst collapses into one notice. The sound hears about questions only.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxListRow, InboxMessage, InboxQuestion, InboxSectionId } from '@plannotator/core/inbox-types';
import type { InboxEvent, ListModel } from './api';
import type { InboxNotifications } from './notify';

const hasDom = typeof document !== 'undefined';
const { useInboxNotifications } = (hasDom ? await import('./notify') : {}) as typeof import('./notify');

interface Raised {
  title: string;
  body: string;
  tag: string;
  silent: boolean;
}

let raised: Raised[] = [];
let front = { visible: true, focused: true };
const saved: { notification?: unknown; hasFocus?: () => boolean; visibility?: PropertyDescriptor } = {};

function installStubs() {
  raised = [];
  class RecordingNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = async () => 'granted' as NotificationPermission;
    onclick: (() => void) | null = null;
    constructor(title: string, options: NotificationOptions = {}) {
      raised.push({ title, body: options.body ?? '', tag: options.tag ?? '', silent: options.silent === true });
    }
    close() {}
  }
  saved.notification = (window as unknown as { Notification?: unknown }).Notification;
  (window as unknown as { Notification: unknown }).Notification = RecordingNotification;
  (globalThis as unknown as { Notification: unknown }).Notification = RecordingNotification;
  saved.hasFocus = document.hasFocus;
  saved.visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (front.visible ? 'visible' : 'hidden') });
  document.hasFocus = () => front.focused;
}

function restoreStubs() {
  (window as unknown as { Notification: unknown }).Notification = saved.notification;
  (globalThis as unknown as { Notification: unknown }).Notification = saved.notification;
  document.hasFocus = saved.hasFocus!;
  if (saved.visibility) Object.defineProperty(document, 'visibilityState', saved.visibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let api: InboxNotifications;
let onScreen: string | null = null;
let questionsHeard = 0;
let silent = false;

function Probe() {
  api = useInboxNotifications({
    settings: { enabled: true, dismissed: false, allowed_origin: null },
    onSettings: () => {},
    openThread: () => {},
    openList: () => {},
    onQuestions: () => {
      questionsHeard++;
    },
    silent: () => silent,
    threadOnScreen: (threadId) => threadId === onScreen,
  });
  return null;
}

const claude: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
let seq = 0;

function message(id: string, threadId: string, over: Partial<InboxMessage> = {}): InboxEvent {
  return {
    seq: ++seq,
    kind: 'message',
    id,
    message: {
      id,
      project_id: 'prj_1',
      thread_id: threadId,
      reply_to: id === threadId ? null : threadId,
      author: claude,
      subject: id === threadId ? `Subject ${threadId}` : null,
      body: 'Body',
      created_at: '2026-10-15T10:00:00.000Z',
      resolved_at: null,
      idempotency_key: null,
      ...over,
    } as InboxMessage,
  };
}

function question(messageId: string, key: string): InboxEvent {
  return {
    seq: ++seq,
    kind: 'question',
    id: `${messageId}/${key}`,
    question: { message_id: messageId, key, state: 'open', revision: 0 } as unknown as InboxQuestion,
  };
}

function list(threads: { id: string; section: InboxSectionId; project?: string }[]): ListModel {
  const rows = threads.map(
    (t) =>
      ({
        thread_id: t.id,
        project: { id: 'prj_1', name: t.project ?? 'billing-svc' },
        subject: `Subject ${t.id}`,
        section: t.section,
      }) as unknown as InboxListRow,
  );
  return { sections: [{ id: 'new', label: 'New', threads: rows }] } as unknown as ListModel;
}

/** One event-stream batch, then the list read that follows it. */
function batch(events: InboxEvent[], after: ListModel) {
  act(() => {
    for (const event of events) api.observe(event);
    api.flush(after);
  });
}

function away() {
  front = { visible: false, focused: false };
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

function back() {
  front = { visible: true, focused: true };
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

describe.if(hasDom)('useInboxNotifications', () => {
  beforeEach(() => {
    front = { visible: true, focused: true };
    onScreen = null;
    questionsHeard = 0;
    silent = false;
    installStubs();
    host = document.createElement('div');
    document.body.appendChild(host);
    act(() => {
      root = createRoot(host!);
      root.render(<Probe />);
    });
    // The page's first list read: these threads were already here.
    act(() => api.flush(list([{ id: 'old', section: 'waiting' }])));
  });
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    restoreStubs();
  });

  test('a new thread that asks nothing notifies with the tab in front, and the sound hears nothing', () => {
    batch([message('t1', 't1')], list([{ id: 'old', section: 'waiting' }, { id: 't1', section: 'new' }]));
    expect(raised).toHaveLength(1);
    expect(raised[0]!.title.startsWith('billing-svc: Claude Code')).toBe(true);
    expect(raised[0]!.body).toBe('Subject t1');
    expect(questionsHeard).toBe(0);
  });

  test('a question in the thread open and visible raises nothing in front; away, or in another thread, it does', () => {
    onScreen = 'old';
    batch([message('m1', 'old'), question('m1', 'q-1')], list([{ id: 'old', section: 'waiting' }]));
    expect(raised).toHaveLength(0);
    // The sound still hears it (it decides for itself, and rings only with no Inbox tab in front).
    expect(questionsHeard).toBe(1);

    away();
    batch([message('m2', 'old'), question('m2', 'q-2')], list([{ id: 'old', section: 'waiting' }]));
    expect(raised).toHaveLength(1);
    back();

    onScreen = 'elsewhere';
    batch([message('m3', 'old'), question('m3', 'q-3')], list([{ id: 'old', section: 'waiting' }]));
    expect(raised).toHaveLength(2);
    expect(raised.every((r) => r.body === 'Subject old')).toBe(true);
  });

  test('plain news in a known thread never notifies, in front or away', () => {
    batch([message('m1', 'old')], list([{ id: 'old', section: 'new' }]));
    away();
    batch([message('m2', 'old')], list([{ id: 'old', section: 'new' }]));
    expect(raised).toHaveLength(0);
  });

  test("a later line of a root the page already listed (a look, an Unarchive) is never a new thread", () => {
    batch([message('old', 'old')], list([{ id: 'old', section: 'quiet' }]));
    expect(raised).toHaveLength(0);
  });

  test('a burst collapses into one notice on the one tag; one with a thread that asks nothing is not counted as waiting', () => {
    away();
    batch([message('t1', 't1'), question('t1', 'q-1')], list([{ id: 't1', section: 'waiting' }]));
    batch([message('t2', 't2'), question('t2', 'q-2')], list([{ id: 't1', section: 'waiting' }, { id: 't2', section: 'waiting', project: 'docs-site' }]));
    expect(raised.map((r) => r.tag)).toEqual([raised[0]!.tag, raised[0]!.tag]);
    const waitingBurst = raised.at(-1)!;
    expect(waitingBurst.title.startsWith('2 ')).toBe(true);
    expect(waitingBurst.body).toBe('billing-svc, docs-site');
    batch(
      [message('t3', 't3')],
      list([
        { id: 't1', section: 'waiting' },
        { id: 't2', section: 'waiting', project: 'docs-site' },
        { id: 't3', section: 'new' },
      ]),
    );
    const mixed = raised.at(-1)!;
    expect(mixed.title.startsWith('3 ')).toBe(true);
    expect(mixed.title.replace('3', '2')).not.toBe(waitingBurst.title);
  });

  test('a notice raised in front does not join the next away burst', () => {
    batch([message('t1', 't1')], list([{ id: 't1', section: 'new' }]));
    away();
    batch([message('t2', 't2'), question('t2', 'q-1')], list([{ id: 't1', section: 'new' }, { id: 't2', section: 'waiting' }]));
    expect(raised).toHaveLength(2);
    // One thread in this burst: its own banner, not "2 … in billing-svc".
    expect(raised[1]!.body).toBe('Subject t2');
  });

  test('silent follows the sound: the same rule in front and away', () => {
    silent = true;
    batch([message('t1', 't1')], list([{ id: 't1', section: 'new' }]));
    away();
    batch([message('t2', 't2'), question('t2', 'q-1')], list([{ id: 't1', section: 'new' }, { id: 't2', section: 'waiting' }]));
    silent = false;
    batch([message('t3', 't3')], list([{ id: 't3', section: 'new' }]));
    expect(raised.map((r) => r.silent)).toEqual([true, true, false]);
  });
});
