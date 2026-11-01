// UI layer (U20 / shell): the LIVE sidebar content wiring (HB-3 root fix).
//
// HB-3 ROOT CAUSE (合成ルートの結線漏れ, 教訓 5.7「ロジックがあっても UI から呼ば
// れず機能しない」): the sidebar sections — 一覧 / プロパティ — are pure "入れ物" in
// {@link Sidebar} that take their content through optional slots (listContent /
// propertiesContent). The composition root (App.tsx) mounted {@link AppShell}
// WITHOUT passing the `sidebar` prop, so every slot stayed empty and the U32
// {@link PropertyPanel} was never mounted at all. (The "PropertyPanel が画面下部に
// 無スタイルで並ぶ" symptom is the absence of any styled host — the panel had no
// sidebar cell to live in, so nothing styled it.) This module builds the slots over
// the LIVE session store and hands them to AppShell so they render INSIDE the sidebar
// with the existing .sidebar__panel chrome (技術方針 2.5: the panels subscribe to the
// store; no parallel truth lives here).
//
// HB6: the former 地物一覧 / 錨一覧 tabs are unified into ONE「一覧」slot whose
// 現在時刻(旧地物一覧) / 通史(旧錨一覧) mode toggle lives in {@link UnifiedListSection}.
//
// The lookups are LIVE over the committed DomainProject at the current time
// (single truth source, 教訓 5.29): featureLookup / anchorLookup resolve against
// the same domain root the renderer draws, so the property panel can never show a
// feature the map does not. Selecting a row in the 地物一覧 promotes it through the
// SAME store.setActiveFeature path every selection uses (no second selection
// source); the property panel then re-resolves to it automatically.

import { useCallback, useMemo } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { AnchorSeries } from '../../domain/anchor-series';
import {
  FEATURE_KIND,
  featureDisplayName,
  isDrawableLineVertexCount,
  type Feature,
} from '../../domain/feature';
import { createGeoParams, type GeoParams } from '../../domain/geo/geo-params';
import { lineLengthKm, multiPolygonAreaKm2 } from '../../domain/geo/geodesy';
import { isMultiPolygonEmpty } from '../../domain/geometry/types';
import { buildForest } from '../../domain/hierarchy/forest';
import { resolveFeatureArea } from '../../domain/hierarchy/resolve-shape';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import {
  ownerLookupFromMap,
  type VertexOwnerLookup,
} from '../../domain/selection';
import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';
import type { WorldCoordinate } from '../../domain/coordinate';
import { getVertex } from '../../domain/vertex';

import { featuresAt, verticesAt } from '../live-lookup';
import { AddDraftForm } from '../add/AddPropertyForm';
import type { AddDraftStore } from '../add/add-draft-store';
import { FeatureLedger, type LedgerQuickEdit } from '../discovery/FeatureLedger';
import { doneIdsOf, stepIndex } from '../discovery/bundle';
import type { LedgerCommandStore } from '../discovery/ledger-commands';
import type { LedgerFilterFocusStore } from '../discovery/ledger-focus';
import { resolveDisplayFor } from '../map/display-resolution-cache';
import type { SessionStore } from '../state/store';
import {
  PropertyPanel,
  PROPERTY_STRINGS,
  buildEditIntent,
  decideEditPlan,
  isNoOpEdit,
  valuesFromFeature,
  NameFieldFocusStore,
  type AnchorStartEditStore,
  PropertyDraftStatusStore,
  type AnchorSeriesLookup,
  type AssetResolver,
  type EditDispatch,
  type AnchorIntervalEditDispatch,
  type FeatureLookup,
  type GoverningAnchorSeries,
  type DeleteImpactView,
} from '../property/index';

import { resolveGoverningSeries } from '../time/governing-series';

import type { OptionBarAction } from './option-bar';
import { SIDEBAR_CONTENT_STRINGS } from './strings';
import type { SidebarProps } from './Sidebar';
import type { SidebarFocusStore } from './sidebar-focus';

/**
 * Build the LIVE FeatureLookup over the domain root. Resolves a feature by id at
 * the CURRENT time so the property panel matches what is effective on the map
 * (教訓 5.29). Read fresh per call (never a stale capture, 教訓 5.6).
 */
function featureLookupOf(
  getRoot: () => DomainProject,
  getTime: () => TimePoint,
): FeatureLookup {
  return {
    featureAt(featureId: FeatureId): Feature | null {
      return featuresAt(getRoot(), getTime()).find((f) => f.id === featureId) ?? null;
    },
  };
}

/**
 * Build the LIVE AnchorSeriesLookup. A feature's full history-anchor series lives
 * on its {@link FeatureHistory} in the project root (U09); we return it whole so
 * the property panel DISPLAYS the series without re-deriving it (spec §やらないこと).
 */
function anchorLookupOf(getRoot: () => DomainProject, calendar: Calendar): AnchorSeriesLookup {
  return {
    anchorSeriesOf(featureId: FeatureId): AnchorSeries | null {
      const history = getRoot().histories.find((h) => h.featureId === featureId);
      return history?.series ?? null;
    },
    /**
     * **編集が実際に書き込まれる系列**（設計書 §C.6「集約地物の下位領域の錨」/ 裁定 §N-15）。
     *
     * 実データの 775 地物のうち **86 件（3 つの集約地物の下位領域ぜんぶ）は自分の履歴を持たない**。
     * `anchorSeriesOf` は `histories.find(h => h.featureId === id)` なので、この 86 件は
     * 必ず null を返し、素性欄から錨の欄が丸ごと消えていた。ドメイン側の属性編集
     * （`applyEditProposal`）は `findHistoryContaining` で **その時刻に自分を含む履歴**
     * ＝親の系列へ書くので、画面もそこを見なければ「上書きなのか新設なのか」を正しく
     * 言えない（教訓 5.46: 結果を実際に決めている経路を確かめる）。判定は**ドメインと
     * 同じ関数**を呼ぶ（単一の真実源, 教訓 5.30）。
     *
     * **解き方そのものは `ui/time/governing-series.ts` に出した**（増分 6）。同じ問いを
     * 時刻レールの錨レーンも持つので、写しを 2 枚にすると、集約地物の下位領域の扱いが
     * 錨表とレーンで割れる（教訓 5.44）。
     */
    governingSeriesOf(featureId: FeatureId, at: TimePoint): GoverningAnchorSeries | null {
      return resolveGoverningSeries(
        getRoot(),
        featureId,
        at,
        calendar,
        SIDEBAR_CONTENT_STRINGS.unknownOwnerName,
      );
    },
  };
}

export interface SidebarContentDeps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  readonly calendar: Calendar;
  /**
   * The edit-command dispatch (U16 → command base). The composition root wires
   * the real bridge; the property panel only assembles + hands off the intent
   * (教訓 5.33 契約越し). When omitted a guarded no-op is used so the panel never
   * crashes pre-binding (the same honest-stub discipline App.tsx uses for the
   * U13 seam — the WIRING is real and observable).
   */
  readonly editDispatch?: EditDispatch;
  /**
   * HB3-12: the存続期間編集 dispatch (U09 changeStart / setEnd / deleteAnchor). The
   * composition root wires the real whole-state-swap command bridge; when omitted the
   * panel hides the存続期間 editor (honest-stub discipline — no dead control). DISTINCT
   * from {@link editDispatch}, which only rewrites the snapshot, never the interval.
   */
  readonly anchorIntervalDispatch?: AnchorIntervalEditDispatch;
  /** FR-98 / FR-02: ZIP-internal asset resolution for the 詳細文書 preview. */
  readonly assetResolver?: AssetResolver;
  readonly onOpenDetail?: (featureId: FeatureId) => void;
  /** FR-85: delete the given feature (the property-panel「地物を削除」button's confirm). */
  readonly onDeleteFeature?: (featureId: FeatureId) => void;
  /**
   * 「この年に錨を作る」（Ctrl+K, 増分 2 の中身 3）の素性欄側の入口。
   * 合成ルートが同じコマンド 1 本へ繋ぐ（教訓 5.30）。
   */
  readonly onCreateAnchorHere?: (featureId: FeatureId) => void;
  /**
   * 増分 7（設計書 §A.3 / §C.6 / G-3）。素性欄から所属変更へ入る 3 つの口、
   * 「この年に終わったことにする」（削除の入口 A）、その断りの理由、
   * そして「全部の年から消す」の前に見せる影響の一覧。合成ルートが繋ぐ。
   */
  readonly onParentPick?: (featureId: FeatureId) => void;
  readonly onParentCreate?: (featureId: FeatureId) => void;
  readonly onParentClear?: (featureId: FeatureId) => void;
  readonly onEndHere?: (featureId: FeatureId) => void;
  readonly endHereDisabledReason?: (featureId: FeatureId) => string | null;
  readonly resolveDeleteImpact?: (featureId: FeatureId) => DeleteImpactView;
  /**
   * 素性欄の「打ちかけを捨てますか」の確認（N-04）が開閉したことを合成ルートへ伝える。
   * 合成ルートはこれを `shortcutsSuspended` に OR して、確認が出ているあいだ
   * Ctrl+K・Delete などの大域ショートカットを止める（増分 2 の手直し A4 (c)）。
   */
  readonly onDraftConfirmChange?: (open: boolean) => void;
  /** 素性欄の中の板が出ていると名乗る口（司令塔の決定 (13)）。 */
  readonly onPropertyModalChange?: (open: boolean) => void;
  /** 時刻レールの右クリック「この錨の開始年を変える」の要求の口（項目 6）。 */
  readonly anchorStartEdit?: AnchorStartEditStore;
  /**
   * Focus the camera on the feature just selected from a一覧 row (錨一覧 HB5-3 AND
   * 地物一覧 A1 — both導線 share the SAME fit path, the user's「地物一覧にも視点移動が
   * 欲しい」). Called AFTER the row promotes the feature (地物一覧) / promotes + syncs
   * the time (錨一覧), so the host resolves the feature's shape at the effective time
   * and frames the view through the single camera write path (ports.writeCamera).
   * Omitted (tests / pre-mount) → the row still selects (+ syncs time for錨), only the
   * camera does not move (honest absence, no crash). A map-click selection routes
   * through the live-selection-port, never here, so a map click never fits the view.
   */
  readonly onFocusFeatureCamera?: (featureId: FeatureId) => void;
  /**
   * 追加の道具が「形を確定したので素性を入れてほしい」と言ってくる口（増分 3 /
   * N-15 / 設計書 §C.2 の 27）。入力待ちのあいだ、素性欄の位置には**新規の姿**が出る。
   *
   * これが無い（テストなど）ときは従来どおり素性欄だけを出す。
   */
  readonly addDraft?: AddDraftStore;
  /**
   * 右パネルの「どの区画に注目させるか」の口（増分 4 / 結合点 #3）。そのまま
   * {@link SidebarProps} へ渡す（この module は寄せる要求を出さない ―― 出すのは
   * 右クリックと追加の確定で、どちらも合成ルートが持っている）。
   */
  readonly focusStore?: SidebarFocusStore;
  /**
   * 拒否理由の共通枠（オプションバーの「次の一手」＋状態行）へ出す口（G-20 / G-23）。
   * 一覧のその場編集がドメインに断られたとき、**理由を画面に出す**ためだけに使う。
   */
  readonly onRefusal?: (
    message: string | null,
    actions?: readonly OptionBarAction[],
  ) => void;
  /**
   * **通ったことを状態行へ出す口**（2026-09-06、2 回目の手直し）。断りは状態行に残る
   * 規約（K-7）なので、やり直して通ったときは通った事実で上書きしないと、直っていない
   * ように読める。
   */
  readonly onResult?: (message: string) => void;
  /**
   * 一覧の絞り込み欄へ焦点を入れる口（Ctrl+F ＝「地物を検索」の行き先。E-6）。
   * 合成ルートがコマンドから呼ぶ。
   */
  readonly filterFocus?: LedgerFilterFocusStore;
  /**
   * 一覧への指図（Alt+↑ / Alt+↓ / F2）の口（増分 4 の手直し B8）。
   * 合成ルートが `CommandRegistry` に繋ぐ。
   */
  readonly ledgerCommands?: LedgerCommandStore;
  /**
   * 一覧の行の右クリック（設計書 §I.3 の「台帳の行」。増分 5 からの送り）。
   * 合成ルートが地図と同じ右クリックの器へ流す。
   */
  readonly onRowContextMenu?: (
    featureId: FeatureId,
    clientX: number,
    clientY: number,
  ) => void;
}

/**
 * Assemble the three sidebar slots over the live store. Returns a {@link
 * SidebarProps} the composition root spreads into {@link AppShell}'s `sidebar`
 * prop, so the panels render INSIDE the styled sidebar cell (HB-3 fix).
 */
export function buildSidebarContent<S>(deps: SidebarContentDeps<S>): SidebarProps {
  const {
    store,
    getRoot,
    getTime,
    calendar,
    editDispatch,
    anchorIntervalDispatch,
    assetResolver,
    onOpenDetail,
    onDeleteFeature,
    onCreateAnchorHere,
    onParentPick,
    onParentCreate,
    onParentClear,
    onEndHere,
    endHereDisabledReason,
    resolveDeleteImpact,
    onDraftConfirmChange,
    onPropertyModalChange,
    anchorStartEdit,
    onFocusFeatureCamera,
    addDraft,
    focusStore,
    onRefusal,
    onResult,
    filterFocus,
    ledgerCommands,
    onRowContextMenu,
  } = deps;

  // 素性欄の名前欄へ焦点を入れる口（束の第 1 手。設計書 §C.5）。器が 1 本だけ持ち、
  // 一覧が要求し、素性欄が受け取る。**DOM を名前で探さない**（結合点 #3 の反省）。
  const nameFieldFocus = new NameFieldFocusStore();
  // 「素性欄がいま打ちかけを抱えている地物」を一覧へ知らせる口（手直し B11 / N-04）。
  const draftStatus = new PropertyDraftStatusStore();

  const dispatch: EditDispatch = editDispatch ?? {
    // 教訓 5.7: the SAVE trigger is fully wired + observable; the live edit-apply
    // (snapshot → anchor → history insert) is an unassigned new-domain op (NOT
    // U42; same seam class as the U13 apply in App.tsx). Until that binding lands
    // a confirm THROWS an honest error (PropertyPanel.handleSave catches it and
    // surfaces 保存に失敗) rather than reporting a SILENT success — the user must
    // never be told an edit landed when it did not (HB-3 Codex P1).
    dispatchEdit() {
      throw new Error(PROPERTY_STRINGS.editNotWired);
    },
  };

  const featureLookup = featureLookupOf(getRoot, getTime);
  const anchorLookup = anchorLookupOf(getRoot, calendar);

  // 素性欄（選んでいる地物の姿）。**組み立てるのは 1 回だけ**にする ―― 2 か所へ書き写すと、
  // あとで受け渡すものを増やしたときに片方だけ直し忘れる（教訓 5.44 の型）。
  /**
   * 一覧のその場編集（名前・種別）。**素性欄の保存とまったく同じ 1 本**を通す
   * （教訓 5.29 / 5.30: 保存の行き先を決める規則を 2 つ持たない）。行き先は
   * `decideEditPlan`、書き込みは `editDispatch`、値の組み立ては `buildEditIntent` で、
   * どれも素性欄が使っているものである。断られたら**理由を文字で返す**（G-23）。
   */
  const quickEdit: LedgerQuickEdit = (featureId, patch) => {
    // **素性欄の打ちかけを黙って上書きしない**（増分 4 の手直し B11 / N-04 の趣旨）。
    // 一覧のその場編集は素性欄とまったく同じ保存の 1 本を通るので、同じ地物を
    // 素性欄が打ちかけていると、その打ちかけが跡形もなく消える（対象が変わって
    // いないので素性欄の確認も出ない）。**確認の板は打ちかけを持っている素性欄の
    // ものなので、ここでは書き込まずに理由を返す**（下段で保存するかやめるかを
    // 決めてもらう）。
    if (draftStatus.get() === featureId) {
      return PROPERTY_STRINGS.quickEditDraftPending;
    }
    const root = getRoot();
    const time = getTime();
    const feature = featuresAt(root, time).find((f) => f.id === featureId);
    if (feature === undefined) return SIDEBAR_CONTENT_STRINGS.quickEditNoTarget;
    const governing = anchorLookup.governingSeriesOf?.(featureId, time) ?? null;
    const plan = decideEditPlan({
      currentTime: time,
      series: governing?.series ?? null,
      featurePresent: true,
      calendar,
      snapshotSize: governing?.effectiveSize ?? null,
    });
    if (plan.editTime === null) {
      return plan.reason ?? SIDEBAR_CONTENT_STRINGS.quickEditNotSavable;
    }
    const values = { ...valuesFromFeature(feature), ...patch };
    // 教訓 5.24: 値が同じなら dispatch しない（幽霊の取り消しを作らない）。
    if (isNoOpEdit(feature, values)) return null;
    try {
      dispatch.dispatchEdit(buildEditIntent(feature, plan.editTime, values));
      return null;
    } catch (err) {
      return `${PROPERTY_STRINGS.saveFailedPrefix}${String(err)}`;
    }
  };

  const propertyPanel = (
    <PropertyPanelHost<S>
      store={store}
      getRoot={getRoot}
      getTime={getTime}
      featureLookup={featureLookup}
      anchorLookup={anchorLookup}
      editDispatch={dispatch}
      calendar={calendar}
      {...(anchorIntervalDispatch ? { anchorIntervalDispatch } : {})}
      {...(assetResolver ? { assetResolver } : {})}
      {...(onOpenDetail ? { onOpenDetail } : {})}
      {...(onDeleteFeature ? { onDeleteFeature } : {})}
      {...(onCreateAnchorHere ? { onCreateAnchorHere } : {})}
      {...(onParentPick ? { onParentPick } : {})}
      {...(onParentCreate ? { onParentCreate } : {})}
      {...(onParentClear ? { onParentClear } : {})}
      {...(onEndHere ? { onEndHere } : {})}
      {...(endHereDisabledReason ? { endHereDisabledReason } : {})}
      {...(resolveDeleteImpact ? { resolveDeleteImpact } : {})}
      {...(onDraftConfirmChange ? { onDraftConfirmChange } : {})}
      {...(onPropertyModalChange ? { onPropertyModalChange } : {})}
      {...(anchorStartEdit ? { anchorStartEdit } : {})}
      nameFieldFocus={nameFieldFocus}
      draftStatus={draftStatus}
      onAdvanceBundle={() => {
        advanceBundleCursor({
          store,
          getRoot,
          getTime,
          nameFieldFocus,
          ...(onFocusFeatureCamera ? { onFocusFeatureCamera } : {}),
        });
      }}
    />
  );

  return {
    // 増分 4: 上段は **地物一覧（台帳）**。階層ツリー＋仮想スクロールで、行が
    // [色][展開][名前][種別][錨の本数][👁] を運ぶ（設計書 §C.5 / C4 / FR-111）。
    //
    // **表示制御パネルはここから外した**（C7）。可変長の一覧の**後ろ**に固定パネルを
    // 置いていたので `offsetTop` が 28,546px（63 画面ぶん下）になっていた。いまは
    // オプションバーの「表示 ▾」ポップオーバーに載っている（`DisplayOptions`）。
    listContent: (
      <FeatureLedger<S>
        store={store}
        getRoot={getRoot}
        getTime={getTime}
        {...(onFocusFeatureCamera ? { onFocusFeatureCamera } : {})}
        {...(quickEdit !== undefined ? { onQuickEdit: quickEdit } : {})}
        {...(onRefusal ? { onRefusal } : {})}
        {...(onResult ? { onResult } : {})}
        {...(filterFocus ? { filterFocus } : {})}
        {...(ledgerCommands ? { commands: ledgerCommands } : {})}
        {...(onRowContextMenu ? { onRowContextMenu } : {})}
        onFocusNameField={() => {
          nameFieldFocus.focus();
        }}
      />
    ),
    // 素性欄の位置は 2 つの姿を持つ（設計書 §C.2 の 27）。
    //  - ふだん … 選んでいる地物の素性欄
    //  - 追加を確定した直後 … **新規の姿**（名前・種別ラベル・親・年代）
    // 地図の真ん中に浮くフォームをやめたので、**いま描いた形を覆わない**（N-15）。
    propertiesContent:
      addDraft === undefined ? (
        propertyPanel
      ) : (
        <AddDraftForm store={addDraft}>{propertyPanel}</AddDraftForm>
      ),
    ...(focusStore !== undefined ? { focusStore } : {}),
  };
}

/**
 * 素性欄の Enter（＝保存して次へ）で作業のまとまりを 1 つ進める（設計書 §C.5 / §I.2）。
 *
 * **一覧の［次へ ▶］とまったく同じ規則を通す**（`stepIndex`）。ここで別の進み方を
 * 書くと、同じ「次へ」が 2 通りになって食い違う（教訓 5.29）。「済」の判定に要る
 * 「いまの名前・種別」は、いまのドメインから引き直す（教訓 5.6）。
 */
function advanceBundleCursor<S>(deps: {
  readonly store: StoreApi<SessionStore<S>>;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  readonly nameFieldFocus: NameFieldFocusStore;
  readonly onFocusFeatureCamera?: (featureId: FeatureId) => void;
}): void {
  const { store, getRoot, getTime, nameFieldFocus, onFocusFeatureCamera } = deps;
  const state = store.getState();
  const bundle = state.ledger.bundle;
  if (bundle === null) return;
  // **表を 1 回だけ作る**（手直し G8）。`find` を全メンバーぶん回すと 5,000 件の束で
  // 2,500 万回の比較になり、Enter を 1 回押すたびに右パネルが詰まる。
  const currentById = new Map<FeatureId, { name: string; kindLabel: string }>();
  for (const f of featuresAt(getRoot(), getTime())) {
    currentById.set(f.id, { name: featureDisplayName(f), kindLabel: f.kindLabel ?? '' });
  }
  const done = doneIdsOf(bundle, (featureId) => currentById.get(featureId));
  // **いまの年に居ないメンバーは飛ばす**（手直し G2）。飛ばさないと「保存して次へ」で
  // 素性欄が空・カメラも動かない幽霊が選ばれる。
  const at = stepIndex(bundle, done, 1, (featureId) => currentById.has(featureId));
  if (at === null) return;
  const member = bundle.members[at];
  if (member === undefined) return;
  state.setBundleCursor(at);
  state.setActiveFeature(member.featureId);
  onFocusFeatureCamera?.(member.featureId);
  nameFieldFocus.focus();
}

/**
 * Subscribing host for the U32 {@link PropertyPanel}. It reads the LIVE FR-109
 * geodesic settings (赤道長・扁平率) and the committed domain / current time from the
 * store, derives the {@link GeoParams}, and hands the panel a `resolveAreaKm2(id)`
 * port so a 面 feature's 面積（km²）row (FR-20 / FR-35) re-derives whenever those
 * change (教訓 5.3, no stale cache). This keeps the panel a pure prop-consumer
 * (port-clean, unit-testable) while the host owns reactivity — mirroring how
 * FeaturesSection / EventsSection subscribe and pass down.
 *
 * THE AREA IS LIVE (bughunt review 穴1): the resolver reads the domain + time FRESH
 * per call, and its closure is `useCallback`-memoized on the exact area INPUTS
 * (settings + domain + currentTime, bughunt #6). The host re-renders on every
 * committed-domain change (a vertex add/delete swaps the `domain` reference), which
 * yields a NEW resolver reference, so the panel's memo — keyed to that reference —
 * re-derives the area against the CURRENT shape rather than a feature object frozen at
 * selection time. When those inputs hold, the reference is stable, so a re-render from
 * another source reuses the memoized area instead of re-resolving every frame.
 *
 * BOTH 末端 AND 集約 (bughunt review 穴2 / FR-35): the area is `resolveFeatureArea`
 * (U08's single derived-shape resolution — a leaf's own shape OR an aggregate's child
 * union, the SAME source the map draws), converted to km² by the geodesy area kernel.
 * Point / line features and unresolvable / childless shapes yield `undefined` (no row).
 *
 * WHY the LIVE UI settings (not domain.settings.geo): the project's geodesic
 * parameters live in the UI store's `projectSettings` (equatorLengthKm / flattening,
 * FR-109); the domain-side `settings.geo` is only synced at save. Reading the store
 * slices here subscribes the host so an equator/flattening edit reflects immediately
 * (単一真実源: the same values the survey readout derives from).
 */
function PropertyPanelHost<S>(props: {
  readonly store: StoreApi<SessionStore<S>>;
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  readonly featureLookup: FeatureLookup;
  readonly anchorLookup: AnchorSeriesLookup;
  readonly editDispatch: EditDispatch;
  readonly calendar: Calendar;
  readonly anchorIntervalDispatch?: AnchorIntervalEditDispatch;
  readonly assetResolver?: AssetResolver;
  readonly onOpenDetail?: (featureId: FeatureId) => void;
  readonly onDeleteFeature?: (featureId: FeatureId) => void;
  readonly onCreateAnchorHere?: (featureId: FeatureId) => void;
  /**
   * 増分 7（設計書 §A.3 / §C.6 / G-3）。素性欄から所属変更へ入る 3 つの口、
   * 「この年に終わったことにする」（削除の入口 A）、その断りの理由、
   * そして「全部の年から消す」の前に見せる影響の一覧。合成ルートが繋ぐ。
   */
  readonly onParentPick?: (featureId: FeatureId) => void;
  readonly onParentCreate?: (featureId: FeatureId) => void;
  readonly onParentClear?: (featureId: FeatureId) => void;
  readonly onEndHere?: (featureId: FeatureId) => void;
  readonly endHereDisabledReason?: (featureId: FeatureId) => string | null;
  readonly resolveDeleteImpact?: (featureId: FeatureId) => DeleteImpactView;
  readonly onDraftConfirmChange?: (open: boolean) => void;
  /** 素性欄の中の板が出ていると名乗る口（司令塔の決定 (13)）。 */
  readonly onPropertyModalChange?: (open: boolean) => void;
  readonly anchorStartEdit?: AnchorStartEditStore;
  readonly nameFieldFocus?: NameFieldFocusStore;
  readonly draftStatus?: PropertyDraftStatusStore;
  readonly onAdvanceBundle?: () => void;
}): JSX.Element {
  const { store, getRoot, getTime } = props;
  // Subscribe to the pieces that must re-derive the shown area: the FR-109 geodesic
  // settings and the committed domain (a shape edit swaps the domain reference).
  const equatorLengthKm = useStore(store, (s) => s.projectSettings.equatorLengthKm);
  const flattening = useStore(store, (s) => s.projectSettings.flattening);
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  // The display-control slice — an owner-lookup input (below): a depth/focus change
  // swaps this reference wholesale (identity == value, bughunt3), re-deriving the lookup.
  const displayControl = useStore(store, (s) => s.displayControl);

  // FR-81 / 現状.md §5「owner lookup の結線」(S4b root fix): the panel's `ownerLookup`
  // resolves each selected vertex to its OWNING feature so a vertex-only selection
  // (no active feature) shows that feature's properties (ContextFeature). Before this
  // wiring the host passed NO lookup, so the panel fell back to the EMPTY lookup and
  // EVERY vertex-only selection classified as Unknown —「選択頂点の所有地物を特定でき
  // ません」on real hardware — regardless of display state (honest-stub left un-wired,
  // 教訓 5.7).
  //
  // SINGLE TRUTH SOURCE (教訓 5.29): owners come from resolveDisplayFor's `owners` map
  // — the EXACT vertex→feature map the click hit-test grabs from and the renderer
  // draws (display-resolution-cache). What the user could CLICK to select is precisely
  // what the panel can resolve back to a feature; the two can never drift. The bundle
  // is memoized by (root, time, displayControl) IDENTITY and those are the live
  // store's own references, so this is a cache HIT off the frame the renderer already
  // resolved — no second pipeline run.
  //
  // MEMOIZED ON ITS EXACT INPUTS (the same discipline as resolveAreaKm2 below): the
  // committed `domain`, the effective `currentTime`, and the `displayControl` slice.
  // When none moved, the lookup reference is stable so the panel's decision memo does
  // not re-run; when any moves (edit / time scrub / depth change) the lookup re-derives
  // against the live resolution (教訓 5.3, no stale capture: the body reads the root /
  // time FRESH through getRoot / getTime — `domain` / `currentTime` gate the closure).
  const ownerLookup = useMemo<VertexOwnerLookup>(
    () => ownerLookupFromMap(resolveDisplayFor(getRoot(), getTime(), displayControl).owners),
    [getRoot, getTime, domain, currentTime, displayControl],
  );

  // FR-20 / FR-35: the target feature's 面積（km²）, resolved LIVE from the domain +
  // time effective now.
  //
  // MEMOIZED ON ITS INPUTS (bughunt #6 perf): the resolver is a `useCallback` keyed to
  // the FR-109 settings + the committed `domain` + the effective `currentTime` — the
  // exact inputs that can change the derived area. The panel's area memo is keyed to
  // this resolver's reference, so a re-render that leaves those inputs unchanged reuses
  // the memoized area instead of re-running the O(histories × anchors) featuresAt scan +
  // boolean-union resolve every frame during a time scrub / playback. Because `domain`
  // and `currentTime` ARE deps, a structural edit (domain swap) or a time move yields a
  // NEW closure ⇒ the memo re-derives against the CURRENT shape — the穴1 liveness the
  // previous "new closure every render" gave, now WITHOUT the per-frame recompute for
  // inputs that did not move. The resolver still reads the root/time FRESH through
  // getRoot/getTime (never a stale capture, 教訓 5.6); the deps only gate the closure.
  //
  // The area is the SINGLE derived-shape resolution `resolveFeatureArea` (a 末端's own
  // shape OR an 集約's child union — the same source the map draws, 教訓 5.29 / FR-35
  // 穴2), turned into km² by the geodesy area kernel. A point / line, an unresolvable /
  // childless shape, or an unknown id yields `undefined` ⇒ the panel shows no 面積 row.
  const resolveAreaKm2 = useCallback((featureId: FeatureId): number | undefined => {
    const geoParams: GeoParams = createGeoParams(equatorLengthKm, flattening);
    const time = getTime();
    const root = getRoot();
    // ONE featuresAt scan per resolve (bughunt #6): the effective feature set is read
    // once and reused both to identify the target's kind and to build the AREA forest —
    // the previous two calls doubled the O(histories × anchors) scan every frame.
    const effective = featuresAt(root, time);
    const feature = effective.find((f) => f.id === featureId);
    if (
      feature === undefined ||
      (feature.kind !== FEATURE_KIND.Leaf && feature.kind !== FEATURE_KIND.Aggregate)
    ) {
      // Point / line (no area) or an id not effective now → no row.
      return undefined;
    }
    // Build the forest over the AREA features so an aggregate's child union resolves
    // through the SAME U08 path the renderer uses (single truth source, 教訓 5.29).
    const areaFeatures = effective.filter(
      (f) => f.kind === FEATURE_KIND.Leaf || f.kind === FEATURE_KIND.Aggregate,
    );
    const forest = buildForest(areaFeatures);
    const resolution = resolveFeatureArea(forest, verticesAt(root, time), featureId);
    if (resolution.status === 'failed' || isMultiPolygonEmpty(resolution.area)) {
      // No area to show: either unresolvable (missing vertex / child / rejected union)
      // OR resolved to an EMPTY multipolygon — a CHILDLESS aggregate (or one whose only
      // children are point / line, filtered out above) resolves to status 'ok' + empty
      // (resolveFeatureArea → ok(EMPTY_MULTI_POLYGON)). Both must yield `undefined` so the
      // panel shows NO 面積 row rather than a fabricated '0.00 km²' — restoring parity with
      // the map (which draws nothing for such a feature) and honouring the honest-stub
      // contract (bughunt review 集約穴 / 教訓 5.7 / 5.26: no fabricated value).
      return undefined;
    }
    return multiPolygonAreaKm2(resolution.area, geoParams);
    // Deps = the exact area INPUTS (bughunt #6): the FR-109 geodesic settings + the
    // committed `domain` + the effective `currentTime`. When any moves, the closure —
    // and thus the panel's area-memo key — changes, so the area re-derives against the
    // live shape (穴1 liveness). When they hold, the reference is stable, so a re-render
    // from another source reuses the memoized area (no per-frame re-resolve). `domain` /
    // `currentTime` gate the closure only; the body still reads them FRESH through
    // getRoot / getTime (never a stale capture, 教訓 5.6). getRoot / getTime are stable
    // (built once in the composition root), listed for completeness.
  }, [getRoot, getTime, equatorLengthKm, flattening, domain, currentTime]);

  /**
   * FR-19 must（G-1 / 現状.md R1）: **線情報の長さ（km）**。面積とまったく同じ形の口で、
   * 測地の 1 本（`lineLengthKm`）から出す ―― ここで距離の式を書き直さない（教訓 5.29）。
   * 面・点・解けない線は `undefined` を返し、素性欄は行そのものを出さない。
   *
   * 依存は面積とまったく同じ（FR-109 の設定 ＋ 確定ドメイン ＋ 現在時刻）。
   */
  const resolveLengthKm = useCallback(
    (featureId: FeatureId): number | undefined => {
      const geoParams: GeoParams = createGeoParams(equatorLengthKm, flattening);
      const time = getTime();
      const root = getRoot();
      const feature = featuresAt(root, time).find((f) => f.id === featureId);
      if (feature === undefined || feature.kind !== FEATURE_KIND.Line) return undefined;
      const store = verticesAt(root, time);
      const points: WorldCoordinate[] = [];
      for (const id of feature.vertexIds) {
        const v = getVertex(store, id);
        if (v === undefined) return undefined;
        points.push(v.coordinate);
      }
      if (!isDrawableLineVertexCount(points.length)) return undefined;
      return lineLengthKm(points, geoParams);
    },
    [getRoot, getTime, equatorLengthKm, flattening, domain, currentTime],
  );

  return (
    <PropertyPanel<S>
      store={props.store}
      featureLookup={props.featureLookup}
      anchorLookup={props.anchorLookup}
      editDispatch={props.editDispatch}
      calendar={props.calendar}
      ownerLookup={ownerLookup}
      resolveAreaKm2={resolveAreaKm2}
      resolveLengthKm={resolveLengthKm}
      {...(props.anchorIntervalDispatch ? { anchorIntervalDispatch: props.anchorIntervalDispatch } : {})}
      {...(props.assetResolver ? { assetResolver: props.assetResolver } : {})}
      {...(props.onOpenDetail ? { onOpenDetail: props.onOpenDetail } : {})}
      {...(props.onDeleteFeature ? { onDeleteFeature: props.onDeleteFeature } : {})}
      {...(props.onCreateAnchorHere ? { onCreateAnchorHere: props.onCreateAnchorHere } : {})}
      {...(props.onParentPick ? { onParentPick: props.onParentPick } : {})}
      {...(props.onParentCreate ? { onParentCreate: props.onParentCreate } : {})}
      {...(props.onParentClear ? { onParentClear: props.onParentClear } : {})}
      {...(props.onEndHere ? { onEndHere: props.onEndHere } : {})}
      {...(props.endHereDisabledReason
        ? { endHereDisabledReason: props.endHereDisabledReason }
        : {})}
      {...(props.resolveDeleteImpact ? { resolveDeleteImpact: props.resolveDeleteImpact } : {})}
      {...(props.onDraftConfirmChange
        ? { onDraftConfirmChange: props.onDraftConfirmChange }
        : {})}
      {...(props.onPropertyModalChange
        ? { onModalChange: props.onPropertyModalChange }
        : {})}
      {...(props.nameFieldFocus ? { nameFieldFocus: props.nameFieldFocus } : {})}
      {...(props.anchorStartEdit ? { anchorStartEdit: props.anchorStartEdit } : {})}
      {...(props.draftStatus ? { draftStatus: props.draftStatus } : {})}
      {...(props.onAdvanceBundle ? { onAdvanceBundle: props.onAdvanceBundle } : {})}
    />
  );
}

