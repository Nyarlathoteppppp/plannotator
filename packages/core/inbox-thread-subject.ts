/**
 * The subject of a thread the person starts in the Inbox (compose): a short
 * name, never the whole dictated paragraph. Agents' subjects keep
 * `deriveInboxSubject` (./inbox-questions, which re-exports this module).
 *
 * Pure and browser-safe: the store writes it and the compose dialog previews
 * it, so the two never differ. Never throws.
 */

import { findQuestionBlocks, parseQuestionBlock } from "./question-block";

/**
 * How wide a subject the person's own thread gets, in columns: a CJK or emoji
 * character counts two, so a Japanese subject is about as wide on screen as
 * an English one. The ellipsis counts one.
 */
export const PERSON_THREAD_SUBJECT_COLUMNS = 60;

/** Bidi controls: never in a subject, where they could reorder what the list shows. */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/gu;

/**
 * The subject of a thread the person starts:
 *
 *  1. The first line with words, as plain text: markdown marks, links (their
 *     text), images, HTML and list, quote or heading marks dropped; fenced
 *     code and `:::` blocks skipped.
 *  2. A greeting or filler at its start dropped ("Hey Claude,", "So,", "Okay
 *     so", "Um,"), and the next letter capitalized.
 *  3. A URL shortened to its host and last path part, a long path to its last
 *     two parts.
 *  4. The first sentence when it fits `PERSON_THREAD_SUBJECT_COLUMNS`, whole
 *     and without "…" (a final "." dropped; "?" and "!" kept).
 *  5. Else its first clause, up to the last comma, semicolon, colon or dash
 *     that fits and leaves at least 24 columns, plus "…".
 *  6. Else cut after the last word that fits (a dangling "and", "the"… dropped),
 *     plus "…"; text without spaces (CJK) is cut between two characters.
 *  7. A body with no words: the first image's alt text or file name, else the
 *     first attached file's name (`files`), else "Image", else the first line
 *     of code, else the first question's prompt (a body that is only a
 *     `:::question` block), else the first line with anything on it (an
 *     unclosed directive).
 *
 * Bidi controls never reach the subject. Null only for a body with nothing on
 * any line.
 */
export function derivePersonThreadSubject(input: string, options: { files?: readonly string[] } = {}): string | null {
  const body = typeof input === "string" ? input.replace(BIDI_CONTROLS, "") : "";
  const images: { alt: string; src: string }[] = [];
  let code: string | null = null;
  let words: string | null = null;
  let fence: string | null = null;
  let directive = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const fenceMark = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fenceMark && fenceMark[1]![0] === fence[0] && fenceMark[1]!.length >= fence.length && line.slice(fenceMark[1]!.length).trim() === "") fence = null;
      else if (code === null && line) code = line;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark[1]!;
      continue;
    }
    if (/^:::\S/.test(line)) {
      directive += 1;
      continue;
    }
    if (line === ":::") {
      directive = Math.max(0, directive - 1);
      continue;
    }
    if (directive > 0 || !line) continue;
    const plain = plainSubjectLine(line, images);
    if (plain) {
      words = plain;
      break;
    }
  }
  if (words) {
    const named = shortenSubject(compactLinks(dropFiller(words)));
    if (named) return named;
  }
  for (const image of images) {
    const alt = image.alt.replace(/\s+/g, " ").trim();
    if (alt && !/^(?:image|img|screenshot|picture|photo|pasted image)$/i.test(alt)) return cutColumns(alt, PERSON_THREAD_SUBJECT_COLUMNS);
    const name = fileNameOf(image.src);
    if (name) return cutColumns(name, PERSON_THREAD_SUBJECT_COLUMNS);
  }
  const files = (options.files ?? []).map((name) => name.replace(BIDI_CONTROLS, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (files.length > 0) {
    const more = files.length - 1;
    const tail = more === 0 ? "" : ` and ${more} more file${more === 1 ? "" : "s"}`;
    return `${cutColumns(files[0]!, PERSON_THREAD_SUBJECT_COLUMNS - columnsOf(tail))}${tail}`;
  }
  if (images.length > 0) return "Image";
  if (code) return cutColumns(code.replace(/\s+/g, " "), PERSON_THREAD_SUBJECT_COLUMNS);
  const prompt = firstQuestionPrompt(body);
  if (prompt) return shortenSubject(prompt);
  return firstLineSubject(body);
}

/** The prompt of the body's first `:::question` block, as plain words. */
function firstQuestionPrompt(body: string): string | null {
  if (!body.includes(":::question")) return null;
  for (const location of findQuestionBlocks(body, { frontmatter: false })) {
    const lines = location.text.replace(/\r\n?/g, "\n").split("\n");
    const inner = lines.slice(1, lines.length > 1 && lines.at(-1)!.trim() === ":::" ? -1 : undefined);
    const prompt = parseQuestionBlock(location.directiveKind, inner.join("\n"))?.prompt;
    const plain = prompt ? plainSubjectLine(prompt.replace(/\s+/g, " ").trim(), []) : "";
    if (plain) return plain;
  }
  return null;
}

/** The first line with anything on it: its words when it has some (directive and fence marks skipped), else the line itself. */
function firstLineSubject(body: string): string | null {
  let first: string | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    first ??= line;
    if (/^(?:`{3,}|~{3,}|:::)/.test(line)) continue;
    const plain = plainSubjectLine(line, []);
    if (plain) return shortenSubject(plain);
  }
  return first === null ? null : cutColumns(first.replace(/\s+/g, " "), PERSON_THREAD_SUBJECT_COLUMNS);
}

/** One markdown line as plain words; the images on it are added to `images`. */
function plainSubjectLine(line: string, images: { alt: string; src: string }[]): string {
  let text = line
    .replace(/^(?:>\s*)+/, "")
    .replace(/^#{1,6}(?:\s+|$)/, "")
    .replace(/^(?:[-*+]|\d{1,9}[.)])\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "");
  text = text.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+[^)]*)?\)/g, (_match, alt: string, src: string) => {
    images.push({ alt, src });
    return " ";
  });
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    const alt = /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
    images.push({ alt, src });
    return " ";
  });
  text = text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?|mailto):[^>\s]+)>/gi, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[\s(["'])[*_]+(?=\S)/g, "$1")
    .replace(/(\S)[*_]+(?=$|[\s)\]"'.,!?:;])/g, "$1");
  return text.replace(/\s+/g, " ").trim();
}

const FILLER_WORD = "(?:so|ok|okay|alright|all right|well|right|anyway|anyways|yeah|basically)";
/** An agent's name: "Hey Claude can you…" needs no comma after it. */
const AGENT_NAME = "(?:claude|codex|pi|opencode|amp|gemini|cursor|droid)";
/** A word that is an addressee only before punctuation: "Hey there, …", never "Hey there is a bug". */
const ADDRESSEE_WORD = "(?:there|team|buddy|friend|folks|all|everyone)";
/**
 * What ends a greeting or filler: punctuation followed by a space or the end,
 * or a dash with spaces around it. A dash inside a word ("Right-click",
 * "Hi-DPI", "Well-known", "So-called") never does.
 */
const SEPARATOR = "(?:\\s*[,.!:;]+(?=\\s|$)\\s*|\\s+[—–-]+\\s+)";
/**
 * A filler counts only before a separator, before another filler, or before
 * words that start a request ("So I want…", not "So many tests…").
 */
const FILLER_LEAD = new RegExp(
  `^${FILLER_WORD}(?:${SEPARATOR}|\\s+(?=(?:${FILLER_WORD.slice(3, -1)}|um+|uh+|i|i'm|i've|i'd|i'll|we|we're|we've|let's|can|could|would|will|please|quick|just|here|what|how|why|is|are|do|does|the|this)\\b))`,
  "iu",
);
/** "Hey Claude can you…": a greeting needs no comma. */
const GREETING = new RegExp(
  `^(?:hey|hi|hello|yo)(?:\\s+${AGENT_NAME}(?:${SEPARATOR}|\\s+)|\\s+${ADDRESSEE_WORD}${SEPARATOR}|${SEPARATOR}|\\s+)`,
  "iu",
);
/** A hesitation never starts what the person means. */
const HESITATION = new RegExp(`^(?:um+|uh+|erm+|hmm+|ah+)(?:${SEPARATOR}|\\s+)`, "iu");
/** What is left when the greeting was the whole message: a name, or nothing. */
const ONLY_A_NAME = new RegExp(`^(?:${AGENT_NAME}|${ADDRESSEE_WORD})?[\\s,.!:;—–-]*$`, "iu");

/** "Hey Claude, so I want to…" → "I want to…"; "Hey Claude" alone stays as it is. */
function dropFiller(text: string): string {
  let out = text;
  for (let i = 0; i < 6; i += 1) {
    const match = GREETING.exec(out) ?? HESITATION.exec(out) ?? FILLER_LEAD.exec(out);
    if (!match || match[0].length >= out.length) break;
    out = out.slice(match[0].length).trimStart();
  }
  if (out === text || ONLY_A_NAME.test(out)) return text;
  return out.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase());
}

/** A URL to its host and last path part; a long path to its last two parts. */
function compactLinks(text: string): string {
  return text
    .replace(/\bhttps?:\/\/(?:www\.)?([^\s/?#]+)(\S*)/gi, (_match, host: string, rest: string) => {
      const trail = /[.,!?:;)]+$/.exec(rest)?.[0] ?? "";
      const path = rest.slice(0, rest.length - trail.length).replace(/[?#].*$/, "");
      const parts = path.split("/").filter(Boolean);
      if (parts.length === 0) return `${host}${trail}`;
      if (parts.length === 1) return `${host}/${parts[0]}${trail}`;
      return `${host}/…/${parts[parts.length - 1]}${trail}`;
    })
    .replace(/(^|\s)((?:~|\.{1,2})?\/?(?:[^\s/]+\/){2,}[^\s/]+)/g, (whole, lead: string, path: string) => {
      if (path.length <= 24 || path.includes("…")) return whole;
      const trail = /[.,!?:;)]+$/.exec(path)?.[0] ?? "";
      const parts = path.slice(0, path.length - trail.length).split("/").filter(Boolean);
      if (parts.length < 3) return whole;
      return `${lead}…/${parts.slice(-2).join("/")}${trail}`;
    });
}

const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "mr", "mrs", "ms", "dr", "st", "approx", "fig", "no", "cf", "a.k.a", "aka"]);
const SMALL_TAIL_WORD =
  /\s+(?:and|or|but|so|the|a|an|to|of|for|with|that|which|in|on|at|by|from|as|is|are|be|it|its|my|our|your|their|this|these|those|if|then|than|like|about|into|over|what|how)$/iu;

/** Steps 4 to 6 of `derivePersonThreadSubject`. */
function shortenSubject(text: string): string {
  const max = PERSON_THREAD_SUBJECT_COLUMNS;
  const sentence = firstSentence(text);
  if (columnsOf(sentence) <= max) return sentence;
  const budget = max - 1;
  let clause: string | null = null;
  for (const match of sentence.matchAll(/[,;:](?=\s)|\s[—–-](?=\s)|[，；：、]/gu)) {
    const head = sentence.slice(0, match.index).trimEnd();
    if (columnsOf(head) > budget) break;
    if (columnsOf(head) >= 24) clause = head;
  }
  if (clause) return `${clause}…`;
  let cut = "";
  for (const match of sentence.matchAll(/\S+/g)) {
    const next = sentence.slice(0, match.index + match[0].length);
    if (columnsOf(next) > budget) break;
    cut = next;
  }
  if (columnsOf(cut) < 24) cut = sliceColumns(sentence, budget);
  for (let i = 0; i < 2; i += 1) cut = cut.replace(SMALL_TAIL_WORD, "");
  cut = cut.replace(/[\s,;:—–(-]+$/u, "");
  return `${cut}…`;
}

/** The first sentence of a line, its final "." or "…" dropped and "?" or "!" kept. The whole line when no sentence ends in it. */
function firstSentence(text: string): string {
  let end = text.length;
  for (let i = 2; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "。" || ch === "！" || ch === "？") {
      end = i + 1;
      break;
    }
    const ellipsis = ch === "…" ? 1 : text.startsWith("...", i) ? 3 : 0;
    if (ch !== "." && ch !== "!" && ch !== "?" && !ellipsis) continue;
    const after = i + (ellipsis || 1);
    const rest = text.slice(after);
    if (rest !== "" && !/^["'”’)\]]*\s/.test(rest)) {
      if (ellipsis === 3) i += 2;
      continue;
    }
    if (ch === "." && !ellipsis) {
      const word = /(\S+)$/.exec(text.slice(0, i))?.[1]?.toLowerCase() ?? "";
      // "e.g", "Dr", a lone initial, or single letters with dots ("U.S", "a.m").
      if (ABBREVIATIONS.has(word) || /^(?:\p{L}\.)*\p{L}$/u.test(word)) continue;
    }
    end = after;
    break;
  }
  const sentence = text
    .slice(0, end)
    .trim()
    .replace(/(?:\.{3}|…|[.。])$/u, "")
    .trimEnd();
  return sentence || text.trim();
}

function fileNameOf(src: string): string {
  const last = src.replace(/[?#].*$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const graphemes: Intl.Segmenter | null =
  typeof Intl !== "undefined" && typeof (Intl as { Segmenter?: unknown }).Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function graphemesOf(text: string): string[] {
  return graphemes ? Array.from(graphemes.segment(text), (part) => part.segment) : Array.from(text);
}

/** Two columns for CJK, Hangul, full-width forms and emoji, else one. */
function graphemeColumns(grapheme: string): number {
  const cp = grapheme.codePointAt(0) ?? 0;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}

function columnsOf(text: string): number {
  let columns = 0;
  for (const grapheme of graphemesOf(text)) columns += graphemeColumns(grapheme);
  return columns;
}

/** The longest start of `text` at most `max` columns wide, ending between two characters. */
function sliceColumns(text: string, max: number): string {
  let columns = 0;
  let out = "";
  for (const grapheme of graphemesOf(text)) {
    const width = graphemeColumns(grapheme);
    if (columns + width > max) break;
    columns += width;
    out += grapheme;
  }
  return out;
}

/** `text` when it fits `max` columns, else its start and "…", together at most `max`. */
function cutColumns(text: string, max: number): string {
  if (columnsOf(text) <= max) return text;
  return `${sliceColumns(text, max - 1).trimEnd()}…`;
}
