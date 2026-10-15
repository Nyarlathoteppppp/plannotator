/**
 * Browser notifications from the open Inbox page (record 6.x; owner Q8: the
 * page first on every platform, the Mac helper later; approval
 * "inbox-notify-every-thread", 2026-10-15).
 *
 * Two things notify: a new thread an agent starts (always, the tab in front
 * or not), and a new question in an agent's message (a `Stopped:` line, a
 * `Holds up:` line or any other question), unless it is in the thread the
 * person has open and visible. Plain news in an existing thread never
 * notifies. Every Inbox notification shares one tag, so the browser shows one
 * at a time. The page keeps the threads of the current burst: with one, the
 * banner names the project, the agent and the subject, and a click opens that
 * thread; with more, the burst becomes one notice, "3 waiting in 2 projects",
 * and a click opens the list. Away, a burst lasts until the tab comes to the
 * front; in front, notices within `FRONT_BURST_MS` of each other are one.
 *
 * The settings live on the Inbox server (config.json), not in localStorage:
 * the permission is per origin and the Inbox can move to another port, so
 * "Not now" and "on" must not depend on the origin.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxAuthor, InboxMessage, InboxSectionId } from '@plannotator/core/inbox-types';
import { inboxApi, type InboxEvent, type ListModel, type NotificationSettings } from './api';
import { agentName, plural } from './format';
import { pageInFront } from './sound';

/** The one tag every Inbox notification carries: a new one replaces the last. */
export const NOTIFICATION_TAG = 'plannotator-inbox';

/**
 * `renotify` is in the Notifications API but not in TypeScript's DOM lib
 * (5.8), so the options type is widened here rather than cast.
 */
export interface InboxNotificationOptions extends NotificationOptions {
  renotify?: boolean;
}

/**
 * The options every Inbox notification is raised with. One tag keeps one
 * notice at a time; `renotify` makes the replacement alert again. Without it
 * Chrome swaps the content of a notice that still carries the tag (one macOS
 * never displayed, say) with no banner and no sound, so a new question would
 * arrive silently.
 */
export function inboxNotificationOptions(text: { body: string }, options: { silent?: boolean } = {}): InboxNotificationOptions {
  const base: InboxNotificationOptions = { body: text.body, tag: NOTIFICATION_TAG, renotify: true };
  // The Inbox's own sound is on (sound.ts): the system's chime (Windows, Linux) would make it two.
  return options.silent ? { ...base, silent: true } : base;
}

/**
 * One thread's banner (record 6.2): "billing-svc: Claude Code stopped on you",
 * "… is waiting on you" while it asks, "… started a thread" for a new thread
 * that asks nothing; the subject is the body.
 */
export function threadNotificationText(input: {
  project: string;
  agent: string;
  subject: string;
  section: InboxSectionId | null;
  /** The notice is about a question (else a new thread that may ask nothing). Absent: a question. */
  asks?: boolean;
}): {
  title: string;
  body: string;
} {
  const asks = input.asks ?? true;
  const what =
    input.section === 'stopped'
      ? 'stopped on you'
      : asks || input.section === 'holding' || input.section === 'waiting'
        ? 'is waiting on you'
        : 'started a thread';
  return { title: `${input.project}: ${input.agent} ${what}`, body: input.subject };
}

/**
 * A burst (record 6.2): "3 waiting in 2 projects", or "2 waiting in
 * billing-svc"; "3 new in …" when a thread in it asks nothing. The body names
 * the projects.
 */
export function burstNotificationText(projects: readonly string[], options: { waiting?: boolean } = {}): { title: string; body: string } {
  const distinct = [...new Set(projects)];
  const where = distinct.length === 1 ? distinct[0]! : plural(distinct.length, 'project');
  const what = options.waiting === false ? 'new' : 'waiting';
  return { title: `${projects.length} ${what} in ${where}`, body: distinct.join(', ') };
}

/** In front, notices this close together are one burst; away, a burst lasts until the tab is back. */
export const FRONT_BURST_MS = 30_000;

/**
 * A message line that is a new thread an agent started: the thread's root,
 * an agent's, not yet looked at, read, archived or read by the agent, and not
 * a thread this page already knew (a later line of an older root, such as an
 * Unarchive, is never a new thread).
 */
export function isNewAgentThread(message: InboxMessage, known: ReadonlySet<string>): boolean {
  return (
    message.id === message.thread_id &&
    message.author.kind === 'agent' &&
    message.started_by_person !== true &&
    message.resolved_at === null &&
    (message.person_seen_seq ?? null) === null &&
    (message.person_read_seq ?? null) === null &&
    (message.agent_checked_seq ?? null) === null &&
    !known.has(message.thread_id)
  );
}

/** One thread a list read may notify about. */
export interface NotifyItem {
  threadId: string;
  author: InboxAuthor;
  /** A new question in it. */
  asks: boolean;
  /** The thread itself is new. */
  fresh: boolean;
}

/**
 * Which items raise a notice: a new thread always; a question unless its
 * thread is the one open and visible (`onScreen`, false whenever the tab is
 * not in front).
 */
export function notifiableItems(items: readonly NotifyItem[], onScreen: (threadId: string) => boolean): NotifyItem[] {
  return items.filter((item) => item.fresh || !onScreen(item.threadId));
}

/**
 * Whether a notice starts a new burst: the tab went from away to in front or
 * back since the last one, or, in front, the last one is older than
 * `FRONT_BURST_MS`.
 */
export function startsNewBurst(last: { front: boolean; at: number } | null, front: boolean, now: number): boolean {
  if (!last || last.front !== front) return true;
  return front && now - last.at > FRONT_BURST_MS;
}

export type AskKind = 'ask' | 'moved';

/**
 * Which one-time line the list shows, if any: the ask, or, when the person
 * turned notifications on at another origin (the Inbox moved port), "The
 * Inbox moved to a new address". Never once they said "Not now", turned
 * notifications off, or the browser already decided.
 */
export function askKind(settings: NotificationSettings, permission: NotificationPermission, origin: string): AskKind | null {
  if (permission !== 'default' || !settings.enabled || settings.dismissed) return null;
  return settings.allowed_origin && settings.allowed_origin !== origin && sameHost(settings.allowed_origin, origin) ? 'moved' : 'ask';
}

/**
 * "Moved" is the Inbox's port changing under the same name. Another name
 * (the tailnet address on another device, or localhost after the tailnet)
 * is another place the Inbox is open, with its own permission: the plain ask.
 */
function sameHost(a: string, b: string): boolean {
  const loopback = (host: string) => host === 'localhost' || host === '[::1]' || /^127\./.test(host);
  try {
    const left = new URL(a).hostname;
    const right = new URL(b).hostname;
    return left === right || (loopback(left) && loopback(right));
  } catch {
    return false;
  }
}

function supported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

function currentPermission(): NotificationPermission | 'unsupported' {
  return supported() ? Notification.permission : 'unsupported';
}

export interface InboxNotifications {
  /** The browser's answer for this origin. */
  permission: NotificationPermission | 'unsupported';
  /** The one-time line to draw above the list, or null. */
  ask: AskKind | null;
  /** Every event-stream line, before the debounced list read. */
  observe: (event: InboxEvent | null) => void;
  /** After a list read: raise what the lines brought (and remember the threads it shows). */
  flush: (list: ListModel) => void;
  turnOn: () => Promise<void>;
  notNow: () => void;
  setEnabled: (next: boolean) => Promise<void>;
}

export function useInboxNotifications(options: {
  settings: NotificationSettings | null;
  onSettings: (next: NotificationSettings) => void;
  openThread: (threadId: string) => void;
  openList: () => void;
  /** New questions arrived (before any notification rule): the sound decides for itself (sound.ts). */
  onQuestions?: () => void;
  /** The Inbox's own sound is on: notifications are raised silent, so there is one sound on every OS. */
  silent?: () => boolean;
  /** The thread is open and visible (its pane mounted and not covered): a question in it raises nothing while in front. */
  threadOnScreen?: (threadId: string) => boolean;
}): InboxNotifications {
  const [permission, setPermission] = useState(currentPermission);
  const [askRaised, setAskRaised] = useState(false);
  const settingsRef = useRef(options.settings);
  settingsRef.current = options.settings;
  const openRef = useRef({ thread: options.openThread, list: options.openList });
  openRef.current = { thread: options.openThread, list: options.openList };
  const onSettingsRef = useRef(options.onSettings);
  onSettingsRef.current = options.onSettings;
  const soundRef = useRef({ questions: options.onQuestions, silent: options.silent });
  soundRef.current = { questions: options.onQuestions, silent: options.silent };
  const onScreenRef = useRef(options.threadOnScreen);
  onScreenRef.current = options.threadOnScreen;
  const messages = useRef(new Map<string, { threadId: string; author: InboxAuthor }>());
  const counted = useRef(new Set<string>());
  /** Every thread a list read showed this page: a later line of one of those roots is never a new thread. */
  const known = useRef(new Set<string>());
  /** Message ids with a new question, waiting for the list read. */
  const pending = useRef<string[]>([]);
  /** New threads an agent started, waiting for the list read. */
  const pendingThreads = useRef<string[]>([]);
  /** The threads of the current burst, with their project names and whether they ask. */
  const burst = useRef(new Map<string, { project: string; asks: boolean }>());
  /** When the last notice was raised, and whether the tab was in front then. */
  const lastNotice = useRef<{ front: boolean; at: number } | null>(null);

  // A grant or block made in the browser's site settings shows without a reload.
  useEffect(() => {
    if (!supported() || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    const sync = () => setPermission(currentPermission());
    navigator.permissions
      .query({ name: 'notifications' })
      .then((s) => {
        status = s;
        s.addEventListener('change', sync);
      })
      .catch(() => {});
    return () => status?.removeEventListener('change', sync);
  }, []);

  // Back in front: the person sees the list, so the next notice starts a new burst.
  useEffect(() => {
    const back = () => {
      if (pageInFront()) burst.current.clear();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, []);

  const save = useCallback(async (change: Partial<NotificationSettings>) => {
    const current = settingsRef.current;
    if (current) onSettingsRef.current({ ...current, ...change });
    try {
      onSettingsRef.current((await inboxApi.saveNotifications(change)).notifications);
    } catch {
      if (current) onSettingsRef.current(current);
    }
  }, []);

  const observe = useCallback((event: InboxEvent | null) => {
    if (!event) return;
    if (event.kind === 'message' && event.message.author.kind === 'agent') {
      const message = event.message;
      messages.current.set(message.id, { threadId: message.thread_id, author: message.author });
      const id = `thread:${message.thread_id}`;
      if (!counted.current.has(id) && isNewAgentThread(message, known.current)) {
        counted.current.add(id);
        pendingThreads.current.push(message.thread_id);
      }
    } else if (event.kind === 'question') {
      const q = event.question;
      const id = `${q.message_id}/${q.key}`;
      // A new question is open at revision 0; a pick or a Send of an old one is not an item.
      if (q.state !== 'open' || q.revision !== 0 || counted.current.has(id)) return;
      counted.current.add(id);
      pending.current.push(q.message_id);
    }
  }, []);

  const flush = useCallback((list: ListModel) => {
    const questions = pending.current;
    const fresh = pendingThreads.current;
    pending.current = [];
    pendingThreads.current = [];
    const rowList = list.sections.flatMap((section) => section.threads);
    for (const row of rowList) known.current.add(row.thread_id);
    if (questions.length === 0 && fresh.length === 0) return;
    // The threads these items landed in, newest last, with the agent that wrote.
    const threads = new Map<string, NotifyItem>();
    for (const threadId of fresh) {
      const root = messages.current.get(threadId);
      if (root) threads.set(threadId, { threadId, author: root.author, asks: false, fresh: true });
    }
    for (const messageId of questions) {
      const message = messages.current.get(messageId);
      if (!message) continue;
      const before = threads.get(message.threadId);
      threads.delete(message.threadId);
      threads.set(message.threadId, { threadId: message.threadId, author: message.author, asks: true, fresh: before?.fresh ?? false });
    }
    if (threads.size === 0) return;
    const asks = [...threads.values()].some((item) => item.asks);
    // The sound does not depend on notifications (off, not allowed or blocked, it still rings), and rings for questions only.
    if (asks) soundRef.current.questions?.();
    const settings = settingsRef.current;
    if (!settings || !settings.enabled || !supported()) return;
    const now = Notification.permission;
    setPermission(now);
    if (now === 'default') {
      // The one-time ask, as before: a new question raises it.
      if (asks) setAskRaised(true);
      return;
    }
    if (now !== 'granted') return;
    const front = pageInFront();
    const items = notifiableItems([...threads.values()], (threadId) => front && onScreenRef.current?.(threadId) === true);
    if (items.length === 0) return;
    const at = Date.now();
    if (startsNewBurst(lastNotice.current, front, at)) burst.current.clear();
    lastNotice.current = { front, at };
    const rows = new Map(rowList.map((row) => [row.thread_id, row]));
    for (const item of items) {
      const earlier = burst.current.get(item.threadId);
      burst.current.delete(item.threadId);
      burst.current.set(item.threadId, {
        project: rows.get(item.threadId)?.project.name ?? 'Plannotator Inbox',
        asks: item.asks || (earlier?.asks ?? false),
      });
    }
    let text: { title: string; body: string };
    let open: () => void;
    if (burst.current.size === 1) {
      const item = items.at(-1)!;
      const row = rows.get(item.threadId);
      text = threadNotificationText({
        project: row?.project.name ?? 'Plannotator Inbox',
        agent: agentName(item.author),
        subject: row?.subject ?? '(no subject)',
        section: row?.section ?? null,
        asks: burst.current.get(item.threadId)!.asks,
      });
      open = () => openRef.current.thread(item.threadId);
    } else {
      const entries = [...burst.current.values()];
      text = burstNotificationText(
        entries.map((entry) => entry.project),
        { waiting: entries.every((entry) => entry.asks) },
      );
      open = () => openRef.current.list();
    }
    try {
      const notification = new Notification(text.title, inboxNotificationOptions(text, { silent: soundRef.current.silent?.() === true }));
      notification.onclick = () => {
        window.focus();
        notification.close();
        burst.current.clear();
        lastNotice.current = null;
        open();
      };
    } catch {
      // A browser that only notifies through a service worker: nothing to show.
    }
  }, []);

  const turnOn = useCallback(async () => {
    if (!supported()) return;
    const answer = await Notification.requestPermission();
    setPermission(answer);
    setAskRaised(false);
    await save(answer === 'granted' ? { enabled: true, dismissed: false, allowed_origin: window.location.origin } : { dismissed: true });
  }, [save]);

  const notNow = useCallback(() => {
    setAskRaised(false);
    void save({ dismissed: true });
  }, [save]);

  const setEnabled = useCallback(
    async (next: boolean) => {
      if (!next) return save({ enabled: false });
      if (!supported()) return;
      let answer = Notification.permission;
      if (answer === 'default') answer = await Notification.requestPermission();
      setPermission(answer);
      // Turning them on here is an answer too: an earlier "Not now" no longer stands.
      if (answer === 'granted') await save({ enabled: true, dismissed: false, allowed_origin: window.location.origin });
    },
    [save],
  );

  const ask =
    askRaised && options.settings && permission !== 'unsupported' ? askKind(options.settings, permission, window.location.origin) : null;

  return { permission, ask, observe, flush, turnOn, notNow, setEnabled };
}
