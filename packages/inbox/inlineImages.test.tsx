/**
 * An image a message's text shows opens in the thread's one viewer
 * (approval "inbox-image-viewer", 2026-10-15): the message body as the thread
 * draws it (MessageBody over ui's Viewer). A captured image (`inline_images`)
 * is a button: a click, Enter or Space hands its record to the thread, which
 * opens it in the file viewer; markdown and raw HTML alike. An image the store
 * could not capture opens nothing, and the old look-only lightbox never
 * appears. The browser proof is tests/e2e/inbox-image-viewer.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxInlineImage, InboxMessageWire } from '@plannotator/core/inbox-types';
import { resetImageSrcResolver, setImageSrcResolver } from '@plannotator/ui/components/ImageThumbnail';
import { inboxImageSrcResolver, inlineImageRefFromSrc } from './images';

const hasDom = typeof document !== 'undefined';
const { MessageBody } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resetImageSrcResolver();
});

const ID = 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ';

function image(id: string, ref: string): InboxInlineImage {
  return {
    id,
    ref,
    path: `/work/shop/${ref}`,
    named_path: null,
    name: ref.split('/').pop()!,
    kind: 'image',
    sent_sha256: 'a'.repeat(64),
    size: 10,
    sent_at: '2026-10-15T11:22:00.000Z',
    sent_mtime: '2026-10-15T11:20:00.000Z',
    media_type: 'image/png',
  };
}

const B = image('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'design/b.png');
const C = image('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'design/c.png');

function message(body: string, inline: InboxInlineImage[]): InboxMessageWire {
  return {
    id: ID,
    project_id: 'prj_01K7PPPPPPPPPPPPPPPPPPPPPP',
    thread_id: ID,
    reply_to: null,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' },
    subject: 'Checkout',
    body,
    created_at: '2026-10-15T11:22:00.000Z',
    resolved_at: null,
    idempotency_key: null,
    inline_images: inline,
    questions: [],
  } as unknown as InboxMessageWire;
}

async function render(body: string, inline: InboxInlineImage[], opened: InboxInlineImage[]) {
  setImageSrcResolver(inboxImageSrcResolver);
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <MessageBody
        message={message(body, inline)}
        projectRoot="/work/shop"
        onOpenAttachment={() => {}}
        onOpenInlineImage={(img) => opened.push(img)}
        readOnly={false}
        answers={new Map()}
        onPick={() => {}}
        footerFor={() => null}
        recordingOf={() => undefined}
        onToggleDecision={() => {}}
        onOpenDecision={() => {}}
      />,
    );
  });
}

test('the src the body drew reads back to the ref as written, only for that message', () => {
  expect(inlineImageRefFromSrc(`/api/inbox/messages/${ID}/image?path=${encodeURIComponent('my shots/b.png')}`, ID)).toBe('my shots/b.png');
  expect(inlineImageRefFromSrc(`/api/inbox/messages/msg_other/image?path=b.png`, ID)).toBeNull();
  expect(inlineImageRefFromSrc('/api/inbox/attachments/att_x/image', ID)).toBeNull();
});

test.skipIf(!hasDom)('a captured image opens in the viewer on a click, Enter or Space, markdown and raw HTML alike; an uncaptured one opens nothing', async () => {
  const opened: InboxInlineImage[] = [];
  const body = ['Two directions:', '', '![B](design/b.png)', '', '<p><img src="design/c.png" alt="C"></p>', '', '![gone](design/gone.png)'].join('\n');
  await render(body, [B, C], opened);
  const img = (alt: string) => host!.querySelector<HTMLImageElement>(`img[alt="${alt}"]`)!;
  // Each captured image is a button named for its file.
  expect(img('B').getAttribute('role')).toBe('button');
  expect(img('B').tabIndex).toBe(0);
  expect(img('B').getAttribute('aria-label')).toBe('Open b.png, B');
  expect(img('B').getAttribute('data-inline-image')).toBe(B.id);
  expect(img('C').getAttribute('data-inline-image')).toBe(C.id);
  expect(img('gone').getAttribute('role')).toBeNull();

  await act(async () => img('B').click());
  await act(async () => img('C').click());
  await act(async () => img('gone').click());
  expect(opened.map((i) => i.id)).toEqual([B.id, C.id]);
  // The look-only lightbox is gone from the Inbox.
  expect(document.querySelector('[data-image-lightbox]')).toBeNull();

  for (const key of ['Enter', ' ']) {
    await act(async () => {
      img('C').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  }
  expect(opened.map((i) => i.id)).toEqual([B.id, C.id, C.id, C.id]);
});
