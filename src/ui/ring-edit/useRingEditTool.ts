// U25 — the ring-edit (穴 / 飛び地 の追加・削除) interaction hook (FR-22 / FR-24 /
// FR-78 / FR-94, 教訓 5.2 / 5.7 / 5.11 / 5.22 / 5.26).
//
// UI layer: holds the TRANSIENT ring-edit state (the pure {@link RingAddDraft} for
// the add sub-mode + the add/delete sub-mode + a message) and DRIVES the whole
// interaction by delegating every decision to the pure U25 domain transitions —
// start → select target face → (add) place ≥3 vertices, the FIRST of which classifies
// hole/enclave / undo → confirm ⇒ addRing → snapshot → confirmRingEdit(U24→U13); or
// (delete) select target face → click a ring ⇒ deleteHoleRing / deleteTerritoryRing →
// snapshot → confirmRingEdit. Target selection is its OWN click in BOTH sub-modes —
// that split is what makes 飛び地追加 / 穴リング削除 reachable under the production
// 穴透過 hit-test (see {@link UseRingEditToolActions.handleClick}). It NEVER re-implements ring geometry / hierarchy and never mutates
// shared domain state before confirm (教訓 5.22 確定までの非破壊). The domain add /
// delete commands + confirm path already existed and were unit-tested; this hook is
// the消費する ui コンシューマ that makes them reachable from the UI (教訓 5.7).
//
// The single reset契約 ({@link resetDraft}) runs on every exit path (cancel / commit /
// tool switch / mode switch / sub-mode switch / Escape) so the transient draft never
// leaks (教訓 5.2). Every completion trigger (confirm add / confirm delete) is wired
// here to real logic.

import { useCallback, useMemo, useState } from 'react';

import type { WorldCoordinate } from '../../domain/coordinate';
import type { GridSpacingDeg } from '../../domain/basemap/grid';
import { resolveSnap } from '../../domain/add/index';
import {
  PROCESS_STATUS,
  type EditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { Feature, LeafFeature } from '../../domain/feature';
import { FEATURE_KIND } from '../../domain/feature';
import type { FeatureId, RingId } from '../../domain/ids';
import { RING_KIND, type Ring, type RingKind, type Shape } from '../../domain/ring';
import type { TimePoint } from '../../domain/time/time-point';
import type { VertexStore } from '../../domain/vertex';
import { getVertex } from '../../domain/vertex';
import { unwrapRing } from '../../domain/geo/index';
import {
  POINT_LOCATION,
  pointInPolygon,
  quantizeCoordinate,
  type GeoPolygon,
} from '../../domain/geometry/index';
import type { FeatureSnapshot, ReleaseOutcome } from '../../domain/editing/index';
import { EDIT_REFUSAL, RELEASE_OUTCOME } from '../../domain/editing/index';
import { isWorldLatitude } from '../../domain/geo/latitude';
import {
  RING_COMMAND_STATUS,
  RING_DELETE_OUTCOME,
  addRing,
  classifyFirstClick,
  deleteHoleRing,
  deleteTerritoryRing,
  placeFirstVertex,
  placeVertex,
  resetDraft,
  setGridSnap,
  snapshotForDeletedFeature,
  snapshotForLeaf,
  startDraft,
  undoVertex,
  UNDO_RESULT,
  type RingAddDraft,
  type RingCommandResult,
  type RingDeleteOutcome,
  type RingIdPorts,
  type RingRejectKind,
} from '../../domain/ring-edit/index';

import { RING_EDIT_STRINGS, RING_REJECT_MESSAGES } from './strings';

// --- Layer-crossing ports (the contracts; 教訓 5.33 / 5.34) ------------------

/** Resolve a feature id to its domain {@link Feature} (host live-lookup). The hook
 * gates LEAF-only itself, so the host may return any feature. undefined ⇒ miss. */
export type ResolveFeature = (featureId: FeatureId) => Feature | undefined;

/** Resolve the live vertex store effective at the ring-edit anchor time (host). */
export type ResolveVertexStore = () => VertexStore;

/** Resolve the ring-edit anchor time (the UI current time, 文脈優先; 教訓 5.15). */
export type ResolveAnchorTime = () => TimePoint;

/** The current domain state the U13 pipeline validates against (host live-lookup). */
export type ResolveCurrent<S> = () => S;

/**
 * Drive U24's confirm → U13's fixed-order pipeline for the assembled snapshot. The
 * host injects the ports from the LIVE `createLiveEditBinding` (the SAME binding the
 * edit-session drag confirm uses — add/knife's U13 stub is bypassed, 教訓 5.7).
 */
export type StartRingEditProcess<S> = (
  snapshot: FeatureSnapshot,
  anchorTime: TimePoint,
  current: S,
) => ReleaseOutcome<S>;

/**
 * 確認待ちのリング削除（N-05 / 増分 7 の中身 7）。**確定に必要なものだけ**を持つ ――
 * 何を消すか（穴か外周か）、面ごと消えるか、そして確定へ渡す写しである。
 */
export interface PendingRingDelete {
  readonly ringKind: RingKind;
  /** 最後の外周か（真なら、この年からこの地物そのものが消える）。 */
  readonly lastTerritory: boolean;
  /** 「はい」と答えたときに確定へ流す写し。 */
  readonly snapshot: FeatureSnapshot;
}

/** The add/delete sub-mode (対概念: リング追加 ↔ リング削除, 教訓 2.10 / 5.19). */
export const RING_EDIT_SUBMODE = {
  Add: 'add',
  Delete: 'delete',
} as const;

export type RingEditSubMode = (typeof RING_EDIT_SUBMODE)[keyof typeof RING_EDIT_SUBMODE];

/** The transient flow the chrome reads (mirrors the draft + sub-mode + verdicts). */
export const RING_EDIT_FLOW = {
  Idle: 'idle',
  /** Armed; awaiting a target-face click (no draft / no delete target yet). */
  SelectingTarget: 'selecting-target',
  /** A target face is chosen and the add draft is running (add sub-mode). */
  Drafting: 'drafting',
  /** A target face is chosen; awaiting a ring click to delete (delete sub-mode). */
  Deleting: 'deleting',
} as const;

export type RingEditFlow = (typeof RING_EDIT_FLOW)[keyof typeof RING_EDIT_FLOW];

export interface UseRingEditToolOptions<S> {
  readonly resolveFeature: ResolveFeature;
  readonly resolveStore: ResolveVertexStore;
  readonly anchorTime: ResolveAnchorTime;
  readonly current: ResolveCurrent<S>;
  readonly ids: RingIdPorts;
  /**
   * The project grid spacing (FR-13) used when the grid-snap draft is on (FR-78).
   * Same source the add tool reads (project settings via {@link coerceGridSpacing}),
   * so an add-hole vertex snaps to the identical graticule an add-tool vertex would.
   */
  readonly gridSpacing: GridSpacingDeg;
  readonly startProcess: StartRingEditProcess<S>;
  /** Commit handler (教訓 5.11): host swaps state + re-resolves selection. */
  readonly onCommitted: (result: ProcessResult<S>, snapshot: FeatureSnapshot) => void;
  /** Conflict handler (FR-62): host opens the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<FeatureSnapshot>) => void)
    | undefined;
  /**
   * Promote the chosen target face into the host selection so it is highlighted while
   * ring-editing (mirrors the knife/merge target promotion). Called ONLY after the
   * LEAF gate passes.
   */
  readonly onTargetSelected?: ((featureId: FeatureId) => void) | undefined;
  /** Un-promote the target on an explicit cancel (mirrors the knife onCancelled). */
  readonly onCancelled?: (() => void) | undefined;
}

export interface UseRingEditToolState {
  readonly flow: RingEditFlow;
  readonly subMode: RingEditSubMode;
  /** The in-progress add draft (null when no face is chosen / in delete mode). */
  readonly draft: RingAddDraft | null;
  /** The chosen target face id (null while still選択中). */
  readonly targetId: FeatureId | null;
  /**
   * The grid-snap toggle (FR-78). This — NOT `draft?.gridSnap` — is the state SOURCE
   * the chrome's checkbox reflects: the toggle is meaningful before a target face is
   * picked (no draft yet) and must survive draft discard/restart. `setGridSnap` keeps
   * the live draft in sync with it, so the two can never disagree (単一の真実源).
   *
   * CONTRACT — deliberately OUTSIDE the reset契約 (教訓 5.2): grid snap is a USER
   * PREFERENCE, not transient interaction state. It carries no geometry, no target and
   * no draft, so it cannot leak an in-progress operation into the next one, and it is
   * permanently VISIBLE in the checkbox whenever the tool chrome is up — the failure
   * mode 5.2 guards against (invisible残存 that silently changes the next operation's
   * result) cannot occur. It therefore survives commit / cancel / sub-mode switch /
   * tool switch, mirroring the add tool's "carry the current grid-snap preference
   * forward" (useAddTool.start). Pinned by a test so this is a decision, not a drift.
   */
  readonly gridSnap: boolean;
  /** The per-state Japanese guide (FR-92). */
  readonly guide: string;
  /** A rejection / info message kept until a meaningful event (教訓 5.12). null = none. */
  readonly message: string | null;
  /** Whether the add draft can confirm (≥3 vertices). */
  readonly canConfirm: boolean;
  /**
   * 確認待ちのリング削除（N-05 / 増分 7 の中身 7）。null なら確認は出ていない。
   * コントローラがこれを見て影響ダイアログを出す。
   */
  readonly pendingDelete: PendingRingDelete | null;
}

export interface UseRingEditToolActions {
  /** 確認に「はい」と答えた（リングを実際に消す）。 */
  readonly confirmPendingDelete: () => void;
  /** 確認をやめた（何も起きない）。 */
  readonly cancelPendingDelete: () => void;
  /** 起動: overlay on, awaiting a target-face click (教訓 5.7 start trigger). */
  start(): void;
  /** Run the reset契約 on an external tool / mode switch (教訓 5.2 (d)/(e)). */
  resetForSwitch(): void;
  /** Toggle between the add / delete sub-modes; discards the current draft (教訓 5.2). */
  toggleSubMode(): void;
  /**
   * A LEFT click. `featureIdAtPoint` is the controller's own hit-test result (the
   * feature id under the click, or null), passed in so the hook stays free of any
   * point→id geometry — mirrors the knife/merge split where the controller owns
   * `featureAtPoint` and the hook drives the state machine (教訓 5.14 / 5.33).
   *
   * It is consulted ONLY while no target face is chosen (phase 1). Once a face IS
   * chosen the id is ignored entirely and the click acts on that face — vertex
   * placement in add (so a 飛び地 can be drawn clean OUTSIDE the face), ring
   * containment in delete (so a HOLE's interior, which the 穴透過 hit-test reports as
   * a miss, still picks that hole ring).
   */
  handleClick(point: WorldCoordinate, featureIdAtPoint: FeatureId | null): void;
  /** Update the cursor-follow preview (add draft; high-frequency, render-sink direct). */
  updatePreview(point: WorldCoordinate): void;
  /** 最後の頂点を取り消す (FR-78). Cancelled at 0 vertices → discard. */
  undoLastVertex(): void;
  /** Toggle the grid-snap draft (FR-78). */
  setGridSnap(gridSnap: boolean): void;
  /** CONFIRM the drafted ring (add): addRing → snapshot → confirmRingEdit → switch. */
  confirm(): void;
  /**
   * **Esc の階段 1 段目**（設計書 §D.4 / §D.4.1）: 打った頂点列だけを **まとめて**捨て、
   * **対象の面は掴んだまま**輪郭の引き直しへ戻る。1 つずつ戻すのは `Ctrl+Z` と
   * オプションバーの［1 つ戻す］（{@link UseRingEditToolActions.undoLastVertex}）の役目。
   *
   * 下書きが無い局面（面を選ぶ前・穴を消す側）では何もしない（冪等）。
   */
  discardDraftVertices(): void;
  /**
   * **Esc の階段 2 段目**（設計書 §D.4）: 掴んでいる対象の面だけを離して面選びへ戻る。
   * **道具は持ったまま**。選択への昇格を戻すのはコントローラの持ち場である
   * （自分が昇格させたものだけを戻す）。
   */
  releaseTarget(): void;
  /** Cancel the whole operation; discard ALL transient state (Escape; 教訓 5.2). */
  cancel(): void;
}

export type UseRingEditTool = UseRingEditToolState & UseRingEditToolActions;

// --- Ring hit-test (delete sub-mode) — UI-layer composition of U06 --------------
//
// FR-24 needs a RING id under a click, but `featureAtPoint` only yields a FEATURE id
// and the domain exposes no ring-granular hit-test. This helper COMPOSES U06's public
// {@link pointInPolygon} over the target face's rings — it re-implements NO predicate
// (単一の真実源 §4): the ring's world coordinates are resolved + seam-unwrapped +
// quantized exactly as auto-mode.ts does for its own point tests so the hit and the
// domain's later validation agree. It returns the DEEPEST ring (most parent-links)
// whose polygon strictly contains the point, so a click in a hole punched into an
// enclave picks that hole, not the outer territory.

function resolveRingPolygon(store: VertexStore, ring: Ring): GeoPolygon | undefined {
  const representative: WorldCoordinate[] = [];
  for (const vid of ring.vertexIds) {
    const vertex = getVertex(store, vid);
    if (vertex === undefined) return undefined;
    representative.push(vertex.coordinate);
  }
  return [unwrapRing(representative).map((c) => quantizeCoordinate(c))];
}

/** Parent-link depth of a ring (top-level = 0), for picking the deepest container. */
function parentDepthOf(shape: Shape, ring: Ring): number {
  const byId = new Map<RingId, Ring>(shape.rings.map((r) => [r.id, r]));
  let depth = 0;
  let current: Ring | undefined = ring;
  const seen = new Set<RingId>();
  while (current !== undefined) {
    if (seen.has(current.id)) return depth; // defensive against a cycle
    seen.add(current.id);
    const parentId: RingId | undefined = current.parentRingId;
    if (parentId === undefined) return depth;
    current = byId.get(parentId);
    depth += 1;
  }
  return depth;
}

/** The deepest ring whose polygon strictly contains `point`, or undefined for a miss. */
function ringAtPoint(shape: Shape, store: VertexStore, point: WorldCoordinate): Ring | undefined {
  const at = quantizeCoordinate(point);
  let best: Ring | undefined;
  let bestDepth = -1;
  for (const ring of shape.rings) {
    const poly = resolveRingPolygon(store, ring);
    if (poly === undefined) continue;
    if (pointInPolygon(at, poly) !== POINT_LOCATION.Inside) continue;
    const depth = parentDepthOf(shape, ring);
    if (depth > bestDepth) {
      best = ring;
      bestDepth = depth;
    }
  }
  return best;
}

// --- The hook ---------------------------------------------------------------

function rejectMessage(reason: RingRejectKind): string {
  return RING_REJECT_MESSAGES[reason];
}

export function useRingEditTool<S>(options: UseRingEditToolOptions<S>): UseRingEditTool {
  const {
    resolveFeature,
    resolveStore,
    anchorTime,
    current,
    ids,
    gridSpacing,
    startProcess,
    onCommitted,
    onConflicts,
    onTargetSelected,
    onCancelled,
  } = options;

  const [subMode, setSubMode] = useState<RingEditSubMode>(RING_EDIT_SUBMODE.Add);
  const [draft, setDraft] = useState<RingAddDraft | null>(null);
  // In delete sub-mode there is no vertex draft, so the chosen target is tracked apart.
  const [deleteTargetId, setDeleteTargetId] = useState<FeatureId | null>(null);
  const [armed, setArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * **消す前に見せる確認**（N-05 / 設計書 §A.3。増分 7 の中身 7）。押した瞬間に消す
   * のをやめ、何が消えるか（とくに「最後の外周を消すと面ごと消える」）を出してから
   * 確定する。確定までドメインは 1 バイトも動かない（教訓 5.22）。
   */
  const [pendingDelete, setPendingDelete] = useState<PendingRingDelete | null>(null);
  // Carries the grid-snap toggle across draft starts (mirrors startDraft's gridSnap arg).
  const [gridSnap, setGridSnapState] = useState(false);

  // The SINGLE reset契約 every exit path funnels through (教訓 5.2). Drops the draft,
  // the delete target and the message together; `armed` (tool-active) is kept unless a
  // full stop is requested by the caller (start / resetForSwitch set it explicitly).
  // `gridSnap` is INTENTIONALLY not reset — it is a user preference, not transient
  // interaction state (see UseRingEditToolState.gridSnap for the full contract).
  const discard = useCallback(() => {
    setDraft(resetDraft());
    setDeleteTargetId(null);
    setMessage(null);
    // 確認待ちの輪郭削除も捨てる（反証 3-1）。捨て忘れると、道具を持ち替えて戻った
    // ときに **古い写しのまま**確認が残り、その写しで確定できてしまう（教訓 5.2:
    // 出口はすべてこの 1 か所を通る、の対象に含める）。
    setPendingDelete(null);
  }, []);

  const start = useCallback(() => {
    setArmed(true);
    setSubMode(RING_EDIT_SUBMODE.Add);
    discard();
  }, [discard]);

  const resetForSwitch = useCallback(() => {
    setArmed(false);
    discard();
  }, [discard]);

  const cancel = useCallback(() => {
    setArmed(false);
    discard();
    onCancelled?.();
  }, [discard, onCancelled]);

  // --- Esc の階段（設計書 §D.4 / §D.4.1。増分 5 の手直し B1）--------------------
  //
  // **`cancel` との違い**: `cancel` は［やめる］ボタンを押されたときの経路で「この作業を
  // やめる」という意思表示だから道具ごと降りてよい。下の 2 つは **Escape の経路**で、
  // 1 回押すごとに 1 段だけ戻る（頂点列 → 対象の面 → あとは大域の階段へ譲る）。

  /** 1 段目: 打った頂点列だけをまとめて捨て、対象の面は掴んだままにする。 */
  const discardDraftVertices = useCallback(() => {
    setDraft((d) => (d === null || d.vertices.length === 0 ? d : startDraft(d.targetFeatureId, d.gridSnap)));
    setMessage(null);
  }, []);

  /** 2 段目: 対象の面だけを離して面選びへ戻す（道具は持ったまま）。 */
  const releaseTarget = useCallback(() => {
    setDraft(resetDraft());
    setDeleteTargetId(null);
    setMessage(null);
  }, []);

  const toggleSubMode = useCallback(() => {
    setSubMode((m) => (m === RING_EDIT_SUBMODE.Add ? RING_EDIT_SUBMODE.Delete : RING_EDIT_SUBMODE.Add));
    // A sub-mode switch is a transient-discard path (教訓 5.2): drop the in-progress
    // add draft / delete target so nothing leaks across the two 対概念 modes.
    discard();
  }, [discard]);

  const setGridSnapAction = useCallback((next: boolean) => {
    setGridSnapState(next);
    setDraft((d) => (d === null ? d : setGridSnap(d, next)));
  }, []);

  // Resolve + LEAF-gate a clicked feature id into a live leaf + its store (educated by
  // the SAME resolve ports the confirm uses so the hit and the edit agree, 教訓 5.29).
  const resolveTargetLeaf = useCallback(
    (featureId: FeatureId): LeafFeature | undefined => {
      const feature = resolveFeature(featureId);
      if (feature === undefined || feature.kind !== FEATURE_KIND.Leaf) return undefined;
      return feature;
    },
    [resolveFeature],
  );

  // --- Drive U24/U13 for an assembled snapshot (add + delete share this, 教訓 5.7) --
  const runConfirm = useCallback(
    (snapshot: FeatureSnapshot) => {
      const outcome = startProcess(snapshot, anchorTime(), current());
      if (outcome.kind === RELEASE_OUTCOME.Refused) {
        // **断られた理由を出す**（増分 3 の手直し 2 回目）。以前はここも `discard()` へ
        // 落としていたので、確定の関門（世界の外・半周以上の辺）が働いても画面には
        // 何も出ず、下書きだけが黙って消えた ―― 現状分析 C1 と同じ「無反応」である。
        setMessage(
          outcome.reason === EDIT_REFUSAL.LongDrag
            ? RING_REJECT_MESSAGES['confirm-long-drag']
            : RING_REJECT_MESSAGES['confirm-outside-world'],
        );
        return; // 下書きは残す（直して確定し直せる）。
      }
      if (outcome.kind !== RELEASE_OUTCOME.Processed) {
        // NoOp: nothing changed (should not happen for add/delete which force changed);
        // discard the transient state so the tool re-arms cleanly (教訓 5.2).
        discard();
        return;
      }
      switch (outcome.result.status) {
        case PROCESS_STATUS.Committed:
          onCommitted(outcome.result, snapshot);
          discard();
          return;
        case PROCESS_STATUS.ConflictsPending:
          onConflicts?.(outcome.result, outcome.proposal);
          return;
        case PROCESS_STATUS.Rejected:
          setMessage(outcome.result.message);
          return;
      }
    },
    [startProcess, anchorTime, current, onCommitted, onConflicts, discard],
  );

  // --- Add sub-mode: place a vertex / classify the first click (教訓 5.7) ----------
  const placeAddVertex = useCallback(
    (leaf: LeafFeature, point: WorldCoordinate) => {
      // **世界の外には置けない**（増分 3 の手直し 2 回目）。追加の道具と同じ関門を
      // リング編集にも掛ける ―― 北極の上にも南極の下にも場所が無いのは道具によらない。
      // 判定は **状態更新の外**で済ませる（React 18 の厳格モードは更新関数を 2 回呼ぶので、
      // 更新関数の中で `setMessage` を呼ばない ―― `useAddTool` と同じ作法）。
      // グリッドは緯度を動かさないので、寄せる前の値で見て差し支えない。
      if (!isWorldLatitude(point.lat)) {
        setMessage(RING_REJECT_MESSAGES['outside-world']);
        return;
      }
      setDraft((d) => {
        const base = d ?? startDraft(leaf.id, gridSnap);
        // FR-78 グリッドスナップ: quantize the placed coordinate through the SAME single
        // snap-priority source the add tool uses (resolveSnap, 単一の真実源) so the
        // grid-snap toggle actually moves the vertex to the graticule instead of being a
        // dead toggle. ring-edit has no shared-vertex proximity resolver, so proximity is
        // always null here — only the grid rule applies (see deviations); `base.gridSnap`
        // is the draft's live truth (setGridSnap keeps it in sync with the hook state).
        const resolved = resolveSnap({
          raw: point,
          gridSnap: base.gridSnap,
          gridSpacing,
          proximity: null,
        });
        const coordinate = resolved.coordinate;
        if (base.vertices.length === 0) {
          // First click freezes the hole / enclave mode (FR-22): classify against the
          // target face's shape at the current time (FR-57) via the SAME resolve store.
          // Classification uses the SNAPPED coordinate so the hole/enclave verdict and the
          // stored vertex agree (they must be one point, not raw-vs-snapped).
          const mode = classifyFirstClick(leaf.shape, resolveStore(), coordinate);
          return placeFirstVertex(base, coordinate, mode);
        }
        return placeVertex(base, coordinate);
      });
      setMessage(null);
    },
    [gridSnap, gridSpacing, resolveStore],
  );

  // --- Delete sub-mode: click a ring → delete it → confirm (教訓 5.7) --------------
  const deleteRingAt = useCallback(
    (leaf: LeafFeature, point: WorldCoordinate) => {
      const store = resolveStore();
      const ring = ringAtPoint(leaf.shape, store, point);
      if (ring === undefined) {
        setMessage(RING_REJECT_MESSAGES['target-not-found']);
        return;
      }
      const outcome: RingDeleteOutcome =
        ring.kind === RING_KIND.Hole
          ? deleteHoleRing(leaf, ring.id, store)
          : deleteTerritoryRing(leaf, ring.id, store);
      switch (outcome.kind) {
        case RING_DELETE_OUTCOME.FeatureSurvives:
          // **消す前に確認する**（N-05 / 設計書 §A.3。増分 7 の中身 7）。旧版は押した
          // 瞬間に消えていた ―― 輪郭は形そのものなので、取り消せるとはいえ何が消えるかを
          // 言わずに消すのは削除の作法から外れている。
          setPendingDelete({
            ringKind: ring.kind === RING_KIND.Hole ? RING_KIND.Hole : RING_KIND.Territory,
            lastTerritory: false,
            snapshot: snapshotForLeaf(outcome.feature, []),
          });
          return;
        case RING_DELETE_OUTCOME.FeatureDeleted:
          // **最後の外周を消すと面ごと消える**（設計書 §A.3 が名指しした事前の文）。
          setPendingDelete({
            ringKind: RING_KIND.Territory,
            lastTerritory: true,
            snapshot: snapshotForDeletedFeature(leaf.id),
          });
          return;
        case RING_DELETE_OUTCOME.Rejected:
          setMessage(rejectMessage(outcome.reason));
          return;
      }
    },
    [resolveStore],
  );

  /** 確認に「はい」と答えた ―― ここで初めて確定へ流す。 */
  const confirmPendingDelete = useCallback((): void => {
    const pending = pendingDelete;
    if (pending === null) return;
    setPendingDelete(null);
    runConfirm(pending.snapshot);
  }, [pendingDelete, runConfirm]);

  /** 確認をやめた ―― 何も起きない（教訓 5.22 確定までドメインを壊さない）。 */
  const cancelPendingDelete = useCallback((): void => {
    setPendingDelete(null);
  }, []);

  // Pick the target face from a click (the ONE target-acquisition path both sub-modes
  // share). Returns the resolved leaf, or undefined after surfacing WHY it failed —
  // never a silent no-op (教訓 5.12: 判断できる理由を必ず出す).
  const acquireTarget = useCallback(
    (featureIdAtPoint: FeatureId | null): LeafFeature | undefined => {
      if (featureIdAtPoint === null) {
        setMessage(RING_EDIT_STRINGS.faceNotFound);
        return undefined;
      }
      const leaf = resolveTargetLeaf(featureIdAtPoint);
      if (leaf === undefined) {
        setMessage(RING_EDIT_STRINGS.selectLeafTarget);
        return undefined;
      }
      onTargetSelected?.(featureIdAtPoint);
      setMessage(null);
      return leaf;
    },
    [resolveTargetLeaf, onTargetSelected],
  );

  // A LEFT click. TWO PHASES in BOTH sub-modes (到達可能性の要, FR-22 / FR-24):
  //
  //   phase 1 — TARGET: the click must hit a leaf face, so it is resolved through the
  //     host hit-test. That hit-test is 穴透過 (`leafAtPoint`), i.e. it only ever
  //     answers for the face's SOLID fill.
  //   phase 2 — ACT: every later click acts on the CHOSEN face and is deliberately
  //     hit-test INDEPENDENT — the hook already knows which face it edits, and the
  //     geometry question ("solid or not", "which ring contains this") is answered by
  //     the domain against that face's own rings.
  //
  // Collapsing the two phases into one click (the previous design) made half of FR-22 /
  // FR-24 UNREACHABLE: a first click had to BOTH hit the face (穴透過 ⇒ inside the
  // solid) AND land outside the solid to mean 飛び地 — mutually exclusive — and a
  // delete click inside a hole void resolved to no face at all, so the hole ring could
  // never be picked. Splitting them makes 穴 / 飛び地 / 穴削除 / 飛び地削除 all reachable
  // with plain clicks, and matches the guide copy the tool already showed.
  const handleClick = useCallback(
    (point: WorldCoordinate, featureIdAtPoint: FeatureId | null) => {
      if (!armed) return;
      if (subMode === RING_EDIT_SUBMODE.Add) {
        if (draft === null) {
          // Phase 1: pick the face; NO vertex is placed by the selection click.
          const leaf = acquireTarget(featureIdAtPoint);
          if (leaf === undefined) return;
          setDraft(startDraft(leaf.id, gridSnap));
          return;
        }
        // Phase 2: a ring vertex — anywhere. The FIRST one classifies 穴 / 飛び地 by
        // geometry (classifyFirstClick over the target face's shape), so a click in a
        // hole void or clean outside the face is an ENCLAVE instead of a dropped click.
        const leaf = resolveTargetLeaf(draft.targetFeatureId);
        if (leaf === undefined) {
          // The target vanished (time move / delete) — abandon the stale draft.
          setMessage(RING_REJECT_MESSAGES['target-not-found']);
          discard();
          return;
        }
        placeAddVertex(leaf, point);
        return;
      }
      // Delete sub-mode — the same two phases.
      const targetId = deleteTargetId;
      if (targetId === null) {
        const leaf = acquireTarget(featureIdAtPoint);
        if (leaf === undefined) return;
        setDeleteTargetId(leaf.id);
        return;
      }
      const leaf = resolveTargetLeaf(targetId);
      if (leaf === undefined) {
        setMessage(RING_REJECT_MESSAGES['target-not-found']);
        setDeleteTargetId(null);
        return;
      }
      // Phase 2: the ring under the click is decided by the face's OWN ring containment
      // (ringAtPoint), never by the 穴透過 hit-test — that is what makes 穴リング削除
      // reachable at all.
      deleteRingAt(leaf, point);
    },
    [
      armed,
      subMode,
      draft,
      gridSnap,
      deleteTargetId,
      acquireTarget,
      resolveTargetLeaf,
      placeAddVertex,
      deleteRingAt,
      discard,
    ],
  );

  const updatePreviewAction = useCallback((point: WorldCoordinate) => {
    setDraft((d) => (d === null ? d : { ...d, preview: point }));
  }, []);

  const undoLastVertex = useCallback(() => {
    setDraft((d) => {
      if (d === null) return d;
      const result = undoVertex(d);
      if (result.kind === UNDO_RESULT.Cancelled) return resetDraft();
      return result.draft;
    });
    setMessage(null);
  }, []);

  const confirm = useCallback(() => {
    if (draft === null) return;
    const leaf = resolveTargetLeaf(draft.targetFeatureId);
    if (leaf === undefined) {
      setMessage(RING_REJECT_MESSAGES['target-not-found']);
      return;
    }
    if (draft.mode === null) {
      setMessage(RING_REJECT_MESSAGES['too-few-vertices']);
      return;
    }
    const result: RingCommandResult = addRing(
      leaf,
      draft.mode,
      draft.vertices,
      resolveStore(),
      ids,
    );
    if (result.status === RING_COMMAND_STATUS.Rejected) {
      setMessage(rejectMessage(result.reason));
      return;
    }
    runConfirm(snapshotForLeaf(result.feature, result.vertices));
  }, [draft, resolveTargetLeaf, resolveStore, ids, runConfirm]);

  // --- Derived view -------------------------------------------------------
  const targetId: FeatureId | null =
    draft?.targetFeatureId ?? deleteTargetId ?? null;

  // Both sub-modes report SelectingTarget until a face is chosen, so the flow the chrome
  // (and an e2e probe) reads always states WHICH phase the click will run — 単一の真実源
  // with the guide below.
  const flow: RingEditFlow = useMemo(() => {
    if (!armed) return RING_EDIT_FLOW.Idle;
    if (subMode === RING_EDIT_SUBMODE.Delete) {
      return deleteTargetId !== null ? RING_EDIT_FLOW.Deleting : RING_EDIT_FLOW.SelectingTarget;
    }
    return draft !== null ? RING_EDIT_FLOW.Drafting : RING_EDIT_FLOW.SelectingTarget;
  }, [armed, subMode, draft, deleteTargetId]);

  const guide = useMemo(() => {
    if (subMode === RING_EDIT_SUBMODE.Delete) {
      return deleteTargetId !== null
        ? RING_EDIT_STRINGS.guideDeleteRing
        : RING_EDIT_STRINGS.guideSelectDeleteTarget;
    }
    return draft !== null ? RING_EDIT_STRINGS.guideDrawRing : RING_EDIT_STRINGS.guideSelectTarget;
  }, [subMode, draft, deleteTargetId]);

  const canConfirm = draft !== null && draft.vertices.length >= 3;

  return {
    flow,
    subMode,
    draft,
    targetId,
    gridSnap,
    guide,
    message,
    canConfirm,
    start,
    resetForSwitch,
    toggleSubMode,
    handleClick,
    updatePreview: updatePreviewAction,
    undoLastVertex,
    setGridSnap: setGridSnapAction,
    confirm,
    discardDraftVertices,
    releaseTarget,
    cancel,
    pendingDelete,
    confirmPendingDelete,
    cancelPendingDelete,
  };
}
