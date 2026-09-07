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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AnchorEntry } from '../../domain/anchor-series';
import type { AnchorSnapshot } from '../../domain/anchor';
import type { AnchorId, FeatureId } from '../../domain/ids';
import type { Calendar } from '../../domain/time/calendar';
import { compare } from '../../domain/time/normalized';
import type { TimePoint } from '../../domain/time/time-point';

import { ImpactConfirmDialog } from '../shell/ImpactConfirmDialog';
import { formatTimePoint } from '../timeline/time-display';
import { YearMonthDayInput } from '../timeline/YearMonthDayInput';

import { diffSentence, featureInSnapshot, type AnchorRow } from './anchor-diff';
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
  rows: readonly AnchorRow[],
  currentTime: TimePoint,
  calendar: Calendar,
  neighbours: number = ANCHOR_NEIGHBOUR_COUNT,
): { readonly rows: readonly AnchorRow[]; readonly offset: number } {
  if (rows.length <= neighbours * 2 + 1) return { rows, offset: 0 };
  // 現在時刻に最も近い（開始が現在時刻以下で最後の）錨を中心にする。全部が未来なら先頭。
  //
  // **二分探索で探す**（2026-09-07、増分 6 の実測）。行は開始時刻の昇順（系列の不変条件
  // INV-1）なので線形に走る必要はない。5 万錨で **時刻を動かすたびに** 5 万回の
  // `compare`（U02 の正規化を 2 回ずつ通る）が走っていて、1 コマの重さに直に効いていた。
  let center = 0;
  let lo = 0;
  let hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    if (r === undefined) break;
    if (compare(r.entry.start, currentTime, calendar) <= 0) {
      center = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const start = Math.max(0, Math.min(center - neighbours, rows.length - (neighbours * 2 + 1)));
  const end = Math.min(rows.length, start + neighbours * 2 + 1);
  return { rows: rows.slice(start, end), offset: start };
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
  /**
   * 出す行（錨とその「前の錨」の組）。**「前の錨」は呼び出し側の {@link anchorRowsOf} が
   * 1 か所で決める**（増分 2 の手直し B2）。旧版はここが `series` を受け取り、絞り込んだ
   * あとの隣を「前の錨」にしていたので、選り分けの判定と行の文で根拠が食い違っていた。
   */
  readonly rows: readonly AnchorRow[];
  /**
   * 差分の文を作る相手。まとめ役の子を選んでいるときは **その子の id** で、行は親の
   * 系列から来る（設計書 §C.6「まとめ役の子の錨」）。
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
  /**
   * 「板が出ている」と名乗る口（司令塔の決定 (13)）。錨の削除の確認が出ている間、
   * 背後で Ctrl+Z / Delete が走らないようにする。
   */
  readonly onModalChange?: (open: boolean) => void;
  /**
   * 上位領域の表示名を **根から**引く落とし先（バグ狩り #5 / Fable #7）。
   *
   * 差分の文の親名はまず錨のスナップショットから引く（その年の姿を言うため）。だが
   * 所属を変えた直後は、移した地物が **自分の系列**を持ち、そのスナップショットには
   * 自分しか居ない ―― 新しい親はそこに居ないので「別の地物」と出ていた。引けなかった
   * ときだけ根から引き直す。
   */
  readonly resolveParentName?: (featureId: FeatureId) => string | null;
}

export function AnchorList(props: AnchorListProps): JSX.Element {
  const {
    rows,
    featureIdForDiff,
    currentTime,
    calendar,
    selectedAnchorId,
    onSelectAnchor,
    featureId,
    onEditInterval,
    resolveParentName,
  } = props;

  const [expanded, setExpanded] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLUListElement | null>(null);
  // いまのスクロール位置を effect から読むための写し。state を直接 dep に入れると
  // 「利用者がスクロールするたびに自動スクロールが割り込む」ことになる（C1）。
  const scrollTopRef = useRef(0);
  scrollTopRef.current = scrollTop;
  // 差分の文は錨 ID を鍵に使い回す（§C.6: 見えている行だけ計算する）。行の並びが差し替わったら
  // 捨てる — 同じ錨 ID でも中身が変わりうる（上書き保存はスナップショットを差し替える）。
  const diffCacheRef = useRef<{ rows: readonly AnchorRow[]; cache: Map<AnchorId, string> }>({
    rows,
    cache: new Map(),
  });
  if (diffCacheRef.current.rows !== rows) {
    diffCacheRef.current = { rows, cache: new Map() };
  }

  const all = rows;
  const window_ = useMemo(
    () => (expanded ? { rows: all, offset: 0 } : neighbourWindow(all, currentTime, calendar)),
    [expanded, all, currentTime, calendar],
  );
  const dataset = window_.rows;
  const range = visibleRange(dataset.length, scrollTop);

  const sentenceFor = useCallback(
    (indexInDataset: number): string => {
      const row = dataset[indexInDataset];
      if (row === undefined) return '';
      const cached = diffCacheRef.current.cache.get(row.entry.anchor.id);
      if (cached !== undefined) return cached;
      // 「前の錨」は行が持っている（母数を切り出しても前後関係は崩さない、B2）。
      // **親の名前は前後で別のスナップショットから引く**（B4 / GPT#11）。
      const sentence = diffSentence(row.previous, row.entry, featureIdForDiff, {
        before: (id) =>
          row.previous === null
            ? PROPERTY_STRINGS.unknownParentName
            : parentNameIn(row.previous.anchor.snapshot, id, resolveParentName),
        after: (id) => parentNameIn(row.entry.anchor.snapshot, id, resolveParentName),
      });
      diffCacheRef.current.cache.set(row.entry.anchor.id, sentence);
      return sentence;
    },
    [dataset, featureIdForDiff, resolveParentName],
  );

  // --- 選ばれている錨まで自動でスクロールする（C1 / バグ狩り #9 / GPT#10） -------
  //
  // 既定の母数は「現在時刻の前後 12 本」の 25 件で、窓には 12 行しか入らない。だから
  // 中央の錨は 13 行目、末尾なら 25 行目になり、**開いた直後に選択中の錨が見えない**。
  // 見えていないときだけ、その行が窓の真ん中へ来る位置へ動かす（利用者が自分で
  // スクロールした位置とは喧嘩しない）。
  const selectedIndex = useMemo(
    () =>
      selectedAnchorId === null
        ? -1
        : dataset.findIndex((r) => r.entry.anchor.id === selectedAnchorId),
    [dataset, selectedAnchorId],
  );
  useEffect(() => {
    if (selectedIndex < 0) return;
    const firstVisible = Math.floor(scrollTopRef.current / ANCHOR_ROW_HEIGHT);
    const lastVisible = firstVisible + ANCHOR_VISIBLE_ROWS - 1;
    if (selectedIndex >= firstVisible && selectedIndex <= lastVisible) return;
    const centred = Math.round(selectedIndex - (ANCHOR_VISIBLE_ROWS - 1) / 2);
    const maxRow = Math.max(0, dataset.length - ANCHOR_VISIBLE_ROWS);
    const next = Math.max(0, Math.min(centred, maxRow)) * ANCHOR_ROW_HEIGHT;
    setScrollTop(next);
    if (listRef.current !== null) listRef.current.scrollTop = next;
  }, [selectedIndex, dataset.length]);

  /**
   * 矢印キー・Home・End で錨を選び替える（C1 / 反証 F8）。**仮想スクロールの窓の外にも
   * 到達できる**ことが要点である。DOM に載っているのは見えている行だけなので、
   * 「次の行の DOM を探して押す」形では窓の外へ出られない。母数の添字で動かす。
   */
  const moveSelection = useCallback(
    (to: number): void => {
      const clamped = Math.max(0, Math.min(to, dataset.length - 1));
      const row = dataset[clamped];
      if (row === undefined) return;
      onSelectAnchor(row.entry);
    },
    [dataset, onSelectAnchor],
  );

  /**
   * Home / End は **全件の端**へ行く（増分 3。増分 2 の手直しの残り）。
   *
   * 既定の母数は「現在時刻の前後 12 本」に切ってあるので、そのまま Home を押すと
   * 「その窓の先頭」＝ 全体の先頭ではない場所へ飛ぶ。**押した人は「いちばん古い錨へ
   * 行った」と読む**ので、切り取られた窓の端で止まるのは黙って嘘をつくのと同じである。
   * そこで、まだ窓が切れているときは **［全部見る］と同じ状態へ広げてから**端へ飛ぶ。
   * 画面の上の件数表示と［近くだけ見る］ボタンが、広がったことをそのまま示す。
   */
  const moveToEnd = useCallback(
    (which: 'first' | 'last'): void => {
      const row = which === 'first' ? all[0] : all[all.length - 1];
      if (row === undefined) return;
      if (all.length > dataset.length) {
        setExpanded(true);
        setScrollTop(0);
      }
      onSelectAnchor(row.entry);
    },
    [all, dataset.length, onSelectAnchor],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>): void => {
      const from = selectedIndex < 0 ? 0 : selectedIndex;
      switch (e.key) {
        case 'ArrowDown':
          moveSelection(selectedIndex < 0 ? 0 : from + 1);
          break;
        case 'ArrowUp':
          moveSelection(selectedIndex < 0 ? dataset.length - 1 : from - 1);
          break;
        case 'Home':
          moveToEnd('first');
          break;
        case 'End':
          moveToEnd('last');
          break;
        default:
          return;
      }
      e.preventDefault();
    },
    [selectedIndex, dataset.length, moveSelection, moveToEnd],
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
      : (all.find((r) => r.entry.anchor.id === selectedAnchorId)?.entry ?? null);
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
        aria-label={PROPERTY_STRINGS.anchorSectionTitle}
        ref={listRef}
        // 矢印キー・Home・End で選び替える（C1 / 反証 F8）。
        //
        // **焦点は常にこの枠が持つ**（増分 3。増分 2 の手直しの残り）。行のボタンに焦点を
        // 置くと、矢印で選択が動いてその行が仮想スクロールの窓から出た瞬間に **DOM ごと
        // 消えて焦点が body へ落ち**、以後の矢印が効かなくなる。listbox の作法どおり
        // 枠が焦点を持ち、いまどの行かは `aria-activedescendant` で伝える。行のボタンは
        // `tabIndex={-1}` にして Tab の順路から外し、押されたときは焦点を枠へ戻す。
        tabIndex={0}
        aria-activedescendant={
          selectedAnchorId === null ? undefined : anchorRowDomId(selectedAnchorId)
        }
        onKeyDown={onKeyDown}
        // 高さは「見せる行数」と「実際の件数」の小さいほう。錨が 1 本しか無い地物で
        // 336px の空箱を出さない（素性欄はそもそも縦に狭い）。
        style={{
          height: `${
            ANCHOR_ROW_HEIGHT * Math.max(1, Math.min(ANCHOR_VISIBLE_ROWS, dataset.length))
          }px`,
        }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {/* 上下の詰め物で「全件ぶんの高さ」を作る（スクロールバーの長さが実際の件数を表す）。
            listbox の子は option でなければならないので、詰め物と入れ物の li は
            アクセシビリティの木から外す（role="presentation"）。中の button が option
            そのものになる（C1）。 */}
        <li
          className="anchor-list__spacer"
          role="presentation"
          aria-hidden="true"
          style={{ height: `${range.start * ANCHOR_ROW_HEIGHT}px` }}
        />
        {dataset.slice(range.start, range.end).map((row, i) => {
          const entry = row.entry;
          const indexInDataset = range.start + i;
          const selected = entry.anchor.id === selectedAnchorId;
          return (
            <li key={entry.anchor.id} className="anchor-list__item" role="presentation">
              <button
                type="button"
                role="option"
                id={anchorRowDomId(entry.anchor.id)}
                aria-selected={selected}
                // Tab の順路から外す（焦点は枠が持つ ―― 上の `aria-activedescendant` の注記）。
                tabIndex={-1}
                data-testid={`anchor-row-${entry.anchor.id}`}
                className={
                  selected ? 'anchor-list__row anchor-list__row--selected' : 'anchor-list__row'
                }
                title={sentenceFor(indexInDataset)}
                onClick={() => {
                  onSelectAnchor(entry);
                  // マウスで押すとその行に焦点が移るので、枠へ戻す。戻さないと、
                  // 押したあとの矢印で行が窓の外へ出た瞬間に焦点が body へ落ちる。
                  listRef.current?.focus();
                }}
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
          role="presentation"
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
          {...(props.onModalChange ? { onModalChange: props.onModalChange } : {})}
        />
      )}
    </div>
  );
}

/**
 * 行の DOM id。`aria-activedescendant` が指す先で、**画面には出ない**（内部 id を
 * 出さない U-1 に触れない）。錨 ID をそのまま使うと数字始まりになりうるので接頭辞を付ける。
 */
export function anchorRowDomId(anchorId: AnchorId): string {
  return `anchor-row-${anchorId}`;
}

/**
 * 親の表示名をそのスナップショットから引く。**引けなければ根から引き直す**
 * （バグ狩り #5: 所属を変えた直後は新しい親が自分の錨のスナップショットに居ない）。
 * それでも引けなければ内部 id は出さない（U-1）。
 */
function parentNameIn(
  snapshot: AnchorSnapshot,
  parentId: FeatureId,
  fallback?: (featureId: FeatureId) => string | null,
): string {
  const parent = featureInSnapshot(snapshot, parentId);
  if (parent !== null) return parent.attributes.name;
  const fromRoot = fallback?.(parentId);
  return fromRoot === undefined || fromRoot === null || fromRoot === ''
    ? PROPERTY_STRINGS.unknownParentName
    : fromRoot;
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
  readonly onModalChange?: (open: boolean) => void;
}): JSX.Element {
  const { entry, calendar, featureId, soleAnchor, onEditInterval, onModalChange } = props;
  const anchorId = entry.anchor.id;

  const [message, setMessage] = useState<string | null>(null);
  /**
   * **錨を消す前に確認する**（N-05 / 設計書 §A.3 の「同じ器を錨の削除にも使う」。
   * 増分 7 の中身 7）。旧版は押した瞬間に消えていた ―― 錨は「その年からの姿」の
   * 記録なので、消すと **その年から次の錨まで、前の錨の姿へ戻る**。取り消せるとはいえ、
   * 何が起きるかを言わずに消すのは削除の作法から外れている。
   */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
        title={soleAnchor ? PROPERTY_STRINGS.intervalDeleteSoleReason : undefined}
        onClick={() => setConfirmingDelete(true)}
      >
        {PROPERTY_STRINGS.intervalDeleteLabel}
      </button>
      {/* 最後の 1 本を消せない理由を **画面の文として**出す（Fable #14）。灰色の
          ボタンだけでは「なぜ押せないのか」が読めない（教訓 5.26）。 */}
      {soleAnchor && (
        <p className="anchor-interval__note" data-testid={`anchor-interval-delete-reason-${anchorId}`}>
          {PROPERTY_STRINGS.intervalDeleteSoleReason}
        </p>
      )}

      {confirmingDelete && (
        <ImpactConfirmDialog
          testIdPrefix="anchor-delete-impact"
          title={PROPERTY_STRINGS.anchorDeleteTitle(formatTimePoint(entry.start))}
          groups={[
            {
              testId: 'gone',
              heading: PROPERTY_STRINGS.impactHeadingGone,
              lines: [
                PROPERTY_STRINGS.anchorDeleteLineRecord(formatTimePoint(entry.start)),
                PROPERTY_STRINGS.anchorDeleteLineFallback,
              ],
            },
          ]}
          confirmLabel={PROPERTY_STRINGS.anchorDeleteConfirm}
          cancelLabel={PROPERTY_STRINGS.impactCancel}
          note={PROPERTY_STRINGS.impactUndoNote}
          onConfirm={() => {
            setConfirmingDelete(false);
            run(buildDeleteAnchorIntent(featureId, anchorId));
          }}
          onCancel={() => setConfirmingDelete(false)}
          {...(onModalChange ? { onModalChange } : {})}
        />
      )}

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
