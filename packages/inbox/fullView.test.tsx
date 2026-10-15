/**
 * Full view for files (approval "inbox-full-view", A · Pill): Plannotator's
 * "hide tools" in the Inbox's file pane. The eye (ui's HtmlSurfaceControls)
 * hides the header, the changed line, the docked comments and the bottom bar;
 * one floating bar is left (pen on HTML, the comment count that opens the
 * Comments sheet, `N/M ⌄` that opens the peek, the eye that brings the tools
 * back). What is proved here, on the pane as the thread drives it: the eye
 * and focus both ways, the bar's controls, the sheet's foot, the peek from
 * the bar, a step keeping full view with its chip and end note, Escape never
 * leaving it, ⌘⇧X on an HTML file only, and the phone's bar. The thread's
 * wiring (HTML opening straight into full view, the shared cookie) is
 * fullViewRemembered.test.tsx; the browser proof is
 * tests/e2e/inbox-full-view.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentSequence, type AttachmentStep } from './stepping';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { getShortcutPlatform } = (hasDom ? await import('@plannotator/ui/shortcuts') : {}) as typeof import('@plannotator/ui/shortcuts');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
});

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';
const M2 = 'msg_01K7M2MMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string, kind: string, messageId: string, extra: Partial<InboxAttachmentState> = {}): InboxAttachmentState {
  return {
    id,
    name,
    path: `/work/shop/${name}`,
    kind: kind as InboxAttachmentState['kind'],
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-10T10:42:00.000Z',
    sent_mtime: '2026-10-10T10:42:00.000Z',
    message_id: messageId,
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
    ...extra,
  };
}

const notes = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'notes.md', 'markdown', M1);
const page = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'turnkey.html', 'html', M1);
const shot = file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'shot.png', 'image', M2, { media_type: 'image/png' });

function message(id: string, createdAt: string): InboxMessageWire {
  return { id, created_at: createdAt, author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' } } as unknown as InboxMessageWire;
}

const STEPS: AttachmentStep[] = attachmentSequence([message(M1, '2026-10-10T10:42:00.000Z'), message(M2, '2026-10-10T11:06:00.000Z')], [notes, page, shot]);

/** One saved comment on notes.md, so the count reads 1. */
const RECORD = {
  id: 'ann_1',
  attachment_id: notes.id,
  path: notes.path,
  version: 'current',
  annotation: { id: 'ann_1', blockId: 'block-0', startOffset: 0, endOffset: 4, type: 'COMMENT', text: 'Say why.', originalText: 'Plan', createdA: 1 },
} as unknown as InboxAnnotationRecord;

/** The view route: markdown text, or the HTML page. */
function stubViews() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const att = [notes, page, shot].find((a) => url.includes(a.id));
    if (att && url.includes('/view')) {
      return new Response(
        JSON.stringify({ attachment: att, version: 'current', text: att.kind === 'html' ? '<h1>Checkout</h1>' : '# Plan\n\nShip it.\n', html: att.kind === 'html' ? '<h1>Checkout</h1>' : null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

interface Harness {
  back: number;
  reply: number;
  fullView: boolean[];
}

/** The pane as the thread drives it: `full` and `fullView` live in the thread, a step opens the next file in place. */
function Pane({ start, harness, startFull = true, startFullView = false, phone = false, records = [RECORD] }: { start: InboxAttachmentState; harness: Harness; startFull?: boolean; startFullView?: boolean; phone?: boolean; records?: InboxAnnotationRecord[] }) {
  const [open, setOpen] = useState(start);
  const [full, setFull] = useState(startFull);
  const [fullView, setFullView] = useState(startFullView);
  const noop = () => {};
  const all = STEPS.map((s) => s.attachment);
  return (
    <AttachmentPane
      attachment={open}
      attachments={all}
      records={records}
      agent="Claude Code"
      projectName="shop"
      projectRoot="/work/shop"
      version="current"
      onVersion={noop}
      full={full || phone}
      fullLocked={phone}
      onToggleFull={() => setFull((v) => !v)}
      fullView={fullView}
      onFullView={(on) => {
        harness.fullView.push(on);
        if (on && !full && !phone) setFull(true);
        setFullView(on);
      }}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={noop}
      strip={{ picks: 0, annotations: records.length, onBack: () => harness.back++, onWriteReply: () => harness.reply++ }}
      steps={STEPS}
      phone={phone}
      onStep={(id) => setOpen(all.find((a) => a.id === id)!)}
    />
  );
}

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  await settle();
}

async function settle(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function key(target: EventTarget, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

const harnessOf = (): Harness => ({ back: 0, reply: 0, fullView: [] });
const pane = () => host!.querySelector<HTMLElement>('[data-attachment-pane]')!;
const bar = () => host!.querySelector<HTMLElement>('[data-full-view-bar]');
const headerEye = () => host!.querySelector<HTMLButtonElement>('.ib-vhead [data-html-tools-toggle]');
const click = async (el: HTMLElement | null) => {
  await act(async () => el!.click());
  await settle();
};
/** The platform's own ⌘⇧X. */
const chord = () => (getShortcutPlatform() === 'mac' ? { key: 'X', code: 'KeyX', metaKey: true, shiftKey: true } : { key: 'X', code: 'KeyX', ctrlKey: true, shiftKey: true });

test.skipIf(!hasDom)('the eye hides the header, the changed line, the docked panel and the bottom bar; the bar takes focus; the bar eye brings everything back', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} />);
  // Full screen with the tools: the header holds ui's eye (Hide tools), the bar under the file and the panel are there.
  expect(headerEye()).not.toBeNull();
  expect(headerEye()!.getAttribute('aria-pressed')).toBe('false');
  expect(host!.querySelector('[data-view-foot]')).not.toBeNull();
  expect(bar()).toBeNull();

  await click(headerEye());
  expect(harness.fullView).toEqual([true]);
  expect(pane().hasAttribute('data-full-view')).toBe(true);
  expect(host!.querySelector('.ib-vhead')).toBeNull();
  expect(host!.querySelector('[data-view-foot]')).toBeNull();
  expect(host!.querySelector('[data-changed-line]')).toBeNull();
  // The docked panel folds: it opens only as the sheet.
  expect(pane().classList.contains('ib-fold')).toBe(true);
  expect(pane().classList.contains('ib-panel-open')).toBe(false);
  // The bar: a named toolbar, first in the pane, focus on its eye.
  expect(bar()!.getAttribute('role')).toBe('toolbar');
  expect(pane().firstElementChild).toBe(bar());
  const eye = host!.querySelector<HTMLButtonElement>('[data-full-view-eye]')!;
  expect(document.activeElement).toBe(eye);
  expect(eye.getAttribute('aria-pressed')).toBe('true');
  // Markdown has no pen and no ⌘⇧X: the live region names the eye only.
  expect(host!.querySelector('[data-full-view-pen]')).toBeNull();
  await settle();
  expect(host!.querySelector('[data-step-live]')!.textContent).toBe('Tools hidden. Press the eye to bring them back.');

  await click(eye);
  expect(harness.fullView).toEqual([true, false]);
  expect(bar()).toBeNull();
  expect(host!.querySelector('.ib-vhead')).not.toBeNull();
  expect(document.activeElement).toBe(headerEye());
});

test.skipIf(!hasDom)('beside the thread the eye takes the file full screen, straight into full view', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} startFull={false} />);
  expect(pane().classList.contains('ib-full')).toBe(false);
  await click(headerEye());
  expect(pane().classList.contains('ib-full')).toBe(true);
  expect(bar()).not.toBeNull();
});

test.skipIf(!hasDom)('the count opens the Comments sheet over the file; its foot says what rides the next Send, with Back to the thread and Write the reply', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} startFullView />);
  const count = host!.querySelector<HTMLButtonElement>('[data-full-view-comments]')!;
  expect(count.getAttribute('aria-label')).toBe('Comments, 1');
  expect(count.getAttribute('aria-expanded')).toBe('false');
  await click(count);
  expect(pane().classList.contains('ib-panel-open')).toBe(true);
  expect(count.getAttribute('aria-expanded')).toBe('true');
  // The bar steps left of the sheet.
  expect(bar()!.classList.contains('ib-shift')).toBe(true);
  const foot = host!.querySelector<HTMLElement>('[data-full-view-foot]')!;
  expect(foot.textContent).toContain('1 annotation rides your next Send to Claude Code.');
  const buttons = [...foot.querySelectorAll<HTMLButtonElement>('button')];
  await click(buttons.find((b) => b.textContent === 'Write the reply')!);
  expect(harness.reply).toBe(1);
  await click(buttons.find((b) => b.textContent === 'Back to the thread')!);
  expect(harness.back).toBe(1);
  // Escape in the sheet (still open: this harness's thread does not close the file) closes it first, focus back on the count, full view stays.
  expect(pane().classList.contains('ib-panel-open')).toBe(true);
  await key(host!.querySelector('.ib-apanel')!, { key: 'Escape' });
  expect(pane().classList.contains('ib-panel-open')).toBe(false);
  expect(document.activeElement).toBe(count);
  expect(bar()).not.toBeNull();
});

test.skipIf(!hasDom)('N/M opens the file peek under the bar; a pick steps there and full view stays', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} startFullView />);
  const pos = host!.querySelector<HTMLButtonElement>('[data-full-view-position]')!;
  expect(pos.textContent).toBe('1/3');
  expect(pos.getAttribute('aria-label')).toBe('1 of 3, notes.md. Show every file in this thread');
  await click(pos);
  expect(pos.getAttribute('aria-expanded')).toBe('true');
  const peek = bar()!.querySelector<HTMLElement>('[data-step-list] [role="grid"]');
  expect(peek).not.toBeNull();
  const tile = [...peek!.querySelectorAll<HTMLElement>('[role="gridcell"], button')].find((el) => el.textContent?.includes('shot.png'));
  await click(tile!);
  expect(pane().getAttribute('data-attachment-pane')).toBe(shot.id);
  expect(bar()).not.toBeNull();
  expect(pos.getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('a step keeps full view: the chip names the new file for a moment, and "Last file in this thread" at the end', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={page} harness={harness} startFullView />);
  const chip = () => host!.querySelector<HTMLElement>('[data-full-view-chip]')!;
  expect(chip().getAttribute('data-full-view-chip')).toBe('hidden');
  await key(pane(), { key: ']' });
  expect(pane().getAttribute('data-attachment-pane')).toBe(shot.id);
  expect(bar()).not.toBeNull();
  expect(chip().getAttribute('data-full-view-chip')).toBe('shown');
  expect(chip().textContent).toContain('3 of 3');
  expect(chip().textContent).toContain('shot.png');
  // At the end: the note rides the chip.
  await key(pane(), { key: ']' });
  expect(chip().textContent).toContain('Last file in this thread');
  // It fades after its moment (FULL_VIEW_CHIP_MS).
  await settle(1700);
  expect(chip().getAttribute('data-full-view-chip')).toBe('hidden');
  expect(bar()).not.toBeNull();
});

test.skipIf(!hasDom)('Escape never leaves full view: an open peek closes first, then nothing', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} startFullView />);
  const pos = host!.querySelector<HTMLButtonElement>('[data-full-view-position]')!;
  await click(pos);
  const peek = bar()!.querySelector<HTMLElement>('[data-step-list] [role="grid"]')!;
  await key(document.activeElement ?? peek, { key: 'Escape' });
  await settle();
  expect(pos.getAttribute('aria-expanded')).toBe('false');
  for (let i = 0; i < 3; i++) await key(pane(), { key: 'Escape' });
  expect(bar()).not.toBeNull();
  expect(harness.fullView).toEqual([]);
});

test.skipIf(!hasDom)('⌘⇧X toggles full view on an HTML file (the pen and the chord in the bar), and does nothing on markdown', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={page} harness={harness} />);
  // The header: ui's eye before the pen.
  const controls = [...host!.querySelectorAll('.ib-vhead [data-html-tools-toggle], .ib-vhead [data-html-annotate-toggle]')].map((el) => (el.hasAttribute('data-html-tools-toggle') ? 'eye' : 'pen'));
  expect(controls).toEqual(['eye', 'pen']);
  const event = await key(document.body, chord());
  expect(event.defaultPrevented).toBe(true);
  expect(bar()).not.toBeNull();
  // The pen in the bar flips Annotate / Interact.
  const pen = host!.querySelector<HTMLButtonElement>('[data-full-view-pen]')!;
  expect(pen.getAttribute('aria-pressed')).toBe('true');
  await click(pen);
  expect(host!.querySelector('[data-full-view-pen]')!.getAttribute('aria-pressed')).toBe('false');
  await settle();
  expect(host!.querySelector('[data-step-live]')!.textContent).toMatch(/^Tools hidden\. Press .+X or the eye to bring them back\.$/);
  await key(document.body, chord());
  expect(bar()).toBeNull();
  expect(harness.fullView).toEqual([true, false]);

  // Markdown: the chord is not this file's.
  act(() => root?.unmount());
  host?.remove();
  const md = harnessOf();
  await render(<Pane start={notes} harness={md} />);
  const ignored = await key(document.body, chord());
  expect(ignored.defaultPrevented).toBe(false);
  expect(bar()).toBeNull();
  expect(md.fullView).toEqual([]);
});

test.skipIf(!hasDom)('a phone: the eye is in the header; the bar holds pen, count and eye (44 px), and the position lives in the Comments sheet', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={page} harness={harness} phone startFull={false} />);
  await click(headerEye());
  expect(bar()!.classList.contains('ib-fvbar-phone')).toBe(true);
  expect(host!.querySelector('[data-full-view-pen]')).not.toBeNull();
  expect(host!.querySelector('[data-full-view-comments]')).not.toBeNull();
  expect(bar()!.querySelector('[data-full-view-position]')).toBeNull();
  await click(host!.querySelector('[data-full-view-comments]'));
  const pos = host!.querySelector<HTMLButtonElement>('[data-full-view-foot] [data-full-view-position]')!;
  expect(pos.textContent).toContain('2 of 3');
  await click(pos);
  // The peek is the phone's bottom sheet, drawn in the Inbox's root.
  expect(document.querySelector('.pn-inbox-peek [role="grid"]')).not.toBeNull();
});
