/**
 * The row's delivery glyph and the thread's delivery line are one rule
 * (`inboxDeliveryState`): for every combination of what the Inbox knows,
 * the state the server puts on the row is the line's state, and the row's
 * tooltip is the line word for word.
 */
import { describe, expect, test } from 'bun:test';
import { inboxDeliveryState, type InboxListRow, type InboxListSection, type InboxRowDelivery } from '@plannotator/core/inbox-types';
import { deliveryLine, type DeliveryLineInput, type RecipientConnection } from './deliveryLine';
import { hasMovingDelivery, rowDeliveryLine, rowDeliveryName, rowDeliverySpoken, rowTimeIso } from './rowDelivery';

const time = (iso: string) => `at ${iso.slice(11, 16)}`;
const AT = '2026-10-20T15:41:00.000Z';

const connections: (RecipientConnection | null | undefined)[] = [
  undefined,
  null,
  { busy: true, idle_since: null, send_now: true },
  { busy: true, idle_since: null, send_now: false },
  { busy: false, idle_since: AT, send_now: false },
  { busy: null, idle_since: null, send_now: false },
];

function* inputs(): Generator<DeliveryLineInput> {
  for (const delivered of [false, true])
    for (const undelivered of [false, true])
      for (const ended of [false, true])
        for (const wakes of [false, true])
          for (const sendingNow of [false, true])
            for (const connection of connections) {
              yield {
                name: 'Claude Code',
                deliveredAt: delivered ? AT : null,
                time,
                wakes,
                sendingNow,
                connection,
                askerEnded: ended ? { name: 'Claude Code' } : null,
                undelivered: undelivered ? { host: 'Claude Code' } : null,
              };
            }
}

/** What the server puts on the row for the same facts. */
function rowFor(input: DeliveryLineInput): InboxRowDelivery {
  const decision = inboxDeliveryState({
    delivered: !!input.deliveredAt,
    undelivered: !!input.undelivered,
    askerEnded: !!input.askerEnded,
    wakes: input.wakes,
    sendingNow: input.sendingNow,
    connection: input.connection,
  });
  return { kind: 'reply', state: decision.state, reason: decision.reason, send_now: decision.sendNow, message_id: 'msg_x', at: input.deliveredAt, host: 'claude-code', name: null };
}

describe('the row and the thread agree', () => {
  test('every case: the same state, Send now, and the tooltip is the thread line', () => {
    let count = 0;
    for (const input of inputs()) {
      const line = deliveryLine(input);
      const row = rowFor(input);
      expect(row.state).toBe(line.state);
      expect(row.send_now).toBe(line.sendNow === true);
      expect(rowDeliveryLine(row, time)).toBe(line.text);
      count += 1;
    }
    expect(count).toBe(2 * 2 * 2 * 2 * 2 * connections.length);
  });

  test('each state is reached', () => {
    const states = new Set([...inputs()].map((input) => deliveryLine(input).state));
    expect([...states].sort()).toEqual(['delivered', 'queued', 'saved', 'sending', 'undelivered']);
  });
});

const base: InboxRowDelivery = { kind: 'reply', state: 'queued', reason: 'working', send_now: true, message_id: 'msg_x', at: null, host: 'claude-code', name: null };

describe('the row words', () => {
  test('whom: the host, an MCP agent by its own name, another session', () => {
    expect(rowDeliveryName(base)).toBe('Claude Code');
    expect(rowDeliveryName({ ...base, host: 'codex', name: 'Codex (review)' })).toBe('Codex (review)');
    expect(rowDeliveryName({ ...base, another_session: true })).toBe('Claude Code (another session)');
  });

  test('the state in words for the accessible name, a 👍 says so', () => {
    expect(rowDeliverySpoken(base)).toBe('Queued for Claude Code');
    expect(rowDeliverySpoken({ ...base, state: 'sending' })).toBe('Sending to Claude Code');
    expect(rowDeliverySpoken({ ...base, state: 'saved' })).toBe('Saved for Claude Code');
    expect(rowDeliverySpoken({ ...base, state: 'delivered' })).toBe('Delivered to Claude Code');
    expect(rowDeliverySpoken({ ...base, state: 'undelivered' })).toBe('Not delivered');
    expect(rowDeliverySpoken({ ...base, kind: 'ack', state: 'queued' })).toBe('Looks good, queued for Claude Code');
  });

  test("a 👍's tooltip, in its Undo window and after", () => {
    expect(rowDeliveryLine({ ...base, kind: 'ack', reason: 'ack_pending' })).toBe('👍 Looks good · Goes to Claude Code in a few seconds');
    expect(rowDeliveryLine({ ...base, kind: 'ack', state: 'sending', reason: 'idle' })).toBe('👍 Looks good · Sending to Claude Code…');
  });

  test('the time is the delivery time once delivered', () => {
    const row = { last_at: '2026-10-20T15:00:00.000Z', delivery: null } as unknown as InboxListRow;
    expect(rowTimeIso(row)).toBe('2026-10-20T15:00:00.000Z');
    expect(rowTimeIso({ ...row, delivery: { ...base, state: 'delivered', reason: 'delivered', at: AT } })).toBe(AT);
    expect(rowTimeIso({ ...row, delivery: { ...base, state: 'queued' } })).toBe('2026-10-20T15:00:00.000Z');
  });

  test('the list reads again on `deliveries` only while some delivery can move', () => {
    const section = (deliveries: (InboxRowDelivery | null | undefined)[]): InboxListSection[] => [
      { id: 'sent', label: 'Sent', threads: deliveries.map((delivery) => ({ delivery }) as unknown as InboxListRow) },
    ];
    expect(hasMovingDelivery(null)).toBe(false);
    expect(hasMovingDelivery(section([null, undefined]))).toBe(false);
    expect(hasMovingDelivery(section([{ ...base, state: 'delivered' }]))).toBe(false);
    for (const state of ['queued', 'sending', 'saved', 'undelivered'] as const) expect(hasMovingDelivery(section([{ ...base, state }]))).toBe(true);
  });
});
