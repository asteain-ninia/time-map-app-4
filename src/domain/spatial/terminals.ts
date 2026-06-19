// U10 adapter — turn an evaluated forest state into the TerminalShape list the
// exclusion detector consumes. This is the seam between U08 (terminal/aggregate
// distinction + shape resolution) and U10's pure detection (spec §依存 / §層境界
// 教訓5.33).
//
// A feature is a terminal for exclusion purposes when it OWNS a shape and has no
// sub-regions — i.e. a childless LEAF. An aggregate (any feature with children)
// is excluded entirely (FR-27 / 教訓5.25): it is never added to the list, so it
// can never appear in an overlap pair. Points and lines carry no area and are
// not exclusion targets either (FR-29) — `resolveFeatureArea` returns an empty
// area for them, which `extractTerminalShapes` drops.
//
// Pure: reads the forest + vertex store, returns a fresh list, mutates nothing.

import type { VertexStore } from '../vertex';
import { directChildIds, type Forest } from '../hierarchy/forest';
import { resolveFeatureArea } from '../hierarchy/resolve-shape';
import { isMultiPolygonEmpty } from '../geometry/types';
import type { TerminalShape } from './overlap';

/**
 * Extract the exclusion-relevant terminal shapes from an evaluated forest.
 *
 * For every feature with NO children (a terminal by the result-state rule, 教訓
 * 5.6) we resolve its own area via U08; features with children are aggregates
 * and are skipped (FR-27). A terminal whose resolved area is empty (a point, a
 * line, or a shapeless/failed resolution) contributes no exclusion shape and is
 * omitted — it cannot overlap anything.
 *
 * A failed shape resolution (missing vertex / rejected union) is skipped rather
 * than thrown: exclusion detection answers "which terminals overlap?", and an
 * unresolvable terminal has no decidable area to test. Callers that need to
 * surface resolution failures should run U08 validation separately (单一責務).
 */
export function extractTerminalShapes(forest: Forest, store: VertexStore): TerminalShape[] {
  const out: TerminalShape[] = [];
  for (const id of forest.byId.keys()) {
    if (directChildIds(forest, id).length > 0) continue; // aggregate: excluded.
    const resolution = resolveFeatureArea(forest, store, id);
    if (resolution.status !== 'ok') continue; // unresolvable: no decidable area.
    if (isMultiPolygonEmpty(resolution.area)) continue; // point/line/empty: no area.
    out.push({ id, shape: resolution.area });
  }
  return out;
}
