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
  setEnd,
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
import type { FeatureId } from '../ids';
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

/** {@link editFeatureInterval} の結果。 */
export type FeatureIntervalEditResult =
  | {
      readonly ok: true;
      readonly histories: readonly FeatureHistory[];
      /** 居なくなる区間で親を外した直接の子（その区間で最上位になる）。 */
      readonly promoted: readonly FeatureId[];
      /** 居なくなる区間（編集の前は居て後は居ない）。空なら何も失われない。 */
      readonly lost: readonly TimeInterval[];
    }
  /** `reason === null` は「自分の系列が無い」（呼び手が錨の id を添えて断る）。 */
  | { readonly ok: false; readonly reason: RejectReason | null };

/**
 * 地物 `featureId` の存続期間を `op`（U09 の changeStart / setEnd / deleteAnchor のどれか）で
 * 編集し、所属の記録を一緒に動かす（先頭の注記）。自分の系列が無ければ `reason: null`。
 */
export function editFeatureInterval(
  histories: readonly FeatureHistory[],
  featureId: FeatureId,
  op: (series: AnchorSeries) => SeriesResult,
  calendar: Calendar,
): FeatureIntervalEditResult {
  const own = histories.find((h) => h.featureId === featureId);
  if (own === undefined) return { ok: false, reason: null };
  const trial = op(own.series);
  if (!trial.ok) return { ok: false, reason: trial.reason };
  const lost = subtractIntervals(
    presenceOf(own.series, calendar),
    presenceOf(trial.series, calendar),
    calendar,
  );

  // 居なくなる区間があるなら、F の錨に居候している子・孫を先に自分の系列へ起こす
  // （錨の id は変わらないので、`op` は起こした後の系列にもそのまま当てられる）。
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

  // F の存在が変わったので、F の親（どの年でも）と、F を子の並びに載せているまとめ役の
  // 子の並びを、時刻ごとの実際の所属に揃える。
  const parents = new Set<FeatureId>();
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

  return { ok: true, histories: base, promoted, lost };
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

/** {@link childrenPromotedByEnding} の材料（板が「再び現れる年」を言うのにも使う）。 */
export interface EndingPlan {
  readonly promoted: readonly FeatureId[];
  /** 居なくなる区間の終わり（その年に再び現れる）。ずっと居なくなるなら null。 */
  readonly reappearsAt: TimePoint | null;
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
    (series) => setEnd(series, anchorId, at, calendar),
    calendar,
  );
  if (!result.ok) return null;
  const first = result.lost[0];
  return {
    promoted: result.promoted,
    reappearsAt: first === undefined ? null : first.end,
  };
}
