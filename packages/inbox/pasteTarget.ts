/**
 * A paste aimed at nothing goes to the text field the person was writing in.
 *
 * Dictation apps (Hex, and most others on macOS) insert their text by putting
 * it on the clipboard and posting a synthetic ⌘V to the front app. The paste
 * lands in whatever has focus at that moment. In the Inbox, focus often leaves
 * the field the person is writing in without them noticing: a click on a
 * question card's choice moves it to that radio or checkbox, a click on a
 * message's text or on a chip in the reply box moves it to the page, while
 * the reply box stays open (and keeps its border). A ⌘V then pastes into
 * nothing, and the dictated words are lost, seemingly at random.
 *
 * So: the window remembers the last text field that had focus (the reply
 * box, a question card's note or Other field, compose, any input), and when a
 * ⌘V (Ctrl+V off macOS) arrives while focus is on something that takes no
 * text, it puts focus back in that field, with its caret or selection where
 * the person left it, before the browser runs the paste. The keydown is never
 * cancelled, so the browser's own paste runs (Chrome runs it after the page
 * has handled the keydown), now into the field. Nothing changes when focus is
 * already in a text field, inside a frame (an attached HTML page), or when
 * the field is gone, hidden, disabled or read-only, or sits outside an open
 * modal dialog.
 */

import { isModKeyHeld } from '@plannotator/ui/utils/platform';

/** Input types that take typed text. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number', '']);

type TextField = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export function isTextField(target: EventTarget | null | undefined): target is TextField {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  return target.isContentEditable;
}

/** A ⌘V / Ctrl+V keydown (Shift allowed: paste and match style). */
export function isPasteKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>, mod: (e: { metaKey: boolean; ctrlKey: boolean }) => boolean = isModKeyHeld): boolean {
  if (event.isComposing || event.altKey || !mod(event)) return false;
  return event.key === 'v' || event.key === 'V' || event.code === 'KeyV';
}

function usable(field: TextField): boolean {
  if (!field.isConnected) return false;
  if ((field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && (field.disabled || field.readOnly)) return false;
  if (field.closest('[inert], [aria-hidden="true"]')) return false;
  if (field.getClientRects().length === 0) return false;
  // An open modal dialog owns the keys: a field behind it is not a paste target.
  let modals: Element[];
  try {
    modals = [...field.ownerDocument.querySelectorAll('dialog[open]:modal, [aria-modal="true"]')];
  } catch {
    modals = [...field.ownerDocument.querySelectorAll('dialog[open], [aria-modal="true"]')];
  }
  return modals.every((modal) => modal.contains(field));
}

/**
 * Install on a window; returns the uninstall. `mod` is for tests (the
 * platform's own modifier by default).
 */
export function installPasteFollowsField(win: Window = window, mod?: (e: { metaKey: boolean; ctrlKey: boolean }) => boolean): () => void {
  const doc = win.document;
  let last: TextField | null = null;
  let selection: { start: number | null; end: number | null; direction: 'forward' | 'backward' | 'none' | null } | null = null;

  const remember = (event: FocusEvent) => {
    const target = event.target;
    if (isTextField(target)) {
      last = target;
      selection = null;
    }
  };
  // Where the caret was when the field lost focus, to put it back there.
  const leave = (event: FocusEvent) => {
    const target = event.target;
    if (target !== last || !(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) return;
    try {
      selection = { start: target.selectionStart, end: target.selectionEnd, direction: target.selectionDirection };
    } catch {
      selection = null; // input types without a selection (number, email)
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isPasteKey(event, mod)) return;
    const active = doc.activeElement;
    // Already in a text field, or in a frame (the page in it gets the keys): the paste is aimed.
    if (isTextField(active) || active instanceof HTMLIFrameElement) return;
    const field = last;
    if (!field || !usable(field)) return;
    field.focus({ preventScroll: true });
    if (doc.activeElement !== field) return;
    if (selection && (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) {
      try {
        const length = field.value.length;
        const start = Math.min(selection.start ?? length, length);
        const end = Math.min(selection.end ?? start, length);
        field.setSelectionRange(start, end, selection.direction ?? 'none');
      } catch {
        // input types without a selection
      }
    }
  };

  doc.addEventListener('focusin', remember, true);
  doc.addEventListener('focusout', leave, true);
  win.addEventListener('keydown', onKey, true);
  return () => {
    doc.removeEventListener('focusin', remember, true);
    doc.removeEventListener('focusout', leave, true);
    win.removeEventListener('keydown', onKey, true);
  };
}
