/**
 * Compose's thread name (approval "inbox-agent-names-own-thread", the owner's
 * "give the human the ability to set it inside the input box"): the thread's
 * chip, given by the person. Optional and out of the way when empty: a small
 * dashed "+ Thread name" beside the subject preview. Pressed, it becomes an
 * input drawn as the outlined chip the list shows. A name given here is never
 * replaced by the agent's; without one, the agent names the thread on its
 * first reply. The Send checks it by the thread-name rules (one line, at most
 * 120 characters).
 */
import { useEffect, useRef, useState } from 'react';
import { INBOX_THREAD_NAME_MAX } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';

export function ThreadNameField(props: { value: string; onChange: (value: string) => void; onDone: () => void }) {
  const { value, onChange, onDone } = props;
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const shown = open || value !== '';
  const wantFocus = useRef(false);

  useEffect(() => {
    if (open && wantFocus.current) {
      wantFocus.current = false;
      inputRef.current?.focus();
    }
  }, [open]);

  if (!shown) {
    return (
      <button
        type="button"
        ref={addRef}
        className="ib-cp-tname-add"
        data-compose-thread-name-add=""
        title="Name this thread: the chip it shows in the list. Optional; without one, the agent names it."
        onClick={() => {
          wantFocus.current = true;
          setOpen(true);
        }}
      >
        <Icon name="plus" size={12} />
        Thread name
      </button>
    );
  }

  return (
    <span className="ib-key ib-cp-tname" data-compose-thread-name="">
      <input
        ref={inputRef}
        type="text"
        className="ib-cp-tname-in"
        aria-label="Thread name"
        placeholder="Thread name"
        maxLength={INBOX_THREAD_NAME_MAX}
        spellCheck={false}
        autoComplete="off"
        dir="auto"
        value={value}
        size={Math.max(10, Math.min(28, [...value].length + 1))}
        onChange={(event) => onChange(event.target.value)}
        onBlur={() => {
          if (value.trim() === '') {
            onChange('');
            setOpen(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onDone();
          } else if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
            // The field's own Escape: it never closes the dialog.
            event.preventDefault();
            event.stopPropagation();
            if (value.trim() === '') {
              onChange('');
              setOpen(false);
            }
            onDone();
          }
        }}
      />
      <button
        type="button"
        className="ib-cp-tname-x"
        aria-label="Remove the thread name"
        title="Remove the thread name"
        onClick={() => {
          onChange('');
          setOpen(false);
          onDone();
        }}
      >
        <Icon name="x" size={11} />
      </button>
    </span>
  );
}
