import React from 'react';
import { Tooltip } from './Tooltip';
import { isTextCut, noHover } from '../utils/textCut';

/**
 * Hover text for a ui control or label, drawn the way the host chooses.
 *
 * Default (every host that does not opt in, Plannotator's plan review,
 * annotate and code review included): the child gets a native `title`,
 * exactly as before.
 *
 * With `configurePlannotatorUI({ componentTooltips: true })` (the Plannotator
 * Inbox): the child gets ui's `Tooltip` instead, and no native title. `name`
 * marks a title that is also the control's accessible name (an icon button
 * with no `aria-label`): the child then gets it as its `aria-label`, so the
 * name never depends on the tooltip. `cut` opens the tooltip only while the
 * child's text is cut. Escape closes it and still reaches the page, and
 * nothing opens on a touch screen.
 */

let componentTooltips = false;

/** Draw ui's hover text as ui's Tooltip (true) or a native title (false, the default). */
export function setComponentTooltips(on: boolean): void {
  componentTooltips = on;
}

export function resetComponentTooltips(): void {
  componentTooltips = false;
}

export function getComponentTooltips(): boolean {
  return componentTooltips;
}

/** How long the pointer rests before a component tooltip opens. */
const HOST_TITLE_DELAY_MS = 150;

export function HostTitle({
  title,
  children,
  name = false,
  cut = false,
  side = 'top',
}: {
  title: string | undefined | null;
  children: React.ReactElement;
  name?: boolean;
  cut?: boolean;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  if (!title) return children;
  if (!componentTooltips) return React.cloneElement(children as React.ReactElement<{ title?: string }>, { title });
  const props = children.props as { 'aria-label'?: string };
  const child = name && props['aria-label'] == null ? React.cloneElement(children as React.ReactElement<{ 'aria-label'?: string }>, { 'aria-label': title }) : children;
  return (
    <Tooltip
      content={title}
      side={side}
      wide
      delayDuration={HOST_TITLE_DELAY_MS}
      escapePassesThrough
      shouldOpen={(trigger) => !noHover() && (!cut || isTextCut(trigger))}
    >
      {child}
    </Tooltip>
  );
}
