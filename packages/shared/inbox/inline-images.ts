/**
 * Plannotator Inbox: the images a message's body shows, captured as files of
 * the thread (approval "inbox-image-viewer", 2026-10-15, owner: "yes, copy
 * them").
 *
 * When an agent's message lands, each image its body shows
 * (`inboxMessageImageRefsInOrder`: markdown `![alt](src)` and `<img src>`,
 * outside code, in text order, each once) is read under the message-image
 * route's own rules (`readInboxMessageImage`: referenced in the body, an image
 * by extension and by its magic bytes, inside the message's project or the
 * linked worktree it was sent from, at most 10 MB and 50 megapixels, one
 * `O_NOFOLLOW | O_NONBLOCK` descriptor checked by dev and ino). Its bytes go
 * to `inbox/blobs/<sha256>` and the message keeps an attachment record for it
 * plus `ref`, the src as written (`InboxInlineImage`). An image that cannot be
 * read (remote, outside the project, missing, too large) is left out: the
 * body still shows it through the message-image route, as before, and it
 * never refuses the send.
 *
 * A message sent before this has no copies: the first read of its thread
 * captures them as they are then, marked `captured: "on_open"`.
 */

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { inboxAttachmentId, type InboxInlineImage } from "@plannotator/core/inbox-types";
import { writeBlob } from "./attachments";
import { inboxMessageImageRefsInOrder, readInboxMessageImage } from "./message-images";

/** The most images one message's capture takes (the rest show through the message-image route, as before). */
export const INBOX_INLINE_IMAGES_MAX = 64;

export interface CaptureInlineImagesInput {
  body: string;
  /** The project's root (a realpath). */
  root: string;
  /** The folder the agent sent from (`base_path`), when not the root. */
  base?: string | null;
  /** The linked worktree the message was sent from, when the caller checked it is one (outside the root). */
  worktree?: string | null;
  /** The message's time: each record's `sent_at`. */
  sentAt: string;
  /** Set when capturing a message sent before capture existed: the records are marked `captured: "on_open"` at this time. */
  capturedOnOpenAt?: string;
}

/** Whether a body shows any local image the capture could take. */
export function bodyShowsLocalImages(body: string): boolean {
  return inboxMessageImageRefsInOrder(body).length > 0;
}

/**
 * Read and copy each image the body shows. Never throws: an image that cannot
 * be read is left out. Blobs are written once (content-addressed).
 */
export function captureInboxInlineImages(inboxDirPath: string, input: CaptureInlineImagesInput): InboxInlineImage[] {
  const out: InboxInlineImage[] = [];
  for (const ref of inboxMessageImageRefsInOrder(input.body).slice(0, INBOX_INLINE_IMAGES_MAX)) {
    let read: ReturnType<typeof readInboxMessageImage>;
    try {
      read = readInboxMessageImage({ body: input.body, root: input.root, base: input.base ?? null, worktree: input.worktree ?? null, path: ref });
    } catch {
      continue;
    }
    if (!read.ok) continue;
    const sha256 = createHash("sha256").update(read.bytes).digest("hex");
    try {
      writeBlob(inboxDirPath, sha256, read.bytes);
    } catch {
      continue;
    }
    out.push({
      id: inboxAttachmentId(),
      path: read.real,
      named_path: read.named === read.real ? null : read.named,
      name: basename(read.named) || basename(read.real),
      kind: "image",
      sent_sha256: sha256,
      size: read.bytes.length,
      sent_at: input.sentAt,
      sent_mtime: read.mtime,
      media_type: read.contentType,
      ...(read.width !== undefined && read.height !== undefined ? { width: read.width, height: read.height } : {}),
      ref,
      ...(input.capturedOnOpenAt ? { captured: "on_open" as const, captured_at: input.capturedOnOpenAt } : {}),
    });
  }
  return out;
}
