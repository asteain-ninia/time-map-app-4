// UI layer (U32 / property panel): the anchor LIST view (FR-84) + per-anchor存続期間
// editor (HB3-12, FR-54〜FR-59).
//
// Displays the target feature's anchor series in start-time ascending order — the series
// is taken AS GIVEN from U09 (single source of truth); this component never re-sorts or
// re-validates it (spec §やらないこと).
//
// **増分 2 で 2 つ変えた**（実装計画の中身 5 / 設計書 §C.6 の錨表）。
//
//   1. **行に「その年に何が変わったか」を書く。** 現物の行は「0年 → 継続中」しか言わず、
//      錨が 10 本に育つと同じ見た目の行が 10 行並んで**何が起きたのか読み取れなかった**
//      （現状分析 N-45）。差分は前後 2 本のスナップショットを見比べて計算する
//      （{@link diffSentence}）ので、保存形式には何も足していない。
//   2. **行 28px 固定・仮想スクロール。** 現物は `series.entries.map` で全件を DOM に
//      作っていたので、裁定 2(b) の「1 地物に極めて多くの錨」で破綻する（設計書 §O の
//      B-19 / GPT 5万錨）。既定は**現在時刻の前後 12 本**だけを母数にし、［全部見る］で
//      全件へ広げる。どちらでも DOM に載る行は窓に見えているぶん＋余白だけである。
//
// 差分の文は **画面に載っている行だけ** 計算し、錨 ID を鍵に使い回す（§C.6 の規模規則）。
// 実データには 2,230 頂点の地物があるので、全件ぶんを毎回計算してはいけない。
//
// HB3-12 — 存続期間の編集は **選ばれている錨 1 本ぶんだけ** を一覧の下に出す。行の中に
// 畳んだエディタを埋めると行の高さが可変になり、仮想スクロールが成り立たない。編集した
// い錨を選んでから触る、という手順は「編集対象を選ぶ」という既存の意味とも合う。

import { useCallback, useMemo, useRef, useState } from 'react';

import type { AnchorEntry, AnchorSeries } from '../../domain/anchor-series';
import type { AnchorSnapshot } from '../../domain/anchor';
import type { AnchorId, FeatureId } from '../../domain/ids';
import type { Calendar } from '../../domain/time/calendar';
import { compare } from '../../domain/time/normalized';
import type { TimePoint } from '../../domain/time/time-point';

import { formatTimePoint } from '../timeline/time-display';
import { YearMonthDayInput } from '../timeline/YearMonthDayInput';

import { diffSentence, featureInSnapshot } from './anchor-diff';
import type { AnchorIntervalEditIntent } from './contracts';
import {
  buildChangeStartIntent,
  buildDeleteAnchorIntent,
  buildSetEndIntent,
} from './interval-edit';
import { PROPERTY_STRINGS } from './messages';

/** 行の高さ（px）。CSS の `.anchor-list__row` と**同じ値**を 1 か所で持つ。 */
export const ANCHOR_ROW_HEIGHT = 28;
/** 窓に見せる行数（＝スクロール枠の高さ / 行の高さ）。 */
export const ANCHOR_VISIBLE_ROWS = 12;
/** 窓の外に余分に作る行数（スクロール中の空白を防ぐ）。 */
export const ANCHOR_OVERSCAN_ROWS = 2;
/** 既定で出す範囲（現在時刻の前後この本数）。［全部見る］で解除する。 */
export const ANCHOR_NEIGHBOUR_COUNT = 12;

/** 母数の切り出し（現在時刻の前後 {@link ANCHOR_NEIGHBOUR_COUNT} 本）。純粋。 */
export function neighbourWindow(
  entries: readonly AnchorEntry[],
  currentTime: TimePoint,
  calendar: Calendar,
  neighbours: number = ANCHOR_NEIGHBOUR_COUNT,
): { readonly entries: readonly AnchorEntry[]; readonly offset: number } {
  if (entries.length <= neighbours * 2 + 1) return { entries, offset: 0 };
  // 現在時刻に最も近い（開始が現在時刻以下で最後の）錨を中心にする。全部が未来なら先頭。
  let center = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e === undefined) continue;
    if (compare(e.start, currentTime, calendar) <= 0) center = i;
  }
  const start = Math.max(0, Math.min(center - neighbours, entries.length - (neighbours * 2 + 1)));
  const end = Math.min(entries.length, start + neighbours * 2 + 1);
  return { entries: entries.slice(start, end), offset: start };
}

/** 仮想スクロールで実際に DOM へ作る範囲。純粋。 */
export function visibleRange(
  total: number,
  scrollTop: number,
  visibleRows: number = ANCHOR_VISIBLE_ROWS,
  overscan: number = ANCHOR_OVERSCAN_ROWS,
): { readonly start: number; readonly end: number } {
  const first = Math.max(0, Math.floor(scrollTop / ANCHOR_ROW_HEIGHT) - overscan);
  const end = Math.min(total, first + visibleRows + overscan * 2);
  return { start: Math.min(first, Math.max(0, end - (visibleRows + overscan * 2))), end };
}

export interface AnchorListProps {
  readonly series: AnchorSeries;
  /**
   * 差分の文を作る相手。まとめ役の子を選んでいるときは **その子の id** で、系列は親の
   * ものになる（設計書 §C.6「まとめ役の子の錨」）。
   */
  readonly featureIdForDiff: FeatureId;
  /** 既定の母数（現在時刻の前後）を決めるための現在時刻。 */
  readonly currentTime: TimePoint;
  /** Calendar used to validate月日 input in the per-anchor存続期間 editor (FR-70, U02). */
  readonly calendar: Calendar;
  /** The currently selected edit-target anchor id, or null. */
  readonly selectedAnchorId: AnchorId | null;
  /** Select an anchor as the edit target (syncs current time to its start). */
  readonly onSelectAnchor: (entry: AnchorEntry) => void;
  /**
   * HB3-12: the target feature id (routing for存続期間 intents). Present (with
   * {@link onEditInterval}) only when the host wired the dispatch AND the form is
   * editable; its presence shows the存続期間 editor for the selected anchor.
   */
  readonly featureId?: FeatureId;
  /** HB3-12: dispatch a存続期間 edit; returns an error message to show, or null. */
  readonly onEditInterval?: (intent: AnchorIntervalEditIntent) => string | null;
}

export function AnchorList(props: AnchorListProps): JSX.Element {
  const {
    series,
    featureIdForDiff,
    currentTime,
    calendar,
    selectedAnchorId,
    onSelectAnchor,
    featureId,
    onEditInterval,
  } = props;

  const [expanded, setExpanded] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  // 差分の文は錨 ID を鍵に使い回す（§C.6: 見えている行だけ計算する）。系列が差し替わったら
  // 捨てる — 同じ錨 ID でも中身が変わりうる（上書き保存はスナップショットを差し替える）。
  const diffCacheRef = useRef<{ series: AnchorSeries; cache: Map<AnchorId, string> }>({
    series,
    cache: new Map(),
  });
  if (diffCacheRef.current.series !== series) {
    diffCacheRef.current = { series, cache: new Map() };
  }

  const all = series.entries;
  const window_ = useMemo(
    () => (expanded ? { entries: all, offset: 0 } : neighbourWindow(all, currentTime, calendar)),
    [expanded, all, currentTime, calendar],
  );
  const dataset = window_.entries;
  const range = visibleRange(dataset.length, scrollTop);

  const sentenceFor = useCallback(
    (indexInDataset: number): string => {
      const entry = dataset[indexInDataset];
      if (entry === undefined) return '';
      const cached = diffCacheRef.current.cache.get(entry.anchor.id);
      if (cached !== undefined) return cached;
      // 「前の錨」は **元の系列の並び** から取る（母数を切り出しても前後関係は崩さない）。
      const absolute = window_.offset + indexInDataset;
      const previous = absolute === 0 ? null : (all[absolute - 1] ?? null);
      const sentence = diffSentence(previous, entry, featureIdForDiff, (id) =>
        parentNameIn(entry.anchor.snapshot, id),
      );
      diffCacheRef.current.cache.set(entry.anchor.id, sentence);
      return sentence;
    },
    [dataset, window_.offset, all, featureIdForDiff],
  );

  if (all.length === 0) {
    return (
      <p className="anchor-list__empty" data-testid="anchor-list-empty">
        {PROPERTY_STRINGS.anchorListEmpty}
      </p>
    );
  }

  const editable = featureId !== undefined && onEditInterval !== undefined;
  const soleAnchor = all.length <= 1;
  const selectedEntry =
    selectedAnchorId === null
      ? null
      : (all.find((e) => e.anchor.id === selectedAnchorId) ?? null);
  const hidden = all.length - dataset.length;

  return (
    <div className="anchor-list-view">
      <div className="anchor-list__toolbar">
        <span className="anchor-list__count" data-testid="anchor-list-count">
          {PROPERTY_STRINGS.anchorCount(all.length)}
        </span>
        {hidden > 0 && !expanded && (
          <button
            type="button"
            className="anchor-list__expand"
            data-testid="anchor-list-expand"
            onClick={() => {
              setExpanded(true);
              setScrollTop(0);
            }}
          >
            {PROPERTY_STRINGS.anchorShowAll(hidden)}
          </button>
        )}
        {expanded && (
          <button
            type="button"
            className="anchor-list__expand"
            data-testid="anchor-list-collapse"
            onClick={() => {
              setExpanded(false);
              setScrollTop(0);
            }}
          >
            {PROPERTY_STRINGS.anchorShowNearby}
          </button>
        )}
      </div>

      <ul
        className="anchor-list"
        data-testid="anchor-list"
        role="listbox"
        style={{ height: `${ANCHOR_ROW_HEIGHT * ANCHOR_VISIBLE_ROWS}px` }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {/* 上下の詰め物で「全件ぶんの高さ」を作る（スクロールバーの長さが実際の件数を表す）。 */}
        <li
          className="anchor-list__spacer"
          aria-hidden="true"
          style={{ height: `${range.start * ANCHOR_ROW_HEIGHT}px` }}
        />
        {dataset.slice(range.start, range.end).map((entry, i) => {
          const indexInDataset = range.start + i;
          const selected = entry.anchor.id === selectedAnchorId;
          return (
            <li key={entry.anchor.id} className="anchor-list__item">
              <button
                type="button"
                role="option"
                aria-selected={selected}
                data-testid={`anchor-row-${entry.anchor.id}`}
                className={
                  selected ? 'anchor-list__row anchor-list__row--selected' : 'anchor-list__row'
                }
                title={sentenceFor(indexInDataset)}
                onClick={() => onSelectAnchor(entry)}
              >
                <span className="anchor-list__time">{formatTimePoint(entry.start)}</span>
                <span className="anchor-list__diff" data-testid={`anchor-diff-${entry.anchor.id}`}>
                  {sentenceFor(indexInDataset)}
                </span>
                {entry.end !== null && (
                  <span className="anchor-list__end">
                    {PROPERTY_STRINGS.anchorEndsAt(formatTimePoint(entry.end))}
                  </span>
                )}
                {selected && (
                  <span className="anchor-list__badge" data-testid="anchor-edit-badge">
                    {PROPERTY_STRINGS.editTargetBadge}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        <li
          className="anchor-list__spacer"
          aria-hidden="true"
          style={{ height: `${Math.max(0, dataset.length - range.end) * ANCHOR_ROW_HEIGHT}px` }}
        />
      </ul>

      {editable && selectedEntry !== null && featureId !== undefined && onEditInterval !== undefined && (
        // 選ばれている錨 1 本ぶんだけ。エディタは開始/終了が変わったら作り直す（下書きを
        // 保存後の値へ種まきし直す — granularity まで見る鍵）。
        <AnchorIntervalEditor
          key={`${selectedEntry.anchor.id}-${timePointKey(selectedEntry.start)}-${
            selectedEntry.end === null ? 'open' : timePointKey(selectedEntry.end)
          }`}
          entry={selectedEntry}
          calendar={calendar}
          featureId={featureId}
          soleAnchor={soleAnchor}
          onEditInterval={onEditInterval}
        />
      )}
    </div>
  );
}

/** 親の表示名をそのスナップショットから引く。引けなければ内部 id は出さない（U-1）。 */
function parentNameIn(snapshot: AnchorSnapshot, parentId: FeatureId): string {
  const parent = featureInSnapshot(snapshot, parentId);
  return parent === null ? PROPERTY_STRINGS.unknownParentName : parent.attributes.name;
}

/** A granularity-aware key fragment for a TimePoint (remount/re-seed after an edit). */
function timePointKey(point: TimePoint): string {
  switch (point.granularity) {
    case 'year':
      return `y${String(point.year)}`;
    case 'yearMonth':
      return `ym${String(point.year)}-${String(point.month)}`;
    case 'yearMonthDay':
      return `ymd${String(point.year)}-${String(point.month)}-${String(point.day)}`;
  }
}

/**
 * Per-anchor存続期間 editor (HB3-12 / FR-70). Edits the anchor's 開始 (U09 changeStart)
 * and 終了 (U09 setEnd, with 継続中にする to clear it), and offers この錨を削除 (U09
 * deleteAnchor — disabled for the sole anchor so the feature stays resolvable, INV-5).
 * Each control assembles the typed intent and hands it to `onEditInterval`; the U09 op
 * runs in the command base (single truth source). A rejection message is held inline.
 *
 * 開始/終了 both use the SHARED {@link YearMonthDayInput} (the SAME component + pure
 * parse/validate core the timeline direct-jump uses, 教訓 5.30) so年月日粒度が選べる
 * (FR-70). The end field's onClear dispatches setEnd(null) = 継続中 (open-ended).
 */
function AnchorIntervalEditor(props: {
  readonly entry: AnchorEntry;
  readonly calendar: Calendar;
  readonly featureId: FeatureId;
  readonly soleAnchor: boolean;
  readonly onEditInterval: (intent: AnchorIntervalEditIntent) => string | null;
}): JSX.Element {
  const { entry, calendar, featureId, soleAnchor, onEditInterval } = props;
  const anchorId = entry.anchor.id;

  const [message, setMessage] = useState<string | null>(null);

  const run = (intent: AnchorIntervalEditIntent): void => {
    setMessage(onEditInterval(intent));
  };

  return (
    <details className="anchor-interval" data-testid={`anchor-interval-${anchorId}`}>
      <summary data-testid={`anchor-interval-summary-${anchorId}`}>
        {PROPERTY_STRINGS.intervalEditTitle}
      </summary>

      <p className="anchor-interval__hint">{PROPERTY_STRINGS.intervalGranularityHint}</p>
      {/* N-46: 同じ画面に「押さないと保存されない」ものと「押した瞬間に効く」ものが
          同居していた。素性の 4 つは下端の保存列に揃えたので、ここが唯一の即時確定に
          なる。**即時であることを書いておく**（取り消しは Ctrl+Z 1 手）。 */}
      <p className="anchor-interval__hint">{PROPERTY_STRINGS.intervalImmediateHint}</p>

      <YearMonthDayInput
        title={PROPERTY_STRINGS.intervalStartTitle}
        calendar={calendar}
        initialValue={entry.start}
        confirmLabel={PROPERTY_STRINGS.intervalApplyLabel}
        testId={`anchor-interval-start-${anchorId}`}
        onConfirm={(point) => run(buildChangeStartIntent(featureId, anchorId, point))}
      />

      <YearMonthDayInput
        title={PROPERTY_STRINGS.intervalEndTitle}
        calendar={calendar}
        // F2: pass the entry's ACTUAL end — `null` (継続中) is modeled directly by the
        // shared input (empty/disabled fields + 継続中 indicator, no fabricated date).
        initialValue={entry.end}
        confirmLabel={PROPERTY_STRINGS.intervalApplyLabel}
        clearLabel={PROPERTY_STRINGS.intervalClearEndLabel}
        specifyLabel={PROPERTY_STRINGS.intervalSpecifyEndLabel}
        openStateLabel={PROPERTY_STRINGS.openEndLabel}
        testId={`anchor-interval-end-${anchorId}`}
        onConfirm={(point) => run(buildSetEndIntent(featureId, anchorId, point))}
        onClear={() => run(buildSetEndIntent(featureId, anchorId, null))}
      />

      <button
        type="button"
        className="anchor-interval__delete"
        data-testid={`anchor-interval-delete-${anchorId}`}
        disabled={soleAnchor}
        onClick={() => run(buildDeleteAnchorIntent(featureId, anchorId))}
      >
        {PROPERTY_STRINGS.intervalDeleteLabel}
      </button>

      {message !== null && (
        <p
          className="anchor-interval__message"
          role="alert"
          data-testid={`anchor-interval-message-${anchorId}`}
        >
          {message}
        </p>
      )}
    </details>
  );
}
