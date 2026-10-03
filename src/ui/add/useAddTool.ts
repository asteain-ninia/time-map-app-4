// U23 — the add-tool interaction hook (FR-76 / FR-77 / FR-78, 教訓 5.2 / 5.7 /
// 5.11 / 5.15 / 5.22).
//
// UI layer: holds the TRANSIENT add state (the {@link AddSession} + the flow
// phase) and drives the whole interaction — start → click vertices (with snap) →
// complete shape → property form → save / cancel. It delegates ALL domain
// decisions to the pure U23 domain core (session machine / shape validation /
// snap priority / proposal assembly) and ALL persistence to the injected U13
// adapter; it never mutates shared domain state (教訓 5.22 確定までの非破壊).
//
// 不変条件 (spec §目的):
//   - 教訓 5.2 全経路で破棄: the session is discarded through the SINGLE
//     `resetSession`契約 on every exit — cancel, save-commit, tool switch, mode
//     switch — via the host-provided `onResetExternally` plumbing AND this hook's
//     own resets. Re-start clears any残存 (start replaces the slot).
//   - 教訓 5.7 完了トリガー: the line/face COMPLETE trigger and the property-form
//     SAVE trigger are both wired to real logic here (`completeShape` / `save`).
//   - 教訓 5.15 / 5.16: the anchor start is the host-supplied current TimePoint
//     (complete value), never the system clock.
//   - 教訓 5.11: after a commit the host re-resolves selection from the new
//     feature id the proposal carries.

import { useCallback, useMemo, useRef, useState } from 'react';

import {
  ADD_TOOL_KIND,
  CONFIRM_STATUS,
  PARENT_UNSET,
  UNDO_RESULT,
  assembleAddProposal,
  canConfirm,
  confirmShape,
  isNestingInside,
  placeVertex,
  resetSession,
  resolveSnap,
  revalidateParent,
  setGridSnap,
  setParentSelection,
  startSession,
  undoVertex,
  updatePreview,
  type AddIdPorts,
  type AddProperties,
  type AddProposal,
  type AddSession,
  type AddToolKind,
  type ParentCandidate,
  type ParentSelection,
  type PreviewSnap,
  type ProximityCandidate,
  type ShapeDraft,
  type ShapeRejection,
} from '../../domain/add/index';
import type { WorldCoordinate } from '../../domain/coordinate';
import { isWorldLatitude } from '../../domain/geo/latitude';
import type { GridSpacingDeg } from '../../domain/basemap/grid';
import { PROCESS_STATUS, type ProcessResult } from '../../domain/consistency/index';
import type { FeatureId, VertexId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';

import { ADD_STRINGS, ADD_TEXT, shapeRejectionMessage, withReportHint } from './strings';

// --- The U13 adapter (the layer-crossing contract; 教訓 5.33) ----------------

/**
 * Start the consistency process for the add proposal and return its result
 * (U13「プロセス開始」). Generic over the opaque domain state `S`; the host binds
 * this to U13's `startProcess(current, proposal, ports)` via a thin closure. This
 * hook depends only on this signature (spec §依存, fixed by both-side tests).
 */
export type StartAddProcess<S> = (proposal: AddProposal) => ProcessResult<S>;

// --- Flow phase (型経由の分岐; 教訓 5.19) -----------------------------------

export const ADD_PHASE = {
  /** No add in progress (no tool active / session discarded). */
  Idle: 'idle',
  /** Collecting clicks: placing / previewing vertices. */
  Drawing: 'drawing',
  /** Shape confirmed; the property form is open awaiting save (FR-76). */
  PropertyForm: 'propertyForm',
  /** Save started U13 and it returned conflicts: confirmation paused (FR-62). */
  ConflictPaused: 'conflictPaused',
  /** U13 rejected the save; a Japanese message is shown (FR-115). */
  Rejected: 'rejected',
} as const;

export type AddPhase = (typeof ADD_PHASE)[keyof typeof ADD_PHASE];

// --- Hook options -----------------------------------------------------------

export interface UseAddToolOptions<S> {
  /** The current timeline time = the anchor start (教訓 5.15 / 5.16). */
  readonly currentTime: TimePoint;
  /** The project grid spacing (FR-13) for grid snap. */
  readonly gridSpacing: GridSpacingDeg;
  /** Injected ID minting (NFR 5.8 / 教訓 5.37). */
  readonly ids: AddIdPorts;
  /** Mint a fresh ring id (face only). */
  readonly nextRingId: () => import('../../domain/ids').RingId;
  /** The U13 process-start adapter. */
  readonly startProcess: StartAddProcess<S>;
  /**
   * Called when U13 commits: the host swaps the new domain state in and
   * re-resolves selection from `newFeatureId` (教訓 5.11). The hook does NOT touch
   * the store directly — it reports the result so the single store-write path
   * stays in the host.
   */
  readonly onCommitted: (
    result: ProcessResult<S>,
    newFeatureId: FeatureId,
    /**
     * 確定したものの素性（増分 3）。いまは **既存の頂点をいくつ共有したか**だけで、
     * 状態行の「直前の結果」に「既存の頂点 2 個を共有しました」と添えるために使う。
     * 任意なので、受け取らない呼び出し側は今までどおり動く。
     */
    committed?: { readonly sharedVertexCount: number },
  ) => void;
  /** Called when U13 returns conflicts: the host opens the conflict-resolution flow. */
  readonly onConflicts?: ((result: ProcessResult<S>, proposal: AddProposal) => void) | undefined;
  /**
   * Resolve the nearest existing-vertex proximity candidate for a raw click
   * (FR-31; U10/U24-backed). Returns null when none is within snap distance. The
   * hook never re-implements the distance test (spec §やらないこと).
   *
   * **吸着の ON/OFF・許容 px も供給元が持つ**（増分 3）。切ってあるときは供給元が null を
   * 返す。ここで二重に判定しない（教訓 5.29 単一真実源）。
   */
  readonly resolveProximity?: ((raw: WorldCoordinate) => AddProximityCandidate | null) | undefined;
  /**
   * FR-29: その座標が **どの末端地物の内側か**（内側でなければ null）。U10 の当たり判定が
   * 供給する。線・点には排他が無いので、フックが道具の種類で先に振り分ける（教訓 5.25）。
   *
   * **真偽ではなく相手を返す**のは、可否の判定に相手の同一性が要るからである（増分 3）。
   * 「他の末端の内側には置けない」を字面どおり全部塞ぐと、**親の面の中に子の面を描く**
   * という正しい使い方まで塞がる（子が付いた瞬間に親は末端でなくなるので、その重なりは
   * 排他違反ではない）。両者を見分けるには「打った頂点が全部**同じ**面の内側か」を見る
   * 必要があり、そのためには相手が誰かを知らなければならない。名前も同じ 1 回の解決から
   * 返すので、可否と文言が食い違いようがない（教訓 5.46）。
   *
   * 現状分析 C1 と設計書 §F.1 はこの口を `isInsideTerminal` と呼んでいる。真偽だけでは
   * 上の判定ができないので、**名前を `terminalAt` に変えて相手を返す形にした**。
   */
  readonly terminalAt?: ((coordinate: WorldCoordinate) => AddTerminalHit | null) | undefined;
}

/** FR-29 の当たり: どの末端地物の内側／境界の上か（`name` は引けなければ null ―― U-1）。 */
export interface AddTerminalHit {
  readonly featureId: FeatureId;
  readonly name: string | null;
  /**
   * 断り文に出す **その面の呼び方**（増分 3 の手直し B3）。上位領域と種別ラベルが引ければ
   * 「デーレ共和国の州『ガロアミド州』」の形になる。引けなければ「『◯◯』」だけ。
   * 名前がまったく引けなければ null。
   */
  readonly where?: string | null;
  /**
   * 内側ではなく **境界（線）の上**に載っているか（増分 3 の手直し B1）。
   * 境界の上は FR-29 では断らない（隣どうしが角を共有するのは正しい使い方）が、
   * 入れ子の見分けでは「その面の側」に数える。
   */
  readonly onBoundary?: boolean;
}

/**
 * 近接候補（FR-31）に **既存の頂点 id** を足したもの（増分 3）。
 *
 * ドメインの {@link ProximityCandidate} は「吸着後の座標」と「持ち主の地物」しか持たない。
 * ところが共有頂点の実体は **同じ `VertexId` を 2 つの地物が参照していること**なので、
 * 新しい地物に同じ id を持たせるには「どの頂点か」が要る。`resolveSnap` は余分な項を
 * 見ないので、ドメイン側（`domain/add/snap.ts`）には手を入れずに済む。
 */
export interface AddProximityCandidate extends ProximityCandidate {
  readonly vertexId: VertexId;
  /**
   * 吸着先の頂点の **保存されている座標**（＝その頂点の「体」）。
   *
   * `coordinate`（{@link ProximityCandidate} 側）は **押した位置と同じ周回**へ寄せた値で、
   * 下書きの連続経度の枠に合わせてある。地図を日付変更線の向こうへパンして描いていると、
   * この 2 つは 360 度ちょうど食い違う。
   *
   * **どちらも要る**:
   *  - 下書きには `coordinate`（周回を合わせた値）を入れる。入れないと隣の頂点との経度差が
   *    355 度などになり、**利用者から見れば小さな形なのに N-51 で「世界を半周以上します」と
   *    断られる**（しかも案内どおり途中に点を打っても直らない）。
   *  - 保存する体には `bodyCoordinate`（元の値）を使う。共有頂点は 2 つの地物が同じ id を
   *    指すことなので、**体が食い違ってはいけない**（読み込みの整合チェックが咎める）。
   *    読み込み側はリングごとに ±360 度ずらして連続へ戻すので、体が元の周回のままでも
   *    形は正しく復元される（技術方針 §6.1 / §6.8）。
   */
  readonly bodyCoordinate: WorldCoordinate;
}

// --- Hook state surface -----------------------------------------------------

export interface UseAddToolState {
  readonly phase: AddPhase;
  /** The in-progress session, or null when idle (教訓 5.18: null is the真値). */
  readonly session: AddSession | null;
  /** The confirmed shape draft awaiting save (phase PropertyForm), else null. */
  readonly draft: ShapeDraft | null;
  /** The Japanese rejection message (phase Rejected), else null. */
  readonly message: string | null;
  /** Whether the current session can confirm its shape (FR-76 完了可否). */
  readonly canComplete: boolean;
}

export interface UseAddToolActions {
  /** Start a fresh add session for `tool` (spec §セッション開始). */
  start(tool: AddToolKind): void;
  /**
   * Place a vertex at a raw click (snap is applied here; FR-78 / FR-31).
   * `suppressSnap` が真なら **既存の頂点への吸着を一時的に切る**（設計書 §I.2:
   * `Ctrl` を押している間。増分 3 の手直し C6）。グリッドへの吸着は切らない
   * ―― 切っているのは「他の地物に吸い寄せられること」だけである。
   */
  placeAt(raw: WorldCoordinate, suppressSnap?: boolean): void;
  /** Update the cursor-follow preview (high-frequency; FR-78). */
  preview(raw: WorldCoordinate, suppressSnap?: boolean): void;
  /**
   * 吸着の予告だけを消す（カーソルの位置はそのまま）。**吸着の設定を変えた瞬間**に呼ぶ:
   * 設定を切ったのに琥珀の輪が残り続けると「切ったのに効いている」と読める（そのときは
   * カーソルがポップオーバーの上にあるので、次の移動まで消えない）。教訓 5.5。
   */
  clearPreviewSnap(): void;
  /** Undo the last placed vertex; at 0 vertices this cancels the add (FR-78). */
  undo(): void;
  /** Cancel the whole add; discard ALL transient state (Escape; 教訓 5.2). */
  cancel(): void;
  /** Toggle grid snap on/off (FR-78). */
  toggleGridSnap(on: boolean): void;
  /** Set the face parent selection (FR-77). */
  chooseParent(parent: ParentSelection): void;
  /**
   * Re-validate the chosen parent against a fresh candidate set after a time
   * change (教訓 5.5); clears an ineligible parent back to unset.
   */
  revalidateParentSelection(candidates: readonly ParentCandidate[]): void;
  /** COMPLETE the shape (line/face complete trigger; 教訓 5.7) → property form. */
  completeShape(): void;
  /** SAVE the anchor (property-form save trigger; 教訓 5.7) → U13. */
  save(properties: AddProperties): void;
  /** Run the reset契約 on an external tool/mode switch (教訓 5.2 (d)/(e)). */
  resetForSwitch(): void;
}

export type UseAddTool = UseAddToolState & UseAddToolActions;

// --- The hook ---------------------------------------------------------------

export function useAddTool<S>(options: UseAddToolOptions<S>): UseAddTool {
  const {
    currentTime,
    gridSpacing,
    ids,
    nextRingId,
    startProcess,
    onCommitted,
    onConflicts,
    resolveProximity,
    terminalAt,
  } = options;

  const [session, setSession] = useState<AddSession | null>(null);
  const [phase, setPhase] = useState<AddPhase>(ADD_PHASE.Idle);
  const [draft, setDraft] = useState<ShapeDraft | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * いま出ている文が **カーソルを動かしても消してはいけない**ものか（増分 3）。
   *
   * 出る文には 2 種類ある。①**押した場所についての案内**（「ここは〈バアカ〉の内側です」
   * 「その頂点はもう使っています」）は、カーソルが動けば古くなるので消す ―― 残すと
   * 「次の一手」欄を占領し続け、吸着の予告が出なくなる。②**確定を断った理由**
   * （頂点が足りない・自己交差・世界を半周以上）は、次にどうするかを決めるための文なので
   * **無関係な操作で消さない**（K-7 / 教訓 5.12）。
   */
  const [messageSticky, setMessageSticky] = useState(false);

  // クリック 1 回ぶんの判断（吸着 → FR-29 の関門）を **状態更新関数の外**で済ませるための
  // 写し。断りの文を出すには「置けなかった」ことを状態更新の外へ伝える必要があるが、
  // 更新関数の中で `setMessage` を呼ぶのは副作用の置き場として正しくない（React 18 の
  // 厳格モードは更新関数を 2 回呼ぶ）。
  const sessionRef = useRef<AddSession | null>(null);
  sessionRef.current = session;

  // The SINGLE reset契約 every exit path funnels through (教訓 5.2). Discards the
  // session, the confirmed draft and any message together.
  const discard = useCallback(() => {
    setSession(resetSession()); // null
    setDraft(null);
    setMessage(null);
    setMessageSticky(false);
    setPhase(ADD_PHASE.Idle);
  }, []);

  const start = useCallback(
    (tool: AddToolKind) => {
      // Start replaces the slot — any残存 from a prior session is dropped
      // (教訓 5.2 (a)). Carry the current grid-snap preference forward.
      const prevGridSnap = session?.gridSnap ?? false;
      const fresh = startSession(tool, prevGridSnap);
      // **写しも同じ入力の中で更新する**（増分 3 の手直し D3）。保存のあとは待機に戻り、
      // 最初の地図クリックで作図を始めるので、1 回の pointerdown の中で `start` →
      // `placeAt` と続けて呼ぶ。React の state はこの入力が終わるまで反映されないので、
      // 写しを先に更新しておかないと最初の 1 点が黙って落ちる（教訓 5.7 の型の欠陥）。
      sessionRef.current = fresh;
      setDraft(null);
      setMessage(null);
      setMessageSticky(false);
      setSession(fresh);
      setPhase(ADD_PHASE.Drawing);
    },
    [session],
  );

  const placeAt = useCallback(
    (raw: WorldCoordinate, suppressSnap = false) => {
      const current = sessionRef.current;
      if (current === null) return;
      // Resolve the single snap priority: shared-vertex proximity > grid > raw
      // (spec §注意点). Proximity is delegated to U10/U24.
      // `Ctrl` を押している間は既存の頂点への吸着を切る（設計書 §I.2 / C6）。密な実データで
      // 「その 1 点だけは吸着させたくない」ときに、設定を開かずに済ませるための逃げ道である。
      const proximity =
        suppressSnap || !toolCanShare(current.tool)
          ? null
          : (resolveProximity?.(raw) ?? null);
      const resolved = resolveSnap({
        raw,
        gridSnap: current.gridSnap,
        gridSpacing,
        proximity,
      });
      // FR-29 terminal exclusion: a FACE vertex may not land inside a terminal
      // (line/point have no exclusion — 教訓 5.25). The host answers the
      // terminal-internal question; we gate by tool kind.
      //
      // **断ったら理由を出す（増分 3）**。現状は `return current` の無反応で、押しても
      // 何も起きず理由も出なかった（現状分析 C1 の最後の項）。可否は
      // `isInsideTerminal` 1 本が決め、名前はその結果を言葉にするためだけに引く。
      // 同じ頂点へ 2 回続けて吸着させない（増分 3 のレビューで見つけた粗）。実データの
      // 密度と 12px の許容では、隣を狙ったつもりで同じ頂点に付くことが起こりうる。
      // 通すと **長さ 0 の辺**を持つ環ができ、自己交差の判定は素通りする。
      const already =
        proximity !== null &&
        current.vertices.some((v) => v.sharedVertexId === proximity.vertexId);
      // **線の道具では、始点へ戻る閉じた線だけを妨げない**（増分 3 の手直し D6。
      // 2 回目の手直しで**始点だけ**に絞った）。同じ頂点を 2 回使うのを止めているのは
      // 「長さ 0 の辺を持つ環」を作らないためで、線が自分の**始点**へ戻って輪になるのは
      // それとは別の、正しい形である。途中の頂点への出戻りまで通すと、直前に打った点を
      // もう一度押しただけで長さ 0 の辺ができる。
      const reusesStart =
        proximity !== null &&
        current.tool === ADD_TOOL_KIND.Line &&
        current.vertices.length >= 2 &&
        current.vertices[0]?.sharedVertexId === proximity.vertexId;
      const blocksReuse = already && !reusesStart;
      if (blocksReuse) {
        setMessage(ADD_STRINGS.snapAlreadyUsed);
        setMessageSticky(false);
        return;
      }
      // **世界の外には置けない**（増分 3 の手直し A6。バグ狩り #3）。北極の上にも南極の
      // 下にも場所は無い。状態行が同じ場所で座標を「—」と出しているのに、クリックだけが
      // 通っていた（緯度 118 度の四角形が実際に作れた）。切り詰めずに断る ―― 切り詰めると
      // 押した場所と違う所に点が置かれる（黙って別の形になる）。
      if (!isWorldLatitude(resolved.coordinate.lat)) {
        setMessage(ADD_STRINGS.outsideWorldRefused);
        setMessageSticky(false);
        return;
      }
      const inside =
        current.tool === ADD_TOOL_KIND.Face ? (terminalAt?.(resolved.coordinate) ?? null) : null;
      // 境界（線）の上は断らない ―― 隣どうしが角を共有するのは正しい使い方である
      // （FR-29 が塞ぐのは「内側」だけ）。入れ子の見分けには「その面の側」として数える。
      const onBoundary = inside?.onBoundary === true;
      if (inside !== null && !onBoundary && !isNestingInside(current, inside.featureId)) {
        // `where`（上位領域と種別を添えた呼び方）が引ければそれを、無ければ名前だけを出す。
        const where =
          inside.where ?? (inside.name === null || inside.name === '' ? null : ADD_TEXT.quotedName(inside.name));
        setMessage(
          where === null || where === ''
            ? ADD_STRINGS.insideTerminalRefusedUnnamed
            : ADD_STRINGS.insideTerminalRefused(where),
        );
        setMessageSticky(false);
        return; // placement blocked; keep state unchanged.
      }
      setMessage(null);
      setSession((s) =>
        s === null
          ? s
          : placeVertex(
              s,
              resolved.coordinate,
              resolved.sharedCandidateId,
              proximity?.vertexId ?? null,
              onBoundary ? null : (inside?.featureId ?? null),
              proximity?.bodyCoordinate ?? null,
              onBoundary ? (inside?.featureId ?? null) : null,
            ),
      );
    },
    [gridSpacing, resolveProximity, terminalAt],
  );

  const preview = useCallback(
    (raw: WorldCoordinate, suppressSnap = false) => {
      // 予告（増分 3 / 設計書 §E.1 の V2）: **確定したらどこへ置かれるか**をカーソル移動の
      // たびに解く。共有相手が居るときだけ琥珀の輪が出る（`render/add-batch`）。
      // 供給元は R-tree 索引つきの当たり判定なので、1 移動あたりの費用は候補数に比例する。
      const previewTool = sessionRef.current?.tool;
      const proximity =
        suppressSnap || previewTool === undefined || !toolCanShare(previewTool)
          ? null
          : (resolveProximity?.(raw) ?? null);
      const previewSnap: PreviewSnap | null =
        proximity === null
          ? null
          : { coordinate: proximity.coordinate, sharedCandidateId: proximity.featureId };
      // **いま押したらどうなるかを先に言う**（増分 3 の手直し B3）。カーソルが面の内側に
      // 乗っている間は、それが「入れ子を作ることになる」のか「断られる」のかを次の一手へ
      // 出す ―― 押してから断られるより、押す前に分かるほうが手数が少ない。
      // 吸着の予告（琥珀の輪）より弱いので、吸着しているときは出さない。
      const current = sessionRef.current;
      const hovering =
        proximity === null && current !== null && current.tool === ADD_TOOL_KIND.Face
          ? (terminalAt?.(raw) ?? null)
          : null;
      const hoverNotice =
        hovering === null || hovering.onBoundary === true
          ? null
          : hoverName(hovering, isNestingInside(current!, hovering.featureId));
      // **押した場所についての案内**は、カーソルが動けば古いので捨てる（残すと
      // 「次の一手」欄を占領し続け、吸着の予告が出なくなる）。**確定を断った理由**は
      // 次の判断に使う文なので残す（K-7 / 教訓 5.12）。
      setMessage((currentMessage) => (messageSticky ? currentMessage : hoverNotice));
      setSession((s) => (s === null ? s : updatePreview(s, raw, previewSnap)));
    },
    [resolveProximity, terminalAt, messageSticky],
  );

  const clearPreviewSnap = useCallback(() => {
    setSession((current) => {
      if (current === null || current.previewSnap === null) return current;
      return { ...current, previewSnap: null };
    });
  }, []);

  const undo = useCallback(() => {
    if (session === null) return;
    const result = undoVertex(session);
    if (result.kind === UNDO_RESULT.Cancelled) {
      // Undo at 0 vertices backs out of the add entirely (spec §注意点): run the
      // single reset契約 (教訓 5.2).
      discard();
      return;
    }
    setSession(result.session);
    setMessage(null);
    setMessageSticky(false);
  }, [session, discard]);

  const cancel = useCallback(() => {
    discard();
  }, [discard]);

  const toggleGridSnap = useCallback((on: boolean) => {
    setSession((current) => (current === null ? current : setGridSnap(current, on)));
  }, []);

  const chooseParent = useCallback((parent: ParentSelection) => {
    setSession((current) => (current === null ? current : setParentSelection(current, parent)));
  }, []);

  const revalidateParentSelection = useCallback((candidates: readonly ParentCandidate[]) => {
    setSession((current) => {
      if (current === null) return current;
      const eligible = new Set<FeatureId>(candidates.map((c) => c.featureId));
      return revalidateParent(current, eligible);
    });
  }, []);

  // COMPLETE trigger (教訓 5.7): validate the shape; on success open the property
  // form, on failure surface the Japanese message and stay in Drawing.
  const completeShape = useCallback(() => {
    setSession((current) => {
      if (current === null) return current;
      const result = confirmShape(current);
      if (result.status === CONFIRM_STATUS.Rejected) {
        setMessage(rejectionToMessage(result.rejection));
        setMessageSticky(true); // 確定を断った理由は、カーソルを動かしても消さない。
        return current; // stay in Drawing; nothing recorded (教訓 5.22).
      }
      setDraft(result.draft);
      setMessage(null);
      setMessageSticky(false);
      setPhase(ADD_PHASE.PropertyForm);
      return current;
    });
  }, []);

  // SAVE trigger (教訓 5.7): assemble the indivisible proposal and run U13. Branch
  // on the discriminated result (受け入れ基準 2).
  const save = useCallback(
    (properties: AddProperties) => {
      const current = session;
      const confirmedDraft = draft;
      if (current === null || confirmedDraft === null) return;
      // **保存の直前に包含を確かめ直すことはしない**（GPT #3 への答え）。集約地物の実領域は
      // 子の和なので、**親自身の形の外に子が居てよい**（V8「新しい上位領域を作る」はその形で
      // ある）。含んでいることは上位領域である条件ではないので、ここで断ると正しい手順を
      // 塞ぐ。含む面が 1 つに決まるときに既定にする（`AddToolController`）だけにとどめた。
      const proposal = assembleAddProposal({
        draft: confirmedDraft,
        properties,
        parent: current.parent,
        currentTime,
        ids,
        nextRingId,
      });
      const result = startProcess(proposal);
      switch (result.status) {
        case PROCESS_STATUS.Committed:
          // 教訓 5.11: hand the result + new feature id to the host to swap state
          // and re-resolve selection. Then discard ALL transient state (教訓 5.2).
          onCommitted(result, proposal.featureId, {
            sharedVertexCount: proposal.snapshot.sharedCandidateIds.size,
          });
          discard();
          break;
        case PROCESS_STATUS.ConflictsPending:
          // FR-62: pause confirmation; the host opens the conflict flow. The
          // session/draft are kept (the edit is paused, not abandoned) until the
          // conflict flow commits or cancels (which calls back into cancel()).
          setMessage(null);
          setPhase(ADD_PHASE.ConflictPaused);
          onConflicts?.(result, proposal);
          break;
        case PROCESS_STATUS.Rejected:
          // FR-115 / 117: show the Japanese message; record nothing (教訓 5.22).
          setMessage(
            result.kind === 'internal-error' ? withReportHint(result.message) : result.message,
          );
          setMessageSticky(true);
          setPhase(ADD_PHASE.Rejected);
          break;
      }
    },
    [
      session,
      draft,
      currentTime,
      ids,
      nextRingId,
      startProcess,
      onCommitted,
      onConflicts,
      discard,
    ],
  );

  const resetForSwitch = useCallback(() => {
    discard();
  }, [discard]);

  const canComplete = useMemo(
    () => (session === null ? false : canConfirm(session)),
    [session],
  );

  return {
    phase,
    session,
    draft,
    message,
    canComplete,
    start,
    placeAt,
    preview,
    clearPreviewSnap,
    undo,
    cancel,
    toggleGridSnap,
    chooseParent,
    revalidateParentSelection,
    completeShape,
    save,
    resetForSwitch,
  };
}

// --- helpers ----------------------------------------------------------------

/**
 * その道具が **共有頂点を作ってよいか**（増分 3 の手直し 2 回目 / 司令塔の決定 3）。
 *
 * 点情報は共有に参加しない ―― FR-30 が共有を定めているのは「複数の面情報や線情報」で
 * あって点情報は入っていないし、都市（点情報）が国境の角と繋がって一緒に動くのは
 * 意味が通らない。**相手側の除外**（面・線が点情報の頂点に吸着しない）は供給元
 * `ui/add/snap-ports.ts` が持ち、**自分側の除外**（点の道具が面・線の頂点に吸着しない）が
 * これである。両側を塞がないと、向きを変えれば同じ連動が作れてしまう。
 */
function toolCanShare(tool: AddToolKind): boolean {
  return tool !== ADD_TOOL_KIND.Point;
}

function rejectionToMessage(rejection: ShapeRejection): string {
  return shapeRejectionMessage(rejection);
}

/**
 * カーソルが面の内側に乗っているときの予告（増分 3 の手直し B3）。入れ子になるなら
 * 「このまま全部内側に打つと〜の中の領域になります」、そうでなければ**押したら断られる**
 * ことを先に言う。文言は押したあとの断り文と同じ 1 か所から作る（食い違わせない）。
 */
function hoverName(hit: AddTerminalHit, nesting: boolean): string {
  const where = hit.where ?? (hit.name === null || hit.name === '' ? null : ADD_TEXT.quotedName(hit.name));
  if (nesting) {
    return hit.name === null || hit.name === ''
      ? ADD_STRINGS.insideTerminalNestingUnnamed
      : ADD_STRINGS.insideTerminalNesting(hit.name);
  }
  return where === null
    ? ADD_STRINGS.insideTerminalRefusedUnnamed
    : ADD_STRINGS.insideTerminalRefused(where);
}

// Re-export the default parent (unset) for convenience at call sites.
export { PARENT_UNSET };
