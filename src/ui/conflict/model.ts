// UI layer (U35 / conflict): the framework-free conflict-resolution model.
//
// These are the PURE functions the modal relies on — no React, no Canvas, no
// Zustand, no clock (教訓 5.41 / NFR 5.8). They turn the U13 conflict list + the
// user's draft choices into: a list view-model, the「全件指定済みか」judgement,
// and the U13 `Resolution[]` to apply. Vitest checks every branch without a DOM.
//
// Import direction is ui → domain only (lint-enforced). The U13 process-result /
// conflict / resolution TYPES are imported from the domain barrel (教訓 5.33: the
// layer-crossing contract is the shared type, never a re-defined shape).

import type { FeatureId } from '../../domain/ids';
import type {
  Conflict,
  ConflictTime,
  Resolution,
} from '../../domain/consistency/index';
import { formatTimePoint } from '../timeline/time-display';

import { CONFLICT_STRINGS } from './strings';

// --- Time display (FR-65 / FR-72) -------------------------------------------

/**
 * Format a {@link ConflictTime} as a Japanese label. A `point` reuses the
 * timeline's single time-formatting source (年/年月/年月日, 紀元前 included —
 * 単一の真実源, 教訓 5.30); a `range` joins the two endpoints with a wave dash.
 * Pure and total.
 */
export function formatConflictTime(time: ConflictTime): string {
  switch (time.kind) {
    case 'point':
      return formatTimePoint(time.at);
    case 'range':
      return `${formatTimePoint(time.from)}〜${formatTimePoint(time.to)}`;
  }
}

// --- Resolution drafts (FR-63) ----------------------------------------------

/**
 * The user's in-flight choices: for each conflict id, which participant is the
 * PRIORITY (kept-whole) feature. A conflict id ABSENT from the map is unresolved
 * (教訓 5.18: absence is decided by membership, not by a falsy value). This is a
 * transient UI value discarded on apply-success / cancel / re-構成 (教訓 5.2).
 */
export type ResolutionDrafts = ReadonlyMap<string, FeatureId>;

/** An empty draft set (the reset value every path returns to, 教訓 5.2). */
export const EMPTY_DRAFTS: ResolutionDrafts = new Map();

/**
 * Set (or change) the priority feature for one conflict, returning a NEW map
 * (drafts are immutable; the input is never mutated). Selecting a different
 * priority for an already-resolved conflict just replaces the value (選び直し,
 * FR-63 / 受け入れ基準 4).
 */
export function setDraftPriority(
  drafts: ResolutionDrafts,
  conflictId: string,
  priorityFeatureId: FeatureId,
): ResolutionDrafts {
  const next = new Map(drafts);
  next.set(conflictId, priorityFeatureId);
  return next;
}

/**
 * Drop drafts whose conflict id is no longer in `conflicts`. Called when U13
 * returns an UPDATED conflict list (再競合): stale choices for conflicts that
 * vanished must not leak into the next round (教訓 5.2 / 5.5). Returns a new map.
 */
export function pruneDrafts(
  drafts: ResolutionDrafts,
  conflicts: readonly Conflict[],
): ResolutionDrafts {
  const live = new Set(conflicts.map((c) => c.id));
  const next = new Map<string, FeatureId>();
  for (const [id, prio] of drafts) {
    if (live.has(id)) next.set(id, prio);
  }
  return next;
}

// --- 全件指定済みか (FR-63 / 受け入れ基準 5, 教訓 5.10 / 5.18) ----------------

/**
 * The conflict ids that still have NO draft priority. Evaluates the RAW conflict
 * list against the RAW draft membership — never a pre-derived counter (教訓 5.10:
 * 生の集合まで評価して網羅する). An empty conflict list yields an empty array (a
 * real, truthy value — 教訓 5.18), so "no conflicts" reads as "nothing unresolved".
 */
export function unresolvedConflictIds(
  conflicts: readonly Conflict[],
  drafts: ResolutionDrafts,
): readonly string[] {
  const out: string[] = [];
  for (const c of conflicts) {
    if (!drafts.has(c.id)) out.push(c.id);
  }
  return out;
}

/**
 * Whether EVERY conflict has a draft priority — the apply-enable predicate
 * (受け入れ基準 5). Decided by全件評価 of the raw lists (教訓 5.10): the result is
 * `unresolvedConflictIds(...).length === 0`, computed directly here so the gate
 * cannot drift from a separately-maintained残件 helper. With an empty conflict
 * list this is `true` only if there is nothing to resolve; callers that should
 * NOT open the modal for an empty list gate on `conflicts.length` separately.
 */
export function allConflictsResolved(
  conflicts: readonly Conflict[],
  drafts: ResolutionDrafts,
): boolean {
  return unresolvedConflictIds(conflicts, drafts).length === 0;
}

// --- Mapping drafts → U13 Resolution[] (FR-63 決定論的写像) -------------------

/**
 * Derive the adjust-feature id from a conflict and the chosen priority: the
 * OTHER participant (優先＝選択側, 調整対象＝もう一方). Returns `undefined` when the
 * priority is not one of the two participants (a caller bug — surfaced, not
 * silently defaulted, 教訓 5.19).
 */
export function adjustFeatureFor(
  conflict: Conflict,
  priorityFeatureId: FeatureId,
): FeatureId | undefined {
  if (priorityFeatureId === conflict.a.featureId) return conflict.b.featureId;
  if (priorityFeatureId === conflict.b.featureId) return conflict.a.featureId;
  return undefined;
}

/**
 * Build the U13 {@link Resolution} set from the drafts, in the SAME order as the
 * conflict list (deterministic). Throws if any conflict lacks a draft or carries
 * a priority that is not one of its participants — callers must only invoke this
 * when {@link allConflictsResolved} is true, so a gap here is a real invariant
 * break, not an expected path (受け入れ基準 5: 適用は全件揃ってから一括で渡す).
 */
export function toResolutions(
  conflicts: readonly Conflict[],
  drafts: ResolutionDrafts,
): Resolution[] {
  const out: Resolution[] = [];
  for (const c of conflicts) {
    const priorityFeatureId = drafts.get(c.id);
    if (priorityFeatureId === undefined) {
      throw new Error(`conflict ${c.id} has no resolution draft`);
    }
    const adjustFeatureId = adjustFeatureFor(c, priorityFeatureId);
    if (adjustFeatureId === undefined) {
      throw new Error(
        `conflict ${c.id}: priority ${String(priorityFeatureId)} is not a participant`,
      );
    }
    out.push({ conflictId: c.id, priorityFeatureId, adjustFeatureId });
  }
  return out;
}

// --- List view-model (受け入れ基準 2) ---------------------------------------

/** The resolution state of one conflict row (型経由の分岐, 教訓 5.19). */
export const ROW_STATE = {
  Unresolved: 'unresolved',
  Resolved: 'resolved',
} as const;

export type RowState = (typeof ROW_STATE)[keyof typeof ROW_STATE];

/** One row of the conflict list, fully derived for display (no React inside). */
export interface ConflictRowVM {
  readonly conflictId: string;
  /** In-story time label (FR-65 / FR-72). */
  readonly timeLabel: string;
  /** Both participants' display names (FR-62), in [a, b] order. */
  readonly featureNames: readonly [string, string];
  /** Conflict-kind label (terminal overlap, FR-26). */
  readonly kindLabel: string;
  /** Resolution state (未指定 / 指定済み). */
  readonly state: RowState;
  /** The chosen priority feature id, or undefined when unresolved. */
  readonly priorityFeatureId: FeatureId | undefined;
}

/** The full list view-model (受け入れ基準 2: 全件・状態・件数). */
export interface ConflictListVM {
  readonly rows: readonly ConflictRowVM[];
  /** Number of rows still unresolved (一目で分かる残件数). */
  readonly unresolvedCount: number;
  /** Whether every row is resolved (apply-enable mirror, 全件評価由来). */
  readonly allResolved: boolean;
}

/**
 * Build the list view-model from the U13 conflict list + drafts. Emits a row for
 * EVERY conflict (片落としなし, 教訓 5.1 / 5.18) in input order, with each row's
 * derived time / names / kind / state. The counts come from the same raw全件
 * evaluation as {@link unresolvedConflictIds} (教訓 5.10), so the displayed残件 and
 * the apply gate can never disagree.
 */
export function buildConflictListVM(
  conflicts: readonly Conflict[],
  drafts: ResolutionDrafts,
): ConflictListVM {
  const rows: ConflictRowVM[] = conflicts.map((c) => {
    const priorityFeatureId = drafts.get(c.id);
    return {
      conflictId: c.id,
      timeLabel: formatConflictTime(c.time),
      featureNames: [c.a.displayName, c.b.displayName] as const,
      kindLabel: CONFLICT_STRINGS.kindTerminalOverlap,
      state: priorityFeatureId === undefined ? ROW_STATE.Unresolved : ROW_STATE.Resolved,
      priorityFeatureId,
    };
  });
  const unresolvedCount = unresolvedConflictIds(conflicts, drafts).length;
  return { rows, unresolvedCount, allResolved: unresolvedCount === 0 };
}
