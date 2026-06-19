// UI/session state layer: the time-existence dependency contract.
//
// 単一の真実源 (開発ガイド §4): "does feature X exist at time T?" and "does
// vertex V exist in feature X's shape at time T?" are TIME-RESOLUTION judgments
// owned by the time model (U02) and the anchor-series unit (U09). This store
// MUST NOT reimplement half-open-interval [start, end) logic or anchor walking
// (spec 依存「存在判定関数を注入可能な依存として受け取り、再実装しない」).
//
// We therefore declare an INJECTED function interface here and let the
// composition root wire the real domain functions (e.g. `resolveAt` over an
// anchor series). The store calls these and never decomposes year/month/day or
// walks anchors itself. Tests inject fakes to prove this store contains no
// independent existence logic (受け入れ基準 3 / 5).

import type { FeatureId, VertexId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';

/**
 * Resolves whether the given feature exists at the given time. Implemented by
 * the anchor-series unit (which internally uses U02's half-open-interval
 * continuation rule, FR-55). The store treats this as opaque.
 */
export type FeatureExistsAt = (featureId: FeatureId, time: TimePoint) => boolean;

/**
 * Resolves whether the given vertex exists in the given feature's shape at the
 * given time. Implemented by the geometry/anchor units; opaque to the store.
 */
export type VertexExistsAt = (
  featureId: FeatureId,
  vertexId: VertexId,
  time: TimePoint,
) => boolean;

/**
 * The bundle of injected existence predicates the store needs to re-validate
 * time-dependent selection state (教訓 5.5). Grouping them in one value makes
 * the dependency explicit at the composition root and trivially fakeable in
 * tests (受け入れ基準 3: 依存注入で再実装していないことを確認).
 */
export interface ExistenceResolver {
  readonly featureExistsAt: FeatureExistsAt;
  readonly vertexExistsAt: VertexExistsAt;
}

/**
 * A default resolver that treats everything as existing. Useful as a safe
 * placeholder before the real domain wiring is injected; it never silently
 * deselects. Production code must replace it at the composition root.
 */
export const ALWAYS_PRESENT_RESOLVER: ExistenceResolver = {
  featureExistsAt: () => true,
  vertexExistsAt: () => true,
};
