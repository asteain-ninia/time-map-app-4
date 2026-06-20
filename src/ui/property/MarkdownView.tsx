// UI layer (U32 / property panel): the sanitized Markdown view (FR-98).
//
// Renders a detail document by calling renderDetailMarkdown (markdown-it →
// asset-resolve → DOMPurify) and inserting ONLY the sanitized HTML — there is no
// un-sanitized path (受け入れ基準 4). Object-reference link clicks are
// intercepted here and routed to the selection-update callback (U22), so a
// `feature:` link selects the target feature instead of navigating. External
// links keep the sanitized href and are not given app navigation.

import { useCallback, useMemo, type MouseEvent } from 'react';

import type { FeatureId } from '../../domain/ids';

import type { AssetResolver } from './contracts';
import { renderDetailMarkdown } from './markdown';
import { LINK_KIND, classifyLink } from './object-link';

export interface MarkdownViewProps {
  /** The raw Markdown detail document. */
  readonly source: string;
  /** Resolves ZIP-internal image relative references (FR-02). */
  readonly assetResolver: AssetResolver;
  /** Called when an object-reference (`feature:`) link is clicked (U22). */
  readonly onSelectFeature?: (featureId: FeatureId) => void;
}

export function MarkdownView(props: MarkdownViewProps): JSX.Element {
  const { source, assetResolver, onSelectFeature } = props;

  // The sanitized HTML is the ONLY thing inserted (FR-116). Recomputed only when
  // the source / resolver change.
  const html = useMemo(
    () => renderDetailMarkdown(source, { assetResolver }),
    [source, assetResolver],
  );

  // Intercept object-reference link clicks (教訓 5.19: branch on the typed
  // scheme, not the link text). External links fall through to the default
  // (which, for a sanitized href, does not navigate the app).
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const target = (e.target as HTMLElement).closest('a');
      if (target === null) return;
      const href = target.getAttribute('href') ?? '';
      const link = classifyLink(href);
      // Prevent in-document navigation for BOTH kinds: an object reference
      // updates the selection instead (U22); an external reference is not given
      // app navigation here (opening外部参照 is a separate concern — spec).
      e.preventDefault();
      if (link.kind === LINK_KIND.Object) {
        onSelectFeature?.(link.featureId);
      }
    },
    [onSelectFeature],
  );

  return (
    <div
      className="markdown-view"
      data-testid="markdown-view"
      onClick={handleClick}
      // `html` is the output of renderDetailMarkdown, which ALWAYS runs DOMPurify
      // (markdown.ts). This is the ONLY insertion point — no un-sanitized path.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
