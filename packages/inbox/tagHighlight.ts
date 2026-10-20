/**
 * The agents the person tagged in a sent reply, painted as the composer
 * paints them (approval "inbox-tag-agents"): `@Pi` in the primary color on a
 * light wash. Painted with the CSS Custom Highlight API, like the skill
 * references (skillHighlight.ts), so the Viewer's DOM is never changed. The
 * tokens are the labels the reply's own tags carry (what was sent). Where the
 * API is missing (an older browser, the DOM tests) nothing is painted and the
 * words read as plain text.
 */

/** The highlight's name in `CSS.highlights` (inbox.css styles `::highlight(ib-tag-ref)`). */
export const TAG_REF_HIGHLIGHT = 'ib-tag-ref';

/** Text the tokens are never found in: code, a message's head row (folded or open), and form fields. */
const SKIP = 'pre, code, [data-skills-line], [data-fold-head], [data-open-head], script, style, textarea';

/**
 * Where `@<label>` appears in `text`: at a word start (the composer's email
 * guard), the longest label first so "Claude Code (another session)" wins
 * over "Claude Code".
 */
export function tagTokenSpans(text: string, labels: readonly string[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const sorted = [...new Set(labels.filter((l) => l.trim() !== ''))].sort((a, b) => b.length - a.length);
  for (let i = text.indexOf('@'); i !== -1; i = text.indexOf('@', i + 1)) {
    if (i > 0 && !/\s|[(["'“‘]/u.test(text.charAt(i - 1))) continue;
    const label = sorted.find((l) => text.startsWith(l, i + 1));
    if (!label) continue;
    const end = i + 1 + label.length;
    // The label ends a word: not "@Pilot" for "Pi".
    if (end < text.length && /[\p{L}\p{N}_]/u.test(text.charAt(end))) continue;
    out.push({ start: i, end });
    i = end - 1;
  }
  return out;
}

/** The ranges of the tokens under `root`. */
export function tagReferenceRanges(root: Node, labels: readonly string[]): Range[] {
  const out: Range[] = [];
  if (labels.length === 0) return out;
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (const span of tagTokenSpans(node.data, labels)) {
      const range = doc.createRange();
      range.setStart(node, span.start);
      range.setEnd(node, span.end);
      out.push(range);
    }
  }
  return out;
}

interface HighlightApi {
  highlights: { set(name: string, value: unknown): void; delete(name: string): void };
  Highlight: new (...ranges: Range[]) => { priority: number };
}

function api(): HighlightApi | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightApi['highlights'] } }).CSS;
  const Highlight = (globalThis as { Highlight?: HighlightApi['Highlight'] }).Highlight;
  return css?.highlights && typeof Highlight === 'function' ? { highlights: css.highlights, Highlight } : null;
}

const painted = new Map<string, Range[]>();

function publish(registry: HighlightApi): void {
  const ranges = [...painted.values()].flat();
  if (ranges.length === 0) {
    registry.highlights.delete(TAG_REF_HIGHLIGHT);
    return;
  }
  const highlight = new registry.Highlight(...ranges);
  // Below search's landing highlight, as the skill references are.
  highlight.priority = -1;
  registry.highlights.set(TAG_REF_HIGHLIGHT, highlight);
}

/** Paint one message's tag tokens under `root`, again whenever its DOM changes. Returns the cleanup. */
export function paintTagReferences(key: string, root: HTMLElement, labels: readonly string[]): () => void {
  const registry = api();
  if (!registry || labels.length === 0) return () => {};
  const paint = () => {
    painted.set(key, tagReferenceRanges(root, labels));
    publish(registry);
  };
  paint();
  let frame = 0;
  const observer = new MutationObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    painted.delete(key);
    publish(registry);
  };
}
