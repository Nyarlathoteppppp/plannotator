/**
 * The page inserts a plain-text paste itself (pasteInsert.ts), the Chrome 155
 * to 156 macOS workaround: a dictation app's synthetic ⌘V carried the right
 * text in the `paste` event but Chrome inserted nothing.
 *
 * Proved here on the real handler: which pastes it takes (text into a focused
 * textarea or text input) and which it leaves to the browser (already
 * cancelled, files, empty, read-only, disabled, unfocused, mid IME
 * composition, contenteditable, code editors, email and number inputs), and
 * that what it inserts is what the browser would (maxlength, line breaks, the
 * selection replaced). happy-dom has no execCommand, so the setRangeText
 * fallback runs; Chromium's execCommand path is proved in
 * tests/e2e/inbox-dictation-paste.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';

const hasDom = typeof document !== 'undefined';
const { installPlainTextPaste, plainTextPasteInsertion } = (hasDom ? await import('./pasteInsert') : {}) as typeof import('./pasteInsert');

let uninstall: (() => void) | null = null;
beforeEach(() => {
  if (!hasDom) return;
  uninstall = installPlainTextPaste(window);
});
afterEach(() => {
  if (!hasDom) return;
  uninstall?.();
  uninstall = null;
  document.body.innerHTML = '';
});

interface Clip {
  text?: string;
  files?: File[];
}

function pasteEvent(clip: Clip): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true, composed: true }) as ClipboardEvent;
  const files = clip.files ?? [];
  const items = [
    ...(clip.text !== undefined ? [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] : []),
    ...files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
  ];
  Object.defineProperty(event, 'clipboardData', {
    value: { files, items, types: items.map((i) => i.type), getData: (type: string) => (type === 'text/plain' ? (clip.text ?? '') : '') },
  });
  return event;
}

/** Dispatch a paste on `el`; returns whether the page took it, and counts the `input` events it fired. */
function paste(el: Element, clip: Clip): { taken: boolean; inputs: number } {
  let inputs = 0;
  const count = () => inputs++;
  el.addEventListener('input', count);
  const event = pasteEvent(clip);
  el.dispatchEvent(event);
  el.removeEventListener('input', count);
  return { taken: event.defaultPrevented, inputs };
}

function field<T extends HTMLElement>(html: string): T {
  document.body.innerHTML = html;
  const el = document.body.firstElementChild as T;
  el.focus();
  return el;
}

test('a text paste into a focused textarea is inserted once by the page, at the caret, with an input event', () => {
  if (!hasDom) return;
  const box = field<HTMLTextAreaElement>('<textarea></textarea>');
  box.value = 'Hello world';
  box.setSelectionRange(5, 5);
  expect(paste(box, { text: ', dictated' })).toEqual({ taken: true, inputs: 1 });
  expect(box.value).toBe('Hello, dictated world');
  expect(box.selectionStart).toBe(15);
  // A second dictation (the one Chrome dropped) lands too.
  expect(paste(box, { text: ' again' }).taken).toBe(true);
  expect(box.value).toBe('Hello, dictated again world');
});

test('a selected range is replaced, as the browser would', () => {
  if (!hasDom) return;
  const box = field<HTMLTextAreaElement>('<textarea></textarea>');
  box.value = 'Keep these words';
  box.setSelectionRange(5, 10);
  paste(box, { text: 'those' });
  expect(box.value).toBe('Keep those words');
});

test('text inputs take it too; line breaks become \\n in a textarea and spaces in an input', () => {
  if (!hasDom) return;
  for (const type of ['text', 'search', 'url', 'tel', 'password']) {
    const input = field<HTMLInputElement>(`<input type="${type}">`);
    expect(paste(input, { text: 'a\r\nb\nc' }).taken).toBe(true);
    expect(input.value).toBe('a b c');
  }
  const box = field<HTMLTextAreaElement>('<textarea></textarea>');
  paste(box, { text: 'a\r\nb\rc' });
  expect(box.value).toBe('a\nb\nc');
});

test('maxlength cuts the text to the room left, never splitting a surrogate pair; no room leaves it to the browser', () => {
  if (!hasDom) return;
  const input = field<HTMLInputElement>('<input maxlength="5">');
  input.value = 'ab';
  input.setSelectionRange(2, 2);
  paste(input, { text: 'cdefgh' });
  expect(input.value).toBe('abcde');
  // Replacing a selection frees its room.
  input.setSelectionRange(0, 5);
  paste(input, { text: 'xy' });
  expect(input.value).toBe('xy');
  // One unit of room before an emoji (two units): nothing cut in half.
  input.value = 'abcd';
  input.setSelectionRange(4, 4);
  expect(paste(input, { text: '😀z' }).taken).toBe(false);
  expect(input.value).toBe('abcd');
  // Full: the browser inserts nothing either, so it is left to it.
  input.value = 'abcde';
  input.setSelectionRange(5, 5);
  expect(paste(input, { text: 'more' }).taken).toBe(false);
  expect(input.value).toBe('abcde');
});

test('pastes carrying files are left native: paste-to-attach keeps working', () => {
  if (!hasDom) return;
  const box = field<HTMLTextAreaElement>('<textarea></textarea>');
  const image = new File([new Uint8Array([1])], 'image.png', { type: 'image/png' });
  expect(paste(box, { files: [image] })).toEqual({ taken: false, inputs: 0 });
  // Text beside the file (an image copied from a page): still native, the browser inserts the text.
  expect(paste(box, { files: [image], text: 'caption' })).toEqual({ taken: false, inputs: 0 });
  expect(box.value).toBe('');
});

test('an empty paste, a cancelled one, and one mid IME composition are left alone', () => {
  if (!hasDom) return;
  const box = field<HTMLTextAreaElement>('<textarea></textarea>');
  expect(paste(box, { text: '' }).taken).toBe(false);
  expect(paste(box, {}).taken).toBe(false);

  // A handler on the page cancelled it (an image paste, for one): nothing inserted.
  const cancel = (e: Event) => e.preventDefault();
  box.addEventListener('paste', cancel);
  expect(paste(box, { text: 'words' }).inputs).toBe(0);
  box.removeEventListener('paste', cancel);
  expect(box.value).toBe('');

  box.dispatchEvent(new Event('compositionstart', { bubbles: true }));
  expect(paste(box, { text: 'words' }).taken).toBe(false);
  box.dispatchEvent(new Event('compositionend', { bubbles: true }));
  expect(paste(box, { text: 'words' }).taken).toBe(true);
  expect(box.value).toBe('words');
});

test('read-only, disabled and unfocused fields are left alone', () => {
  if (!hasDom) return;
  const readOnly = field<HTMLTextAreaElement>('<textarea readonly></textarea>');
  expect(paste(readOnly, { text: 'x' }).taken).toBe(false);
  const disabled = field<HTMLInputElement>('<input disabled>');
  expect(paste(disabled, { text: 'x' }).taken).toBe(false);
  document.body.innerHTML = '<textarea></textarea><input id="other">';
  const box = document.querySelector('textarea')!;
  (document.getElementById('other') as HTMLInputElement).focus();
  expect(paste(box, { text: 'x' }).taken).toBe(false);
  expect(box.value).toBe('');
});

test('contenteditable, code editors, email, number and opted-out fields stay native', () => {
  if (!hasDom) return;
  const editable = field<HTMLDivElement>('<div contenteditable="true"></div>');
  expect(paste(editable, { text: 'x' }).taken).toBe(false);
  for (const html of [
    '<div class="cm-editor"><textarea></textarea></div>',
    '<div class="xterm"><textarea class="xterm-helper-textarea"></textarea></div>',
    '<div data-native-paste><textarea></textarea></div>',
  ]) {
    document.body.innerHTML = html;
    const inner = document.querySelector('textarea')!;
    inner.focus();
    expect(paste(inner, { text: 'x' }).taken).toBe(false);
  }
  for (const type of ['email', 'number']) {
    const input = field<HTMLInputElement>(`<input type="${type}">`);
    expect(paste(input, { text: '1' }).taken).toBe(false);
  }
});

test('the decision alone: plainTextPasteInsertion names the field, text and range', () => {
  if (!hasDom) return;
  const box = field<HTMLTextAreaElement>('<textarea></textarea>');
  box.value = 'abc';
  box.setSelectionRange(1, 2);
  const event = pasteEvent({ text: 'XY' });
  Object.defineProperty(event, 'target', { value: box });
  expect(plainTextPasteInsertion(event)).toEqual({ field: box, text: 'XY', start: 1, end: 2 });
  expect(plainTextPasteInsertion(event, true)).toBeNull();
});
