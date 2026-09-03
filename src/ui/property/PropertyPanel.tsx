// UI layer (U32 / property panel): the sidebar property panel (FR-83 / FR-84 /
// FR-97 / FR-99前段 / FR-60 / FR-57).
//
// The main panel. It SUBSCRIBES to the session store (U16) for the raw selection
// (active feature id + the vertex set + its owner lookup) and the edit mode, then
// runs the SINGLE display judgment (selection-display.decideDisplay) over the raw
// IDs (教訓 5.10).
//
// **編集時刻は常に現在時刻である**（増分 2 の中核。設計書 §D.3 / 裁定 §N-2 の (A)）。
// 以前は「選択中の錨の開始時刻」に保存が効いていたので、画面の真ん中に「1200年」と
// 出ていても保存すると **0 年の錨が黙って書き換わり**、「1500 年から国名が変わった」を
// 記録する手段が画面に 1 つも無かった（現状分析 C2(a)、FR-57 must と FR-84 should の
// 衝突）。いまは:
//   - 保存の行き先（上書きか、新しい錨か、押せないか）を {@link decideEditPlan} が決め、
//     **押す前に**編集時刻バッジと保存ボタンの文言で見せる。
//   - 渡す時刻は年へ丸める（錨の開始に月日を焼き付けない、U-14）。
//   - まとめ役の子は自分の系列を持たないので、**編集が実際に書き込まれる系列**
//     （親の系列）を `governingSeriesOf` で引いて判定する（設計書 §C.6 / §N-15）。
//
// 下書き（名前・種別ラベル・見た目・詳細文書）は **このパネルが 1 つだけ持つ**。保存列は
// 素性欄の下端に固定してあり（設計書 §C.6 / C7）、1 回の押下で 4 つとも確定する
// （N-46: 「押さないと保存されない」場所が 2 つあった状態を 1 つに揃えた）。
//
// 錨を選ぶと現在時刻がその錨の開始時刻へ同期する（FR-84 前半は維持）。これは今までと
// 同じ単一経路 setCurrentTime を通る（教訓 5.6 / 5.15）。
//
// The panel holds NO map-draw state in React (技術方針 2.3); it reads the store.

import { useCallback, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { resolveAt, type AnchorEntry, type AnchorSeries } from '../../domain/anchor-series';
import type { TimePoint } from '../../domain/time/time-point';
import type { PaletteThemeId } from '../../domain/coloring';
import { featureDisplayName } from '../../domain/feature';
import type { AnchorId, FeatureId } from '../../domain/ids';
import { ownerLookupFromMap, type VertexOwnerLookup } from '../../domain/selection';
import type { Calendar } from '../../domain/time/calendar';
import { isPersistedYear } from '../../domain/time/validate';

import { canEdit } from '../shell/permissions';
import type { SessionStore } from '../state/store';
import { TIME_CHANGE_SOURCE } from '../state/store';
import { formatTimePoint, formatYear } from '../timeline/time-display';

import { DELETE_TARGET_KIND } from '../../domain/deletion';

import { relevantEntriesFor } from './anchor-diff';
import { AnchorSection } from './AnchorSection';
import { BasicInfoForm } from './BasicInfoForm';
import { DeleteFeatureButton } from './DeleteFeatureButton';
import { DetailDocumentSection } from './DetailDocumentSection';
import type {
  AnchorIntervalEditDispatch,
  AnchorIntervalEditIntent,
  AnchorSeriesLookup,
  AssetResolver,
  EditDispatch,
  FeatureLookup,
  GoverningAnchorSeries,
  PropertyEditValues,
} from './contracts';
import { DETAIL_DOCUMENT_PLAN, planDetailDocumentEdit } from './detail-document';
import { buildEditIntent, isNoOpEdit, propertyValuesEqual, valuesFromFeature } from './edit-intent';
import {
  decideEditPlan,
  EDIT_PLAN_KIND,
  EDIT_PLAN_STRINGS,
  type EditPlan,
} from './edit-plan';
import { PROPERTY_STRINGS, detailDocumentTooLongMessage, featureKindJaLabel } from './messages';
import {
  DISPLAY_KIND,
  decideDisplay,
  targetFeatureIdOf,
} from './selection-display';

export interface PropertyPanelProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  readonly featureLookup: FeatureLookup;
  readonly anchorLookup: AnchorSeriesLookup;
  readonly editDispatch: EditDispatch;
  /**
   * HB3-12: the存続期間編集 dispatch (U09 changeStart / setEnd / deleteAnchor). When
   * wired AND the form is editable the anchor section shows a per-anchor存続期間 editor
   * (move 開始/終了, 継続中, この錨を削除); when omitted the section stays the read-only
   * view (honest-stub discipline — no dead control, 教訓 5.7).
   */
  readonly anchorIntervalDispatch?: AnchorIntervalEditDispatch;
  readonly calendar: Calendar;
  /**
   * FR-98 / FR-02: resolves ZIP-internal image references for the 詳細文書 preview.
   * Defaults to "no asset resolves" (safe broken image) when the host has none.
   */
  readonly assetResolver?: AssetResolver;
  /**
   * Resolve the owner of a vertex (U22 / U03). Used to evaluate the RAW owner set
   * for the display judgment (教訓 5.10). Defaults to "no owner" so a host that
   * has not wired it shows the guidance cases rather than crashing.
   */
  readonly ownerLookup?: VertexOwnerLookup;
  /** Open a detail panel for the feature (FR-99後段). */
  readonly onOpenDetail?: (featureId: FeatureId) => void;
  /** FR-85: delete the feature shown in the panel (the「地物を削除」button's confirm). */
  readonly onDeleteFeature?: (featureId: FeatureId) => void;
  /**
   * 「この年に錨を作る」（Ctrl+K, 実装計画 増分 2 の中身 3 / 設計書 §D.3）の
   * 素性欄側の入口。**保存ボタンとは別のコマンド**で、値を変えていなくても錨を
   * 1 本増やす（保存は `isNoOpEdit` の関門で何もしないので、この経路が無いと
   * 「1500 年から同じ姿が続く」を記録できない）。ホストはこれを
   * `COMMAND_ID.EditCreateAnchorHere` の 1 本に繋ぐ（権限の関門も可否の判定も
   * そこで 1 回だけ行われる、教訓 5.13 / 5.30）。未配線ならボタンを出さない。
   */
  readonly onCreateAnchorHere?: (featureId: FeatureId) => void;
  /**
   * Palette themes for the U33「スタイル」section dropdown (from settings, FR-109).
   * Forwarded to the basic-info form's StyleSection. When omitted the form falls
   * back to the feature's own theme so the section still renders.
   */
  readonly paletteThemes?: readonly PaletteThemeId[];
  /**
   * FR-20 / FR-35: resolve a feature's 面積（km²）by id, computed by the HOST from
   * the LIVE domain + current time + FR-109 geoParams. Returns `undefined` for a
   * point / line, an unresolvable shape, or an unknown id — the panel then shows NO
   * 面積 row (honest-stub, no fabricated value).
   *
   * WHY A BY-ID PORT (not a resolved shape prop): the panel keys its resolved
   * feature to the target ID (教訓 5.2) so a structural edit that keeps the SAME id
   * does not churn the form draft — but that also means the memoized `feature`
   * object does NOT change reference on such an edit, so an area derived from it
   * would go STALE. The host owns reactivity and hands a FRESH resolver each render.
   */
  readonly resolveAreaKm2?: (featureId: FeatureId) => number | undefined;
}

/** 打ちかけの下書きが捨てられそうになったときに握っておく文脈（N-04）。 */
interface DraftOrigin {
  readonly featureId: FeatureId;
  readonly anchorId: AnchorId | null;
  readonly time: TimePoint;
  readonly featureName: string;
}

/** 下書きの種（作り直しの判定に使う）。 */
interface DraftSeed {
  /** 種を作ったときの編集対象（地物 × 錨 × 年）。 */
  readonly key: string;
  /** 種になった値（＝そのときの確定済みの姿）。 */
  readonly baseline: PropertyEditValues;
  /** 打ちかけを「元の場所へ戻す」ために覚えておく文脈。 */
  readonly origin: DraftOrigin | null;
}

const EMPTY_VALUES: PropertyEditValues = {
  name: '',
  kindLabel: '',
  detailDocument: '',
  startYear: 0,
  endYear: 0,
  autoColorEnabled: false,
  fillColor: '',
  fillOpacity: 1,
  selectedColor: '',
  selectedOpacity: 1,
  borderColor: '',
  paletteTheme: '',
};

export function PropertyPanel<S>(props: PropertyPanelProps<S>): JSX.Element {
  const {
    store,
    featureLookup,
    anchorLookup,
    editDispatch,
    anchorIntervalDispatch,
    calendar,
    onOpenDetail,
    onDeleteFeature,
    onCreateAnchorHere,
  } = props;

  // FR-98: preview asset resolution — default to "nothing resolves" (safe broken
  // image, never a raw external fetch) when the host wired none.
  const assetResolver = useMemo<AssetResolver>(
    () => props.assetResolver ?? { resolveAsset: () => null },
    [props.assetResolver],
  );

  // Raw selection inputs (教訓 5.10): each is read from the store's mirror of
  // U22's truth. The display judgment evaluates these raw values directly.
  const activeFeatureId = useStore(store, (s) => s.selection.activeFeature);
  const vertexIds = useStore(store, (s) => s.selection.vertexIds);
  const mode = useStore(store, (s) => s.mode);
  const currentTime = useStore(store, (s) => s.currentTime);
  // The committed domain root (F1). Subscribed here so the panel re-renders on a
  // committed-domain swap AND so the memos below can key on it — an edit swaps the
  // root but leaves the selection + the current time unchanged, and the production
  // lookups have a STABLE identity across that swap (教訓 5.5).
  const domain = useStore(store, (s) => s.domain);

  const ownerLookup = useMemo(
    () => props.ownerLookup ?? ownerLookupFromMap(new Map()),
    [props.ownerLookup],
  );

  const decision = useMemo(
    () => decideDisplay({ activeFeatureId, vertexIds, ownerLookup }),
    [activeFeatureId, vertexIds, ownerLookup],
  );

  const targetFeatureId = targetFeatureIdOf(decision);
  // Memoize the resolved feature by the target feature ID (教訓 5.2 / 5.12), with
  // `currentTime` AND `domain` as deps: the production FeatureLookup resolves
  // `featuresAt(getRoot(), getTime())` but its object identity is stable across both
  // a time move and a committed-domain swap, so without these deps the panel froze
  // at the selection-time snapshot (bughunt 第12波 #1 / A9 = BH1-01).
  const feature = useMemo(
    () => (targetFeatureId !== null ? featureLookup.featureAt(targetFeatureId) : null),
    [featureLookup, targetFeatureId, currentTime, domain],
  );

  // 自分の系列（無いこともある = まとめ役の子）。`domain` が dep なのは上と同じ理由
  // （存続期間の編集は根を差し替えるが選択も時刻も動かさない、教訓 5.5）。
  const ownSeries = useMemo<AnchorSeries | null>(
    () => (targetFeatureId !== null ? anchorLookup.anchorSeriesOf(targetFeatureId) : null),
    [anchorLookup, targetFeatureId, domain],
  );

  // **編集が実際に書き込まれる系列**（設計書 §C.6 / 裁定 §N-15）。ホストが口を配線して
  // いなければ自分の系列で代用する（honest stub）。
  const governing = useMemo<GoverningAnchorSeries | null>(() => {
    if (targetFeatureId === null) return null;
    const resolved = anchorLookup.governingSeriesOf?.(targetFeatureId, currentTime) ?? null;
    if (resolved !== null) return resolved;
    if (ownSeries === null) return null;
    return {
      series: ownSeries,
      ownerFeatureId: targetFeatureId,
      ownerName: null,
      effectiveSize: null,
    };
  }, [anchorLookup, targetFeatureId, currentTime, domain, ownSeries]);

  // 錨表に出す系列。自分の系列があればそのまま、借り物（親の系列）ならその子に関わる錨だけ
  // に絞る（裁定 §N-15 の (A)。親の系列をそのまま出すと 60 人ぶんの他人の変化が混ざる）。
  const inherited = governing !== null && governing.ownerName !== null;
  const displaySeries = useMemo<AnchorSeries | null>(() => {
    if (governing === null) return ownSeries;
    if (!inherited) return governing.series;
    if (targetFeatureId === null) return null;
    // 表示専用の見かけの系列。U09 の不変条件を主張しないので、存続期間の編集には
    // 渡さない（下の intervalEditable が自分の系列のときだけ真になる）。
    return { entries: relevantEntriesFor(governing.series.entries, targetFeatureId) };
  }, [governing, inherited, ownSeries, targetFeatureId]);

  // FR-20 / FR-35: the DERIVED area (km²). KEYED TO THE TARGET ID, NOT the resolved
  // `feature` OBJECT, so a structural edit that keeps the id still re-derives (教訓 5.3).
  const { resolveAreaKm2 } = props;
  const areaKm2 = useMemo<number | undefined>(() => {
    if (targetFeatureId === null || resolveAreaKm2 === undefined) return undefined;
    return resolveAreaKm2(targetFeatureId);
  }, [targetFeatureId, resolveAreaKm2]);

  // The edit-target anchor is local UI文脈 (教訓 5.4). Keyed by feature so it is
  // discarded when the target feature changes (教訓 5.2).
  const [selectedAnchorId, setSelectedAnchorId] = useState<AnchorId | null>(null);
  const [anchorKey, setAnchorKey] = useState<FeatureId | null>(null);
  if (anchorKey !== targetFeatureId) {
    setAnchorKey(targetFeatureId);
    setSelectedAnchorId(null);
  }

  // 錨表で目立たせる錨: 利用者が明示的に選んだもの、無ければ現在時刻で実効なもの。
  // **編集時刻はこれではなく現在時刻である**（増分 2）。ここは「どの行に印を付けるか」
  // と「下書きをいつ作り直すか」の目印にだけ使う。
  const effectiveAnchorId = useMemo<AnchorId | null>(() => {
    if (displaySeries === null) return null;
    if (
      selectedAnchorId !== null &&
      displaySeries.entries.some((e) => e.anchor.id === selectedAnchorId)
    ) {
      return selectedAnchorId;
    }
    const r = resolveAt(displaySeries, currentTime, calendar);
    return r.kind === 'present' ? r.entry.anchor.id : null;
  }, [selectedAnchorId, displaySeries, currentTime, calendar]);

  // 教訓 5.6 / 5.15: anchor selection syncs the session current time to the
  // anchor START via the SAME setCurrentTime action every time path uses.
  const handleSelectAnchor = useCallback(
    (entry: AnchorEntry) => {
      setSelectedAnchorId(entry.anchor.id);
      store.getState().setCurrentTime(entry.start, TIME_CHANGE_SOURCE.AnchorSync);
    },
    [store],
  );

  // --- 保存の行き先（設計書 §D.3 の表） -------------------------------------
  const editPlan: EditPlan = useMemo(
    () =>
      decideEditPlan({
        currentTime,
        series: governing?.series ?? null,
        featurePresent: feature !== null,
        calendar,
        snapshotSize: governing?.effectiveSize ?? null,
      }),
    [currentTime, governing, feature, calendar],
  );

  // --- 下書き（名前・種別ラベル・見た目・詳細文書の 4 つ、設計書 §C.6） --------
  const baseline = useMemo<PropertyEditValues>(
    () => (feature === null ? EMPTY_VALUES : valuesFromFeature(feature)),
    [feature],
  );
  /** いま打っている場所（打ちかけを「元へ戻す」ために覚えておく、N-04）。 */
  const origin = useMemo<DraftOrigin | null>(() => {
    if (targetFeatureId === null || feature === null) return null;
    return {
      featureId: targetFeatureId,
      anchorId: effectiveAnchorId,
      time: currentTime,
      featureName: featureDisplayName(feature),
    };
  }, [targetFeatureId, feature, effectiveAnchorId, currentTime]);
  // 編集対象の同一性: 地物 × 錨 × **年**。年を鍵に入れるのは、錨が 1 本しか無い地物でも
  // 「1200 年で打って 1500 年へ移った」ら保存の行き先が変わるからである（N-04）。
  const editTargetKey = `${String(targetFeatureId ?? '')}|${String(effectiveAnchorId ?? '')}|${String(
    currentTime.year,
  )}`;

  // 初回の種も **打っている場所を覚える**。null のままにしていたときは、選んでから
  // 一度も対象が変わっていない状態で打ちかけを捨てていた（N-04 が効かない）。
  const [seed, setSeed] = useState<DraftSeed>({ key: editTargetKey, baseline, origin });
  const [draft, setDraft] = useState<PropertyEditValues>(baseline);
  // 教訓 5.12: the save-failure / validation message is dedicated state. It is
  // cleared by ONLY three契機 — a same-operation re-save attempt, an explicit
  // dismiss, or a妥当値での再保存成功.
  const [message, setMessage] = useState<string | null>(null);
  // N-04: 打ちかけを捨てる前の確認。null なら確認は出ていない。
  const [pendingDiscard, setPendingDiscard] = useState<DraftOrigin | null>(null);

  // 「打ちかけの内容がある」＝ **種にした姿とも、いまの確定済みの姿とも違う**こと。
  // 片方だけで判定すると、**保存の直後に確認が出てしまう**。保存で錨が 1 本増えると
  // 編集対象（地物×錨×年）が変わるので、「対象が変わったかつ下書きが種と違う」になるが、
  // その下書きは **いま保存した内容そのもの** で、失われるものは何も無い。
  const dirty =
    !propertyValuesEqual(draft, seed.baseline) && !propertyValuesEqual(draft, baseline);

  if (pendingDiscard === null && seed.key !== editTargetKey) {
    // 編集対象そのものが変わった（別の地物・別の錨・別の年）。
    if (dirty && seed.origin !== null) {
      // **打ちかけがあるなら捨てない**。確認を出して利用者に決めてもらう（N-04）。
      // 本設計は時刻を動かす頻度が上がるので、黙って消すと被害が比例して増える。
      setPendingDiscard(seed.origin);
    } else {
      setSeed({ key: editTargetKey, baseline, origin });
      setDraft(baseline);
    }
  } else if (pendingDiscard === null && !propertyValuesEqual(seed.baseline, baseline)) {
    // 同じ編集対象のまま、確定済みの姿だけが変わった（取り消し・やり直し・外部読み込み）。
    // **こちらは黙って追従する**のが正しい向きである（A9 / BH1-01。ドメインの巻き戻しは
    // 打ちかけより強い）。追従しないと、取り消したはずの名前が保存で復活した。
    setSeed({ key: editTargetKey, baseline, origin });
    setDraft(baseline);
  }

  const patchDraft = useCallback((next: Partial<PropertyEditValues>) => {
    setDraft((prev) => ({ ...prev, ...next }));
  }, []);

  const patchDetailDocument = useCallback(
    (next: string) => {
      patchDraft({ detailDocument: next });
    },
    [patchDraft],
  );

  /** 打ちかけを捨てて、いまの編集対象へ作り直す。 */
  const discardDraft = useCallback(() => {
    setPendingDiscard(null);
    setSeed({ key: editTargetKey, baseline, origin });
    setDraft(baseline);
    // 判断用のメッセージは残す（教訓 5.12: 3 つの契機に「対象の変更」は入らない）。
  }, [editTargetKey, baseline, origin]);

  /** 打ちかけを続けるために、打っていた場所へ戻る。 */
  const returnToDraftOrigin = useCallback(() => {
    const origin = pendingDiscard;
    setPendingDiscard(null);
    if (origin === null) return;
    const state = store.getState();
    if (origin.featureId !== targetFeatureId) state.setActiveFeature(origin.featureId);
    state.setCurrentTime(origin.time, TIME_CHANGE_SOURCE.AnchorSync);
  }, [pendingDiscard, store, targetFeatureId]);

  // --- 保存 ------------------------------------------------------------------
  const handleSave = useCallback(() => {
    if (feature === null) {
      setMessage(`${PROPERTY_STRINGS.saveFailedPrefix}編集対象が解決できません。`);
      return;
    }
    if (editPlan.editTime === null) {
      setMessage(
        `${PROPERTY_STRINGS.saveFailedPrefix}${editPlan.reason ?? 'この年には保存できません。'}`,
      );
      return;
    }
    // WRITE 側の年境界ガード (bughunt 第12波 #2). 基本情報の開始年/終了年は type=number
    // ゆえ巨大整数・負巨大・小数を受理し、READ 側 schema.ts の yearSchema が load 時に
    // 範囲外年で manifest 全体を Invalid 拒否 → .gimoza が二度と開けず全損する。
    if (!isPersistedYear(draft.startYear) || !isPersistedYear(draft.endYear)) {
      setMessage(`${PROPERTY_STRINGS.saveFailedPrefix}${PROPERTY_STRINGS.yearOutOfRange}`);
      return;
    }
    // FR-98 の WRITE ガード（長すぎる詳細文書）。ドメインの RangeError は最後の防波堤で
    // あって UX ではない。判定は単一真実源 planDetailDocumentEdit を通す（教訓 5.29）。
    const docPlan = planDetailDocumentEdit(feature, draft.detailDocument);
    if (docPlan.kind === DETAIL_DOCUMENT_PLAN.TooLong) {
      setMessage(detailDocumentTooLongMessage(docPlan.length));
      return;
    }
    // 教訓 5.24: no-op guard. 値が同じ保存は dispatch しない（幽霊の取り消しを作らない）。
    // **Ctrl+K（この年に錨を作る）はこの関門に飲まれない別のコマンド**である（設計書 §D.3）。
    if (isNoOpEdit(feature, draft)) {
      setMessage(null);
      return;
    }
    try {
      editDispatch.dispatchEdit(buildEditIntent(feature, editPlan.editTime, draft));
      setMessage(null);
    } catch (err) {
      setMessage(`${PROPERTY_STRINGS.saveFailedPrefix}${String(err)}`);
    }
  }, [feature, editPlan, draft, editDispatch]);

  /** 年ちょうどでないときに、その年へ丸める（設計書 §D.3 の表の 4 行目）。 */
  const handleRoundToYear = useCallback(() => {
    const rounded = editPlan.roundedTime;
    if (rounded === null) return;
    store.getState().setCurrentTime(rounded, TIME_CHANGE_SOURCE.NumericJump);
  }, [editPlan.roundedTime, store]);

  // HB3-12: dispatch a存続期間編集 intent through the host's command bridge.
  const handleEditInterval = useCallback(
    (intent: AnchorIntervalEditIntent): string | null => {
      if (anchorIntervalDispatch === undefined) return null;
      try {
        anchorIntervalDispatch.dispatchAnchorInterval(intent);
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    },
    [anchorIntervalDispatch],
  );

  // 教訓 5.13 / K-6: 権限の判定は `permissions.ts` の canEdit(mode) **1 本** に寄せる。
  const editingAllowed = canEdit(mode);
  const editable = decision.editable && editingAllowed;

  // 存続期間の編集は **自分の系列** のときだけ（借り物の親の系列を、子の画面から
  // 書き換えさせない。§C.6 の「まとめ役の子の錨」は読むための表示である）。
  const intervalEditable =
    anchorIntervalDispatch !== undefined && editable && !inherited && ownSeries !== null;

  // FR-98: an object-reference (feature:) link in the preview promotes the target
  // through the SAME store.setActiveFeature path every selection uses (教訓 5.29).
  const handleSelectFromDocument = useCallback(
    (featureId: FeatureId): void => {
      store.getState().setActiveFeature(featureId);
    },
    [store],
  );

  /** 本物の存続期間（U-23: 正本は錨の並び）を 1 行にする。 */
  const existenceLabel = useMemo<string | undefined>(() => {
    if (displaySeries === null || displaySeries.entries.length === 0) return undefined;
    const first = displaySeries.entries[0];
    const last = displaySeries.entries[displaySeries.entries.length - 1];
    if (first === undefined || last === undefined) return undefined;
    const end = last.end === null ? PROPERTY_STRINGS.existenceOpenEnd : formatTimePoint(last.end);
    return `${formatTimePoint(first.start)} → ${end}`;
  }, [displaySeries]);

  return (
    <div className="property-panel" data-testid="property-panel">
      {feature === null ? (
        <GuidanceMessage decision={decision} />
      ) : (
        <>
          {/* 見出しと編集時刻バッジ。**スクロールしても消えない**（設計書 §C.6）。 */}
          <div className="property-panel__head" data-testid="property-panel-head">
            <div className="property-panel__title">
              <span className="property-panel__name" data-testid="property-title-name">
                {featureDisplayName(feature)}
              </span>
              <span className="property-panel__kind" data-testid="property-title-kind">
                {featureKindJaLabel(feature.kind)}
              </span>
            </div>
            <div
              className="property-panel__badge"
              data-testid="edit-time-badge"
              data-plan={editPlan.kind}
            >
              <span className="property-panel__badge-time" data-testid="edit-time-badge-time">
                {editPlan.badgeTime}
              </span>
              <span className="property-panel__badge-sep" aria-hidden="true">
                {EDIT_PLAN_STRINGS.badgeSeparator}
              </span>
              <span className="property-panel__badge-note" data-testid="edit-time-badge-note">
                {editPlan.badgeNote}
              </span>
            </div>
          </div>

          <div className="property-panel__actions">
            <button
              type="button"
              data-testid="open-detail-button"
              onClick={() => onOpenDetail?.(feature.id)}
            >
              {PROPERTY_STRINGS.openDetailButton}
            </button>
          </div>

          <BasicInfoForm
            feature={feature}
            editable={editable}
            values={draft}
            onChange={patchDraft}
            {...(props.paletteThemes ? { paletteThemes: props.paletteThemes } : {})}
            {...(areaKm2 !== undefined ? { areaKm2 } : {})}
            {...(existenceLabel !== undefined ? { existenceLabel } : {})}
          />

          {/* まとめ役の子（実データで 86 件）は自分の歴史を持たない。**錨の欄ごと消す**の
              をやめ、誰が持っているかを書いて、その子に関わる錨だけを出す（§C.6 / §N-15）。 */}
          {inherited && governing !== null && (
            <p className="property-panel__inherited" data-testid="inherited-anchor-notice">
              <span>{PROPERTY_STRINGS.inheritedAnchorNotice(governing.ownerName ?? '')}</span>
              <button
                type="button"
                data-testid="inherited-anchor-owner"
                onClick={() => store.getState().setActiveFeature(governing.ownerFeatureId)}
              >
                {PROPERTY_STRINGS.inheritedAnchorGoToOwner}
              </button>
            </p>
          )}

          {displaySeries !== null && (
            <AnchorSection
              // Feature-scoped key so React REMOUNTS the section on a target change,
              // resetting its transient view-mode (List/TimeBar) state (教訓 5.2).
              key={targetFeatureId ?? 'none'}
              series={displaySeries}
              featureIdForDiff={feature.id}
              currentTime={currentTime}
              calendar={calendar}
              selectedAnchorId={effectiveAnchorId}
              onSelectAnchor={handleSelectAnchor}
              {...(intervalEditable
                ? { featureId: feature.id, onEditInterval: handleEditInterval }
                : {})}
            />
          )}

          <DetailDocumentSection
            // 下書きの作り直しは編集対象（地物×錨×年）が変わったときだけ。パネルが
            // 下書きを持つので、ここは key で閲覧/編集の一時状態だけ捨てる（教訓 5.2）。
            key={`${String(targetFeatureId ?? 'none')}-${String(effectiveAnchorId ?? '')}`}
            feature={feature}
            editable={editable}
            draft={draft.detailDocument}
            onDraftChange={patchDetailDocument}
            assetResolver={assetResolver}
            onSelectFeature={handleSelectFromDocument}
          />

          {/* FR-85: the always-present「地物を削除」button for the shown feature.
              N-03 / K-6: このボタンだけが権限の関門を素通りしていて表示専用でも押せた。 */}
          {onDeleteFeature !== undefined && (
            <DeleteFeatureButton
              target={{ kind: DELETE_TARGET_KIND.ActiveFeature, featureId: feature.id }}
              onConfirm={onDeleteFeature}
              editable={editable}
              featureName={feature.attributes.name}
            />
          )}

          {/* 保存列。**素性欄の下端に固定**する（設計書 §C.6 / C7）。現物は保存ボタンの
              offsetTop が 755.8px で初期表示（高さ 362px）の外にあり、誰も見なかった
              （BH1-03）。押す前に行き先が読める文言はここに出る。 */}
          <div className="property-panel__save-bar" data-testid="property-save-bar">
            {pendingDiscard !== null && (
              <div
                className="property-panel__draft-confirm"
                role="alertdialog"
                aria-label={PROPERTY_STRINGS.draftDiscardTitle}
                data-testid="draft-discard-confirm"
              >
                <p>
                  {PROPERTY_STRINGS.draftDiscardBody(
                    PROPERTY_STRINGS.draftOrigin(
                      pendingDiscard.featureName,
                      formatYear(pendingDiscard.time.year),
                    ),
                  )}
                </p>
                <div className="property-panel__draft-confirm-buttons">
                  <button
                    type="button"
                    data-testid="draft-discard-keep"
                    onClick={returnToDraftOrigin}
                  >
                    {PROPERTY_STRINGS.draftDiscardKeep}
                  </button>
                  <button
                    type="button"
                    data-testid="draft-discard-drop"
                    onClick={discardDraft}
                  >
                    {PROPERTY_STRINGS.draftDiscardDrop}
                  </button>
                </div>
              </div>
            )}

            {message !== null && (
              <div className="basic-info__message" role="alert" data-testid="save-message">
                <span>{message}</span>
                <button
                  type="button"
                  aria-label={PROPERTY_STRINGS.dismissMessage}
                  onClick={() => setMessage(null)}
                >
                  ×
                </button>
              </div>
            )}

            {editPlan.reason !== null && (
              <p className="property-panel__save-reason" data-testid="save-disabled-reason">
                {editPlan.reason}
              </p>
            )}

            {/* 「この年に錨を作る」（Ctrl+K）。**現在時刻に錨が無いときだけ**出す
                （設計書 §D.3）。値を変えない保存は何もしないので、「この年から同じ姿が
                続く」を記録するにはこの入口が要る。 */}
            {editable &&
              onCreateAnchorHere !== undefined &&
              editPlan.kind === EDIT_PLAN_KIND.NewAnchor && (
                <button
                  type="button"
                  className="property-panel__create-anchor"
                  data-testid="create-anchor-here"
                  onClick={() => onCreateAnchorHere(feature.id)}
                >
                  {EDIT_PLAN_STRINGS.createAnchorHereLabel(formatYear(currentTime.year))}
                </button>
              )}

            {editable && (
              <div className="property-panel__save-row">
                <button
                  type="button"
                  className="basic-info__save"
                  data-testid="save-button"
                  disabled={!editPlan.savable || pendingDiscard !== null}
                  onClick={handleSave}
                >
                  {editPlan.saveLabel}
                </button>
                {editPlan.kind === EDIT_PLAN_KIND.NotYearAligned &&
                  editPlan.roundedTime !== null && (
                    <button
                      type="button"
                      className="property-panel__round-year"
                      data-testid="round-to-year-button"
                      onClick={handleRoundToYear}
                    >
                      {EDIT_PLAN_STRINGS.roundToYearLabel(formatYear(currentTime.year))}
                    </button>
                  )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** The guidance message for a non-editable decision (FR-83). */
function GuidanceMessage(props: {
  readonly decision: ReturnType<typeof decideDisplay>;
}): JSX.Element {
  const { decision } = props;
  const message =
    decision.kind === DISPLAY_KIND.Empty ||
    decision.kind === DISPLAY_KIND.Multiple ||
    decision.kind === DISPLAY_KIND.Unknown
      ? decision.message
      : PROPERTY_STRINGS.featureMissing;
  return (
    <p className="property-panel__guidance" data-testid="property-guidance">
      {message}
    </p>
  );
}
