/**
 * A ⌘V aimed at nothing goes to the text field the person was writing in
 * (pasteTarget.ts). Dictation apps (Hex and others) insert text with a
 * synthetic ⌘V; in the Inbox focus often leaves the field without the person
 * noticing (a click on a question's choice, on the message text, on a chip),
 * and the paste then landed nowhere.
 *
 * Proved here on the real handler, with several kinds of field (a textarea
 * like the reply box, a text input like a question's Other, a contenteditable,
 * a field inside a modal dialog like compose): focus comes back, with the
 * caret where it was, before the browser pastes; a paste already aimed at a
 * field, a frame, a field that is gone, disabled, read-only or hidden, or one
 * behind a modal dialog, is left alone; other chords are untouched and the
 * keydown is never cancelled.
 *
 * The whole window in a real Chromium (the reply box, a question card's note,
 * compose): tests/e2e/inbox-paste.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';

const hasDom = typeof document !== 'undefined';
const { installPasteFollowsField, isPasteKey } = (hasDom ? await import('./pasteTarget') : {}) as typeof import('./pasteTarget');

const mac = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey;
let uninstall: (() => void) | null = null;

beforeEach(() => {
  if (!hasDom) return;
  uninstall = installPasteFollowsField(window, mac);
});
afterEach(() => {
  if (!hasDom) return;
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = '';
});

/** A ⌘V as Chrome hands it to the page: keydown Meta, then keydown V with metaKey. Returns the V keydown. */
function commandV(init: KeyboardEventInit = {}): KeyboardEvent {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true, bubbles: true, cancelable: true }));
  const v = new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', metaKey: true, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(v);
  return v;
}

/** Build a page; every element "laid out" (happy-dom draws nothing, so client rects are stubbed per element). */
function page(html: string): void {
  document.body.innerHTML = html;
  for (const el of document.body.querySelectorAll<HTMLElement>('*')) {
    if (el.hasAttribute('data-hidden')) continue;
    el.getClientRects = () => [{ x: 0, y: 0, width: 10, height: 10 }] as unknown as DOMRectList;
  }
}

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

test.skipIf(!hasDom)('isPasteKey: the platform modifier with V, Shift allowed; nothing else', () => {
  const base = { key: 'v', code: 'KeyV', metaKey: true, ctrlKey: false, altKey: false, isComposing: false };
  expect(isPasteKey(base, mac)).toBe(true);
  expect(isPasteKey({ ...base, key: 'V' }, mac)).toBe(true);
  // Another keyboard layout: the key's name differs, the physical key is V.
  expect(isPasteKey({ ...base, key: 'м' }, mac)).toBe(true);
  expect(isPasteKey({ ...base, metaKey: false }, mac)).toBe(false);
  expect(isPasteKey({ ...base, metaKey: false, ctrlKey: true }, mac)).toBe(false);
  expect(isPasteKey({ ...base, altKey: true }, mac)).toBe(false);
  expect(isPasteKey({ ...base, isComposing: true }, mac)).toBe(false);
  expect(isPasteKey({ ...base, key: 'c', code: 'KeyC' }, mac)).toBe(false);
});

test.skipIf(!hasDom)('several fields: a ⌘V on a choice, a button or the page goes back to the field last written in, caret kept', () => {
  page(`
    <textarea id="reply"></textarea>
    <input id="other" type="text">
    <div id="rich" contenteditable="true"></div>
    <label><input id="choice" type="radio" name="q"> Retry</label>
    <button id="chip">Keep open</button>
    <p id="text" tabindex="-1">The agent's message</p>
  `);
  const reply = $<HTMLTextAreaElement>('#reply');
  const other = $<HTMLInputElement>('#other');
  const rich = $<HTMLElement>('#rich');

  // The reply box: words in it, the caret in the middle, then a pick on a question.
  reply.focus();
  reply.value = 'one three';
  reply.setSelectionRange(4, 4);
  $<HTMLInputElement>('#choice').focus();
  const v = commandV();
  expect(document.activeElement).toBe(reply);
  expect([reply.selectionStart, reply.selectionEnd]).toEqual([4, 4]);
  // Never cancelled: the browser's own paste runs, into the field.
  expect(v.defaultPrevented).toBe(false);

  // A text input (a question's Other), then a button.
  other.focus();
  other.value = 'Other';
  other.setSelectionRange(5, 5);
  $<HTMLButtonElement>('#chip').focus();
  commandV();
  expect(document.activeElement).toBe(other);
  expect(other.selectionStart).toBe(5);

  // A contenteditable, then the message text (focus on the page itself).
  rich.focus();
  $<HTMLElement>('#text').focus();
  commandV();
  expect(document.activeElement).toBe(rich);

  // Focus on the page itself.
  (document.activeElement as HTMLElement).blur();
  expect(document.activeElement).toBe(document.body);
  commandV();
  expect(document.activeElement).toBe(rich);
});

test.skipIf(!hasDom)('a paste already aimed at a field stays there', () => {
  page(`<textarea id="reply"></textarea><input id="search" type="search">`);
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLInputElement>('#search').focus();
  commandV();
  expect(document.activeElement).toBe($('#search'));
});

test.skipIf(!hasDom)('left alone: no field used yet, a frame, a field gone, disabled, read-only or hidden', () => {
  page(`<button id="b">x</button><iframe id="f"></iframe>`);
  $<HTMLButtonElement>('#b').focus();
  commandV();
  expect(document.activeElement).toBe($('#b'));

  for (const [html, change] of [
    ['<textarea id="t"></textarea>', (t: HTMLTextAreaElement) => t.remove()],
    ['<textarea id="t"></textarea>', (t: HTMLTextAreaElement) => (t.disabled = true)],
    ['<textarea id="t"></textarea>', (t: HTMLTextAreaElement) => (t.readOnly = true)],
    ['<div id="w"><textarea id="t"></textarea></div>', (t: HTMLTextAreaElement) => t.parentElement!.setAttribute('inert', '')],
    ['<textarea id="t"></textarea>', (t: HTMLTextAreaElement) => (t.getClientRects = () => [] as unknown as DOMRectList)],
  ] as const) {
    page(`${html}<button id="b">x</button>`);
    const t = $<HTMLTextAreaElement>('#t');
    t.focus();
    $<HTMLButtonElement>('#b').focus();
    change(t);
    commandV();
    expect(document.activeElement).toBe($('#b'));
  }

  // Focus in a frame (an attached HTML page): the page in it owns the keys.
  page(`<textarea id="t"></textarea><iframe id="f"></iframe>`);
  $<HTMLTextAreaElement>('#t').focus();
  $<HTMLIFrameElement>('#f').focus();
  if (document.activeElement === $('#f')) {
    commandV();
    expect(document.activeElement).toBe($('#f'));
  }
});

test.skipIf(!hasDom)('a modal dialog: a field behind it is no target; a field inside it is (compose)', () => {
  page(`
    <textarea id="reply"></textarea>
    <div id="dialog" aria-modal="true" role="dialog"><textarea id="message"></textarea><button id="to">To</button></div>
  `);
  // The reply box was last, then compose opened over it.
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLButtonElement>('#to').focus();
  commandV();
  expect(document.activeElement).toBe($('#to'));

  // In compose: the message, then To.
  $<HTMLTextAreaElement>('#message').focus();
  $<HTMLButtonElement>('#to').focus();
  commandV();
  expect(document.activeElement).toBe($('#message'));
});

test.skipIf(!hasDom)('other chords are untouched', () => {
  page(`<textarea id="reply"></textarea><button id="b">x</button>`);
  $<HTMLTextAreaElement>('#reply').focus();
  $<HTMLButtonElement>('#b').focus();
  commandV({ key: 'c', code: 'KeyC' });
  expect(document.activeElement).toBe($('#b'));
  commandV({ metaKey: false, ctrlKey: true });
  expect(document.activeElement).toBe($('#b'));
});
