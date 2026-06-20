import { describe, expect, it } from 'vitest';

import { toSearchableText } from './sanitize';

describe('toSearchableText (検索前サニタイズ, FR-116)', () => {
  it('strips HTML tags, leaving the text content', () => {
    // tags become spaces; markdown markup chars (incl. parentheses) are stripped
    // so the searchable素テキスト carries only the words.
    expect(toSearchableText('<p>ローマ</p><script>alert(1)</script>')).toBe(
      'ローマ alert 1',
    );
  });

  it('strips Markdown markup so words still match', () => {
    expect(toSearchableText('**ローマ** _帝国_ `コード`')).toBe('ローマ 帝国 コード');
  });

  it('drops link/image markup but keeps the visible words', () => {
    expect(toSearchableText('[ローマ](feature:abc) ![図](img.png)')).toBe(
      'ローマ feature:abc 図 img.png',
    );
  });

  it('collapses whitespace and trims', () => {
    expect(toSearchableText('  多くの\n\n空白  ')).toBe('多くの 空白');
  });

  it('does not match on tag names (no HTML leaks into search)', () => {
    const text = toSearchableText('<strong class="x">語</strong>');
    expect(text).toBe('語');
    expect(text).not.toContain('strong');
    expect(text).not.toContain('class');
  });
});
