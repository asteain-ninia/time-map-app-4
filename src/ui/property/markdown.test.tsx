// U32: Markdown render + sanitize tests (FR-98 / FR-116 / NFR 5.5).
//
// Runs under jsdom (.test.tsx) because DOMPurify + DOMParser need a DOM. These
// fix the无害化 (dangerous input removed), the ZIP-internal image relative-ref
// resolution (no external URL), the object/external link handling, and basic
// format rendering. There is no un-sanitized path — the renderer's output is the
// only thing inserted.

import { describe, expect, it } from 'vitest';

import type { AssetResolver } from './contracts';
import { BROKEN_IMAGE_SRC, renderDetailMarkdown } from './markdown';
import { OBJECT_LINK_SCHEME } from './object-link';

const resolveNone: AssetResolver = { resolveAsset: () => null };
const resolveImages: AssetResolver = {
  resolveAsset: (ref) =>
    ref === 'images/castle.png' ? 'blob:local/castle' : null,
};

describe('renderDetailMarkdown — sanitize (FR-116 / NFR 5.5)', () => {
  it('never emits a live <script> element', () => {
    const html = renderDetailMarkdown('hello <script>alert(1)</script>', {
      assetResolver: resolveNone,
    });
    // Raw HTML is escaped (html:false) AND a real <script> would be stripped by
    // DOMPurify; either way there is no live script tag (escaped text is inert).
    expect(html).not.toMatch(/<script[\s>]/i);
    // Confirm the dangerous markup is escaped rather than live.
    expect(html).toContain('&lt;script&gt;');
  });

  it('output parses to zero live <script> elements (DOM-level)', () => {
    const html = renderDetailMarkdown('hello <script>alert(1)</script>', {
      assetResolver: resolveNone,
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(0);
  });

  it('removes onerror / event-handler attributes', () => {
    const html = renderDetailMarkdown('![x](images/castle.png "t")', {
      assetResolver: resolveImages,
    });
    expect(html).not.toContain('onerror');
  });

  it('never emits an executable javascript: href', () => {
    const html = renderDetailMarkdown('[click](javascript:alert(1))', {
      assetResolver: resolveNone,
    });
    // The dangerous form is an anchor with a javascript: href; that must not
    // exist (markdown-it/DOMPurify drop it — any leftover is inert literal text).
    expect(html).not.toMatch(/href\s*=\s*["']?javascript:/i);
    expect(html).not.toContain('<a href="javascript:');
  });

  it('escapes raw inline HTML so event handlers are inert text, not attributes', () => {
    const html = renderDetailMarkdown('<img src=x onerror="alert(1)">', {
      assetResolver: resolveNone,
    });
    // No live <img> element carrying an onerror attribute; the source is escaped
    // to inert text (html:false + DOMPurify), so it cannot execute.
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('&lt;img');
  });
});

describe('renderDetailMarkdown — images (FR-98 / FR-02)', () => {
  it('resolves a ZIP-internal relative reference to a local source', () => {
    const html = renderDetailMarkdown('![castle](images/castle.png)', {
      assetResolver: resolveImages,
    });
    expect(html).toContain('blob:local/castle');
  });

  it('uses the safe broken sentinel for an unresolved reference (no external URL)', () => {
    const html = renderDetailMarkdown('![missing](images/none.png)', {
      assetResolver: resolveNone,
    });
    expect(html).toContain(BROKEN_IMAGE_SRC);
  });

  it('never lets an external http image URL through', () => {
    const html = renderDetailMarkdown('![ext](https://evil.example/x.png)', {
      assetResolver: resolveNone,
    });
    expect(html).not.toContain('https://evil.example');
    expect(html).toContain(BROKEN_IMAGE_SRC);
  });
});

describe('renderDetailMarkdown — links (FR-98 / 教訓 5.19)', () => {
  it('keeps an object-reference (feature:) link href intact', () => {
    const html = renderDetailMarkdown('[go](feature:F42)', {
      assetResolver: resolveNone,
    });
    expect(html).toContain(`${OBJECT_LINK_SCHEME}F42`);
  });

  it('keeps a safe external https link', () => {
    const html = renderDetailMarkdown('[ext](https://example.com)', {
      assetResolver: resolveNone,
    });
    expect(html).toContain('https://example.com');
  });
});

describe('renderDetailMarkdown — basic format (FR-98)', () => {
  it('renders bold, italic, list and table', () => {
    const md = [
      '**bold** and *italic*',
      '',
      '- one',
      '- two',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n');
    const html = renderDetailMarkdown(md, { assetResolver: resolveNone });
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>1</td>');
  });
});
