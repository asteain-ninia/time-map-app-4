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
//   - 集約地物の下位領域は自分の系列を持たないので、**編集が実際に書き込まれる系列**
//     （親の系列）を `governingSeriesOf` で引いて判定する（設計書 §C.6 / §N-15）。
//
// 下書き（名前・種別ラベル・見た目・詳細文書）は **このパネルが 1 つだけ持つ**。保存列は
// 素性欄の下端に固定してあり（設計書 §C.6 / C7）、1 回の押下で 4 つとも確定する
// （N-46: 「押さないと保存されない」場所が 2 つあった状態を 1 つに揃えた）。
//
// 錨を選ぶと現在時刻がその錨の開始時刻へ同期する（FR-84 前半は維持）。これは今までと
// 同じ単一経路 setCurrentTime を通る（教訓 5.6 / 5.15）。
//
// **打ちかけの下書きを、どの経路でどう扱うか**（K-5「一時状態は全経路で捨てる」。
// 増分 2 の手直し A4 / GPT#2。捨てるのは全経路で同じ、聞くかどうかだけが経路ごとに違う）:
//
//   | 経路                                        | 下書き           | 確認 |
//   | ------------------------------------------- | ---------------- | ---- |
//   | 編集対象が変わる（別の地物・別の錨・別の年）| 捨てる前に聞く   | 出す |
//   | 対象が解決できなくなった（選択解除・不在年）| 捨てる前に聞く   | 出す |
//   | 自分の保存が成功した直後                    | 黙って追従       | 出さない（失われるものが無い、教訓 5.53） |
//   | 取り消し／やり直し                          | 黙って捨てる     | 出さない（ドメインの巻き戻しのほうが強い） |
//   | 鍵を「読むだけ」にする                      | 黙って捨てる     | 出さない（編集経路が閉じる） |
//   | プロジェクトを開く／新規                    | 捨てる前に聞く   | 出す（下の注記） |
//
// **注記（プロジェクトの読み込み）**: 読み込みは選択を消すので、この画面からは
// 「編集対象が変わった」と見分けが付かない。素性欄へ「いま読み込んだ」を伝える合図が
// まだ無いためで、結果として確認が出る（捨てはする＝K-5 は守られる）。ただし
// ［元の場所へ戻る］は新しいプロジェクトに居ない地物を選び直すので、
// 「選択された地物が見つかりません」になる。合図を通すのは増分 6（現状.md に申し送り）。
//
// 確認が出ているあいだは **背後の編集経路をすべて止める**: 保存ボタン・存続期間の操作・
// 地物の削除はこのパネルの中で、Ctrl+K / Delete などの鍵盤は `onDraftConfirmChange` で
// ホストの `shortcutsSuspended` に載せて止める（教訓 5.14）。
//
// The panel holds NO map-draw state in React (技術方針 2.3); it reads the store.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { resolveAt, type AnchorEntry, type AnchorSeries } from '../../domain/anchor-series';
import type { TimePoint } from '../../domain/time/time-point';
import type { PaletteThemeId } from '../../domain/coloring';
import { FEATURE_KIND, featureDisplayName, type Feature } from '../../domain/feature';
import type { AnchorId, FeatureId } from '../../domain/ids';
import { ownerLookupFromMap, type VertexOwnerLookup } from '../../domain/selection';
import type { Calendar } from '../../domain/time/calendar';
import { compare } from '../../domain/time/normalized';
import { carriedAttributesOf, carryForwardTargets, nextDivergingEntry } from '../../domain/editing/carry-forward';

import { canEdit } from '../shell/permissions';
import type { SessionStore } from '../state/store';
import { TIME_CHANGE_SOURCE } from '../state/store';
import { formatTimePoint, formatYear } from '../timeline/time-display';

import { DELETE_TARGET_KIND } from '../../domain/deletion';

import { anchorRowsOf, existenceRunsOf, type AnchorRow } from './anchor-diff';
import { useModalChannels } from '../a11y/index';

import { AnchorSection, type StartEditorSignal } from './AnchorSection';
import type { AnchorStartEditStore } from './anchor-start-edit';
import { BasicInfoForm } from './BasicInfoForm';
import { existenceStatusAt, type ExistenceStatus } from './existence-status';
import { DeleteFeatureButton } from './DeleteFeatureButton';
import type { DeleteImpactView } from './delete-impact';
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
  saveEffectOf,
  EDIT_PLAN_KIND,
  EDIT_PLAN_STRINGS,
  type EditPlan,
} from './edit-plan';
import { PROPERTY_STRINGS, PROPERTY_TEXT, detailDocumentTooLongMessage, featureKindJaLabel } from './messages';
import type { PropertyDraftStatusStore } from './draft-status';
import type { NameFieldFocusStore } from './name-focus';
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
   * **消す前に見せる影響の一覧**（設計書 §A.3 / 増分 7 の中身 6）。押した瞬間に
   * ホストが `describeDeletionImpact` → `buildDeleteImpactView` で組み立てて返す。
   * 未配線なら名前だけを出す従来の確認へ落ちる。
   */
  readonly resolveDeleteImpact?: (featureId: FeatureId) => DeleteImpactView;
  /**
   * 親欄の 3 ボタン（G-3 / FR-46 must。増分 7 の中身 3b）。**押した瞬間に所属変更の
   * 手順へ入る** ―― 素性欄の保存ボタンでは親を変えない（設計書 §C.6 の「保存の対象」）。
   * 3 つとも配線されているときだけ押せる。
   */
  readonly onParentPick?: (featureId: FeatureId) => void;
  readonly onParentCreate?: (featureId: FeatureId) => void;
  readonly onParentClear?: (featureId: FeatureId) => void;
  /**
   * **この年に終わったことにする**（設計書 §A.3 の削除の入口 A。増分 7 の中身 5）。
   * ホストは存続期間のコマンド（`setEnd`）1 本へ繋ぐ。未配線ならボタンを出さない。
   */
  readonly onEndHere?: (featureId: FeatureId) => void;
  /** 入口 A を押せない理由（自分の歴史を持たない地物など）。押せるなら `null` を返す。 */
  readonly endHereDisabledReason?: (featureId: FeatureId) => string | null;
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
  /**
   * FR-19 must（G-1 / 現状.md R1）: 線情報の長さ（km）。面積とまったく同じ形の口で、
   * ホストが測地の 1 本（`lineLengthKm`）から出す。線でなければ `undefined`。
   */
  readonly resolveLengthKm?: (featureId: FeatureId) => number | undefined;
  /**
   * 打ちかけを捨てるかどうかの確認（N-04）が開いた／閉じたことをホストへ伝える
   * （増分 2 の手直し A4 (c)）。ホストはこれを `shortcutsSuspended` に OR して、
   * 確認が出ているあいだ Ctrl+K・Delete・Ctrl+Z などの大域ショートカットを止める。
   * 右クリックメニューの `onOpenChange` と同じ形（教訓 5.14: 重なる UI は入力を
   * 受ける層も同時に設計する）。未配線でも確認そのものは動く（honest stub）。
   */
  readonly onDraftConfirmChange?: (open: boolean) => void;
  /**
   * 素性欄の中で「本物の板」が出ている間、そう名乗る口（司令塔の決定 (13)）。
   * いまは錨の削除の確認が使う。名乗らないと背後で Ctrl+Z / Delete が走る。
   */
  readonly onModalChange?: (open: boolean) => void;
  /**
   * 名前欄へ焦点を入れてほしい、という要求の口（増分 4 / 設計書 §C.5）。作業のまとまりを
   * 作った瞬間と、送りで次の地物へ移ったときに一覧が呼ぶ。**DOM を名前で探さない**
   * （結合点 #3 の反省。`property/name-focus.ts` の注記）。
   */
  readonly nameFieldFocus?: NameFieldFocusStore;
  /**
   * 「この錨の開始年の欄を開いて焦点を置いて」の要求の口（時刻レールの右クリック。
   * 増分 7 の手直し 項目 6）。名前欄の口と同じ形。
   */
  readonly anchorStartEdit?: AnchorStartEditStore;
  /**
   * 「いま打ちかけを抱えている地物」を外へ知らせる口（増分 4 の手直し B11）。
   * 一覧のその場編集がこれを見て、打ちかけを黙って上書きしないようにする。
   */
  readonly draftStatus?: PropertyDraftStatusStore;
  /**
   * 素性欄の Enter =「保存して**次へ**」の「次へ」の側（設計書 §I.2）。保存が通った
   * ときだけ呼ぶ。**作業のまとまりが無ければホストが何もしない**（ここは可否を知らない）。
   */
  readonly onAdvanceBundle?: () => void;
}

/**
 * 画面に出す名前。`featureDisplayName` は名前が空のとき **内部 id** を返すので、
 * そのまま出すと確認の本文や見出しに `f-5-4` が出る（U-1 違反 / A4 (d)）。
 * 出口 1 か所で日本語へ落とす（教訓 5.51 の「出口で写像する」形）。
 */
function shownName(feature: Feature): string {
  const shown = featureDisplayName(feature);
  return shown === String(feature.id) ? PROPERTY_STRINGS.unnamedFeature : shown;
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
    nameFieldFocus,
    draftStatus,
    onAdvanceBundle,
  } = props;

  /** 素性欄の根。**地物を替えたらスクロール位置を先頭へ戻す**ために持つ（C5 の④）。 */
  const rootRef = useRef<HTMLDivElement | null>(null);

  /** 名前の入力欄。作業のまとまりの送りがここへ焦点を入れる（設計書 §C.5）。 */
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * 焦点の要求の通し番号。**要求が来た瞬間に `focus()` を呼んではいけない。**
   *
   * 束を作る／送るときは「地物を選ぶ」と「名前欄へ焦点」が同じ 1 回の押下で起きる。
   * 選んだ瞬間はまだ素性欄が描き直されていないので、そのとき入力欄はまだ **存在しない**
   * （何も選んでいなければ案内文が出ているだけ）。要求は番号として受け取り、**描き直した
   * あとの effect で** 焦点を入れる（教訓 5.7 の裏面: 呼ぶ場所ではなく、効く順番の話）。
   */
  const [nameFocusRequest, setNameFocusRequest] = useState(0);
  useEffect(() => {
    if (nameFieldFocus === undefined) return;
    return nameFieldFocus.subscribe(() => {
      setNameFocusRequest((n) => n + 1);
    });
  }, [nameFieldFocus]);


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

  // 自分の系列（無いこともある = 集約地物の下位領域）。`domain` が dep なのは上と同じ理由
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

  // 錨表に出す行。自分の系列があればそのまま、借り物（親の系列）ならその子に関わる錨だけ
  // に絞る（裁定 §N-15 の (A)。親の系列をそのまま出すと 60 人ぶんの他人の変化が混ざる）。
  //
  // **選り分けの結果は「系列の同一性 × 地物」で使い回す**（増分 2 の手直し B4 / GPT#4）。
  // 選り分けは親の全錨 × その子の形の比較なので、時刻を動かすだけで走らせてはいけない。
  // `governing.series` はドメインが差し替わったときだけ新しい参照になる（ホストの
  // `anchorSeriesOf` / `governingSeriesOf` が根から引き直す）ので、その参照と地物 id を
  // 鍵にすれば「ドメインが変わったときだけ再計算」になる。
  const inherited = governing !== null && governing.ownerName !== null;
  // **鍵にするのは `governing` ではなく `governing.series`**（2026-09-07、増分 6 の実測で
  // 判明）。`governingSeriesOf(featureId, currentTime)` は **時刻を引数に取る**ので
  // 毎回新しい入れ物を返す ―― 入れ物を鍵にすると、上のコメントが「やってはいけない」と
  // 書いているそのもの（時刻を動かすだけで選り分けが走る）になっていた。中の `series` は
  // ドメインが差し替わったときだけ新しい参照になるので、そちらを鍵にする。
  // 実測: 5 万錨を選んだまま 1 年送ると 1 コマが 3ms → 31ms になっていた。
  const displaySeries = useMemo<AnchorSeries | null>(
    () => governing?.series ?? ownSeries,
    [governing, ownSeries],
  );
  // **いま見ている年に、選んでいる地物がどういう状態か**（司令塔の決定 (12) / 設計適合
  // 指摘 5・GPT #5・バグ狩り 2-3）。終わらせた年（以後）に選択を保ったまま「○○年で
  // 終わっています」と読めるようにする。時刻レールの見出しも同じ 1 本から決める。
  const existence = useMemo<ExistenceStatus>(
    () => existenceStatusAt(displaySeries, targetFeatureId, currentTime, calendar),
    [displaySeries, targetFeatureId, currentTime, calendar],
  );
  /** 居ない年に見出しへ出す名前（その年より前の最後の姿、無ければ最初の姿）。 */
  const absentName = useMemo<string | null>(() => {
    if (feature !== null || displaySeries === null || targetFeatureId === null) return null;
    let found: Feature | undefined;
    for (const entry of displaySeries.entries) {
      const f = entry.anchor.snapshot.features.find((x) => x.id === targetFeatureId);
      if (f === undefined) continue;
      if (found === undefined || compare(entry.start, currentTime, calendar) <= 0) found = f;
    }
    return found === undefined ? null : shownName(found);
  }, [feature, displaySeries, targetFeatureId, currentTime, calendar]);

  const anchorRows = useMemo<readonly AnchorRow[]>(() => {
    if (displaySeries === null || targetFeatureId === null) return [];
    return anchorRowsOf(displaySeries.entries, targetFeatureId, { onlyRelevant: inherited });
  }, [displaySeries, inherited, targetFeatureId]);

  // FR-20 / FR-35: the DERIVED area (km²). KEYED TO THE TARGET ID, NOT the resolved
  // `feature` OBJECT, so a structural edit that keeps the id still re-derives (教訓 5.3).
  const { resolveAreaKm2 } = props;
  const areaKm2 = useMemo<number | undefined>(() => {
    if (targetFeatureId === null || resolveAreaKm2 === undefined) return undefined;
    return resolveAreaKm2(targetFeatureId);
  }, [targetFeatureId, resolveAreaKm2]);

  // FR-19 must（G-1 / R1）: 線の長さ。面積とまったく同じ鍵（対象 id ＋ ホストの
  // 解決関数の参照）で memo する。
  //
  // **線のときだけ呼ぶ。** 面や点でも呼ぶと、長さの解決が毎回もう 1 回
  // `featuresAt`（O(履歴 × 錨)）を走らせる ―― 面積の側が「1 回だけ」を守っている
  // 意味が無くなる（`SidebarContent.test.tsx` の「featuresAt を 1 回だけ」が
  // これを固定している）。線かどうかは既に解決済みの `feature` から分かる。
  const { resolveLengthKm } = props;
  const isLine = feature !== null && feature.kind === FEATURE_KIND.Line;
  const lengthKm = useMemo<number | undefined>(() => {
    if (targetFeatureId === null || resolveLengthKm === undefined || !isLine) {
      return undefined;
    }
    return resolveLengthKm(targetFeatureId);
  }, [targetFeatureId, resolveLengthKm, isLine]);

  /**
   * 上位領域（親）の表示名（現状.md B27 / 設計書 §C.6）。**引けないときは `undefined`**
   * にして行ごと出さない ―― 値を捏造しない（honest absence）。
   */
  const parentName = useMemo<string | null | undefined>(() => {
    if (feature === null) return undefined;
    const parentId = feature.parentId;
    if (parentId === undefined) return null;
    const parent = featureLookup.featureAt(parentId);
    return parent === null ? null : shownName(parent);
  }, [feature, featureLookup, currentTime, domain]);

  /**
   * 錨表の差分の文が「親が変わった」を出すときの落とし先（バグ狩り #5）。錨の
   * スナップショットから引けなかったときだけ、**親欄と同じ源**（根の live-lookup）で
   * 引き直す ―― 所属を変えた直後の新しい親は、移した地物の錨には居ないので
   * 「別の地物」と出ていた。
   */
  const resolveParentName = useCallback(
    (featureId: FeatureId): string | null => {
      const f = featureLookup.featureAt(featureId);
      return f === null ? null : shownName(f);
    },
    [featureLookup],
  );

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
    // 目印を付ける相手は **錨表に出ている行** に限る（集約地物の下位領域では親の系列のうち
    // その子に関わる錨だけが出る）。
    if (
      selectedAnchorId !== null &&
      anchorRows.some((r) => r.entry.anchor.id === selectedAnchorId)
    ) {
      return selectedAnchorId;
    }
    const r = resolveAt(displaySeries, currentTime, calendar);
    if (r.kind !== 'present') return null;
    const shown = anchorRows.some((row) => row.entry.anchor.id === r.entry.anchor.id);
    return shown ? r.entry.anchor.id : null;
  }, [selectedAnchorId, displaySeries, anchorRows, currentTime, calendar]);

  // 教訓 5.6 / 5.15: anchor selection syncs the session current time to the
  // anchor START via the SAME setCurrentTime action every time path uses.
  // 印は移動の続きとして渡す ―― 下書きの板で年が止まったら、印も動かない（B112）。
  const handleSelectAnchor = useCallback(
    (entry: AnchorEntry, andThen?: () => void) => {
      store.getState().setCurrentTime(entry.start, TIME_CHANGE_SOURCE.AnchorSync, () => {
        setSelectedAnchorId(entry.anchor.id);
        andThen?.();
      });
    },
    [store],
  );

  // 時刻レールの右クリック「この錨の開始年を変える」（項目 6）。錨表の行を選んだのと
  // 同じ 1 本（`handleSelectAnchor`）でその錨を編集の対象にし、存続期間の欄を開く合図を
  // 出す。行は要求の瞬間の最新を読む（購読は 1 回だけ張る）。
  const anchorStartEdit = props.anchorStartEdit;
  const anchorRowsRef = useRef(anchorRows);
  anchorRowsRef.current = anchorRows;
  // 合図は **どの地物に対するものか**も持つ（地物を替えたあとに古い合図で節が開かない）。
  const [startEditorSignal, setStartEditorSignal] = useState<
    (StartEditorSignal & { readonly featureId: FeatureId | null }) | null
  >(null);
  const targetFeatureIdRef = useRef(targetFeatureId);
  targetFeatureIdRef.current = targetFeatureId;
  useEffect(() => {
    if (anchorStartEdit === undefined) return;
    return anchorStartEdit.subscribe((anchorId) => {
      const row = anchorRowsRef.current.find((r) => r.entry.anchor.id === anchorId);
      if (row === undefined) return;
      handleSelectAnchor(row.entry, () => {
        setStartEditorSignal((prev) => ({
          anchorId,
          n: (prev?.n ?? 0) + 1,
          featureId: targetFeatureIdRef.current,
        }));
      });
    });
  }, [anchorStartEdit, handleSelectAnchor]);

  // --- 保存の行き先（設計書 §D.3 の表） -------------------------------------
  const editPlan: EditPlan = useMemo(
    () =>
      decideEditPlan({
        currentTime,
        series: governing?.series ?? null,
        featurePresent: feature !== null,
        featureEnded: existence.kind === 'ended',
        calendar,
        snapshotSize: governing?.effectiveSize ?? null,
      }),
    [currentTime, governing, feature, calendar, existence],
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
      featureName: shownName(feature),
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
  // 増分 8E の再手直し（G-15 / 再検証 3-1）: 「この下書きで 1 度、自動配色を OFF にしたか」。
  // **下書きと同じ場所** に持ち、下書きを作り直すところ（`setDraft(baseline)` の 4 か所）で一緒に
  // 消す。「見た目」の欄の部品に持たせると、選択を外す・居ない年へ動いたときに部品だけが外れて
  // 覚えが消え、確認の［残す］で生き残った下書きの打った色が、次の ON → OFF で上書きされた。
  const [autoColorWentManual, setAutoColorWentManual] = useState(false);
  const markAutoColorWentManual = useCallback(() => setAutoColorWentManual(true), []);
  // 教訓 5.12: the save-failure / validation message is dedicated state. It is
  // cleared by ONLY three契機 — a same-operation re-save attempt, an explicit
  // dismiss, or a妥当値での再保存成功.
  const [message, setMessage] = useState<string | null>(null);
  // N-04: 打ちかけを捨てる前の確認。null なら確認は出ていない。
  const [pendingDiscard, setPendingDiscard] = useState<DraftOrigin | null>(null);
  /**
   * **自分が保存した直後の値**（教訓 5.53 の例外はこれ 1 つだけ）。保存が成功すると
   * 錨が 1 本増えて編集対象（地物×錨×年）が変わるので、素の「種と違う」判定では
   * 自分で保存した直後に「入力中の内容が失われます」と聞かれる。
   *
   * 旧: 「いまの確定済みの姿とも違う」を条件に足していた。しかしそれだと
   * **0 年で A→B と打って、移動先 1200 年の確定名がたまたま B だったとき**、確認なしで
   * 「0 年へ B を保存する」という意図が消えていた（GPT#2）。例外の相手を
   * 「自分が保存した値」だけに絞ると、この穴が閉じる。
   */
  const [savedValues, setSavedValues] = useState<PropertyEditValues | null>(null);

  // 「打ちかけの内容がある」＝ **種にした姿と違う**こと（ただし自分の保存の直後を除く）。
  const dirty =
    !propertyValuesEqual(draft, seed.baseline) &&
    !(savedValues !== null && propertyValuesEqual(draft, savedValues));

  // **打ちかけの相手を外へ知らせる**（増分 4 の手直し B11）。一覧のその場編集は
  // 素性欄とまったく同じ保存の 1 本を通るので、素性欄が同じ地物を打ちかけていると
  // **黙って上書きされる**（対象が変わっていないので N-04 の確認も出ない）。
  // 打ちかけを持っているのはこの欄なので、持っている事実だけを渡し、書き込みを
  // 断るかどうかは呼び出し側に決めてもらう（K-5 の趣旨: 一時状態を黙って失わせない）。
  useEffect(() => {
    if (draftStatus === undefined) return;
    draftStatus.set(dirty ? targetFeatureId : null);
  }, [draftStatus, dirty, targetFeatureId]);
  useEffect(() => {
    if (draftStatus === undefined) return;
    return () => {
      draftStatus.set(null);
    };
  }, [draftStatus]);

  // 鍵を「読むだけ」にしたら下書きは **黙って捨てる**（K-5 / GPT#2）。編集経路そのものが
  // 閉じるので、開け直したときに古い打ちかけが復活してはいけない。確認を出さないのは、
  // 利用者自身が閉じた操作だからである。
  const [wasEditable, setWasEditable] = useState(canEdit(mode));
  // 鍵を閉じると選択も外れる（store.setMode が一時状態を捨てる）ので、**同じ描画で**
  // 「対象が変わった」の枝も成立してしまう。捨てたばかりのときは確認を出さない。
  let discardedForLock = false;
  if (wasEditable !== canEdit(mode)) {
    setWasEditable(canEdit(mode));
    if (!canEdit(mode)) {
      discardedForLock = true;
      setPendingDiscard(null);
      setSeed({ key: editTargetKey, baseline, origin });
      setDraft(baseline);
      setAutoColorWentManual(false); // 増分 8E の再手直し: 覚えも下書きと一緒に作り直す
      setSavedValues(null);
    }
  }

  if (!discardedForLock && pendingDiscard === null && seed.key !== editTargetKey) {
    // 編集対象そのものが変わった（別の地物・別の錨・別の年・地物が解決できなくなった）。
    if (dirty && seed.origin !== null) {
      // **打ちかけがあるなら捨てない**。確認を出して利用者に決めてもらう（N-04）。
      // 本設計は時刻を動かす頻度が上がるので、黙って消すと被害が比例して増える。
      // 確認そのものは素性欄の枝の外に描く（地物が解決できないときにも出す、反証 F3）。
      setPendingDiscard(seed.origin);
    } else {
      setSeed({ key: editTargetKey, baseline, origin });
      setDraft(baseline);
      setAutoColorWentManual(false); // 増分 8E の再手直し: 覚えも下書きと一緒に作り直す
      setSavedValues(null);
    }
  } else if (
    !discardedForLock &&
    pendingDiscard === null &&
    !propertyValuesEqual(seed.baseline, baseline)
  ) {
    // 同じ編集対象のまま、確定済みの姿だけが変わった（取り消し・やり直し・外部読み込み・
    // 鍵を「読むだけ」にしたあとの読み直し）。**こちらは黙って追従する**のが正しい向きで
    // ある（A9 / BH1-01。ドメインの巻き戻しは打ちかけより強い）。追従しないと、取り消した
    // はずの名前が保存で復活した。捨てる契機の表は module 冒頭にある（K-5）。
    setSeed({ key: editTargetKey, baseline, origin });
    setDraft(baseline);
    setAutoColorWentManual(false); // 増分 8E の再手直し: 覚えも下書きと一緒に作り直す
    setSavedValues(null);
  }

  // --- 引き継ぎの予告（A1 / 反証 F1。設計書 §D.3 の「危険と打ち消し方」） ------
  //
  // 錨は「その時点の全体の写し」なので、T より後ろの錨は直す前の値の写しを持っている。
  // 保存はその写しも「次にその属性が本当に変わる錨」まで新値へ引き継ぐ（ドメインの
  // `applyCarryForward`）。**画面はその範囲を押す前に文字で見せる**。数え直さず、
  // ドメインとまったく同じ純粋関数を呼ぶ（教訓 5.29）。
  const carryPreview = useMemo(() => {
    const editTime = editPlan.editTime;
    if (feature === null || governing === null || editTime === null) {
      return { targets: [] as readonly AnchorEntry[], diverging: null as AnchorEntry | null };
    }
    const before = carriedAttributesOf(feature);
    return {
      targets: carryForwardTargets(
        governing.series.entries,
        editTime,
        feature.id,
        before,
        draft,
        calendar,
      ),
      diverging: nextDivergingEntry(
        governing.series.entries,
        editTime,
        feature.id,
        before,
        draft,
        calendar,
      ),
    };
  }, [feature, governing, editPlan.editTime, draft, calendar]);

  const saveEffect = useMemo(
    () =>
      saveEffectOf(
        editPlan,
        carryPreview.targets.map((e) => formatTimePoint(e.start)),
        carryPreview.diverging === null ? null : formatTimePoint(carryPreview.diverging.start),
      ),
    [editPlan, carryPreview],
  );

  // 教訓 5.24 の裏面（A6 / GPT#6）: 「1500年に錨を作って保存」と書いてあるボタンが、
  // 値が同じだと黙って何もしない状態だった。**押せないことと、その代わりの一手を出す。**
  const noOpDraft = feature !== null && isNoOpEdit(feature, draft);

  // A4 (c): 確認が開いているあいだ、ホストは大域ショートカットを止める。開閉が変わった
  // ときだけ伝える（描画のたびに呼ぶと親が無駄に再描画する）。
  /**
   * 素性欄の中で開いている板を名前で数え、1 本の口へまとめて上へ報せる
   * （司令塔の決定 (13)）。素性欄は「全部の年から消す」の確認と「錨を削除」の確認の
   * 2 枚を持つので、真偽値を 2 つ OR する形にすると板が増えるたびに書き足しが要る。
   */
  const propertyModals = useModalChannels();
  const { onModalChange } = props;
  const propertyModalOpen = propertyModals.anyOpen;
  useEffect(() => {
    onModalChange?.(propertyModalOpen);
  }, [onModalChange, propertyModalOpen]);
  useEffect(
    () => () => {
      onModalChange?.(false);
    },
    [onModalChange],
  );

  const { onDraftConfirmChange } = props;
  const draftConfirmOpen = pendingDiscard !== null;
  useEffect(() => {
    onDraftConfirmChange?.(draftConfirmOpen);
  }, [onDraftConfirmChange, draftConfirmOpen]);
  useEffect(
    () => () => {
      // 素性欄が外れるときは必ず解除する（教訓 5.2: 一時状態は全経路で捨てる）。
      onDraftConfirmChange?.(false);
    },
    [onDraftConfirmChange],
  );

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
    setAutoColorWentManual(false); // 増分 8E の再手直し: 覚えも下書きと一緒に作り直す
    setSavedValues(null);
    // 判断用のメッセージは残す（教訓 5.12: 3 つの契機に「対象の変更」は入らない）。
  }, [editTargetKey, baseline, origin]);

  /** 打ちかけを続けるために、打っていた場所へ戻る。 */
  const returnToDraftOrigin = useCallback(() => {
    const origin = pendingDiscard;
    setPendingDiscard(null);
    if (origin === null) return;
    store.getState().setCurrentTime(origin.time, TIME_CHANGE_SOURCE.AnchorSync, () => {
      if (origin.featureId !== targetFeatureId) store.getState().setActiveFeature(origin.featureId);
    });
  }, [pendingDiscard, store, targetFeatureId]);

  // --- 保存 ------------------------------------------------------------------
  const handleSave = useCallback((): boolean => {
    if (feature === null) {
      setMessage(`${PROPERTY_STRINGS.saveFailedPrefix}${PROPERTY_TEXT.saveFailedTargetUnresolved}`);
      return false;
    }
    if (editPlan.editTime === null) {
      setMessage(
        `${PROPERTY_STRINGS.saveFailedPrefix}${editPlan.reason ?? PROPERTY_TEXT.saveFailedNotThisYear}`,
      );
      return false;
    }
    // 旧: 基本情報の開始年/終了年に対する WRITE 側の年境界ガード (bughunt 第12波 #2)。
    // **入力欄そのものを無くしたので不要になった**（A7 / GPT#8）。飾りの年は読み取り
    // 専用になり、保存には地物が持っている値がそのまま載る（読み込み時の schema が
    // 既に範囲を保証している）。
    // FR-98 の WRITE ガード（長すぎる詳細文書）。ドメインの RangeError は最後の防波堤で
    // あって UX ではない。判定は単一真実源 planDetailDocumentEdit を通す（教訓 5.29）。
    const docPlan = planDetailDocumentEdit(feature, draft.detailDocument);
    if (docPlan.kind === DETAIL_DOCUMENT_PLAN.TooLong) {
      setMessage(detailDocumentTooLongMessage(docPlan.length));
      return false;
    }
    // 教訓 5.24: no-op guard. 値が同じ保存は dispatch しない（幽霊の取り消しを作らない）。
    // **Ctrl+K（この年に錨を作る）はこの関門に飲まれない別のコマンド**である（設計書 §D.3）。
    if (isNoOpEdit(feature, draft)) {
      setMessage(null);
      // **値が同じでも「次へ」は進める**（設計書 §E.1 の V4）。220 件を送っている途中で
      // 「この 1 件は直さなくてよい」と判断したとき、Enter で次へ行けないと詰まる。
      return true;
    }
    try {
      editDispatch.dispatchEdit(buildEditIntent(feature, editPlan.editTime, draft));
      setMessage(null);
      // 教訓 5.53: 保存が成功すると編集対象（地物×錨×年）が変わる。**いま保存した値**
      // だけを例外として覚えておき、次に対象が変わったときに黙って追従させる。
      setSavedValues(draft);
      return true;
    } catch (err) {
      setMessage(`${PROPERTY_STRINGS.saveFailedPrefix}${String(err)}`);
      return false;
    }
  }, [feature, editPlan, draft, editDispatch]);

  /**
   * 名前欄・種別欄の Enter =「**保存して次へ**」（設計書 §I.2 / §C.5）。
   * `Ctrl+Enter` は保存だけして次へ進まない。**保存が通ったときだけ送る** ――
   * 断られたのに次の地物へ飛ぶと、理由を読む前に画面が変わってしまう（教訓 5.12）。
   */
  const handleSubmitField = useCallback(
    (advance: boolean): void => {
      if (pendingDiscard !== null) return;
      // **保存できないときは理由を出す**（増分 4 の手直し B11）。旧版は黙って return
      // していたので、Enter を押しても何も起きず、なぜ保存できないのか（その年に錨が
      // 無い・読むだけ・値が同じ）が画面のどこにも出なかった。理由は保存ボタンの
      // 可否を決めている `decideEditPlan` が既に持っている（同じ 1 本、教訓 5.30）。
      if (!editPlan.savable) {
        setMessage(editPlan.reason ?? PROPERTY_STRINGS.saveUnavailable);
        return;
      }
      const saved = handleSave();
      if (!saved || !advance) return;
      onAdvanceBundle?.();
    },
    [handleSave, editPlan.savable, editPlan.reason, pendingDiscard, onAdvanceBundle],
  );

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
  // 書き換えさせない。§C.6 の「集約地物の下位領域の錨」は読むための表示である）。
  // 確認が出ているあいだは **背後の編集をすべて止める**（A4 (c) / GPT#2。教訓 5.14:
  // 重なる UI は入力を受ける層も同時に設計する）。存続期間の操作・地物の削除・保存の
  // 3 つはこの枝で、Ctrl+K と Delete などの鍵盤は下の `onDraftConfirmChange` で
  // ホストの shortcutsSuspended に載せる。
  const intervalEditable =
    anchorIntervalDispatch !== undefined &&
    editable &&
    !inherited &&
    ownSeries !== null &&
    pendingDiscard === null;

  // FR-98: an object-reference (feature:) link in the preview promotes the target
  // through the SAME store.setActiveFeature path every selection uses (教訓 5.29).
  const handleSelectFromDocument = useCallback(
    (featureId: FeatureId): void => {
      store.getState().setActiveFeature(featureId);
    },
    [store],
  );

  /**
   * 本物の存続期間（U-23: 正本は錨の並び）を 1 行にする（増分 2 の手直し B3）。
   *
   * **親の系列そのものから出す。** 旧版は「錨表に出している並び」（集約地物の下位領域では
   * 絞り込んだあと）の先頭と末尾だけを見ていたので、子の存在期間ではなく「その子に
   * 関わる錨の最初と最後」を出していた。さらに **途中に存在しない期間（穴）があっても
   * 1 本に見せていた**（設計 C4 / 反証 F7 / バグ狩り #7）。いまは
   * 「0年 → 2000年、3000年 → 継続中」のように穴を隠さない。
   */
  const existenceLabel = useMemo<string | undefined>(() => {
    if (displaySeries === null || targetFeatureId === null) return undefined;
    const runs = existenceRunsOf(displaySeries.entries, targetFeatureId, calendar);
    if (runs.length === 0) return undefined;
    return runs
      .map((run) => {
        const end =
          run.end === null ? PROPERTY_STRINGS.existenceOpenEnd : formatTimePoint(run.end);
        return `${formatTimePoint(run.start)} → ${end}`;
      })
      .join(PROPERTY_STRINGS.existenceRunSeparator);
  }, [displaySeries, targetFeatureId, calendar]);

  /**
   * 親欄の 3 ボタンの配線（増分 7 の中身 3b）。**3 つとも渡されているときだけ**繋ぐ ――
   * 1 つでも欠けたまま押せるようにすると「押せるのに動かない部品」ができる。
   */
  const onParentPick = props.onParentPick;
  const onParentCreate = props.onParentCreate;
  const onParentClear = props.onParentClear;
  const parentActions = useMemo(() => {
    if (
      targetFeatureId === null ||
      onParentPick === undefined ||
      onParentCreate === undefined ||
      onParentClear === undefined
    ) {
      return null;
    }
    const id = targetFeatureId;
    return {
      onParentPick: () => onParentPick(id),
      onParentCreate: () => onParentCreate(id),
      onParentClear: () => onParentClear(id),
    };
  }, [targetFeatureId, onParentPick, onParentCreate, onParentClear]);

  /**
   * 「この年に終わったことにする」（設計書 §A.3 の入口 A。増分 7 の中身 5）。文言には
   * **いま見ている年**を入れる ―― どの年で終わることになるのかが押す前に読めないと、
   * T25 の事故（見えている終了年が飾りだった）が形を変えて戻る。
   */
  const onEndHere = props.onEndHere;
  const endHereDisabledReason = props.endHereDisabledReason;
  const endHereAction = useMemo(() => {
    if (targetFeatureId === null || onEndHere === undefined) return null;
    const id = targetFeatureId;
    // **いま居る区間に終わりが打たれていれば、その年を言う**（司令塔の決定 (12) / GPT #5）。
    // 旧版は「終わりのある最初の錨」から引いていたので、過去に終わって後で再び現れた
    // 地物や、終わる年より前を見ているときも「終わっています」と言っていた。いま見ている
    // 年の解決結果（`existence`）から決める。終わった後の年の表示は下の `ended` の欄。
    const endsAt = existence.kind === 'present' ? existence.endsAt : null;
    return {
      onEndHere: () => onEndHere(id),
      endHereLabel: PROPERTY_STRINGS.endHereLabel(formatYear(currentTime.year)),
      endHereDisabledReason: endHereDisabledReason?.(id) ?? null,
      ...(endsAt === null
        ? {}
        : { endStateText: PROPERTY_STRINGS.endHereFuture(formatYear(endsAt.year)) }),
    };
  }, [targetFeatureId, onEndHere, endHereDisabledReason, currentTime, existence]);

  /** 影響の一覧を押した瞬間に解く（全錨の走査なので、開いている間は再計算しない）。 */
  const resolveDeleteImpactPort = props.resolveDeleteImpact;
  const resolveDeleteImpactRef = useCallback(
    (featureId: FeatureId): DeleteImpactView => {
      if (resolveDeleteImpactPort === undefined) {
        throw new Error(PROPERTY_TEXT.deleteImpactPortMissing);
      }
      return resolveDeleteImpactPort(featureId);
    },
    [resolveDeleteImpactPort],
  );

  // **地物を替えたらスクロール位置を先頭へ戻す**（現状分析 C5 の④ / 設計書 §C.6）。
  // 旧: 前の地物で下のほうを見ていると、次の地物でも同じ位置から始まるので、名前欄が
  // 画面の外にある状態で開く。220 件を送る作業では毎回それが起きる。
  //
  // **DOM を名前で探さない**（結合点 #3 の反省）。自分の根から**祖先をたどって最初に
  // 実際にスクロールしている器**を見つけて戻す ―― 器が誰かは素性欄の関心事ではないので、
  // 器の testid やクラスに依存しない形にしてある。
  useEffect(() => {
    if (targetFeatureId === null) return;
    let el: HTMLElement | null = rootRef.current;
    while (el !== null) {
      if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) {
        el.scrollTop = 0;
        return;
      }
      el = el.parentElement;
    }
    // **この effect は名前欄の焦点より先に走らなければならない**（下の
    // `appliedNameFocusRef` の effect が真下に置いてあるのはそのため）。順番が逆だと、
    // 束の送りで「名前欄へ寄せる → 地物が変わったので先頭へ戻す」となって、寄せた
    // ぶんが取り消される（実測: 素性欄の器 156px に対し名前欄が 91px 下に残った）。
  }, [targetFeatureId]);

  // 焦点は **描き直したあと** に入れる（上の `nameFocusRequest` の注記）。
  //
  // **1 つの要求につき 1 回だけ**入れる。`targetFeatureId` を依存に入れているのは
  // 「要求が来たときにまだ入力欄が無い」場合に次の描画で拾うためだが、番号で締めないと
  // **選択が変わるたびに焦点が入り続ける**。実データの探索でそれを踏んだ ―― 取り消しで
  // 選択が動いた拍子に名前欄へ焦点が入り、**続けて押した Ctrl+Z が入力欄に食われて
  // 2 回目以降の取り消しが効かなかった**（`focus-guard` は編集要素の上では大域
  // ショートカットを立ち止まらせる）。
  /**
   * 焦点を一覧へ返す（2026-09-06、2 回目の手直し。名前欄の Escape）。
   *
   * **一覧は別の部品**なので ref は渡ってこない。役割で探す（`role="tree"` を持つ
   * 一覧の器）1 か所だけに閉じ込め、見つからなければ何もしない（一覧を出していない
   * 画面でも壊れない）。焦点が入るのは器なので、`aria-activedescendant` で示している
   * 行がそのまま「いま居る行」になる。
   */
  const focusLedger = useCallback((): void => {
    if (typeof document === 'undefined') return;
    const list = document.querySelector('[data-testid="ledger-scroller"]');
    if (list instanceof HTMLElement) list.focus();
  }, []);

  const appliedNameFocusRef = useRef(0);
  useEffect(() => {
    if (nameFocusRequest === 0 || appliedNameFocusRef.current === nameFocusRequest) return;
    const el = nameInputRef.current;
    if (el === null) return;
    appliedNameFocusRef.current = nameFocusRequest;
    // **焦点の既定のスクロールに任せない**（増分 4 の手直し A2）。保存列を重ねていた頃に
    // 名前欄がその下へ潜ったので入れた形である。いまは重ねない 3 段の flex なので潜らないが
    // （教訓 5.61）、本文が低いと既定のスクロールでは端に掛かるので、**真ん中へ寄せる**。
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center' });
    el.select();
  }, [nameFocusRequest, targetFeatureId]);

  return (
    <div className="property-panel" data-testid="property-panel" ref={rootRef}>
      {/* N-04 の確認は **素性欄の枝の外**に描く。選択が外れた／その年に地物が居なく
          なった経路でも打ちかけは失われうるのに、旧版は feature !== null の枝の中に
          あったので確認そのものが出なかった（反証 F3）。 */}
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
            <button type="button" data-testid="draft-discard-keep" onClick={returnToDraftOrigin}>
              {PROPERTY_STRINGS.draftDiscardKeep}
            </button>
            <button type="button" data-testid="draft-discard-drop" onClick={discardDraft}>
              {PROPERTY_STRINGS.draftDiscardDrop}
            </button>
          </div>
        </div>
      )}
      {feature === null && absentName !== null && (existence.kind === 'ended' || existence.kind === 'not-yet') ? (
        // **選択は保ったまま、居ない理由を名前で言う**（司令塔の決定 (12)）。終わらせた年
        // （以後）に「選択された地物が見つかりません。」と出すと、押した操作が失敗した
        // ように読める（設計適合 指摘 5 / バグ狩り 2-3）。
        <div className="property-panel__absent" data-testid="property-absent">
          <div className="property-panel__head" data-testid="property-panel-head">
            <div className="property-panel__title">
              <span className="property-panel__name" data-testid="property-title-name">
                {absentName}
              </span>
            </div>
          </div>
          <p className="property-panel__guidance" data-testid="end-here-state">
            {existence.kind === 'ended'
              ? existence.reappearsAt === null
                ? PROPERTY_STRINGS.endHereState(formatYear(existence.endedAt.year))
                : PROPERTY_STRINGS.endHereStateReappears(
                    formatYear(existence.endedAt.year),
                    formatYear(existence.reappearsAt.year),
                  )
              : PROPERTY_STRINGS.notYetState(formatYear(existence.startsAt.year))}
          </p>
        </div>
      ) : feature === null ? (
        <GuidanceMessage decision={decision} />
      ) : (
        <>
          {/* 見出しと編集時刻バッジ。**スクロールしても消えない**（設計書 §C.6）。 */}
          <div className="property-panel__head" data-testid="property-panel-head">
            <div className="property-panel__title">
              <span className="property-panel__name" data-testid="property-title-name">
                {shownName(feature)}
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

          {/* **スクロールするのはここだけ**（2026-09-06、2 回目の手直し）。
              見出しと保存列は重ねずに上下へ並べ、この本文が残りの高さを受け取る。
              以前は見出しを `sticky; top`、保存列を `sticky; bottom` で **中身の上に
              重ねて**いたので、保存列が育つ年（錨のない年は説明文＋ボタン 2 つで
              103px）には、あいだの帯が 20px しか残らず **名前欄がどのスクロール位置
              でもマウスで押せなかった**（教訓 5.61 の再々発）。重ねない作りなら、
              保存列がいくら育っても本文がその上に残る。 */}
          <div className="property-panel__body" data-testid="property-panel-body">
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
              nameInputRef={nameInputRef}
              onSubmit={handleSubmitField}
              pristine={!dirty}
              onEscape={focusLedger}
              autoColorWentManual={autoColorWentManual}
              onAutoColorWentManual={markAutoColorWentManual}
              {...(props.paletteThemes ? { paletteThemes: props.paletteThemes } : {})}
              {...(areaKm2 !== undefined ? { areaKm2 } : {})}
              {...(lengthKm !== undefined ? { lengthKm } : {})}
              {...(parentName !== undefined ? { parentName } : {})}
              {...(existenceLabel !== undefined ? { existenceLabel } : {})}
              {...(parentActions === null ? {} : parentActions)}
              {...(endHereAction === null ? {} : endHereAction)}
            />

            {/* 集約地物の下位領域（実データで 86 件）は自分の歴史を持たない。**錨の欄ごと消す**の
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
                // resetting its transient state (教訓 5.2).
                key={targetFeatureId ?? 'none'}
                rows={anchorRows}
                featureIdForDiff={feature.id}
                currentTime={currentTime}
                calendar={calendar}
                selectedAnchorId={effectiveAnchorId}
                onSelectAnchor={handleSelectAnchor}
                {...(intervalEditable
                  ? { featureId: feature.id, onEditInterval: handleEditInterval }
                  : {})}
                onModalChange={propertyModals.channel('anchor-delete-impact')}
                resolveParentName={resolveParentName}
                openStartEditor={
                  startEditorSignal !== null && startEditorSignal.featureId === targetFeatureId
                    ? startEditorSignal
                    : null
                }
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

            {/* **削除の入口 B**（設計書 §A.3 / 増分 7 の中身 5）。「全部の年から消す」は
                取り返しがつかないので **畳んだ節の中**へ下ろす ―― 目立つ位置に置くのは
                「この年に終わったことにする」（入口 A、上の存続期間の行の隣）のほうである。
                N-03 / K-6: このボタンだけが権限の関門を素通りしていて表示専用でも押せた。 */}
            {onDeleteFeature !== undefined && (
              <details className="property-panel__danger" data-testid="danger-zone">
                <summary data-testid="danger-zone-summary">
                  {PROPERTY_STRINGS.dangerZoneTitle}
                </summary>
                <DeleteFeatureButton
                  target={{ kind: DELETE_TARGET_KIND.ActiveFeature, featureId: feature.id }}
                  onConfirm={onDeleteFeature}
                  editable={editable && pendingDiscard === null}
                  featureName={feature.attributes.name}
                  {...(props.resolveDeleteImpact === undefined
                    ? {}
                    : { resolveImpact: () => resolveDeleteImpactRef(feature.id) })}
                  onModalChange={propertyModals.channel('delete-impact')}
                />
              </details>
            )}
          </div>

          {/* 保存列。**素性欄の下端に固定**する（設計書 §C.6 / C7）。現物は保存ボタンの
              offsetTop が 755.8px で初期表示（高さ 362px）の外にあり、誰も見なかった
              （BH1-03）。押す前に行き先が読める文言はここに出る。 */}
          <div className="property-panel__save-bar" data-testid="property-save-bar">
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
              <p
                className="property-panel__save-reason"
                data-testid="save-disabled-reason"
                title={editPlan.reason}
              >
                {editPlan.reason}
              </p>
            )}

            {/* **押す前に効く範囲を見せる**（A1 / 設計書 §D.3 の「危険と打ち消し方」）。
                保存は後ろの錨が持つ「直す前の値の写し」も、次にその属性が本当に変わる
                錨まで新値へ引き継ぐ。だから「いつまでこの姿が続くのか」を常に出す。 */}
            {saveEffect.effectRange !== null && (
              <p className="property-panel__save-effect" data-testid="save-effect-range">
                {saveEffect.effectRange}
              </p>
            )}

            {/* A6 / GPT#6: 値が変わっていないのに「錨を作って保存」と書いてあるボタンが
                押せて、押しても黙って何も起きなかった。押せなくしたうえで、代わりの
                一手（この年に錨だけ作る）を文字で出す。 */}
            {editable && editPlan.savable && noOpDraft && (
              <p
                className="property-panel__save-reason"
                data-testid="save-no-change-note"
                title={
                  editPlan.kind === EDIT_PLAN_KIND.NewAnchor
                    ? EDIT_PLAN_STRINGS.noChangeNoteWithCreateAnchor(formatYear(currentTime.year))
                    : EDIT_PLAN_STRINGS.noChangeNote
                }
              >
                {editPlan.kind === EDIT_PLAN_KIND.NewAnchor
                  ? EDIT_PLAN_STRINGS.noChangeNoteWithCreateAnchor(formatYear(currentTime.year))
                  : EDIT_PLAN_STRINGS.noChangeNote}
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
                  disabled={!editPlan.savable || pendingDiscard !== null || noOpDraft}
                  onClick={handleSave}
                >
                  {saveEffect.saveLabel}
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
