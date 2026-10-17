import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';

/** How long the pointer rests before a tooltip opens (the list chips' timing). */
export const TIP_DELAY_MS = 150;

/**
 * The Inbox's hover text: ui's Tooltip (the component the list's chips use),
 * never the browser's native `title`, which waits about a second and cannot
 * be styled. The window's one TooltipProvider (App.tsx) sets the timing:
 * 150 ms to open, the next one at once within 400 ms.
 *
 * `cut`: open only while the trigger's text is actually cut (an ellipsis, a
 * clamp), so a name that fits gets no tooltip repeating it. Without `cut` it
 * always opens. `when` decides each time instead, for anything else (a mark
 * whose label is hidden).
 *
 * The trigger keeps its own accessible name (an `aria-label`, or its text):
 * the tooltip adds nothing a screen reader needs, and a trigger that is not
 * focusable stays out of the tab order. Nothing opens on a touch screen
 * (`hover: none`): a hover there is a first tap. A trigger inside a native
 * modal `<dialog>` portals the popup into that dialog, so the top layer does
 * not cover it. Escape closes an open tooltip and still reaches the window
 * (`escapePassesThrough`), so Escape closes a thread whatever holds focus.
 */
export function Tip({
  content,
  children,
  cut = false,
  when,
  side = 'top',
  align,
  wide = true,
}: {
  content: ReactNode;
  children: ReactElement;
  cut?: boolean;
  when?: (trigger: Element) => boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  wide?: boolean;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const shouldOpen = useCallback(
    (trigger: Element) => {
      if (content === null || content === undefined || content === '') return false;
      if (noHover()) return false;
      if (cut && !isTextCut(trigger)) return false;
      if (when && !when(trigger)) return false;
      setContainer(trigger.closest<HTMLElement>('dialog[open]'));
      return true;
    },
    [content, cut, when],
  );
  // A disabled control gets no pointer events (and React drops mouse events on
  // it), so its tooltip hangs on a wrapper the pointer reaches instead
  // (inbox.css: `.ib-tipwrap > :disabled` lets the pointer through). Any
  // control that can be disabled gets the wrapper, disabled or not, so the
  // control is never remounted (and never loses focus) when it changes.
  const canDisable = 'disabled' in (children.props as object);
  const trigger = canDisable ? (
    <span className="ib-tipwrap" data-tip-wrap="">
      {children}
    </span>
  ) : (
    children
  );
  return (
    <Tooltip content={content} side={side} align={align} wide={wide} delayDuration={TIP_DELAY_MS} shouldOpen={shouldOpen} container={container} escapePassesThrough>
      {trigger}
    </Tooltip>
  );
}

function noHover(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;
}

/**
 * Is this element's text cut (its own overflow with "…", or a line clamp)?
 * A FileName (`.ib-fname`) is cut when its first part is. Rounding can hide
 * a cut of under a pixel (an Arabic chip measured a scrollWidth of 104 in a
 * clientWidth of 103 with its ellipsis showing), so any whole pixel counts,
 * and where layout can be read the text's own width is compared with the
 * box's content width to catch what rounding hides.
 */
export function isTextCut(el: Element | null | undefined): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const part = el.classList.contains('ib-fname') ? el.querySelector<HTMLElement>('.ib-fname-h') : null;
  if (part && overflows(part)) return true;
  return overflows(el);
}

function overflows(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1) return true;
  if (el.clientWidth === 0 || typeof document.createRange !== 'function') return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  const text = range.getBoundingClientRect?.().width ?? 0;
  if (!(text > 0)) return false;
  const style = getComputedStyle(el);
  if (style.overflowX === 'visible') return false;
  const box = el.getBoundingClientRect().width;
  const inner =
    box -
    num(style.paddingLeft) -
    num(style.paddingRight) -
    num(style.borderLeftWidth) -
    num(style.borderRightWidth);
  // Chrome draws the ellipsis for any overflow (a chip lost 0.06 px): a hundredth of a pixel counts.
  return text > inner + 0.01;
}

function num(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** A project's tooltip: its whole name (a row may cut it) over its folder, which no row shows. */
export function ProjectTipText({ name, root }: { name: string; root: string }) {
  return (
    <span className="ib-tip-proj" data-project-tip="">
      <bdi className="ib-tip-name">{name}</bdi>
      <span className="ib-tip-path" dir="ltr">
        {root}
      </span>
    </span>
  );
}
