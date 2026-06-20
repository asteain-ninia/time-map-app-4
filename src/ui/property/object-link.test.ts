// U32: object-link classification tests (FR-98, 受け入れ基準 4, 教訓 5.19).

import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';

import {
  LINK_KIND,
  classifyLink,
  objectLinkHref,
} from './object-link';

describe('classifyLink (FR-98, 教訓 5.19)', () => {
  it('a feature: scheme href is an object reference carrying the id', () => {
    const link = classifyLink('feature:F123');
    expect(link.kind).toBe(LINK_KIND.Object);
    if (link.kind === LINK_KIND.Object) expect(link.featureId).toBe(asFeatureId('F123'));
  });

  it('an http href is external', () => {
    const link = classifyLink('https://example.com');
    expect(link.kind).toBe(LINK_KIND.External);
    if (link.kind === LINK_KIND.External) expect(link.href).toBe('https://example.com');
  });

  it('a malformed feature: with no id is external (not a half-resolved object)', () => {
    const link = classifyLink('feature:');
    expect(link.kind).toBe(LINK_KIND.External);
  });

  it('round-trips a feature id through objectLinkHref', () => {
    const id = asFeatureId('round-trip');
    const link = classifyLink(objectLinkHref(id));
    expect(link.kind).toBe(LINK_KIND.Object);
    if (link.kind === LINK_KIND.Object) expect(link.featureId).toBe(id);
  });

  it('classification is on the scheme, not the display text', () => {
    // An external href whose text merely contains "feature" must stay external.
    const link = classifyLink('https://wiki/feature/123');
    expect(link.kind).toBe(LINK_KIND.External);
  });
});
