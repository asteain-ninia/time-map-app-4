// 状態行とウィンドウタイトルの文字を作る純関数の単体テスト（設計書 §C.8 / §H.6）。

import { describe, expect, it } from 'vitest';

import {
  APP_NAME,
  DIRTY_MARK,
  METRES_PER_CSS_PX,
  UNKNOWN_TIME,
  UNSAVED_NEW_PROJECT,
  buildWindowTitle,
  fileNameOf,
  formatClock,
  formatScale,
  formatTimestamp,
  scaleDenominator,
} from './status-format';

describe('fileNameOf — パスから画面に出す名前を取る', () => {
  it('Windows の区切りでも POSIX の区切りでも末尾を返す', () => {
    expect(fileNameOf('E:\\WORKSPACE\\derle-world-2026-08-16.gimoza')).toBe(
      'derle-world-2026-08-16.gimoza',
    );
    expect(fileNameOf('/home/u/derle.gimoza')).toBe('derle.gimoza');
  });

  it('保存先が決まっていなければ null', () => {
    expect(fileNameOf(null)).toBeNull();
  });

  it('末尾が区切りだけのときは null（空の名前を出さない）', () => {
    expect(fileNameOf('E:\\WORKSPACE\\')).toBeNull();
  });
});

describe('buildWindowTitle（設計書 §H.6）', () => {
  it('世界名・ファイル名・未保存の印を並べる', () => {
    expect(
      buildWindowTitle({
        worldName: 'デーレ界',
        fileName: 'derle-world-2026-08-16.gimoza',
        dirty: true,
      }),
    ).toBe(`${APP_NAME} — デーレ界 — derle-world-2026-08-16.gimoza ${DIRTY_MARK}`);
  });

  it('未保存でなければ印は付かない', () => {
    expect(
      buildWindowTitle({ worldName: 'デーレ界', fileName: 'a.gimoza', dirty: false }),
    ).toBe(`${APP_NAME} — デーレ界 — a.gimoza`);
  });

  it('保存先が未確定なら「（未保存の新規）」', () => {
    expect(buildWindowTitle({ worldName: 'デーレ界', fileName: null, dirty: false })).toBe(
      `${APP_NAME} — デーレ界 — ${UNSAVED_NEW_PROJECT}`,
    );
  });

  it('世界名が空なら段ごと落とす（空の「— —」を出さない）', () => {
    expect(buildWindowTitle({ worldName: '   ', fileName: 'a.gimoza', dirty: true })).toBe(
      `${APP_NAME} — a.gimoza ${DIRTY_MARK}`,
    );
  });
});

describe('縮尺（設計書 §C.8。分母の定義は §L.1 の未解決事項をここで決めた）', () => {
  it('実データの既定表示でおよそ 1:1.7 億になる', () => {
    // デーレ界: 赤道 42,035km。地図セル 940px が 360 度 ⇒ zoom ≒ 2.611 px/度。
    // 940px × (1/96 インチ) ≒ 0.2487m に 42,035km が載るので、1:1.69 億前後。
    const zoom = 940 / 360;
    const n = scaleDenominator(zoom, 42035);
    expect(n).not.toBeNull();
    expect(n!).toBeGreaterThan(1.6e8);
    expect(n!).toBeLessThan(1.8e8);
    expect(formatScale(n)).toBe('1:169,000,000');
  });

  it('拡大すると分母が小さくなる（倍率と反比例）', () => {
    const a = scaleDenominator(10, 40000)!;
    const b = scaleDenominator(20, 40000)!;
    expect(b).toBeCloseTo(a / 2, 5);
  });

  it('定義どおり「1 CSS ピクセルの実距離 ÷ 1 CSS ピクセルの物理長」である', () => {
    const zoom = 4;
    const equatorKm = 40000;
    const metresPerPixel = ((equatorKm * 1000) / 360) / zoom;
    expect(scaleDenominator(zoom, equatorKm)).toBeCloseTo(metresPerPixel / METRES_PER_CSS_PX, 3);
  });

  it('病的な入力では null を返し、表示は「—」になる', () => {
    expect(scaleDenominator(0, 40000)).toBeNull();
    expect(scaleDenominator(-1, 40000)).toBeNull();
    expect(scaleDenominator(Number.NaN, 40000)).toBeNull();
    expect(scaleDenominator(4, 0)).toBeNull();
    expect(formatScale(null)).toBe('—');
  });

  it('有効数字 3 桁に丸めて 3 桁区切りにする', () => {
    expect(formatScale(12345678)).toBe('1:12,300,000');
    expect(formatScale(999)).toBe('1:999');
    expect(formatScale(1234)).toBe('1:1,230');
  });
});

describe('formatClock — 最終保存の時刻', () => {
  it('24 時制で 0 埋めする', () => {
    const t = new Date(2026, 8, 3, 4, 5, 0).getTime();
    expect(formatClock(t)).toBe('04:05');
  });

  it('午後も 24 時制で出す', () => {
    const t = new Date(2026, 8, 3, 14, 3, 0).getTime();
    expect(formatClock(t)).toBe('14:03');
  });
});

describe('formatTimestamp — 診断情報の記録時刻', () => {
  it('「年-月-日 時:分:秒」を 0 埋めで出す（ロケールに依らない固定の並び）', () => {
    // `toLocaleString()` だと OS の地域・暦の設定しだいで「2026/9/4 14:03:07」にも
    // 和暦にもなる。診断は環境をまたいで突き合わせる用途なので並びを固定する。
    const t = new Date(2026, 8, 4, 14, 3, 7).getTime();
    expect(formatTimestamp(t)).toBe('2026-09-04 14:03:07');
  });

  it('1 桁の月・日・時・分・秒がすべて 0 埋めされる', () => {
    const t = new Date(2026, 0, 2, 3, 4, 5).getTime();
    expect(formatTimestamp(t)).toBe('2026-01-02 03:04:05');
  });

  it('時:分は formatClock と同じ整形を使う（同じ整形を 2 か所に書かない）', () => {
    const t = new Date(2026, 8, 4, 14, 3, 7).getTime();
    expect(formatTimestamp(t)).toContain(formatClock(t));
  });

  it('読めない日時では「—」を返す', () => {
    expect(formatTimestamp(Number.NaN)).toBe(UNKNOWN_TIME);
  });
});
