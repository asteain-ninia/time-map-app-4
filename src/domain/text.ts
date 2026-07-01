// Invisible / zero-width code-point handling — the single source of the rule
// (教訓 5.30). Names, labels and search queries can carry code points that occupy
// no visual space yet are not matched by `\s` (zero-width spaces, joiners, the
// bidi marks, the word joiner, the BOM). Left in, an invisible-only name defeats
// the display-name fallback (a "present-but-blank" name reads as non-empty) and
// invisible glyphs leak into the search corpus/query. Both the domain
// display-name rule (feature.ts) and the discovery search入口 (sanitize.ts /
// validation.ts) defer here so the character set is defined ONCE and cannot drift.
//
// Pure: string in → string / boolean out. No DOM, no framework.

/**
 * Zero-width and other invisible-but-non-whitespace code points to strip:
 * U+200B–U+200F (zero-width space/non-joiner/joiner, LRM/RLM), U+2060 (word
 * joiner) and U+FEFF (zero-width no-break space / BOM). These are NOT matched by
 * `\s`, so a `\s+`/`trim` alone leaves them behind.
 */
const INVISIBLE_RE = /[\u200B-\u200F\u2060\uFEFF]/g;

/** Remove every invisible zero-width code point, leaving visible text intact. */
export function stripInvisible(input: string): string {
  return input.replace(INVISIBLE_RE, '');
}

/**
 * Strip invisible code points THEN trim surrounding whitespace. An input made up
 * of only invisible chars and/or whitespace collapses to `''`, so a caller can
 * treat the result's emptiness as "no visible text" (feeding the id fallback /
 * empty-query rejection). Single source of the "really empty" decision.
 */
export function stripInvisibleThenTrim(input: string): string {
  return stripInvisible(input).trim();
}

/** True iff a visible (non-whitespace, non-invisible) glyph survives. */
export function hasVisibleText(input: string): boolean {
  return stripInvisibleThenTrim(input).length > 0;
}
