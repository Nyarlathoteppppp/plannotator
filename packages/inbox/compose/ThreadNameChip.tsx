/**
 * Compose's thread chip (the owner's 2026-10-16 note on #1956: "why can't I
 * just type in the little chip?"): the thread's name, drawn as the grey chip
 * the list shows, and a real text field. It follows the message while the
 * person has not typed in it (`suggested`, compose's short suggestion), and
 * stops following once they do. Emptied, it follows the message again, but
 * only once focus leaves it, so it never refills under the person's caret.
 *
 * Nothing to suggest yet: an empty dashed chip saying "Name this thread".
 * `error` (the name is taken, or not a valid name) is said beside it.
 * Enter moves to the message; Escape is the dialog's (close or ask).
 *
 * Room left for later: joining an existing thread would be a ⌄ after the
 * chip, the way To has one.
 */
import { useRef, useState } from 'react';
import { INBOX_THREAD_NAME_MAX } from '@plannotator/core/inbox-types';
import { shownThreadName, typeThreadName, type ThreadNameState } from './model';

/** At most `INBOX_THREAD_NAME_MAX` code points; `maxLength` would count UTF-16 units and stop an emoji name early. */
export function capThreadName(value: string): string {
  const points = [...value];
  return points.length > INBOX_THREAD_NAME_MAX ? points.slice(0, INBOX_THREAD_NAME_MAX).join('') : value;
}

export const THREAD_NAME_PLACEHOLDER = 'Name this thread';

/** Columns of monospace text: CJK, Hangul and emoji take two. */
function widthOf(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    n += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60) || cp >= 0x1f300 ? 2 : 1;
  }
  return n;
}

export function ThreadNameChip(props: {
  state: ThreadNameState;
  suggested: string;
  onChange: (state: ThreadNameState) => void;
  onDone: () => void;
  error?: string | null;
  describedBy?: string;
}) {
  const { state, suggested, onChange, onDone, error = null } = props;
  // Emptied while focused: show it empty until focus leaves, then follow the message again.
  const [clearing, setClearing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const value = clearing && !state.edited ? '' : shownThreadName(state, suggested);
  const mode = state.edited ? 'edited' : 'auto';
  const columns = Math.min(40, Math.max(widthOf(value || THREAD_NAME_PLACEHOLDER), 4)) + 1;
  const errorId = error ? 'ib-cp-tname-err' : undefined;

  return (
    <span className="ib-cp-tnamew">
      <span
        className="ib-key ib-cp-tname"
        data-compose-thread-name={mode}
        data-empty={value === '' ? '' : undefined}
        data-invalid={error ? '' : undefined}
        // The chip's padding (and a phone's larger hit area) puts the caret in the field.
        onMouseDown={(event) => {
          if (event.target === inputRef.current) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <input
          ref={inputRef}
          type="text"
          className="ib-cp-tname-in"
          aria-label="Thread name"
          aria-describedby={[errorId, props.describedBy].filter(Boolean).join(' ') || undefined}
          aria-invalid={error ? true : undefined}
          placeholder={THREAD_NAME_PLACEHOLDER}
          title={state.edited ? 'The thread’s name. Empty it to name it from your message again.' : 'Named from your message. Type to rename it.'}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="sentences"
          enterKeyHint="next"
          dir="auto"
          value={value}
          style={{ width: `${columns}ch` }}
          onChange={(event) => {
            const next = typeThreadName(capThreadName(event.target.value));
            setClearing(!next.edited);
            onChange(next);
          }}
          onBlur={() => setClearing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              onDone();
            }
          }}
        />
      </span>
      {error && (
        <span className="ib-cp-tname-err" id={errorId} role="alert" data-compose-thread-name-error="">
          {error}
        </span>
      )}
    </span>
  );
}
