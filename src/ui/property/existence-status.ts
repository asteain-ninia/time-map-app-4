// UI layer (素性欄 / 時刻レール): **いま見ている年に、選んでいる地物がどういう状態か**
// （増分 7 の手直し 2 回目 / 司令塔の決定 (12)・設計適合 指摘 5・GPT #5・バグ狩り 2-3）。
//
// 「この年に終わったことにする」を押した直後（その年を見たまま）、地物はその年には居ない。
// それを「見つかりません」「この年にはまだありません」と言うと、押した操作が失敗したように
// 読める。居ない理由は 2 つあり、言い方が違う:
//   - まだ始まっていない（最初の錨より前）     → 「○○年から始まります」
//   - もう終わっている（終わりを打った年以後）   → 「○○年で終わっています」
//     （後の年の錨で再び現れるなら、その年も言う）
// 居る年でも、いま居る区間に終わりが打たれていれば「○○年で終わります」と言う（GPT #5:
// 終わりの年を「最初に終わりのある錨」から引いていたので、過去の終了・後の再登場・終了より
// 前の年を区別していなかった）。
//
// 材料は **画面に出している系列**（自分の系列、または親から選り分ける系列）で、地物が居る
// 錨だけを区間として数える（錨が効くのは自分の終わりか次の錨の始まりの早いほうまで）。
// 素性欄と時刻レールの見出しが同じ 1 本から決める（教訓 5.29）。純粋。

import type { AnchorSeries } from '../../domain/anchor-series';
import type { FeatureId } from '../../domain/ids';
import type { Calendar } from '../../domain/time/calendar';
import { compare } from '../../domain/time/normalized';
import type { TimePoint } from '../../domain/time/time-point';

export type ExistenceStatus =
  | { readonly kind: 'present'; readonly endsAt: TimePoint | null }
  | { readonly kind: 'not-yet'; readonly startsAt: TimePoint }
  | { readonly kind: 'ended'; readonly endedAt: TimePoint; readonly reappearsAt: TimePoint | null }
  | { readonly kind: 'unknown' };

interface Interval {
  readonly start: TimePoint;
  readonly end: TimePoint | null;
}

function intervalsOf(series: AnchorSeries, featureId: FeatureId, calendar: Calendar): Interval[] {
  const out: { start: TimePoint; end: TimePoint | null }[] = [];
  const entries = series.entries;
  entries.forEach((entry, i) => {
    if (!entry.anchor.snapshot.features.some((f) => f.id === featureId)) return;
    const next = entries[i + 1];
    let end: TimePoint | null = entry.end;
    if (next !== undefined && (end === null || compare(next.start, end, calendar) < 0)) {
      end = next.start;
    }
    const last = out[out.length - 1];
    if (last !== undefined && last.end !== null && compare(last.end, entry.start, calendar) === 0) {
      last.end = end;
      return;
    }
    out.push({ start: entry.start, end });
  });
  return out;
}

/** `at` の年に、`featureId` が `series` の上でどういう状態か。 */
export function existenceStatusAt(
  series: AnchorSeries | null,
  featureId: FeatureId | null,
  at: TimePoint,
  calendar: Calendar,
): ExistenceStatus {
  if (series === null || featureId === null) return { kind: 'unknown' };
  const intervals = intervalsOf(series, featureId, calendar);
  if (intervals.length === 0) return { kind: 'unknown' };
  for (const iv of intervals) {
    const started = compare(iv.start, at, calendar) <= 0;
    const notEnded = iv.end === null || compare(at, iv.end, calendar) < 0;
    if (started && notEnded) return { kind: 'present', endsAt: iv.end };
  }
  let endedAt: TimePoint | null = null;
  let reappearsAt: TimePoint | null = null;
  for (const iv of intervals) {
    if (iv.end !== null && compare(iv.end, at, calendar) <= 0) endedAt = iv.end;
    if (reappearsAt === null && compare(iv.start, at, calendar) > 0) reappearsAt = iv.start;
  }
  if (endedAt !== null) return { kind: 'ended', endedAt, reappearsAt };
  const first = intervals[0];
  return first === undefined ? { kind: 'unknown' } : { kind: 'not-yet', startsAt: first.start };
}
