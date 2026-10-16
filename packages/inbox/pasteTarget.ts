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
 * text, it puts focus back in that field, the caret where the person left it
 * (a range they had selected collapses to its end, so the dictation replaces
 * nothing), before the browser runs the paste. The keydown is never
 * cancelled, so the browser's own paste runs (Chrome runs it after the page
 * has handled the keydown), now into the field. Nothing changes when focus is
 * already in a text field, inside a frame (an attached HTML page), or when
 * the field is gone, hidden, disabled or read-only, sits outside a cover over
 * the thread (a full-screen file, a guided review, an open modal dialog), or
 * has something else drawn over it.
 */

import { isModKeyHeld } from '@plannotator/ui/utils/platform';

/** Input types that take typed text. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number']);

/**
 * What covers the thread while it stays laid out under it: a file shown full
 * screen (`.ib-view.ib-full`, fixed over the window), an open guided review
 * (`.ib-viewer`, over the thread pane) and a modal dialog. A field outside
 * such a cover is hidden from the person, so a paste must not go into it.
 */
const COVERS = '.ib-view.ib-full, .ib-viewer, dialog[open], [aria-modal="true"]';

type TextField = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export function isTextField(target: EventTarget | null | undefined): target is TextField {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  return target.isContentEditable;
}

type KeyFields = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing'>;

/**
 * A ⌘V / Ctrl+V keydown (Shift allowed: paste and match style). When the key
 * names a Latin letter, that letter decides: on Dvorak, Colemak-DH or Workman
 * the key in V's place types another letter, and ⌘ with it is that letter's
 * command (⌘K, ⌘D, ⌘C), not paste. Only a key that names no Latin letter (a
 * Cyrillic or Greek layout, where the shortcut still pastes) is read by its
 * physical place.
 */
export function isPasteKey(event: KeyFields, mod: (e: { metaKey: boolean; ctrlKey: boolean }) => boolean = isModKeyHeld): boolean {
  if (event.isComposing || event.altKey || !mod(event)) return false;
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase() === 'v';
  return event.code === 'KeyV';
}

function isModal(dialog: HTMLDialogElement): boolean {
  try {
    return dialog.matches(':modal');
  } catch {
    return true; // no :modal in this browser: count an open dialog as modal (refusing is the safe side)
  }
}

/** Something else is drawn over the field's first line (a sheet, a popover, a cover the selectors do not name). */
function drawnOver(field: TextField): boolean {
  const doc = field.ownerDocument;
  const view = doc.defaultView;
  if (!view || typeof doc.elementFromPoint !== 'function') return false;
  const rect = field.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + Math.min(rect.height / 2, 12);
  // Scrolled out of view inside its pane: nothing covers it, the person scrolled.
  if (x < 0 || y < 0 || x >= view.innerWidth || y >= view.innerHeight) return false;
  const hit = doc.elementFromPoint(x, y);
  if (!hit) return false;
  // The field itself, or the box around it (a highlight mirror drawn behind a transparent textarea).
  return !(hit === field || field.contains(hit) || hit.contains(field));
}

function usable(field: TextField): boolean {
  if (!field.isConnected) return false;
  if ((field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) && (field.disabled || field.readOnly)) return false;
  if (field.closest('[inert], [aria-hidden="true"]')) return false;
  if (field.getClientRects().length === 0) return false;
  // A cover over the thread owns the screen: a field outside it is hidden, though still laid out.
  for (const cover of field.ownerDocument.querySelectorAll(COVERS)) {
    if (cover instanceof HTMLDialogElement && !isModal(cover)) continue;
    if (!cover.contains(field)) return false;
  }
  return !drawnOver(field);
}

/**
 * Install on a window; returns the uninstall. `mod` is for tests (the
 * platform's own modifier by default).
 */
export function installPasteFollowsField(win: Window = window, mod?: (e: { metaKey: boolean; ctrlKey: boolean }) => boolean): () => void {
  const doc = win.document;
  let last: TextField | null = null;
  // Where each field's caret was when it lost focus. Kept apart from `last`, so focusing the field
  // again (which fires focusin) cannot clear it before it is put back.
  const carets = new WeakMap<TextField, number>();

  const remember = (event: FocusEvent) => {
    if (isTextField(event.target)) last = event.target;
  };
  const leave = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) || !isTextField(target)) return;
    try {
      if (target.selectionEnd !== null) carets.set(target, target.selectionEnd);
    } catch {
      // input types without a selection (number, email)
    }
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !isPasteKey(event, mod)) return;
    const active = doc.activeElement;
    // Already in a text field, or in a frame (the page in it gets the keys): the paste is aimed.
    if (isTextField(active) || active instanceof HTMLIFrameElement) return;
    const field = last;
    if (!field || !usable(field)) return;
    // Read before focus(): a range the person selected earlier, no longer visible, would otherwise
    // be what the paste replaces.
    const caret = carets.get(field);
    field.focus({ preventScroll: true });
    if (doc.activeElement !== field) return;
    if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
      try {
        const length = field.value.length;
        const at = Math.min(caret ?? field.selectionEnd ?? length, length);
        // Collapsed at its end: the paste lands where the caret was and replaces nothing.
        field.setSelectionRange(at, at, 'none');
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
