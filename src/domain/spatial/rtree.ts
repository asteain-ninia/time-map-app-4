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

  /**
   * Auxiliary `ref → entries` index kept in lock-step with the tree across every
   * mutation (bulkLoad / insert / remove / clear). Its sole purpose is to make
   * {@link removeRef} and {@link boundsOf} O(k) in the number of entries sharing
   * a ref instead of O(n) full scans of `tree.all()` — so the差分更新 path
   * (技術方針 2.7: drag-time insert/removeRef) does not degrade to O(n·k) at the
   * 5000 規模 the spec targets. 教訓5.5: this is duplicated state, so every
   * mutating method updates BOTH structures or neither (no partial writes).
   *
   * Key semantics match the tree's own `e.ref === ref` comparison: a JS Map uses
   * SameValueZero, which is value equality for primitive refs and identity for
   * object refs (e.g. seam replica tags) — identical to the previous `===` filter.
   */
  private readonly byRef: Map<Ref, IndexEntry<Ref>[]>;

  /**
   * Live count of entries currently in the tree, maintained in lock-step with
   * every mutation (track / removeRef / bulkLoad / clear). Exists so {@link size}
   * is O(1): the old `tree.all().length` allocated a full n-length copy of the
   * tree on every call just to read its length, which silently turned size-sampling
   * in hot paths (e.g. benchmarks) into O(n) garbage (教訓5.5: derived state is
   * kept explicit and updated at each mutation, never recomputed by full scan).
   *
   * This counts entries, not distinct refs — so it differs from `byRef.size`,
   * which would undercount seam replicas that share one ref across several boxes.
   */
  private count: number;

  constructor(maxEntries?: number) {
    this.tree = maxEntries === undefined ? new RBush<IndexEntry<Ref>>() : new RBush<IndexEntry<Ref>>(maxEntries);
    this.byRef = new Map<Ref, IndexEntry<Ref>[]>();
    this.count = 0;
  }

  /**
   * Replace the entire contents with `entries` in one bulk load (full rebuild).
   * Use after a load / reorganization / edit-confirm where many entries change
   * (spec §更新方針「一括再構築 (bulk load)」). Clears first so a rebuild is a
   * true replacement, not an append.
   */
  bulkLoad(entries: readonly IndexEntry<Ref>[]): this {
    this.tree.clear();
    this.byRef.clear();
    this.count = 0;
    if (entries.length > 0) {
      this.tree.load(entries);
      for (const entry of entries) this.track(entry);
    }
    return this;
  }

  /** Insert one entry (差分更新 half: the "add" of a local change). */
  insert(entry: IndexEntry<Ref>): this {
    this.tree.insert(entry);
    this.track(entry);
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
    // Every entry sharing this ref is already tracked in `byRef`, so we remove
    // each one from the tree by object identity (RBush's default equality) — no
    // search, no `boundsOf`, no full scan. A ref inserted more than once (e.g.
    // seam replicas sharing a base ref) is fully cleared, not left with
    // stragglers (片落とし禁止, 教訓5.1). Removal of an absent ref is a no-op.
    const victims = this.byRef.get(ref);
    if (victims === undefined) return this;
    for (const victim of victims) this.tree.remove(victim);
    this.count -= victims.length;
    this.byRef.delete(ref);
    return this;
  }

  /** Empty the index. */
  clear(): this {
    this.tree.clear();
    this.byRef.clear();
    this.count = 0;
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

  /**
   * Count of entries currently indexed. O(1): reads the live {@link count}
   * maintained at each mutation rather than allocating `tree.all()` to take its
   * length (the latter copied all n entries on every call — costly when size is
   * sampled in hot paths such as benchmarks).
   */
  size(): number {
    return this.count;
  }

  /**
   * Record `entry` under its ref in the auxiliary {@link byRef} index. Called by
   * every method that adds to the tree (bulkLoad / insert) so the two structures
   * stay in agreement; {@link removeRef} reads it to find victims in O(k).
   */
  private track(entry: IndexEntry<Ref>): void {
    const existing = this.byRef.get(entry.ref);
    if (existing === undefined) this.byRef.set(entry.ref, [entry]);
    else existing.push(entry);
    this.count += 1;
  }
}
