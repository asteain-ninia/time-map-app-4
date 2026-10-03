// 存続期間の編集（開始年を動かす・終わりを打つ・錨を消す）を、所属の記録ごと正しく動かす純関数。
//
// **何が壊れていたか**（増分 7 の手直し 2 回目。反証 #1・#5、GPT #2、バグ狩り §3 の開き直し）:
//   1. まとめ役 P をある年で終わらせると、子の `parentId` を **その年より後の全部の錨で**外していた。
//      子が後の年に別の親 Q へ移っていても Q との所属まで外れ（反証 #1）、P が後の年の錨で
//      再び現れるときは子の居ない殻になった。孫まで最上位にしていた（反証 #5）。
//   2. 自分の系列を持つ子（外から移された・連邦化で束ねられた子）を終わらせても、親の
//      子の並び（`childIds`）から外さなかった。アプリが書いたファイルを自分で
//      `child-parent-mismatch` と判定し、開き直すと修復の板で止まっていた（バグ狩り §3 / D1）。
//      開始年を動かしたときも同じ。
//
// **直し方**: 存続期間の編集で地物 F が **居なくなる区間**（編集の前は居て後は居ない区間）を
// 求め、その区間の中だけで
//   - F を指している直接の子の `parentId` を外す（区間の外は触らない。F が後の年に再び
//     現れれば、そこからは元の所属に戻る ―― 殻を作らない）。別の親を指す錨は触らない。
//   - 孫は外さない（中間のまとめ役は子を保ったまま最上位になる）。
// そのうえで、F の存在が変わった年について **F の親の子の並び**を時刻ごとの実際の所属に揃える。
// F の錨に居候している子・孫は、居なくなる区間で一緒に消えないよう先に自分の系列へ起こす
// （記録の置き場の決定 (1)）。
//
// 押す前の影響の板（`App.endFeatureHere`）と確定（`createAnchorIntervalCommandForRoot`）は、
// 同じ {@link editFeatureInterval} を通して数える（教訓 5.26: 予告と確定で別の数え方を作らない）。
//
// 純粋: 入力を変更せず新しい histories を返す。

import { createAnchor, createAnchorSnapshot, type AnchorSnapshot } from '../anchor';
import {
  createAnchorEntry,
  normalizeSeries,
  resolveAt,
  withUniqueAnchorId,
  type AnchorEntry,
  type AnchorSeries,
  type RejectReason,
  type SeriesResult,
} from '../anchor-series';
import { deriveAnchorId } from '../anchor-id';
import {
  FEATURE_KIND,
  withAggregateChildIds,
  withParentId,
  type Feature,
} from '../feature';
import type { AnchorId, FeatureId } from '../ids';
import type { FeatureHistory } from '../persistence/serialize';
import type { Calendar } from '../time/calendar';
import { compare } from '../time/normalized';
import type { TimePoint } from '../time/time-point';

import { materializeOwnSeries, residentFeatureIds } from './materialize';

/** 半開区間 [start, end)。`end === null` は「ずっと先まで」。 */
export interface TimeInterval {
  readonly start: TimePoint;
  readonly end: TimePoint | null;
}

/** 錨 `i` が実際に効く終わり（自分の終わりか、次の錨の始まりの早いほう）。 */
function effectiveEnd(
  entries: readonly AnchorEntry[],
  i: number,
  calendar: Calendar,
): TimePoint | null {
  const entry = entries[i];
  if (entry === undefined) return null;
  const next = entries[i + 1];
  if (entry.end === null) return next?.start ?? null;
  if (next === undefined) return entry.end;
  return compare(entry.end, next.start, calendar) <= 0 ? entry.end : next.start;
}

/** `a < b`（null は無限大）。 */
function before(a: TimePoint | null, b: TimePoint | null, calendar: Calendar): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return compare(a, b, calendar) < 0;
}

/** 系列が存在する区間（隣り合う区間はつなぐ）。 */
export function presenceOf(series: AnchorSeries, calendar: Calendar): readonly TimeInterval[] {
  const out: { start: TimePoint; end: TimePoint | null }[] = [];
  series.entries.forEach((entry, i) => {
    const end = effectiveEnd(series.entries, i, calendar);
    if (end !== null && compare(entry.start, end, calendar) >= 0) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.end !== null && compare(last.end, entry.start, calendar) === 0) {
      last.end = end;
      return;
    }
    out.push({ start: entry.start, end });
  });
  return out;
}

/** `a` から `b` を引いた区間（どちらも昇順で重ならない区間の列）。 */
export function subtractIntervals(
  a: readonly TimeInterval[],
  b: readonly TimeInterval[],
  calendar: Calendar,
): readonly TimeInterval[] {
  const out: TimeInterval[] = [];
  for (const piece of a) {
    let pieces: TimeInterval[] = [piece];
    for (const cut of b) {
      const next: TimeInterval[] = [];
      for (const p of pieces) {
        // 重ならなければそのまま。
        if (!before(cut.start, p.end, calendar) || !before(p.start, cut.end, calendar)) {
          next.push(p);
          continue;
        }
        if (compare(p.start, cut.start, calendar) < 0) next.push({ start: p.start, end: cut.start });
        if (cut.end !== null && before(cut.end, p.end, calendar)) next.push({ start: cut.end, end: p.end });
      }
      pieces = next;
    }
    out.push(...pieces);
  }
  return out;
}

/** 区間 [s, e) と区間の列が重なるか。 */
function overlapsAny(
  s: TimePoint,
  e: TimePoint | null,
  intervals: readonly TimeInterval[],
  calendar: Calendar,
): boolean {
  return intervals.some(
    (iv) => before(iv.start, e, calendar) && before(s, iv.end, calendar),
  );
}

/** 時刻 t がどれかの区間に入るか。 */
function insideAny(t: TimePoint, intervals: readonly TimeInterval[], calendar: Calendar): boolean {
  return intervals.some(
    (iv) => compare(iv.start, t, calendar) <= 0 && before(t, iv.end, calendar),
  );
}

/**
 * 系列を時刻 `t` で 2 つに割る（`t` に効いている錨が `t` より前に始まっているときだけ）。
 * 後ろの片は前の片の写しで、**前の片の終わりを引き継ぐ**（`applyPastEdit` の挿入は終わりを
 * 引き継がないので、終わりのある錨を割ると後ろの片が永遠に続いてしまう ―― ここでは使わない）。
 */
function splitSeriesAt(
  series: AnchorSeries,
  ownerId: FeatureId,
  t: TimePoint,
  calendar: Calendar,
): AnchorSeries {
  const r = resolveAt(series, t, calendar);
  if (r.kind !== 'present') return series;
  if (compare(r.entry.start, t, calendar) === 0) return series;
  const copy = withUniqueAnchorId(
    series.entries,
    createAnchor(deriveAnchorId(ownerId, t), r.entry.anchor.snapshot),
  );
  const tail = createAnchorEntry(copy, t, r.entry.end);
  return normalizeSeries([...series.entries, tail], calendar);
}

function withSnapshotFeatures(entry: AnchorEntry, features: readonly Feature[]): AnchorEntry {
  return {
    anchor: createAnchor(entry.anchor.id, createAnchorSnapshot(features, entry.anchor.snapshot.vertices)),
    start: entry.start,
    end: entry.end,
  };
}

/**
 * `intervals` の中で `parentId` を親にしている **自分の系列を持つ**地物（`parentId` 自身は除く）。
 * 自分の錨の自分の姿で数える（居候はこの前に起こしておくこと）。
 */
export function directChildrenWithin(
  histories: readonly FeatureHistory[],
  parentId: FeatureId,
  intervals: readonly TimeInterval[],
  calendar: Calendar,
): readonly FeatureId[] {
  if (intervals.length === 0) return [];
  const out: FeatureId[] = [];
  const seen = new Set<FeatureId>();
  for (const history of histories) {
    const id = history.featureId;
    if (id === parentId || seen.has(id)) continue;
    const entries = history.series.entries;
    const hit = entries.some((entry, i) => {
      const self = entry.anchor.snapshot.features.find((f) => f.id === id);
      if (self?.parentId !== parentId) return false;
      return overlapsAny(entry.start, effectiveEnd(entries, i, calendar), intervals, calendar);
    });
    if (!hit) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * `childIds` の各地物について、`intervals` の中だけ `parentId === parentId` を外す（区間の
 * 境目で錨を割り、区間の外の所属はそのまま残す）。別の親を指す錨には触らない。
 */
export function clearParentWithin(
  histories: readonly FeatureHistory[],
  childIds: readonly FeatureId[],
  parentId: FeatureId,
  intervals: readonly TimeInterval[],
  calendar: Calendar,
): readonly FeatureHistory[] {
  if (intervals.length === 0 || childIds.length === 0) return histories;
  const targets = new Set<FeatureId>(childIds);
  return histories.map((history) => {
    const id = history.featureId;
    if (!targets.has(id)) return history;
    const pointsAtParent = (entry: AnchorEntry): boolean =>
      entry.anchor.snapshot.features.find((f) => f.id === id)?.parentId === parentId;
    // 区間の境目で割る（その時刻に効いている錨が親を指しているときだけ）。
    let series = history.series;
    for (const iv of intervals) {
      for (const t of iv.end === null ? [iv.start] : [iv.start, iv.end]) {
        const r = resolveAt(series, t, calendar);
        if (r.kind === 'present' && pointsAtParent(r.entry)) {
          series = splitSeriesAt(series, id, t, calendar);
        }
      }
    }
    let changed = false;
    const entries = series.entries.map((entry) => {
      if (!insideAny(entry.start, intervals, calendar) || !pointsAtParent(entry)) return entry;
      changed = true;
      return withSnapshotFeatures(
        entry,
        entry.anchor.snapshot.features.map((f) => (f.id === id ? withParentId(f, undefined) : f)),
      );
    });
    if (!changed) return history;
    return { featureId: id, series: normalizeSeries(entries, calendar) };
  });
}

/** 時刻 t に居る地物のうち、親が `parentId` のものの id（重複は 1 つに）。 */
function childrenAt(
  histories: readonly FeatureHistory[],
  parentId: FeatureId,
  t: TimePoint,
  calendar: Calendar,
): readonly FeatureId[] {
  const out: FeatureId[] = [];
  const seen = new Set<FeatureId>();
  for (const history of histories) {
    const r = resolveAt(history.series, t, calendar);
    if (r.kind !== 'present') continue;
    for (const f of r.entry.anchor.snapshot.features) {
      if (f.id === parentId || f.parentId !== parentId || seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f.id);
    }
  }
  return out;
}

function sameIdSet(a: readonly FeatureId[], b: readonly FeatureId[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set<FeatureId>(a);
  if (set.size !== a.length) return false;
  return b.every((id) => set.has(id));
}

/** 宣言の並びを保ち、足りない子は後ろへ足した並び。 */
function orderedLike(derived: readonly FeatureId[], declared: readonly FeatureId[]): FeatureId[] {
  const want = new Set<FeatureId>(derived);
  const out: FeatureId[] = [];
  const seen = new Set<FeatureId>();
  for (const id of declared) {
    if (want.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const id of derived) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * 自分の系列を持つまとめ役 `aggregateIds` の子の並び（`childIds`）を、**時刻ごとの実際の所属**
 * （その時刻に居て `parentId` がそのまとめ役である地物）に揃える。錨の区間の途中で子が
 * 出入りするときは、その時刻で錨を割る。揃っている錨は触らない（同一参照を返す）。
 *
 * 子の並びは `parentId` の写し（U08 の単一真実源は `parentId`）なので、揃える向きは常に
 * 「`parentId` から子の並びを作り直す」で、逆はしない。
 */
export function syncAggregateChildIds(
  histories: readonly FeatureHistory[],
  aggregateIds: Iterable<FeatureId>,
  calendar: Calendar,
): readonly FeatureHistory[] {
  let current = histories;
  for (const aggId of new Set<FeatureId>(aggregateIds)) {
    const index = current.findIndex((h) => h.featureId === aggId);
    const history = index >= 0 ? current[index] : undefined;
    if (history === undefined) continue;

    // 子になりうる地物（どこかの年で親がこのまとめ役・または子の並びに載っている）の境目の時刻。
    const candidates = new Set<FeatureId>();
    for (const entry of history.series.entries) {
      for (const f of entry.anchor.snapshot.features) {
        if (f.id === aggId && f.kind === FEATURE_KIND.Aggregate) {
          for (const c of f.childIds) candidates.add(c);
        }
      }
    }
    const boundaries: TimePoint[] = [];
    for (const h of current) {
      h.series.entries.forEach((entry, i) => {
        const relevant = entry.anchor.snapshot.features.some(
          (f) => f.id !== aggId && (f.parentId === aggId || candidates.has(f.id)),
        );
        if (!relevant) return;
        boundaries.push(entry.start);
        const end = effectiveEnd(h.series.entries, i, calendar);
        if (end !== null) boundaries.push(end);
      });
    }

    const entries = history.series.entries;
    let changed = false;
    const rebuilt: AnchorEntry[] = [];
    entries.forEach((entry, i) => {
      const self = entry.anchor.snapshot.features.find((f) => f.id === aggId);
      if (self === undefined || self.kind !== FEATURE_KIND.Aggregate) {
        rebuilt.push(entry);
        return;
      }
      const end = effectiveEnd(entries, i, calendar);
      const inside = boundaries
        .filter((t) => compare(entry.start, t, calendar) < 0 && before(t, end, calendar))
        .sort((a, b) => compare(a, b, calendar));
      const times: TimePoint[] = [entry.start];
      for (const t of inside) {
        const last = times[times.length - 1];
        if (last !== undefined && compare(last, t, calendar) === 0) continue;
        times.push(t);
      }
      // 区間ごとの実際の子（同じ並びが続く区間はつなぐ）。
      const segments: { start: TimePoint; kids: readonly FeatureId[] }[] = [];
      for (const t of times) {
        const kids = childrenAt(current, aggId, t, calendar);
        const last = segments[segments.length - 1];
        if (last !== undefined && sameIdSet(last.kids, kids)) continue;
        segments.push({ start: t, kids });
      }
      if (segments.length === 1 && sameIdSet(segments[0]!.kids, self.childIds)) {
        rebuilt.push(entry);
        return;
      }
      changed = true;
      segments.forEach((segment, k) => {
        const childIds = orderedLike(segment.kids, self.childIds);
        const snapshot: AnchorSnapshot = createAnchorSnapshot(
          entry.anchor.snapshot.features.map((f) =>
            f.id === aggId && f.kind === FEATURE_KIND.Aggregate ? withAggregateChildIds(f, childIds) : f,
          ),
          entry.anchor.snapshot.vertices,
        );
        const anchor =
          k === 0
            ? createAnchor(entry.anchor.id, snapshot)
            : withUniqueAnchorId(
                [...entries, ...rebuilt],
                createAnchor(deriveAnchorId(aggId, segment.start), snapshot),
              );
        const isLast = k === segments.length - 1;
        rebuilt.push({ anchor, start: segment.start, end: isLast ? entry.end : null });
      });
    });
    if (!changed) continue;
    const updated: FeatureHistory = {
      featureId: aggId,
      series: normalizeSeries(rebuilt, calendar),
    };
    current = current.map((h, i) => (i === index ? updated : h));
  }
  return current;
}

// --- 記録の続き（途切れ）と、区間を指定して居なくする --------------------------------
//
// **途切れの定義**（増分 7 の手直し 3 回目。相談役との合議の締め A）: 錨 i と i+1 の間に途切れがある
// ⇔ 錨 i が明示の終わり E を持ち、かつ i+1 の始まりが E より後。終わりの無い錨のあとに別の錨が
// 続くのは「途切れずに続いている」。帳簿のために割られた錨（B76 の終わりの引き継ぎ・子の並びを
// 揃える直しで割られたもの）はこの定義で「続いている」側に入り、利用者がわざと作った「復活」は
// 途切れの後にしか作れない。

/** 錨 i と i+1 の間に途切れがあるか（締め A）。 */
export function hasGapAfter(
  entries: readonly AnchorEntry[],
  i: number,
  calendar: Calendar,
): boolean {
  const entry = entries[i];
  const next = entries[i + 1];
  if (entry === undefined || next === undefined) return false;
  return entry.end !== null && compare(next.start, entry.end, calendar) > 0;
}

/** 錨 i を含む、途切れずに続いている記録の範囲 [first, last]（錨の番号）。 */
export function continuousRunOf(
  entries: readonly AnchorEntry[],
  i: number,
  calendar: Calendar,
): { readonly first: number; readonly last: number } {
  let first = i;
  while (first > 0 && !hasGapAfter(entries, first - 1, calendar)) first -= 1;
  let last = i;
  while (last + 1 < entries.length && !hasGapAfter(entries, last, calendar)) last += 1;
  return { first, last };
}

/**
 * 系列の `cuts` の区間で、その地物を居なくする（錨を区間の境目で割り、区間の中の部分は落とす）。
 * 残る部分の最初の片は元の錨の id を保ち、2 つ目からの片は写しに一意な id を振る。残る片の
 * 終わりが元の効く終わりと違えば、明示の終わりを打つ（＝そこに途切れができる）。純粋。
 */
export function cutSeries(
  series: AnchorSeries,
  ownerId: FeatureId,
  cuts: readonly TimeInterval[],
  calendar: Calendar,
): AnchorSeries {
  if (cuts.length === 0) return series;
  const out: AnchorEntry[] = [];
  series.entries.forEach((entry, i) => {
    const end = effectiveEnd(series.entries, i, calendar);
    const pieces = subtractIntervals([{ start: entry.start, end }], cuts, calendar);
    pieces.forEach((piece, k) => {
      const sameEnd =
        piece.end === null ? end === null : end !== null && compare(piece.end, end, calendar) === 0;
      // 終わりの無い錨は次の錨の始まりで区切られている。次の錨が切り取られて居なくなるなら、
      // その始まりを明示の終わりとして打つ（打たないと、残る錨が先まで続いてしまう）。
      const next = series.entries[i + 1];
      const nextSurvives = next !== undefined && !insideAny(next.start, cuts, calendar);
      const keepOwnEnd = sameEnd && (entry.end !== null || next === undefined || nextSurvives);
      const pieceEnd = keepOwnEnd ? entry.end : piece.end;
      const anchor =
        k === 0
          ? entry.anchor
          : withUniqueAnchorId(
              [...series.entries, ...out],
              createAnchor(deriveAnchorId(ownerId, piece.start), entry.anchor.snapshot),
            );
      out.push(createAnchorEntry(anchor, piece.start, pieceEnd));
    });
  });
  return normalizeSeries(out, calendar);
}

/**
 * **「この年に終わったことにする」**（増分 7 の手直し 3 回目 / 再検証 #2）: `at` に効いている錨から
 * 先の、**途切れずに続いている記録をまとめて**終わらせる。再び現れるのは、途切れ（その地物が
 * 居ない年）を挟んだ後に始まる記録だけ。`anchorId` はその年に効いている錨（呼び手の確認用）。
 * 続きの始まりで終わらせる（何も残らない）のは断る（`endNotAfterStart`）。
 */
export function endRunAt(
  series: AnchorSeries,
  ownerId: FeatureId,
  anchorId: AnchorId,
  at: TimePoint,
  calendar: Calendar,
): SeriesResult {
  const index = series.entries.findIndex((e) => e.anchor.id === anchorId);
  if (index < 0) return { ok: false, reason: { code: 'anchorNotFound', id: anchorId } };
  const { first, last } = continuousRunOf(series.entries, index, calendar);
  const runStart = series.entries[first]?.start;
  if (runStart === undefined || compare(at, runStart, calendar) <= 0) {
    return { ok: false, reason: { code: 'endNotAfterStart' } };
  }
  const runEnd = effectiveEnd(series.entries, last, calendar);
  if (runEnd !== null && compare(at, runEnd, calendar) >= 0) {
    return { ok: false, reason: { code: 'endBeyondNextEnd' } };
  }
  return { ok: true, series: cutSeries(series, ownerId, [{ start: at, end: runEnd }], calendar) };
}

function mergeIntervals(intervals: readonly TimeInterval[], calendar: Calendar): readonly TimeInterval[] {
  const sorted = [...intervals].sort((a, b) => compare(a.start, b.start, calendar));
  const out: { start: TimePoint; end: TimePoint | null }[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && !before(last.end, iv.start, calendar)) {
      if (iv.end === null || before(last.end, iv.end, calendar)) last.end = iv.end;
      continue;
    }
    out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

/** 全部の系列のどこかで `featureId` が居る区間（自分の系列でも、居候先の錨でも）。 */
export function featurePresence(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  calendar: Calendar,
): readonly TimeInterval[] {
  const intervals: TimeInterval[] = [];
  for (const h of histories) {
    h.series.entries.forEach((entry, i) => {
      if (!entry.anchor.snapshot.features.some((f) => f.id === featureId)) return;
      const end = effectiveEnd(h.series.entries, i, calendar);
      if (end !== null && compare(entry.start, end, calendar) >= 0) return;
      intervals.push({ start: entry.start, end });
    });
  }
  return mergeIntervals(intervals, calendar);
}

/**
 * 地物 `featureId`（自分の系列を持つ）が、**その年には居ない親**を指している区間を、親ごとに返す
 * （増分 7 の手直し 3 回目 1-1: 子の開始年を親より前へ動かす、など）。
 */
export function absentParentIntervals(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  calendar: Calendar,
): ReadonlyMap<FeatureId, readonly TimeInterval[]> {
  const own = histories.find((h) => h.featureId === featureId);
  const out = new Map<FeatureId, TimeInterval[]>();
  if (own === undefined) return out;
  const presenceCache = new Map<FeatureId, readonly TimeInterval[]>();
  own.series.entries.forEach((entry, i) => {
    const parentId = entry.anchor.snapshot.features.find((f) => f.id === featureId)?.parentId;
    if (parentId === undefined) return;
    const end = effectiveEnd(own.series.entries, i, calendar);
    if (end !== null && compare(entry.start, end, calendar) >= 0) return;
    let presence = presenceCache.get(parentId);
    if (presence === undefined) {
      presence = featurePresence(histories, parentId, calendar);
      presenceCache.set(parentId, presence);
    }
    const missing = subtractIntervals([{ start: entry.start, end }], presence, calendar);
    if (missing.length === 0) return;
    const list = out.get(parentId) ?? [];
    list.push(...missing);
    out.set(parentId, list);
  });
  return out;
}

interface ChildRun {
  readonly runEnd: TimePoint | null;
  readonly segments: readonly { readonly start: TimePoint; readonly count: number }[];
}

/**
 * まとめ役 `aggId`（自分の系列を持つ）の、途切れずに続く記録ごとの「子が居るか」の区切り。
 * 子は、その時刻に居て親が `aggId` である地物（自分の系列でも、居候でも）。
 */
function childSegments(
  histories: readonly FeatureHistory[],
  aggId: FeatureId,
  calendar: Calendar,
): readonly ChildRun[] {
  const own = histories.find((h) => h.featureId === aggId);
  if (own === undefined) return [];
  const isAggregate = own.series.entries.some((e) =>
    e.anchor.snapshot.features.some((f) => f.id === aggId && f.kind === FEATURE_KIND.Aggregate),
  );
  if (!isAggregate) return [];
  const boundaries: TimePoint[] = [];
  for (const h of histories) {
    h.series.entries.forEach((entry, i) => {
      if (!entry.anchor.snapshot.features.some((f) => f.id !== aggId && f.parentId === aggId)) return;
      boundaries.push(entry.start);
      const end = effectiveEnd(h.series.entries, i, calendar);
      if (end !== null) boundaries.push(end);
    });
  }
  for (const e of own.series.entries) boundaries.push(e.start);
  boundaries.sort((a, b) => compare(a, b, calendar));

  const runs: ChildRun[] = [];
  const entries = own.series.entries;
  let i = 0;
  while (i < entries.length) {
    const { first, last } = continuousRunOf(entries, i, calendar);
    const runStart = entries[first]!.start;
    const runEnd = effectiveEnd(entries, last, calendar);
    const times: TimePoint[] = [runStart];
    for (const t of boundaries) {
      if (compare(t, runStart, calendar) <= 0 || !before(t, runEnd, calendar)) continue;
      const lastTime = times[times.length - 1]!;
      if (compare(lastTime, t, calendar) === 0) continue;
      times.push(t);
    }
    const segments: { start: TimePoint; count: number }[] = [];
    for (const t of times) {
      const count = childrenAt(histories, aggId, t, calendar).length;
      const prev = segments[segments.length - 1];
      if (prev !== undefined && (prev.count === 0) === (count === 0)) continue;
      segments.push({ start: t, count });
    }
    runs.push({ runEnd, segments });
    i = last + 1;
  }
  return runs;
}

/**
 * **後ろ側が空になったまとめ役**（増分 7 の手直し 3 回目 1-1 / 締め C）: 途切れずに続く記録ごとに、
 * 年 Y の直前に子が 1 件以上居て、Y からその続きの終わりまで子が 0 件なら、[Y, 続きの終わり) を返す。
 * 最初から子が居ない続き・途中だけ空の続きは返さない（終わらせない）。
 */
export function tailEmptyCuts(
  histories: readonly FeatureHistory[],
  aggId: FeatureId,
  calendar: Calendar,
): readonly TimeInterval[] {
  const out: TimeInterval[] = [];
  for (const run of childSegments(histories, aggId, calendar)) {
    const segs = run.segments;
    const lastSeg = segs[segs.length - 1];
    if (lastSeg === undefined || lastSeg.count > 0) continue;
    if (!segs.some((s) => s.count > 0)) continue; // 最初から子が居ない続きは終わらせない
    out.push({ start: lastSeg.start, end: run.runEnd });
  }
  return out;
}

/**
 * まとめ役 `aggId` に子が 1 件も居ない区間（読み込みの修復 1-2 の材料）。**一度も子を持たない
 * まとめ役**（どの続きにも子が居ない）は空を返す ―― その区間を無くすと地物ごと消えるので、
 * 区間の修復の対象にしない（締め C）。
 */
export function emptyAggregateIntervals(
  histories: readonly FeatureHistory[],
  aggId: FeatureId,
  calendar: Calendar,
): readonly TimeInterval[] {
  const runs = childSegments(histories, aggId, calendar);
  if (!runs.some((r) => r.segments.some((s) => s.count > 0))) return [];
  const out: TimeInterval[] = [];
  for (const run of runs) {
    run.segments.forEach((seg, k) => {
      if (seg.count > 0) return;
      const next = run.segments[k + 1];
      out.push({ start: seg.start, end: next === undefined ? run.runEnd : next.start });
    });
  }
  return out;
}

/** 終わらせる操作の連鎖で、別のまとめ役がその年から終わったもの（1-1）。 */
export interface CascadedEnd {
  readonly featureId: FeatureId;
  readonly at: TimePoint;
}

/** {@link editFeatureInterval} の結果。 */
export type FeatureIntervalEditResult =
  | {
      readonly ok: true;
      readonly histories: readonly FeatureHistory[];
      /** 居なくなる区間で親を外した直接の子（その区間で最上位になる）。 */
      readonly promoted: readonly FeatureId[];
      /** 居なくなる区間（編集の前は居て後は居ない）。空なら何も失われない。 */
      readonly lost: readonly TimeInterval[];
      /** 後ろ側の子が 0 件になったので、その年から終わったまとめ役（1-1）。 */
      readonly cascaded: readonly CascadedEnd[];
    }
  /** `reason === null` は「自分の系列が無い」（呼び手が錨の id を添えて断る）。 */
  | { readonly ok: false; readonly reason: RejectReason | null };

interface CoreEdit {
  readonly histories: readonly FeatureHistory[];
  readonly promoted: readonly FeatureId[];
  readonly lost: readonly TimeInterval[];
  /** 子の並びを揃えたまとめ役（後ろ側が空になったかを見る相手）。 */
  readonly touchedParents: ReadonlySet<FeatureId>;
}

type CoreResult =
  | { readonly ok: true; readonly value: CoreEdit }
  | { readonly ok: false; readonly reason: RejectReason | null };

function coreEdit(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  op: (series: AnchorSeries) => SeriesResult,
  calendar: Calendar,
): CoreResult {
  const own = histories.find((h) => h.featureId === featureId);
  if (own === undefined) return { ok: false, reason: null };
  const trial = op(own.series);
  if (!trial.ok) return { ok: false, reason: trial.reason };
  const lost = subtractIntervals(
    presenceOf(own.series, calendar),
    presenceOf(trial.series, calendar),
    calendar,
  );

  // 居なくなる区間があるなら、F の錨に居候している子・孫を先に自分の系列へ起こす。**全部の
  // 錨**（終わらせる範囲の後ろの錨にだけ居る子も）の記録を起こしてから錨を切り詰める（締め B）。
  // 錨の id は変わらないので、`op` は起こした後の系列にもそのまま当てられる。
  let base: readonly FeatureHistory[] = histories;
  if (lost.length > 0) {
    const residents = residentFeatureIds(base, featureId);
    if (residents.length > 0) base = materializeOwnSeries(base, residents, calendar).histories;
  }
  const index = base.findIndex((h) => h.featureId === featureId);
  const history = index >= 0 ? base[index] : undefined;
  if (history === undefined) return { ok: false, reason: null };
  const run = op(history.series);
  if (!run.ok) return { ok: false, reason: run.reason };
  base = base.map((h, i) => (i === index ? { featureId, series: run.series } : h));

  const promoted = directChildrenWithin(base, featureId, lost, calendar);
  base = clearParentWithin(base, promoted, featureId, lost, calendar);

  // **編集した地物自身が、その年には居ない親を指す形にしない**（1-1。子の開始年を親より前へ
  // 動かす、など）。その区間だけ親を外す（区間の外の所属は触らない）。
  const parents = new Set<FeatureId>();
  for (const [parentId, intervals] of absentParentIntervals(base, featureId, calendar)) {
    base = clearParentWithin(base, [featureId], parentId, intervals, calendar);
    parents.add(parentId);
  }

  // F の存在が変わったので、F の親（どの年でも）と、F を子の並びに載せているまとめ役の
  // 子の並びを、時刻ごとの実際の所属に揃える。
  for (const series of [own.series, run.series]) {
    for (const entry of series.entries) {
      const self = entry.anchor.snapshot.features.find((f) => f.id === featureId);
      if (self?.parentId !== undefined) parents.add(self.parentId);
    }
  }
  for (const h of base) {
    for (const entry of h.series.entries) {
      for (const f of entry.anchor.snapshot.features) {
        if (f.kind === FEATURE_KIND.Aggregate && f.id === h.featureId && f.childIds.includes(featureId)) {
          parents.add(f.id);
        }
      }
    }
  }
  if (parents.size > 0) base = syncAggregateChildIds(base, parents, calendar);
  return { ok: true, value: { histories: base, promoted, lost, touchedParents: parents } };
}

/**
 * 地物 `featureId` の存続期間を `op`（U09 の changeStart / setEnd / deleteAnchor、または
 * {@link endRunAt}）で編集し、所属の記録を一緒に動かす（先頭の注記）。自分の系列が無ければ
 * `reason: null`。
 *
 * そのあと、子の並びを揃えたまとめ役のうち **後ろ側の子が 0 件になったもの**を、その年から
 * 終わらせる（1-1。削除・所属変更の「下位領域を全て失うので自動で消える」と同じ規則を、
 * 存続期間の編集にも通す）。終わらせたまとめ役の親も同じ規則で見る（連鎖）。
 */
export function editFeatureInterval(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  op: (series: AnchorSeries) => SeriesResult,
  calendar: Calendar,
): FeatureIntervalEditResult {
  const first = coreEdit(histories, featureId, op, calendar);
  if (!first.ok) return first;
  let base = first.value.histories;
  const cascaded: CascadedEnd[] = [];
  const queue: FeatureId[] = [...first.value.touchedParents];
  const ownAfter = base.find((h) => h.featureId === featureId);
  const isAggregate =
    ownAfter?.series.entries.some((e) =>
      e.anchor.snapshot.features.some((f) => f.id === featureId && f.kind === FEATURE_KIND.Aggregate),
    ) === true;
  if (isAggregate) queue.push(featureId);
  const maxRounds = (histories.length + 8) * 4;
  for (let round = 0; queue.length > 0 && round < maxRounds; round += 1) {
    const aggId = queue.shift()!;
    const cuts = tailEmptyCuts(base, aggId, calendar);
    if (cuts.length === 0) continue;
    const step = coreEdit(
      base,
      aggId,
      (series) => ({ ok: true, series: cutSeries(series, aggId, cuts, calendar) }),
      calendar,
    );
    if (!step.ok) continue;
    base = step.value.histories;
    for (const cut of cuts) cascaded.push({ featureId: aggId, at: cut.start });
    for (const p of step.value.touchedParents) queue.push(p);
  }
  return {
    ok: true,
    histories: base,
    promoted: first.value.promoted,
    lost: first.value.lost,
    cascaded,
  };
}

/**
 * `featureId` を `at` の年で終わらせたとき、**その年から最上位になる直接の子**（司令塔の決定 (2)）。
 * 確定と同じ {@link editFeatureInterval} を空打ちして数える（予告と確定がずれない）。
 * `at` に効いている自分の錨が無ければ空。
 */
export function childrenPromotedByEnding(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  at: TimePoint,
  calendar: Calendar,
): readonly FeatureId[] {
  return planEnding(histories, featureId, at, calendar)?.promoted ?? [];
}

/** {@link childrenPromotedByEnding} の材料（押す前の板・状態行が言うこと）。 */
export interface EndingPlan {
  readonly promoted: readonly FeatureId[];
  /** 途切れの後に再び現れる年（その年から子は元の所属に戻る）。現れないなら null。 */
  readonly reappearsAt: TimePoint | null;
  /** 一緒に終わる、その年より後の自分の記録（錨）の件数（途切れずに続いていたもの）。 */
  readonly trimmedLaterRecords: number;
  /** 後ろ側の子を全部失うので、その年から終わるまとめ役（1-1）。 */
  readonly cascaded: readonly CascadedEnd[];
}

export function planEnding(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  at: TimePoint,
  calendar: Calendar,
): EndingPlan | null {
  const own = histories.find((h) => h.featureId === featureId);
  if (own === undefined) return null;
  const r = resolveAt(own.series, at, calendar);
  if (r.kind !== 'present') return null;
  const anchorId = r.entry.anchor.id;
  const result = editFeatureInterval(
    histories,
    featureId,
    (series) => endRunAt(series, featureId, anchorId, at, calendar),
    calendar,
  );
  if (!result.ok) return null;
  const after = result.histories.find((h) => h.featureId === featureId);
  const reappears =
    after === undefined
      ? undefined
      : presenceOf(after.series, calendar).find((iv) => compare(iv.start, at, calendar) > 0);
  const keptIds = new Set(after?.series.entries.map((e) => e.anchor.id) ?? []);
  const trimmedLaterRecords = own.series.entries.filter(
    (e) => compare(e.start, at, calendar) > 0 && !keptIds.has(e.anchor.id),
  ).length;
  return {
    promoted: result.promoted,
    reappearsAt: reappears === undefined ? null : reappears.start,
    trimmedLaterRecords,
    cascaded: result.cascaded,
  };
}
