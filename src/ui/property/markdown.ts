// UI layer (U32 / property panel): Markdown detail-document rendering +
// sanitization (FR-98 / FR-116 / NFR 5.5, 技術方針 2.11).
//
// markdown-it renders the Markdown to HTML; DOMPurify ALWAYS sanitizes it before
// it reaches the DOM. There is NO path that inserts un-sanitized HTML — the only
// exported renderer returns the sanitized string, and the React view inserts
// exactly that (受け入れ基準 4). The allow-list (tags / attributes / URI
// schemes) is defined in ONE place here so image (relative ref) / link / basic
// format (bold・italic・list・table) pass while <script>, event-handler
// attributes and dangerous URI schemes (javascript:) are removed.
//
// Images are resolved through the injected ZIP-internal AssetResolver: a
// relative reference becomes a display source, and an UNRESOLVED reference is
// left as a safe broken image (a sentinel that is never an外部 URL — FR-02
// offline完結). Object-reference links keep the reserved `feature:` scheme so
// the React view can intercept clicks (object-link.ts); external links are kept
// only if the sanitize allow-list permits their scheme.
//
// Pure given its inputs (Markdown text + resolvers). DOMPurify needs a DOM
// (jsdom in tests, the Electron renderer at runtime); the sanitize itself takes
// no other side effect, so it is covered by jsdom (.test.tsx) unit tests.

import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify';
import MarkdownIt from 'markdown-it';

import type { AssetResolver } from './contracts';
import { OBJECT_LINK_SCHEME } from './object-link';

/** A safe sentinel src for an image whose relative reference does not resolve. */
export const BROKEN_IMAGE_SRC = 'about:blank#broken-image';

/**
 * The single sanitize allow-list (技術方針 2.11). Tags cover basic format
 * (太字・斜体・リスト・表), images and links. No `<script>`, `<style>`, `<iframe>`
 * or event-handler attributes are allowed. The URI schemes for href are limited
 * to safe navigational schemes plus the reserved object-link scheme; `src` is
 * resolved to a local source before sanitize so it never carries an外部 URL.
 */
const SANITIZE_CONFIG: DOMPurifyConfig = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr',
    'strong', 'em', 'b', 'i', 'del', 's', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'span',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
  // Forbid everything that could carry script (defense in depth alongside the
  // tag/attr allow-list). DOMPurify already drops on* handlers; this is explicit.
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  // Drop the CONTENT of forbidden elements too (e.g. the body of a <script>) so
  // no inert-but-confusing leftover text (the script source) survives.
  FORBID_CONTENTS: ['script', 'style'],
  // Allow only safe href schemes + the reserved object-link scheme. Resolved
  // image srcs are local (blob:/data: from the asset resolver, or the broken
  // sentinel about:); permit those for src via the same regex.
  ALLOWED_URI_REGEXP:
    /^(?:(?:https?|mailto|feature|blob|data|about):|[^a-z]|[a-z+.-]+(?:[^a-z+.:-]|$))/i,
};

/** Lazily-built markdown-it instance (HTML enabled so tables render; sanitize後段で無害化). */
let mdInstance: MarkdownIt | null = null;

function md(): MarkdownIt {
  if (mdInstance === null) {
    // `html: false` keeps raw HTML in the source escaped; we still ALWAYS run
    // DOMPurify afterwards (defense in depth). `linkify: false` so only explicit
    // Markdown links become anchors (object-link scheme stays intact).
    mdInstance = new MarkdownIt({ html: false, linkify: false, typographer: false });
  }
  return mdInstance;
}

export interface RenderOptions {
  /** Resolves ZIP-internal image relative references to a display source. */
  readonly assetResolver: AssetResolver;
}

/**
 * Render Markdown to SANITIZED HTML (FR-98). Steps:
 *   1. markdown-it → HTML.
 *   2. Resolve <img> relative references through the asset resolver (FR-02): an
 *      unresolved reference becomes the safe broken sentinel, never an外部 URL.
 *   3. DOMPurify sanitize with the single allow-list (FR-116 / NFR 5.5).
 * The returned string is the ONLY value the view inserts — there is no
 * un-sanitized path.
 */
export function renderDetailMarkdown(
  source: string,
  options: RenderOptions,
): string {
  const rawHtml = md().render(source);
  const resolved = resolveImageSources(rawHtml, options.assetResolver);
  const clean = DOMPurify.sanitize(resolved, SANITIZE_CONFIG);
  return typeof clean === 'string' ? clean : String(clean);
}

/**
 * Rewrite every <img src="..."> in the rendered HTML so its source comes from
 * the ZIP-internal asset resolver. A reference that already looks like a
 * resolved local source (blob:/data:) is left as-is; an external (http) src or
 * an unresolved relative ref is replaced with the broken sentinel — this unit
 * never lets an external URL through to the <img> (FR-02). Object-link `feature:`
 * never appears in src (it is an href scheme only).
 *
 * This runs BEFORE DOMPurify, on an isolated detached document, so it never
 * mutates the live DOM and its output is still sanitized afterwards.
 */
function resolveImageSources(html: string, resolver: AssetResolver): string {
  // Parse into a detached template so the original document is untouched.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgs = doc.querySelectorAll('img');
  imgs.forEach((img) => {
    const ref = img.getAttribute('src') ?? '';
    img.setAttribute('src', resolveOneImageSrc(ref, resolver));
  });
  return doc.body.innerHTML;
}

/** Resolve a single <img> ref to a safe local source or the broken sentinel. */
function resolveOneImageSrc(ref: string, resolver: AssetResolver): string {
  if (ref.length === 0) return BROKEN_IMAGE_SRC;
  // Already a local source produced by the resolver elsewhere — keep it.
  if (ref.startsWith('blob:') || ref.startsWith('data:')) return ref;
  // An object-link scheme is never a valid image src.
  if (ref.startsWith(OBJECT_LINK_SCHEME)) return BROKEN_IMAGE_SRC;
  // Resolve as a ZIP-internal relative reference. An external http(s) ref is NOT
  // passed to the resolver as a network fetch — the resolver only knows ZIP
  // assets, so an unknown ref (including http) yields null → broken sentinel.
  const resolved = resolver.resolveAsset(ref);
  return resolved ?? BROKEN_IMAGE_SRC;
}
