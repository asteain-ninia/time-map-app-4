// U28 — the 所属変更 (reparent / affiliation-change) interaction hook (FR-46〜FR-49 /
// FR-94, 教訓 5.2 / 5.7 / 5.11 / 5.22 / 5.26).
//
// UI layer: holds the TRANSIENT reparent state (the chosen target leaf + the chosen
// new parent) and DRIVES the whole interaction by delegating every decision to the
// pure U28 domain logic — start → pick target → pick parent → confirm
// (= buildAffiliationProposal → U13). It never re-implements hierarchy / cycle /
// existence-period rules and never mutates shared domain state before confirm
// (教訓 5.22 確定までの非破壊).
//
// This hook is exactly the消費する ui コンシューマ the integration lens flagged as
// MISSING for 所属変更: src/domain/affiliation (allowedParentCandidates /
// buildAffiliationProposal / decision + command units) was fully unit-tested but
// UNREACHABLE — no UI subscribed to or drove it, so the 所属変更 toolbar button armed
// yet did nothing (bughunt3: reparent-dead-button; 教訓 5.7「ロジック側に関数があっても
// UI からの呼び出しがなければ機能しない」). Every completion trigger (confirm) is wired
// here to real logic, and the SINGLE `reset` 契約 runs on every exit path (cancel /
// commit / tool switch / mode switch / Escape) so the transient selection never leaks
// (教訓 5.2).

import { useCallback, useMemo, useState } from 'react';

import {
  PROCESS_STATUS,
  type EditProposal,
  type ProcessResult,
} from '../../domain/consistency/index';
import type { Feature } from '../../domain/feature';
import { buildForest } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';
import { createIdGeneratorState } from '../../domain/id-generator';
import type { TimePoint } from '../../domain/time/time-point';
import type { VertexStore } from '../../domain/vertex';
import {
  AFFILIATION_STATUS,
  buildAffiliationProposalForTargets,
  isLegalNewParent,
  parentExisting,
  parentNone,
  planAffiliationTargets,
  type AffiliationProposal,
  type AffiliationRejected,
  type AffiliationTargetPlan,
  type ParentDecision,
} from '../../domain/affiliation/index';
import {
  toAffiliationEditProposal,
  type AffiliationSnapshot,
} from '../../domain/editing/apply-proposal';

import { REPARENT_STRINGS } from './strings';

// --- Layer-crossing ports (the contracts; 教訓 5.33 / 5.34) ------------------

/** Resolve the features effective at the reparent anchor time (host live-lookup). */
export type ResolveFeatures = () => readonly Feature[];

/** Resolve the reparent anchor time (the UI current time, 文脈優先). */
export type ResolveAnchorTime = () => TimePoint;

/**
 * Resolve the {@link VertexStore} effective at the reparent anchor time (host live-lookup
 * `verticesAt`). Threaded into buildAffiliationProposal so the post-reparent
 * 形状=和・隙間なし check (checkAggregateShapes via validateHierarchy) actually runs
 * (基準 5 / FR-35). Without it the shape-gap validation is silently skipped — the
 * bughunt finding "reparent skips the aggregate-shape check" (mirrors the knife / merge
 * bootstrap resolveStore). Optional: a host that has not bound it falls back to the
 * topological-only check (the prior behaviour).
 */
export type ResolveVertexStore = () => VertexStore;

/** The U13 process-start adapter the host injects (createLiveAffiliationBinding). */
export type StartAffiliationProcess<S> = (
  proposal: EditProposal<AffiliationSnapshot>,
) => ProcessResult<S>;

export interface UseReparentToolOptions<S> {
  readonly resolveFeatures: ResolveFeatures;
  readonly anchorTime: ResolveAnchorTime;
  /** Live-lookup of the vertices at the anchor time → enables the shape-gap check (基準 5). */
  readonly resolveStore?: ResolveVertexStore;
  readonly startProcess: StartAffiliationProcess<S>;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection to the target. */
  readonly onCommitted?: (result: ProcessResult<S>, snapshot: AffiliationSnapshot) => void;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?: (
    result: ProcessResult<S>,
    proposal: EditProposal<AffiliationSnapshot>,
  ) => void;
  /**
   * Run the host's EXPLICIT-CANCEL contract (Escape / キャンセルボタン) — the composition
   * root releases `activeTool` here, exactly as knife / drill / ring-edit do (W3-AB).
   * Without it the toolbar button stayed `aria-pressed=true` while the session was
   * disarmed, so pressing the SAME button again ran the store's press-toggle
   * (tool → null) and「何も起きない」= a dead button until another tool was visited.
   * NOT called on `resetForSwitch` (tool/mode switch already cleared) nor on
   * `clearSelection` (which keeps the session and only returns to pick-target).
   */
  readonly onCancelled?: (() => void) | undefined;
}

// --- The transient flow state (discriminated; 技術方針 2.1) -------------------

export const REPARENT_FLOW = {
  /** Not armed — no reparent session. */
  Idle: 'idle',
  /** Armed and waiting for the target feature pick (the first click). */
  PickTarget: 'pick-target',
  /** Target chosen; waiting for the new parent pick (the second click). */
  PickParent: 'pick-parent',
  /** A confirm paused on conflicts (the modal owns the next step, FR-62). */
  ConflictPaused: 'conflict-paused',
  /** A confirm was rejected (the domain refused — show why, 教訓 5.12). */
  Rejected: 'rejected',
} as const;

/**
 * 対象の集合をどこから受け取ったか（増分 7 の中身 2b）。
 *
 * - `map`   … 地図をクリックして 1 件ずつ掴んだ（従来の手順）。
 * - `marked` … 一覧で印を付けた集合をそのまま引き継いだ（V8 の「3 件をまとめて」）。
 *
 * **どちらでも確定の経路は 1 本**（{@link buildAffiliationProposalForTargets}）だが、
 * 対象を離す Escape の意味が違う ―― 印から来た対象は道具が掴んだものではないので、
 * 道具側では外さない（外すのは一覧の印を消したとき）。
 */
export const REPARENT_TARGET_SOURCE = {
  Map: 'map',
  Marked: 'marked',
} as const;

export type ReparentTargetSource =
  (typeof REPARENT_TARGET_SOURCE)[keyof typeof REPARENT_TARGET_SOURCE];

export type ReparentFlow = (typeof REPARENT_FLOW)[keyof typeof REPARENT_FLOW];

export interface UseReparentToolState {
  readonly flow: ReparentFlow;
  /**
   * 所属を変える地物（複数。増分 7 の中身 2b）。空なら手順 1 の頭に居る。
   *
   * 旧版は 1 件しか持てず、**3 件をマークしても確定できずに止まっていた**（設計書 §O の
   * GPT V8）。ドメインには {@link buildAffiliationProposalForTargets} が実在するので、
   * 受け口をここで広げて素通しする。
   */
  readonly targetIds: readonly FeatureId[];
  /** 対象をどこから受け取ったか（地図で掴んだ／一覧の印を引き継いだ）。 */
  readonly targetSource: ReparentTargetSource;
  /**
   * 確定と同じ規則で洗い直した対象（集約は下位領域へ展開、居ないものは外す）。
   * 予告文と「外した件数と理由」はここから作る。
   */
  readonly plan: AffiliationTargetPlan;
  /** 先頭の対象（1 件のときの従来の読み方。0 件なら null）。 */
  readonly targetId: FeatureId | null;
  /** The chosen new parent feature (null until picked). */
  readonly newParentId: FeatureId | null;
  /** The per-state Japanese guide (FR-92). */
  readonly guide: string;
  /** A rejection / info message kept until a meaningful event (教訓 5.12). null = none. */
  readonly message: string | null;
  /** Whether confirm is allowed (a target + a legal new parent are chosen). */
  readonly canConfirm: boolean;
  /**
   * Whether 最上位化 (detach / make-top-level, `parentNone`) is allowed: a target is
   * picked. The new-parent guard does NOT apply — detaching only needs a target
   * (FR-46 独立 / FR-47 解体 の構成要素). 単一フロー上の別決定 (parentNone) なので
   * existing-parent の canConfirm とは独立 (教訓 5.26).
   */
  readonly canConfirmNone: boolean;
}

export interface UseReparentToolActions {
  /** Arm the tool (idempotent; clears any stale transient, 教訓 5.2). */
  readonly start: () => void;
  /**
   * 対象の集合を外から入れ替える（一覧の印・素性欄の親欄・右クリックの入口）。
   * 空配列を渡すと手順 1 の頭へ戻る。**選びかけの上位領域は保つ**（対象が増減しても
   * 「どこへ移すか」の答えは変わらないため）。
   */
  readonly setTargets: (
    featureIds: readonly FeatureId[],
    source?: ReparentTargetSource,
  ) => void;
  /** Discard the session on a tool / mode switch (the single reset 契約, 教訓 5.2). */
  readonly resetForSwitch: () => void;
  /** A map click resolved to `featureId`: pick target, then pick parent (toggles off). */
  readonly pick: (featureId: FeatureId) => void;
  /** Drop the current target + parent (stay armed at PickTarget). */
  readonly clearSelection: () => void;
  /**
   * **Esc の階段 1 段目**（設計書 §D.4 / 増分 5 の手直し B1）: 選びかけの「新しい上位
   * 領域」だけを外し、**所属を変える地物（対象）は掴んだまま**手順 2 の頭へ戻る。
   *
   * 所属変更には打った点の列が無いので、「下書き」に当たるのがこの選びかけである
   * ―― 相手を選び間違えたときに、対象ごと選び直しにならない。
   */
  readonly clearNewParent: () => void;
  /** Cancel the session (Escape / cancel button) → idle transient cleared. */
  readonly cancel: () => void;
  /** Build the affiliation proposal and drive U13 (the COMPLETE trigger, 教訓 5.7). */
  readonly confirm: () => void;
  /**
   * Build a `parentNone` (最上位化 / detach) proposal and drive U13 — the make-top-level
   * COMPLETE trigger (教訓 5.7). Mirrors {@link confirm} but with the `parentNone`
   * decision and NO new-parent guard (detaching only needs a target). This is the UI
   * entry point the domain `parentNone` variant had no consumer for (bughunt wiring gap).
   */
  readonly confirmNone: () => void;
  /**
   * **3 択のどれでも確定する 1 本**（増分 7 の中身 1）。`existing` / `create` /
   * `none` を同じ経路へ流す ―― {@link confirm} と {@link confirmNone} はこの糖衣である。
   *
   * `directDomainNameOverride` は分け残し（直轄領）の名前の上書き（G-4 / FR-37 must）。
   * 空文字・未指定なら既定名称「<元名> 直轄領」を使う。
   */
  /**
   * 確定できたら `true`、断られたら `false`（反証 2-12）。断られたときに板を閉じると
   * **入力した名前も選んだ行き先も消える**ので、呼び出し側はこの値で「板を畳むか」を
   * 決める。
   */
  readonly confirmWith: (
    decision: ParentDecision,
    options?: { readonly directDomainNameOverride?: string },
  ) => boolean;
}

export type UseReparentTool = UseReparentToolState & UseReparentToolActions;

/** 対象が 0 件のときの共有の空配列（同一性を保って再レンダーを増やさない）。 */
const EMPTY_TARGETS: readonly FeatureId[] = [];

/** Map a domain {@link AffiliationRejected} to its user-facing message (教訓 5.12). */
function rejectionMessage(rejection: AffiliationRejected): string {
  return rejection.message;
}

export function useReparentTool<S>(options: UseReparentToolOptions<S>): UseReparentTool {
  const { resolveFeatures, anchorTime, startProcess } = options;
  const resolveStore = options.resolveStore;
  const onCommitted = options.onCommitted;
  const onConflicts = options.onConflicts;
  const onCancelled = options.onCancelled;

  const [flow, setFlow] = useState<ReparentFlow>(REPARENT_FLOW.Idle);
  const [targetIds, setTargetIds] = useState<readonly FeatureId[]>(EMPTY_TARGETS);
  const [targetSource, setTargetSource] = useState<ReparentTargetSource>(
    REPARENT_TARGET_SOURCE.Map,
  );
  const [newParentId, setNewParentId] = useState<FeatureId | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const targetId = targetIds[0] ?? null;

  const reset = useCallback((next: ReparentFlow): void => {
    setFlow(next);
    setTargetIds(EMPTY_TARGETS);
    setTargetSource(REPARENT_TARGET_SOURCE.Map);
    setNewParentId(null);
    setMessage(null);
  }, []);

  const start = useCallback((): void => {
    reset(REPARENT_FLOW.PickTarget);
  }, [reset]);

  const resetForSwitch = useCallback((): void => {
    reset(REPARENT_FLOW.Idle);
  }, [reset]);

  // W3-AB: an EXPLICIT cancel also leaves the tool (the host releases `activeTool`), so the
  // toolbar's pressed state and the session's armed state stay ONE truth and the next press
  // of the SAME button re-arms (教訓 5.2 全経路で破棄 + 単一の真実源). Same規約 as knife /
  // drill / ring-edit / merge; `resetForSwitch` deliberately does NOT run it.
  const cancel = useCallback((): void => {
    reset(REPARENT_FLOW.Idle);
    onCancelled?.();
  }, [reset, onCancelled]);

  const clearSelection = useCallback((): void => {
    setTargetIds(EMPTY_TARGETS);
    setTargetSource(REPARENT_TARGET_SOURCE.Map);
    setNewParentId(null);
    setMessage(null);
    setFlow((f) => (f === REPARENT_FLOW.Idle ? f : REPARENT_FLOW.PickTarget));
  }, []);

  /**
   * 対象の集合を外から入れ替える（一覧の印・素性欄の親欄・右クリック）。
   *
   * **選びかけの上位領域は保つ** ―― 対象が 1 件増えても「どこへ移すか」の答えは
   * 変わらないので、そこまで捨てると印を 1 つ足すたびに選び直しになる。
   */
  const setTargets = useCallback(
    (featureIds: readonly FeatureId[], source: ReparentTargetSource = REPARENT_TARGET_SOURCE.Map): void => {
      const next = [...new Set(featureIds)];
      setTargetIds(next.length === 0 ? EMPTY_TARGETS : next);
      setTargetSource(source);
      setMessage(null);
      setFlow((f) =>
        f === REPARENT_FLOW.Idle
          ? f
          : next.length === 0
            ? REPARENT_FLOW.PickTarget
            : REPARENT_FLOW.PickParent,
      );
    },
    [],
  );

  // **Esc の階段 1 段目**（増分 5 の手直し B1）。選びかけの上位領域だけを外す。断りや
  // 競合の途中でも意味があるので flow は PickParent へ戻す（対象は掴んだままなので、
  // 次にやることは「新しい上位領域を選ぶ」である）。
  const clearNewParent = useCallback((): void => {
    setNewParentId(null);
    setMessage(null);
    setFlow((f) => (f === REPARENT_FLOW.Idle ? f : REPARENT_FLOW.PickParent));
  }, []);

  // A map click. While idle, ignore. The FIRST pick chooses the target; the SECOND
  // chooses the new parent (clicking the same target again toggles it back to the
  // pick-target phase, 教訓 5.12). Re-picking a parent replaces the prior choice.
  const pick = useCallback((featureId: FeatureId): void => {
    setFlow((f) => {
      if (f === REPARENT_FLOW.Idle) return f;
      // After a rejection / paused-conflict the transient still holds the FAILED target +
      // new parent. The user's NEXT click is a fresh start, not a continuation: without
      // resetting, that click would be (mis)read as a new-parent pick against the stale
      // target (or toggle the stale target off). Drop the stale selection and treat this
      // click as a fresh TARGET pick (教訓 5.12 — a meaningful event clears the failure).
      if (f === REPARENT_FLOW.Rejected || f === REPARENT_FLOW.ConflictPaused) {
        setMessage(null);
        setTargetIds([featureId]);
        setTargetSource(REPARENT_TARGET_SOURCE.Map);
        setNewParentId(null);
        return REPARENT_FLOW.PickParent;
      }
      if (targetIds.length === 0) {
        setMessage(null);
        setTargetIds([featureId]);
        setTargetSource(REPARENT_TARGET_SOURCE.Map);
        return REPARENT_FLOW.PickParent;
      }
      if (targetIds.includes(featureId)) {
        // **N-12**（増分 7 の中身 10）: 旧版はここで **黙って対象を外して**いた ――
        // 同じ地物を 2 回押すのは「もう 1 度確かめた」であることが多く、外れたことに
        // 気づかないまま次のクリックが「新しい対象」として読まれていた。
        //
        // **もう外さない。** 対象はそのままにして「同じ地物です」と言う。外す手は
        // ［選択を外す］と Escape（Esc の階段の 2 段目）に既にある ―― 取り返しの
        // つく操作の入口を 3 つ持つ必要は無く、黙って消える経路だけを塞ぐ。
        setMessage(REPARENT_STRINGS.samePickNotice);
        return f;
      }
      setMessage(null);
      setNewParentId(featureId);
      return REPARENT_FLOW.PickParent;
    });
  }, [targetIds]);

  /**
   * 確定と同じ規則で洗い直した対象（増分 7 の中身 2b）。集約は下位領域へ展開し、その年に
   * 居ないものは外す。**確定の直前にもう 1 度引き直す**ので、ここは画面の予告のためだけの
   * 値である（教訓 5.6: 判断は結果状態で）。
   */
  const plan = useMemo(
    () => planAffiliationTargets(resolveFeatures(), targetIds),
    [resolveFeatures, targetIds],
  );

  // The legality verdict over the LIVE features at the anchor time (教訓 5.26: the SAME
  // single predicate buildAffiliationProposal re-runs at confirm). Drives canConfirm so
  // the button is honest about whether a confirm would be accepted (target + legal new
  // parent: not self, not a descendant cycle, existence periods compatible).
  const canConfirm = useMemo(() => {
    if (flow === REPARENT_FLOW.Idle) return false;
    if (targetIds.length === 0 || newParentId === null) return false;
    const forest = buildForest(resolveFeatures());
    // **対象は洗い直したあとの末端で見る**（増分 7 の中身 2b）。集約地物を掴んでいる
    // ときの合法性は「集約地物そのもの」ではなく「その下位領域それぞれ」で決まる
    // ―― 確定側（buildProposalForLeaves）が展開後に同じ述語を回すので、ここでも
    // 同じ集合で判定しないとボタンの名乗りと結果が食い違う（教訓 5.26）。
    if (plan.leafIds.length === 0) return false;
    return plan.leafIds.every((leafId) => isLegalNewParent(forest, leafId, newParentId).ok);
    // resolveFeatures reads live; targetIds/newParentId are the reactive drivers. flow
    // is included so a post-commit re-arm recomputes.
  }, [flow, targetIds, plan, newParentId, resolveFeatures]);

  // 最上位化 (detach) only needs a target — `parentNone` carries no new-parent legality
  // (循環/存在期間 are vacuous when the parent reference is removed, 教訓 5.26). Honest
  // about whether a confirmNone would be accepted.
  const canConfirmNone = useMemo(
    () => flow !== REPARENT_FLOW.Idle && targetIds.length > 0,
    [flow, targetIds],
  );

  // Shared build → drive helper (single confirm path, 教訓 5.7). Builds the proposal for
  // `decision`, threading the LIVE vertexStore so buildAffiliationProposal's post-reparent
  // 形状=和・隙間なし check (checkAggregateShapes via validateHierarchy) runs (基準 5 /
  // FR-35) — omitted previously, so the shape-gap check was silently skipped on every
  // reparent (bughunt). idState is a fresh generator (its internal `existing` set is built
  // from the live features, so a `create`-path id can never collide; existing/none mint
  // nothing).
  //
  // **複数対象は `buildAffiliationProposalForTargets` の 1 呼び出しで確定する**（増分 7 の
  // 中身 2b）。1 件ずつ回すと「3 件ぶんの新しい上位領域」が 3 つ生まれ、取り消しも 3 手に
  // なる ―― ドメインの `create` は **新規集約を 1 度だけ生成**して全対象を再親付けする
  // 契約なので、まとめて渡すことがそのまま「1 つの取り消し単位」になる。
  const driveProposal = useCallback(
    (
      targets: readonly FeatureId[],
      decision: ParentDecision,
      commitOptions?: { readonly directDomainNameOverride?: string },
    ): boolean => {
      const features = resolveFeatures();
      const at = anchorTime();
      // **確定の直前にもう 1 度洗い直す**（増分 7 の中身 2b）。印を付けてから年を動かす・
      // 別の編集で消える、が起こりうるので、押した瞬間の実物で決める（教訓 5.6）。
      const fresh = planAffiliationTargets(features, targets);
      if (fresh.leafIds.length === 0) {
        setMessage(REPARENT_STRINGS.noTargetsLeft);
        setFlow(REPARENT_FLOW.Rejected);
        return false;
      }
      const override = commitOptions?.directDomainNameOverride;
      const result = buildAffiliationProposalForTargets(features, fresh.leafIds, decision, {
        idState: createIdGeneratorState(),
        now: () => Date.now(),
        ...(resolveStore ? { vertexStore: resolveStore() } : {}),
        ...(override !== undefined && override !== '' ? { directDomainNameOverride: override } : {}),
      });
      if (result.status === AFFILIATION_STATUS.Rejected) {
        setMessage(rejectionMessage(result));
        setFlow(REPARENT_FLOW.Rejected);
        return false;
      }

      const proposal: AffiliationProposal = result.proposal;
      const editProposal = toAffiliationEditProposal(proposal, at);
      const processResult = startProcess(editProposal);
      switch (processResult.status) {
        case PROCESS_STATUS.Committed:
          onCommitted?.(processResult, editProposal.snapshot);
          reset(REPARENT_FLOW.PickTarget); // re-arm fresh for another reparent (教訓 5.2).
          return true;
        case PROCESS_STATUS.ConflictsPending:
          setFlow(REPARENT_FLOW.ConflictPaused);
          onConflicts?.(processResult, editProposal);
          // 競合の板が次の一手を持つので、3 択の板は畳んでよい。
          return true;
        case PROCESS_STATUS.Rejected:
          setMessage(processResult.message);
          setFlow(REPARENT_FLOW.Rejected);
          return false;
      }
    },
    [resolveFeatures, anchorTime, resolveStore, startProcess, onCommitted, onConflicts, reset],
  );

  /**
   * **3 択のどれでも確定する 1 本**（増分 7 の中身 1）。`existing` / `create` / `none` を
   * 同じ経路へ流すので、直轄領の生成も確定後の選択も 3 択で同じ形になる。
   */
  const confirmWith = useCallback(
    (
      decision: ParentDecision,
      commitOptions?: { readonly directDomainNameOverride?: string },
    ): boolean => {
      if (targetIds.length === 0) return false;
      return driveProposal(targetIds, decision, commitOptions);
    },
    [targetIds, driveProposal],
  );

  // Confirm 既存上位領域 (the picked parent, FR-46/48). buildAffiliationProposal re-runs
  // the SAME legality predicate (教訓 5.26), expands an aggregate target to its下位領域,
  // auto-prunes emptied aggregates, and re-validates U08 hierarchy consistency — refusing
  // without touching shared state on any violation (教訓 5.22).
  const confirm = useCallback((): void => {
    if (newParentId === null) return;
    confirmWith(parentExisting(newParentId));
  }, [newParentId, confirmWith]);

  // Confirm 最上位化 (detach to top level, `parentNone`, FR-46 独立 / 解体の構成要素).
  // Only a target is required — no new parent guard (the parent reference is removed).
  const confirmNone = useCallback((): void => {
    confirmWith(parentNone);
  }, [confirmWith]);

  const guide = useMemo(
    () =>
      targetIds.length === 0
        ? REPARENT_STRINGS.guidePickTarget
        : REPARENT_STRINGS.guidePickParent,
    [targetIds],
  );

  return {
    flow,
    targetIds,
    targetSource,
    plan,
    targetId,
    newParentId,
    guide,
    message,
    canConfirm,
    canConfirmNone,
    start,
    setTargets,
    resetForSwitch,
    pick,
    clearSelection,
    clearNewParent,
    cancel,
    confirm,
    confirmNone,
    confirmWith,
  };
}
