// UI layer (U32 / property panel): in-document link classification (FR-98).
//
// A detail document may link to another OBJECT (feature) or to an EXTERNAL
// reference. The kind is decided by a TYPED scheme — never by guessing from the
// display text (教訓 5.19). Object references use a reserved URI scheme
// `feature:` carrying a feature id; everything else is treated as external and
// handled by the sanitize policy. Pure + framework-free (NFR 5.8).

import { asFeatureId, type FeatureId } from '../../domain/ids';

/** The reserved scheme for an in-document object (feature) reference. */
export const OBJECT_LINK_SCHEME = 'feature:';

export const LINK_KIND = {
  /** A reference to another feature (clicking selects it via U22). */
  Object: 'object',
  /** Any other href; handled by the sanitize policy (no app navigation). */
  External: 'external',
} as const;

export type LinkKind = (typeof LINK_KIND)[keyof typeof LINK_KIND];

/**
 * A classified link. The object variant exposes the resolved feature id ONLY in
 * its branch, so a consumer cannot read a feature id out of an external link
 * (教訓 5.19: 型で分岐).
 */
export type ClassifiedLink =
  | { readonly kind: typeof LINK_KIND.Object; readonly featureId: FeatureId }
  | { readonly kind: typeof LINK_KIND.External; readonly href: string };

/**
 * Classify an href. An href of the form `feature:<id>` with a non-empty id is an
 * object reference; anything else (including a malformed `feature:` with no id)
 * is external. The decision is on the SCHEME, not the link's display text.
 */
export function classifyLink(href: string): ClassifiedLink {
  if (href.startsWith(OBJECT_LINK_SCHEME)) {
    const raw = href.slice(OBJECT_LINK_SCHEME.length).trim();
    if (raw.length > 0) {
      return { kind: LINK_KIND.Object, featureId: asFeatureId(raw) };
    }
  }
  return { kind: LINK_KIND.External, href };
}

/** Build the canonical object-link href for a feature id (round-trip helper). */
export function objectLinkHref(featureId: FeatureId): string {
  return `${OBJECT_LINK_SCHEME}${featureId}`;
}
