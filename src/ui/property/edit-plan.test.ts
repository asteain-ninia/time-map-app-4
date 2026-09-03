// 保存の行き先 4 状態（設計書 §D.3 の表 / 実装計画 増分 2 の中身 2）を固定する。
//
// **これは本増分でいちばん危ない変更の安全装置である。** 編集時刻を「選んでいる錨の
// 開始時刻」から「いま見ている年」へ移すと、上書きのつもりが新しい錨を増やす事故が
// 起こりうる。裁定 §N-2 の (A) は「どちらになるかを押す前に必ず文字で見せる」ことを
// 条件にしているので、その文字を決めるここを直接押さえる。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, type AnchorSeries } from '../../domain/anchor-series';
import { asAnchorId } from '../../domain/ids';
import { getCalendar } from '../../domain/time/calendar';
import {
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
} from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';

import {
  EDIT_PLAN_KIND,
  decideEditPlan,
  estimateAnchorBytes,
  formatApproximateBytes,
  hasAnchorStartingAt,
  isYearAligned,
  saveEffectOf,
} from './edit-plan';

const cal = getCalendar('gregorian');

function seriesAt(...starts: readonly (readonly [number, number, number] | number)[]): AnchorSeries {
  const snap = createAnchorSnapshot([], createVertexStore([]));
  return {
    entries: starts.map((s, i) =>
      createAnchorEntry(
        createAnchor(asAnchorId(`a${String(i)}`), snap),
        typeof s === 'number' ? timePointYear(s) : timePointYearMonthDay(s[0], s[1], s[2]),
        null,
      ),
    ),
  };
}

function plan(args: {
  time: ReturnType<typeof timePointYear>;
  series?: AnchorSeries | null;
  present?: boolean;
  size?: { featureCount: number; vertexCount: number } | null;
}) {
  return decideEditPlan({
    currentTime: args.time,
    series: args.series ?? null,
    featurePresent: args.present ?? true,
    calendar: cal,
    snapshotSize: args.size ?? null,
  });
}

describe('isYearAligned は「粒度」ではなく「値」で見る', () => {
  // ここを粒度（granularity === "year"）で判定すると、**正しい年にいるのに保存できない**。
  // 錨を選ぶと現在時刻はその錨の開始時刻へ同期するが、実データもテスト fixture も
  // 年月日で書かれた錨を持ちうるからである。
  it('年だけ・1月1日つき の両方が「年ちょうど」', () => {
    expect(isYearAligned(timePointYear(1200))).toBe(true);
    expect(isYearAligned(timePointYearMonthDay(1573, 1, 1))).toBe(true);
    expect(isYearAligned(timePointYearMonth(1573, 1))).toBe(true);
  });

  it('月日が 1月1日 でなければ「年ちょうど」ではない', () => {
    expect(isYearAligned(timePointYearMonthDay(5080, 12, 31))).toBe(false);
    expect(isYearAligned(timePointYearMonth(5080, 6))).toBe(false);
    expect(isYearAligned(timePointYearMonthDay(1200, 1, 2))).toBe(false);
  });
});

describe('hasAnchorStartingAt は U02 の比較を通す（粒度の違いで取り違えない）', () => {
  it('年だけの錨と、1月1日つきの時刻は「同じ」', () => {
    expect(hasAnchorStartingAt(seriesAt(1200), timePointYearMonthDay(1200, 1, 1), cal)).toBe(true);
    expect(hasAnchorStartingAt(seriesAt([1200, 1, 1]), timePointYear(1200), cal)).toBe(true);
  });

  it('違う年なら偽。系列が無ければ偽', () => {
    expect(hasAnchorStartingAt(seriesAt(0), timePointYear(1200), cal)).toBe(false);
    expect(hasAnchorStartingAt(null, timePointYear(1200), cal)).toBe(false);
  });

  it('年の途中に始まる錨は、その年の頭とは「別」（新しい錨を作る側になる）', () => {
    expect(hasAnchorStartingAt(seriesAt([1200, 6, 1]), timePointYear(1200), cal)).toBe(false);
  });
});

describe('保存の行き先 — 設計書 §D.3 の 4 状態', () => {
  it('①その年ちょうどに錨がある ⇒ 上書き（押せる。文言に年が入る）', () => {
    const p = plan({ time: timePointYear(1200), series: seriesAt(0, 1200) });
    expect(p.kind).toBe(EDIT_PLAN_KIND.Overwrite);
    expect(p.savable).toBe(true);
    expect(p.saveLabel).toBe('1200年の錨を上書き保存');
    expect(p.badgeTime).toBe('1200年');
    expect(p.badgeNote).toContain('1200年の錨を直します');
    expect(p.reason).toBeNull();
  });

  it('②錨は無いが地物はいる ⇒ その年に錨を作る（押せる。文言が上書きと違う）', () => {
    const p = plan({ time: timePointYear(1200), series: seriesAt(0) });
    expect(p.kind).toBe(EDIT_PLAN_KIND.NewAnchor);
    expect(p.savable).toBe(true);
    expect(p.saveLabel).toBe('1200年に錨を作って保存');
    expect(p.badgeNote).toContain('錨を新しく作ります');
    expect(p.reason).toBeNull();
  });

  it('③その年に地物がいない ⇒ 押せない。理由が出る', () => {
    const p = plan({ time: timePointYear(1200), series: seriesAt(0), present: false });
    expect(p.kind).toBe(EDIT_PLAN_KIND.FeatureAbsent);
    expect(p.savable).toBe(false);
    expect(p.editTime).toBeNull();
    expect(p.reason).not.toBeNull();
    expect(p.reason).toContain('1200年');
  });

  it('④年ちょうどでない ⇒ 押せない。理由と、丸めた先が出る', () => {
    const p = plan({ time: timePointYearMonthDay(5080, 12, 31), series: seriesAt(0) });
    expect(p.kind).toBe(EDIT_PLAN_KIND.NotYearAligned);
    expect(p.savable).toBe(false);
    expect(p.editTime).toBeNull();
    expect(p.badgeTime).toBe('5080年12月31日');
    expect(p.reason).toContain('5080年12月31日');
    expect(p.roundedTime).toEqual(timePointYear(5080));
  });

  it('4 状態の文言はすべて違う（押す前に見分けられなければ意味がない）', () => {
    const labels = [
      plan({ time: timePointYear(1200), series: seriesAt(1200) }).saveLabel,
      plan({ time: timePointYear(1200), series: seriesAt(0) }).saveLabel,
      plan({ time: timePointYear(1200), series: seriesAt(0), present: false }).badgeNote,
      plan({ time: timePointYearMonthDay(5080, 12, 31), series: seriesAt(0) }).badgeNote,
    ];
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('「地物がいない」ほうが「年ちょうどでない」より先に効く（本当の理由を出す）', () => {
    // 年へ丸めても保存できないので、「月日の付いた年には作れません」ではなく
    // 「この年にはまだありません」が利用者にとっての本当の理由である。
    const p = plan({
      time: timePointYearMonthDay(5080, 12, 31),
      series: seriesAt(0),
      present: false,
    });
    expect(p.kind).toBe(EDIT_PLAN_KIND.FeatureAbsent);
    expect(p.reason).toContain('5080年12月31日');
  });
});

describe('月日から始まる錨は、その開始にいるとき上書きできる（設計 B1 / GPT#1 / 反証 F9）', () => {
  // 存続期間エディタは月日つきの開始を実際に作れる。錨を選ぶと現在時刻はその開始へ
  // 同期するので、ここを「年ちょうど」で弾くと **その錨だけ永久に編集できない**。
  it('1200年6月1日 に始まる錨を選んでいるときは上書きできる', () => {
    const p = plan({
      time: timePointYearMonthDay(1200, 6, 1),
      series: seriesAt(0, [1200, 6, 1]),
    });
    expect(p.kind).toBe(EDIT_PLAN_KIND.Overwrite);
    expect(p.savable).toBe(true);
    expect(p.reason).toBeNull();
  });

  it('年ちょうどでないときは編集時刻を丸めない（既存の錨の月日をそのまま保つ）', () => {
    const p = plan({
      time: timePointYearMonthDay(1200, 6, 1),
      series: seriesAt(0, [1200, 6, 1]),
    });
    expect(p.editTime).toEqual(timePointYearMonthDay(1200, 6, 1));
  });

  it('文言にも月日が出る（押す前にどの錨を直すか読める）', () => {
    const p = plan({
      time: timePointYearMonthDay(1200, 6, 1),
      series: seriesAt(0, [1200, 6, 1]),
    });
    expect(p.badgeTime).toBe('1200年6月1日');
    expect(p.saveLabel).toBe('1200年6月1日の錨を上書き保存');
  });

  it('同じ月日でも、そこに錨が無ければ今までどおり新設を止める', () => {
    const p = plan({ time: timePointYearMonthDay(1200, 6, 1), series: seriesAt(0) });
    expect(p.kind).toBe(EDIT_PLAN_KIND.NotYearAligned);
    expect(p.savable).toBe(false);
    expect(p.roundedTime).toEqual(timePointYear(1200));
  });
});

describe('保存に渡す編集時刻は「年だけ」', () => {
  // 実データの錨 689 本はすべて年だけで始まる。年ちょうどの時刻から作る錨に月日を
  // 焼き付けない（U-14「月日を勝手に補わない」）。
  it('1月1日つきの現在時刻でも、渡す時刻は年だけになる', () => {
    const p = plan({ time: timePointYearMonthDay(1573, 1, 1), series: seriesAt(0) });
    expect(p.editTime).toEqual(timePointYear(1573));
    expect(p.editTime?.granularity).toBe('year');
  });

  it('紀元前でも年の値は変えない', () => {
    const p = plan({ time: timePointYear(-450), series: seriesAt(-450) });
    expect(p.editTime).toEqual(timePointYear(-450));
    expect(p.badgeTime).toBe('紀元前450年');
    expect(p.saveLabel).toBe('紀元前450年の錨を上書き保存');
  });
});

describe('新しい錨で増える量の概算（設計書 §A.3 / §D.3）', () => {
  it('材料があるときだけ概算を添える（数字を捏造しない）', () => {
    const without = plan({ time: timePointYear(1200), series: seriesAt(0) });
    expect(without.estimatedBytes).toBeNull();
    expect(without.badgeNote).not.toContain('ファイルが');

    const withSize = plan({
      time: timePointYear(1200),
      series: seriesAt(0),
      size: { featureCount: 61, vertexCount: 3067 },
    });
    expect(withSize.estimatedBytes).not.toBeNull();
    expect(withSize.badgeNote).toContain('ファイルが');
  });

  it('上書きのときは概算を出さない（増えないので）', () => {
    const p = plan({
      time: timePointYear(1200),
      series: seriesAt(1200),
      size: { featureCount: 61, vertexCount: 3067 },
    });
    expect(p.estimatedBytes).toBeNull();
  });

  it('デーレ共和国の実測（錨 1 本 = 約 270 KB）と桁が合う', () => {
    // 実測: 地物 61・頂点 3,067 のスナップショットで 276,461 バイト
    // （scripts/measure-anchor-growth.ts）。概算はここから決めた係数なので、
    // **係数を勝手に変えたらここが落ちる**。
    const bytes = estimateAnchorBytes({ featureCount: 61, vertexCount: 3067 });
    expect(bytes).toBeGreaterThan(200_000);
    expect(bytes).toBeLessThan(350_000);
  });
});

describe('formatApproximateBytes', () => {
  it('KB と MB を使い分け、1 KB 未満は言い切る', () => {
    expect(formatApproximateBytes(500)).toBe('1 KB 未満');
    expect(formatApproximateBytes(276_461)).toBe('約 270 KB');
    expect(formatApproximateBytes(15 * 1024 * 1024)).toBe('約 15.0 MB');
  });

  it('壊れた値でも数字を捏造しない', () => {
    expect(formatApproximateBytes(Number.NaN)).toBe('不明');
    expect(formatApproximateBytes(-1)).toBe('不明');
  });
});

describe('保存の「効く範囲」を押す前に見せる（A1 / 反証 F1）', () => {
  const overwrite = plan({ time: timePointYear(1000), series: seriesAt(0, 1000) });
  const disabled = plan({ time: timePointYear(1000), series: seriesAt(0), present: false });

  it('引き継ぎが無ければ、ボタンの文言は行き先だけ', () => {
    const e = saveEffectOf(overwrite, [], null);
    expect(e.saveLabel).toBe('1000年の錨を上書き保存');
  });

  it('引き継ぐ先が 2 件までなら、その年をそのまま並べる', () => {
    const e = saveEffectOf(overwrite, ['2000年', '3000年'], null);
    expect(e.saveLabel).toBe('1000年の錨を上書き保存（2000年・3000年の記録にも同じ値を入れます）');
  });

  it('引き継ぐ先が多いときは先頭 2 件と残りの本数にする（文言が窓からはみ出さない）', () => {
    const e = saveEffectOf(overwrite, ['2000年', '3000年', '4000年', '5000年'], null);
    expect(e.saveLabel).toBe(
      '1000年の錨を上書き保存（2000年・3000年ほか 2 件の記録にも同じ値を入れます）',
    );
  });

  it('「この姿がいつまで続くか」を必ず添える', () => {
    expect(saveEffectOf(overwrite, [], '5000年').effectRange).toBe(
      'この保存でできる姿は5000年まで続きます。',
    );
    expect(saveEffectOf(overwrite, [], null).effectRange).toBe(
      'この保存でできる姿は、この先ずっと続きます。',
    );
  });

  it('押せないときは範囲を出さない（起きないことを約束しない）', () => {
    const e = saveEffectOf(disabled, ['2000年'], '3000年');
    expect(e.effectRange).toBeNull();
    expect(e.saveLabel).toBe(disabled.saveLabel);
  });
});
