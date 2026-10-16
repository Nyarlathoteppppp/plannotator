/**
 * Plain-text paste into our own text fields, inserted by the page.
 *
 * Works around a Chrome 155 to 156 bug on macOS. Remove after Chrome 157 is
 * the stable channel (it ships the fix).
 *
 * Chrome 155 added a check after the `paste` event (Chromium CL 8217390,
 * commit 4f9d868279, "Ensure default paste behavior doesn't leak changed
 * clipboard content"): the browser's own insertion is skipped when the
 * clipboard's sequence token changed while the event ran. On macOS an older
 * race in ClipboardMac can give the same NSPasteboard changeCount a second
 * token when a paste starts right after an app wrote the pasteboard and
 * posted a synthetic ⌘V. Dictation apps (Hex) and text expanders do exactly
 * that. The `paste` event still carries the right `text/plain`, but
 * `beforeinput` arrives with empty data and nothing is inserted: the first
 * dictation after a page load lands, later ones vanish. Fixed in Chromium
 * main (CL 8503629, commit fc5529f522, crbug 568453825), not before 157.
 *
 * So, for a paste into a plain-text field we own (a textarea or a text-like
 * input) that nothing else handled, that carries no files and has text, the
 * page cancels the browser's insertion and inserts the text itself with
 * `execCommand('insertText')` (keeps undo, fires `input`, so React's onChange
 * runs), else `setRangeText` plus an `input` event. That is what the browser
 * would have done, so it is safe on every browser and needs no flag.
 *
 * Left native: a paste that a handler already cancelled (image paste to
 * attach), one that carries files (paste-to-attach keeps working; the
 * browser inserts the text beside them), an empty one, a field that is
 * read-only or disabled, one that is not focused, one mid IME composition,
 * contenteditable and code editors (CodeMirror, Pierre's editor, the agent
 * terminal's helper textarea), and a field marked `data-native-paste`.
 */

/** Input types the page can insert into with a caret (email and number have no selection API). */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'password']);

/** Editors that read the paste themselves through a hidden textarea or own their own model. */
const NATIVE_PASTE = '[data-native-paste], .xterm, .cm-editor, .monaco-editor';

export type PlainTextField = HTMLTextAreaElement | HTMLInputElement;

export interface PasteInsertion {
  field: PlainTextField;
  text: string;
  start: number;
  end: number;
}

type PasteLike = Pick<ClipboardEvent, 'defaultPrevented' | 'clipboardData' | 'target'> & {
  composedPath?: () => EventTarget[];
};

function plainTextField(target: EventTarget | null | undefined): PlainTextField | null {
  if (!target || typeof (target as Node).nodeType !== 'number') return null;
  const el = target as Element;
  const view = el.ownerDocument?.defaultView;
  if (!view) return null;
  if (el instanceof view.HTMLTextAreaElement) return el;
  if (el instanceof view.HTMLInputElement && TEXT_INPUT_TYPES.has(el.type)) return el;
  return null;
}

function carriesFiles(data: DataTransfer): boolean {
  if ((data.files?.length ?? 0) > 0) return true;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') return true;
  }
  return false;
}

function focused(field: PlainTextField): boolean {
  const root = field.getRootNode() as Document | ShadowRoot;
  return 'activeElement' in root && root.activeElement === field;
}

/** Cut to `room` UTF-16 units without splitting a surrogate pair. */
function truncate(text: string, room: number): string {
  if (text.length <= room) return text;
  let cut = room;
  const last = text.charCodeAt(cut - 1);
  if (cut > 0 && last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return text.slice(0, cut);
}

/**
 * What the page should insert for this paste, or null to leave it to the
 * browser. Pure apart from reading the event and the field.
 */
export function plainTextPasteInsertion(event: PasteLike, composing = false): PasteInsertion | null {
  if (event.defaultPrevented || composing) return null;
  const data = event.clipboardData;
  if (!data) return null;
  const path = event.composedPath?.() ?? [];
  const field = plainTextField(path[0] ?? event.target);
  if (!field) return null;
  if (field.readOnly || field.disabled) return null;
  if (field.closest(NATIVE_PASTE)) return null;
  if (!focused(field)) return null;
  if (carriesFiles(data)) return null;
  let text = data.getData('text/plain');
  if (!text) return null;
  // What Chrome does with line breaks: a textarea keeps each as \n, a one-line input turns each into a space.
  text = text.replace(/\r\n?/g, '\n');
  if (field.tagName !== 'TEXTAREA') text = text.replace(/\n/g, ' ');
  if (!text) return null;
  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (start === null || end === null) return null;
  if (field.maxLength >= 0) {
    const room = field.maxLength - (field.value.length - (end - start));
    if (room <= 0) return null; // the browser inserts nothing either
    text = truncate(text, room);
    if (!text) return null;
  }
  return { field, text, start, end };
}

/** Insert as typing would: an undo step and an `input` event. */
export function insertPastedText({ field, text, start, end }: PasteInsertion): void {
  const doc = field.ownerDocument;
  let inserted = false;
  try {
    inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, text) === true;
  } catch {
    inserted = false;
  }
  if (inserted) return;
  field.setRangeText(text, start, end, 'end');
  const caret = start + text.length;
  field.setSelectionRange(caret, caret); // some engines put the caret elsewhere after setRangeText
  const view = doc.defaultView;
  const event =
    view && typeof view.InputEvent === 'function'
      ? new view.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text })
      : new Event('input', { bubbles: true });
  field.dispatchEvent(event);
}

/**
 * Install on a window; returns the uninstall. Listens in the bubble phase on
 * the window, so every handler on the page (React's, the image-paste ones)
 * runs first and can claim the paste.
 */
export function installPlainTextPaste(win: Window = window): () => void {
  const doc = win.document;
  let composing = false;
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
  };
  const onPaste = (event: ClipboardEvent) => {
    const insertion = plainTextPasteInsertion(event, composing);
    if (!insertion) return;
    event.preventDefault();
    insertPastedText(insertion);
  };
  doc.addEventListener('compositionstart', onCompositionStart, true);
  doc.addEventListener('compositionend', onCompositionEnd, true);
  win.addEventListener('paste', onPaste);
  return () => {
    doc.removeEventListener('compositionstart', onCompositionStart, true);
    doc.removeEventListener('compositionend', onCompositionEnd, true);
    win.removeEventListener('paste', onPaste);
  };
}
