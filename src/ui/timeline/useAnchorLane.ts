// UI layer (U21 / 時刻レール): 錨レーンの素材と集計を持つ hook（設計書 §F.2）。
//
// **費用の置き場所を 2 つに分けるのがこの hook の役目である。**
//   - 素材（系列を引く・選り分ける・U02 で正規化する）… **選択が変わったとき**と
//     **プロジェクトの世代が変わったとき**だけ。
//   - 集計（`Uint32Array` 1 本への 1 パス）… **表示範囲**と**軸の画素数**が変わったとき。
//
// **現在時刻は依存に入れない**（規則 4）。入れると再生の 1 コマごとに 5 万錨を数え直す
// ことになる。まとめ役の子の選り分け（親の全錨 × その子の形の比較）はさらに重いので、
// 素材の側にしか置かない ―― §F.2 規則 1 の但し書きが「引くのは選択が変わったときだけ」と
// 明記している。
//
// 選り分けそのものは **増分 2 で錨表に入れた `anchorRowsOf` をそのまま使う**（教訓 5.44:
// 同じ判定の写しを作らない）。錨表とレーンで「その子に関わる錨」の顔ぶれが割れない。

import { useCallback, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { AnchorEntry, AnchorSeries } from '../../domain/anchor-series';
import type { FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import type { Calendar } from '../../domain/time/calendar';
import { normalize } from '../../domain/time/normalized';
import type { TimePoint } from '../../domain/time/time-point';
import type { AnchorLaneStats } from '../e2e/rail-observation';
import { anchorRowsOf, existenceRunsOf } from '../property/anchor-diff';
import { SIDEBAR_CONTENT_STRINGS } from '../shell/strings';
import type { SessionStore } from '../state/store';
import {
  EMPTY_LANE_AGGREGATE,
  EMPTY_LANE_SOURCE,
  aggregateAnchorLane,
  laneSourceOf,
  markColumnsOf,
  type AnchorLaneAggregate,
  type AnchorLaneSource,
} from '../time/anchor-lane';
import { resolveGoverningSeries } from '../time/governing-series';
import type { TimeBarView } from '../time/timebar';

export interface AnchorLaneBinding {
  /** レーンの素材（正規化済みの開始と存続期間）。 */
  readonly source: AnchorLaneSource;
  /** 1 パス集計の結果。 */
  readonly aggregate: AnchorLaneAggregate;
  /** レーンが描いている錨（`source.starts` と同じ添字）。 */
  readonly entries: readonly AnchorEntry[];
  /**
   * 編集が書き込まれる系列 **そのもの**（選り分ける前）。編集時刻バッジは
   * 「この年に錨があるか」で行き先を決めるので、**選り分けたあとの並びを渡しては
   * いけない** ―― まとめ役の子では「その子に関わらない錨」も上書きの相手になりうる。
   */
  readonly governingSeries: AnchorSeries | null;
  /** 選んでいる地物の id（無ければ null）。 */
  readonly featureId: FeatureId | null;
  /** まとめ役の子か（親の系列を借りているか）。 */
  readonly inherited: boolean;
  /** 借りているときの持ち主の名前。 */
  readonly ownerName: string | null;
  /** 錨が 1 本だけで、しかも時間軸の左端にあるか（設計書 §H.4 の空状態）。 */
  readonly onlyOrigin: boolean;
  /** 観測（`window.__E2E__.getAnchorLaneStats`）。 */
  readonly stats: () => AnchorLaneStats;
  /** 印の画素位置（観測）。 */
  readonly markPositions: () => readonly number[];
  /** 当たり判定にかかった時間を控える（観測の `lastHitTestMs`）。 */
  readonly recordHitTestMs: (ms: number) => void;
  /** レーンの高さ（px）を控える（観測の `laneHeightPx`）。 */
  readonly recordLaneHeight: (px: number) => void;
}

export function useAnchorLane<S>(
  store: StoreApi<SessionStore<S>>,
  view: TimeBarView,
  calendar: Calendar,
  timelineMin: TimePoint,
  /**
   * ドメインの根を引く口。**合成ルートだけが型を知っている**（セッションストアの
   * `domain` は総称なので、この hook からは `DomainProject` と名乗れない）。渡されない
   * ときはレーンを空のままにする（honest stub ―― 無い機能を有るように見せない）。
   */
  getRoot?: () => DomainProject,
): AnchorLaneBinding {
  const activeFeature = useStore(store, (s) => s.activeFeature);
  // 世代の見張り。**値そのものは `getRoot()` から取る**が、`recordCommand` で根が
  // 差し替わったことを知るための依存としてここを購読する（教訓 5.5）。
  const generation = useStore(store, (s) => s.domain);

  const costs = useRef({
    sourceCount: 0,
    lastSourceMs: 0,
    aggregateCount: 0,
    lastAggregateMs: 0,
    lastHitTestMs: 0,
    laneHeightPx: 0,
  });
  const scratch = useRef<Uint32Array>(new Uint32Array(0));

  /**
   * 素材。**依存は「世代」と「選択」の 2 つだけ。**
   *
   * `resolveGoverningSeries` は「その時刻に自分を含む履歴」を引くので時刻を要るが、
   * **依存には入れない** ―― ここで読むのは「選択が変わった瞬間の現在時刻」であり、
   * それが §F.2 規則 1 の但し書き「引くのは選択が変わったときだけ」の意味である。
   * 時刻を依存に入れると、再生の 1 コマごとに親の全錨を選り分け直すことになる。
   */
  const resolved = useMemo(() => {
    void generation;
    const root = getRoot?.();
    if (activeFeature === null || root === undefined) {
      return {
        source: EMPTY_LANE_SOURCE,
        entries: [] as readonly AnchorEntry[],
        governingSeries: null as AnchorSeries | null,
        inherited: false,
        ownerName: null as string | null,
      };
    }
    const started = performance.now();
    const at = store.getState().currentTime;
    const governing = resolveGoverningSeries(
      root,
      activeFeature,
      at,
      calendar,
      SIDEBAR_CONTENT_STRINGS.unknownOwnerName,
    );
    if (governing === null) {
      costs.current.sourceCount += 1;
      costs.current.lastSourceMs = performance.now() - started;
      return {
        source: EMPTY_LANE_SOURCE,
        entries: [] as readonly AnchorEntry[],
        governingSeries: null as AnchorSeries | null,
        inherited: false,
        ownerName: null as string | null,
      };
    }
    const inherited = governing.ownerName !== null;
    const rows = anchorRowsOf(governing.series.entries, activeFeature, {
      onlyRelevant: inherited,
    });
    const entries = rows.map((r) => r.entry);
    const runs = existenceRunsOf(governing.series.entries, activeFeature, calendar);
    const source = laneSourceOf(
      entries.map((e) => e.start),
      runs,
      calendar,
    );
    costs.current.sourceCount += 1;
    costs.current.lastSourceMs = performance.now() - started;
    return {
      source,
      entries,
      governingSeries: governing.series,
      inherited,
      ownerName: governing.ownerName,
    };
  }, [generation, activeFeature, calendar, store, getRoot]);

  /** 集計。**依存は表示範囲（ズーム・スクロール）と軸の画素数だけ**（規則 4 の (b)(c)）。 */
  const aggregate = useMemo<AnchorLaneAggregate>(() => {
    if (resolved.source.starts.length === 0 || view.pixelLength <= 0) {
      return EMPTY_LANE_AGGREGATE;
    }
    const started = performance.now();
    const result = aggregateAnchorLane(resolved.source, view, scratch.current);
    scratch.current = result.counts;
    costs.current.aggregateCount += 1;
    costs.current.lastAggregateMs = performance.now() - started;
    return result;
  }, [resolved.source, view]);

  /**
   * 「歴史の節目が 0 年にしかない」（設計書 §H.4 の空状態。**実データがまさにこれ**）。
   * 0 年に決め打ちせず、**時間軸の左端と同じ日か**で見る ―― 時間軸の下限は設定で
   * 動かせるので、数を焼き付けると設定を変えた瞬間に嘘になる。
   */
  const onlyOrigin = useMemo(() => {
    if (resolved.source.starts.length !== 1) return false;
    const only = resolved.source.starts[0];
    return only !== undefined && only === (normalize(timelineMin, calendar) as number);
  }, [resolved.source, timelineMin, calendar]);

  const stats = useCallback(
    (): AnchorLaneStats => ({
      featureId: (activeFeature as unknown as string | null) ?? '',
      inherited: resolved.inherited,
      anchorCount: resolved.source.starts.length,
      inView: aggregate.inView,
      width: aggregate.width,
      markCount: aggregate.markCount,
      denseCount: aggregate.denseCount,
      shapeCount: aggregate.shapeCount,
      maxCount: aggregate.maxCount,
      lastAggregateMs: costs.current.lastAggregateMs,
      aggregateCount: costs.current.aggregateCount,
      sourceCount: costs.current.sourceCount,
      lastSourceMs: costs.current.lastSourceMs,
      lastHitTestMs: costs.current.lastHitTestMs,
      laneHeightPx: costs.current.laneHeightPx,
    }),
    [activeFeature, resolved, aggregate],
  );

  const markPositions = useCallback(() => markColumnsOf(aggregate), [aggregate]);

  const recordHitTestMs = useCallback((ms: number) => {
    costs.current.lastHitTestMs = ms;
  }, []);
  const recordLaneHeight = useCallback((px: number) => {
    costs.current.laneHeightPx = px;
  }, []);

  return {
    source: resolved.source,
    aggregate,
    entries: resolved.entries,
    governingSeries: resolved.governingSeries,
    featureId: activeFeature,
    inherited: resolved.inherited,
    ownerName: resolved.ownerName,
    onlyOrigin,
    stats,
    markPositions,
    recordHitTestMs,
    recordLaneHeight,
  };
}
