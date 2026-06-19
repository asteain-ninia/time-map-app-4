// Domain layer (U09): shared fast-check generators for anchor series (R7 / §9.10).
//
// Defined ONCE and reused by every U09 property test, so the boundary cases
// (BC/negative years, anchor boundaries, temporal enclaves, single-anchor
// series, gapless adjacency, end == next start) are generated consistently and
// derived FROM the invariants rather than re-stated per test. Generators build
// values through the REAL factories (教訓 5.39: fixtures via entity factories,
// not bare literals). Imports fast-check (devDependency); consumed only by
// *.test.ts files, never by production code.

import fc from 'fast-check';

import { createAnchor, createAnchorSnapshot, type Anchor } from './anchor';
import {
  createAnchorEntry,
  normalizeSeries,
  type AnchorEntry,
  type AnchorSeries,
} from './anchor-series';
import { createBasicAttributes, createColorInfo } from './attributes';
import { createCoordinate } from './coordinate';
import { createPointFeature } from './feature';
import { asAnchorId, asFeatureId, asVertexId } from './ids';
import type { Calendar } from './time/calendar';
import { timePointYear, type TimePoint } from './time/time-point';
import { createVertex, createVertexStore } from './vertex';

/** Builds a concrete, non-trivial full-state snapshot via the real factories. */
export function makeSnapshot(seed: number) {
  const vid = asVertexId(`v-${seed}`);
  const vertex = createVertex(vid, createCoordinate(seed % 180, seed % 90));
  const feature = createPointFeature(
    asFeatureId(`f-${seed}`),
    createBasicAttributes(`name-${seed}`, seed, seed + 1),
    createColorInfo(true, '#102030', '#405060', '#708090'),
    vid,
  );
  return createAnchorSnapshot([feature], createVertexStore([vertex]));
}

/** Builds a concrete anchor (id + snapshot) via the real factories. */
export function makeAnchor(seed: number, idSuffix = ''): Anchor {
  return createAnchor(asAnchorId(`a-${seed}${idSuffix}`), makeSnapshot(seed));
}

/**
 * A start-year generator spanning BC (negative), the year-0 boundary, and AD.
 * Year-only TimePoints keep the series small and exercise the same boundary
 * behavior the U02 model is tested against.
 */
export function startYearArb(): fc.Arbitrary<number> {
  return fc.integer({ min: -400, max: 400 });
}

/**
 * Generates a VALID, non-empty anchor series (INV-1〜INV-5). Distinct ascending
 * start years are chosen, and each entry independently either has no end
 * (open-ended) or an end placed somewhere in (start, nextStart] — this yields
 * gapless adjacency, temporal enclaves (gaps), and end-equals-next-start cases
 * with positive probability. The last entry may also carry an end (existence
 * stop). The series is funneled through normalizeSeries so it is guaranteed
 * valid even at the boundaries the per-entry generator produces.
 */
export function anchorSeriesArb(calendar: Calendar): fc.Arbitrary<AnchorSeries> {
  return fc
    .uniqueArray(startYearArb(), { minLength: 1, maxLength: 6 })
    .chain((years) => {
      const sorted = [...years].sort((a, b) => a - b);
      // For each entry decide an end: 'none', 'gapless' (== next start),
      // 'gap' (strictly inside (start, next)), or for the last 'stop'.
      const endChoices = fc.array(
        fc.constantFrom('none', 'gapless', 'gap', 'stop'),
        { minLength: sorted.length, maxLength: sorted.length },
      );
      return endChoices.map((choices) => {
        const entries: AnchorEntry[] = sorted.map((startYear, i) => {
          const anchor = makeAnchor(startYear, `-${i}`);
          const start: TimePoint = timePointYear(startYear);
          const nextStart = sorted[i + 1];
          const choice = choices[i] ?? 'none';
          let end: TimePoint | null = null;
          if (nextStart !== undefined) {
            if (choice === 'gapless') {
              end = timePointYear(nextStart);
            } else if (choice === 'gap' && nextStart - startYear >= 2) {
              end = timePointYear(startYear + 1);
            }
          } else if (choice === 'stop') {
            end = timePointYear(startYear + 1);
          }
          return createAnchorEntry(anchor, start, end);
        });
        return normalizeSeries(entries, calendar);
      });
    });
}
