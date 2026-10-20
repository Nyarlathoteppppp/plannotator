/**
 * The Inbox's one composer field (approval "inbox-skill-references"): the
 * reply box, New message, and compose (a message the person starts) all
 * render this. It is Plannotator's comment composer field, unchanged in
 * behavior: the `/` and `$` skill picker at the start of a word
 * (`useSkillReferenceAutocomplete`, `SkillReferenceMenu`), the highlight
 * layer that paints a reference (`ComposerTokenTextarea`, a dotted underline
 * on a human-only skill), and the quiet "Includes skill instructions" line
 * under it. The text stays plain: `$write-better` is the reference, and the
 * Send composes the block (skills.ts).
 *
 * Keys: the picker sees a key first and takes only what it was aimed at (a
 * row arrowed onto, Escape after typing a query), so Enter, Tab and Mod+Enter
 * keep their meaning and the host's own `onKeyDown` gets everything else.
 * With no skills installed (or the route missing) `/` and `$` are plain text.
 *
 * Where the picker opens: by default against the field's own box (the reply
 * box, two lines tall, so that is at the caret). A tall field in a modal
 * dialog (compose) passes `caretMenu`: the picker then opens at the caret's
 * line, portaled into the dialog so the field's scroll container cannot clip
 * it, and kept inside the box `caretMenu.bounds` names (compose: the viewport
 * on a desktop, so it floats over the footer; the sheet above its footer on a
 * phone).
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ComposerTokenTextarea } from '@plannotator/ui/components/ComposerTokenTextarea';
import { HumanOnlySkillNotice, SkillReferenceMenu } from '@plannotator/ui/components/SkillReferenceMenu';
import { useSkillReferenceAutocomplete } from '@plannotator/ui/hooks/useSkillReferenceAutocomplete';
import { caretAnchor, caretLineRect, visibleBox, type AnchorBox, type VerticalBox } from '../caretMenu';

export interface CaretMenuOptions {
  /** Which side of the caret's line the picker tries first. */
  prefer: 'above' | 'below';
  /** The box the picker stays inside, in viewport coordinates. */
  bounds: () => VerticalBox | null;
  /** Cap on the list's height (a phone's 4½ rows). */
  maxListHeight?: number;
}

export interface InboxComposerFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** The host's keys (Mod+Enter sends, Escape closes); called only for keys the picker did not take. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** The textarea, for the host's focus calls. */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
  ariaLabel: string;
  ariaDescribedBy?: string;
  /** What the human-only line says the instructions go with: "your reply", "your message". */
  destination: string;
  /** Open the picker at the caret's line, inside the open dialog that holds the field (see the header). */
  caretMenu?: CaretMenuOptions;
  /** Escape closes an open picker even before a query was typed (compose: Escape would ask about a draft). */
  escapeClosesMenu?: boolean;
}

export function InboxComposerField({
  value,
  onChange,
  onKeyDown,
  textareaRef,
  placeholder,
  ariaLabel,
  ariaDescribedBy,
  destination,
  caretMenu,
  escapeClosesMenu = false,
}: InboxComposerFieldProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const attach = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (textareaRef) textareaRef.current = el;
    },
    [textareaRef],
  );
  const skills = useSkillReferenceAutocomplete({
    text: value,
    setText: onChange,
    textareaRef: innerRef,
    enabled: true,
    bareEscapeDismisses: escapeClosesMenu,
  });
  const listboxId = `ib-skills-${useId().replace(/:/g, '')}`;
  const active = skills.menu?.activeIndex;
  const host = caretMenu ? (innerRef.current?.closest('dialog') ?? null) : null;
  return (
    <div className="ib-cfield" data-composer-field="">
      {skills.menu && caretMenu && host && innerRef.current ? (
        <CaretSkillMenu textarea={innerRef.current} host={host} options={caretMenu}>
          {(boundary) => (
            <SkillReferenceMenu
              id={listboxId}
              items={skills.menu!.items}
              activeIndex={skills.menu!.activeIndex}
              onSelect={skills.select}
              boundary={boundary}
              prefer={caretMenu.prefer}
              maxListHeight={caretMenu.maxListHeight}
            />
          )}
        </CaretSkillMenu>
      ) : skills.menu ? (
        <SkillReferenceMenu id={listboxId} items={skills.menu.items} activeIndex={skills.menu.activeIndex} onSelect={skills.select} />
      ) : null}
      <ComposerTokenTextarea
        textareaRef={attach}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          skills.onSelect();
        }}
        onKeyDown={(event) => {
          if (skills.onKeyDown(event)) return;
          onKeyDown?.(event);
        }}
        onSelectCaret={skills.onSelect}
        placeholder={placeholder}
        sizeClassName=""
        textClassName=""
        inputClassName="ib-rtext"
        mirrorClassName="ib-rmirror"
        skillReferences
        tokens={skills.referenceTokens}
        mentionChips={null}
        listboxId={listboxId}
        listboxOpen={skills.menu !== null}
        activeOptionId={active === null || active === undefined ? undefined : `${listboxId}-option-${active}`}
        inputProps={{ 'aria-label': ariaLabel, 'aria-describedby': ariaDescribedBy, rows: 2 }}
      />
      <HumanOnlySkillNotice skills={skills.humanOnlyReferences} destination={destination} />
    </div>
  );
}

/**
 * The picker at the caret: a box laid over the caret's line, absolutely
 * positioned in the dialog (a modal dialog is in the top layer, so a portal
 * to the body would render under it), with the menu hanging above or below it
 * as SkillReferenceMenu decides against `options.bounds`. The box follows the
 * caret on every render (typing, a caret move) and on any scroll or resize.
 */
function CaretSkillMenu({
  textarea,
  host,
  options,
  children,
}: {
  textarea: HTMLTextAreaElement;
  host: HTMLElement;
  options: CaretMenuOptions;
  children: (boundary: () => VerticalBox | null) => React.ReactNode;
}) {
  const [box, setBox] = useState<AnchorBox | null>(null);
  const boundsRef = useRef(options.bounds);
  boundsRef.current = options.bounds;
  const boundary = useCallback(() => boundsRef.current(), []);

  const update = useCallback(() => {
    const field = textarea.getBoundingClientRect();
    // Not laid out (a test DOM): the field's top edge, so the menu still renders.
    const line = caretLineRect(textarea) ?? { top: field.top, bottom: field.top };
    const visible = visibleBox(textarea, host);
    const anchor = caretAnchor(line, visible, { left: field.left, width: field.width });
    // In the host's coordinates: an absolute box is placed against its padding box.
    const h = host.getBoundingClientRect();
    const next: AnchorBox = {
      top: Math.round(anchor.top - h.top - host.clientTop + host.scrollTop),
      bottom: Math.round(anchor.bottom - h.top - host.clientTop + host.scrollTop),
      left: Math.round(anchor.left - h.left - host.clientLeft + host.scrollLeft),
      width: Math.round(anchor.width),
    };
    setBox((prev) =>
      prev && prev.top === next.top && prev.bottom === next.bottom && prev.left === next.left && prev.width === next.width ? prev : next,
    );
  }, [host, textarea]);

  // Every commit: the caret moved or the text changed (the equality guard above converges).
  useLayoutEffect(() => {
    update();
  });

  useEffect(() => {
    const viewport = window.visualViewport;
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
    };
  }, [update]);

  if (!box) return null;
  return createPortal(
    <div
      className="ib-skanchor"
      data-skill-menu-anchor=""
      style={{ top: box.top, left: box.left, width: box.width, height: Math.max(0, box.bottom - box.top) }}
    >
      {children(boundary)}
    </div>,
    host,
  );
}
