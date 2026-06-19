// U10 spatial index — the single RBush (R-tree) wrapper used for the three
// candidate-narrowing duties the tech policy assigns to ONE part (技術方針 2.7):
// view clipping, proximity snapping, and terminal-pair exclusion. Upper units
// hold a `SpatialIndex<Ref>` and ask "which refs' boxes intersect this
// rectangle?"; that one generic query backs all three uses (spec §実装方針
// 「汎用 API に統一」).
//
// This is the ONLY module in the codebase that imports `rbush` — the wrapper is
// the boundary, exactly as U06 owns `polygon-clipping`. Upper units must not
// import `rbush` directly (layer-direction lint + this file's comment keep the
// dependency surface a single, auditable point, 教訓5.30).
//
// 教訓5.5 (依存する状態は変化時に再検証する): the index is mutable state, so the
// build/update/query boundary is explicit. Callers choose the update strategy —
// `bulkLoad` for "many things changed" (read/reorg/confirm), `insert`/`remove`
// for a local drag (差分更新). The two strategies are required by the spec to
// agree (受け入れ基準6), which the tests pin.
//
// Queries are side-effect free: `search` never mutates the tree and returns a
// fresh array each call.

import RBush from 'rbush';

import type { BBox } from './bbox';
import { multiPolygonBBox } from './bbox';
import type { GeoMultiPolygon } from '../geometry/types';

/**
 * One entry stored in the index: a bounding box plus the caller's opaque
 * reference (a feature id, or a {ref, turns} replica tag for seam handling).
 * Mirrors RBush's required `{minX,minY,maxX,maxY}` shape and adds `ref`.
 */
export interface IndexEntry<Ref> extends BBox {
  readonly ref: Ref;
}

/**
 * Build an index entry from a multi-polygon shape, or undefined when the shape
 * has no extent (an empty shape is never inserted — it cannot intersect any
 * query rectangle, so omitting it changes no candidate set, 教訓5.18).
 */
export function entryFromShape<Ref>(ref: Ref, shape: GeoMultiPolygon): IndexEntry<Ref> | undefined {
  const box = multiPolygonBBox(shape);
  if (box === undefined) return undefined;
  return { ref, minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY };
}

/**
 * A thin, typed wrapper over RBush. The element type is fixed to
 * {@link IndexEntry} so RBush's default `{minX,minY,maxX,maxY}` accessor works
 * without overriding `toBBox`. `Ref` is opaque to the index.
 */
export class SpatialIndex<Ref> {
  private readonly tree: RBush<IndexEntry<Ref>>;

  constructor(maxEntries?: number) {
    this.tree = maxEntries === undefined ? new RBush<IndexEntry<Ref>>() : new RBush<IndexEntry<Ref>>(maxEntries);
  }

  /**
   * Replace the entire contents with `entries` in one bulk load (full rebuild).
   * Use after a load / reorganization / edit-confirm where many entries change
   * (spec §更新方針「一括再構築 (bulk load)」). Clears first so a rebuild is a
   * true replacement, not an append.
   */
  bulkLoad(entries: readonly IndexEntry<Ref>[]): this {
    this.tree.clear();
    if (entries.length > 0) this.tree.load(entries);
    return this;
  }

  /** Insert one entry (差分更新 half: the "add" of a local change). */
  insert(entry: IndexEntry<Ref>): this {
    this.tree.insert(entry);
    return this;
  }

  /**
   * Remove every entry whose `ref` equals `ref` (差分更新 half: the "remove").
   * Comparison is by `ref` value, not object identity, so a caller holding only
   * the ref (not the original entry object) can still remove it — the typical
   * drag case where the box changed (教訓5.5). Returns this even if nothing
   * matched (removal of an absent ref is a no-op, not an error).
   */
  removeRef(ref: Ref): this {
    // RBush removes by a single matching item; loop until none remain so a ref
    // that was inserted more than once (e.g. seam replicas sharing a base ref)
    // is fully cleared rather than leaving stragglers (片落とし禁止, 教訓5.1).
    for (;;) {
      const match = this.tree.search(this.boundsOf(ref));
      const victim = match.find((e) => e.ref === ref);
      if (victim === undefined) break;
      this.tree.remove(victim);
    }
    return this;
  }

  /** Empty the index. */
  clear(): this {
    this.tree.clear();
    return this;
  }

  /**
   * The generic query: every entry whose box intersects (or touches) `box`.
   * This single call serves view-clipping / proximity / exclusion candidate
   * narrowing (技術方針 2.7). Returns a fresh array; the tree is untouched.
   */
  search(box: BBox): IndexEntry<Ref>[] {
    return this.tree.search(box);
  }

  /** All entries currently in the index (order unspecified). Fresh array. */
  all(): IndexEntry<Ref>[] {
    return this.tree.all();
  }

  /** Count of entries currently indexed. */
  size(): number {
    return this.tree.all().length;
  }

  /**
   * The smallest box covering every entry that shares `ref` — used internally by
   * {@link removeRef} to localise the search before filtering by ref value. When
   * no entry matches, returns a degenerate box that intersects nothing useful;
   * the subsequent `find` simply yields undefined.
   */
  private boundsOf(ref: Ref): BBox {
    let box: BBox | undefined;
    for (const e of this.tree.all()) {
      if (e.ref !== ref) continue;
      box =
        box === undefined
          ? { minX: e.minX, minY: e.minY, maxX: e.maxX, maxY: e.maxY }
          : {
              minX: Math.min(box.minX, e.minX),
              minY: Math.min(box.minY, e.minY),
              maxX: Math.max(box.maxX, e.maxX),
              maxY: Math.max(box.maxY, e.maxY),
            };
    }
    return box ?? { minX: NaN, minY: NaN, maxX: NaN, maxY: NaN };
  }
}
