// 「どこへでも移動」（Ctrl+P。設計書 §C.2 の 26）の 5 規則。
//
// **いちばん大事なのは規則 1** である。現状の「地物を検索」は年を属性の検索対象に
// 入れているので、**数字 1 文字でほぼ全件が一致する**（C10。`HelpToolsController` が
// `String(startYear)` / `String(endYear)` を属性値に混ぜている）。ここでは
// 「数字だけなら年の候補しか出さない」を機械で固定して、同じ罠を作り直さない。

import { describe, expect, it } from 'vitest';

import { asFeatureId, type FeatureId } from '../../domain/ids';

import {
  JUMP_CANDIDATE_KIND,
  JUMP_MAX_CANDIDATES,
  isYearQuery,
  jumpCandidates,
} from './jump-palette';

function id(s: string): FeatureId {
  return asFeatureId(s);
}

const features = [
  { id: id('a'), name: 'アアウェン州', qualifier: null },
  { id: id('b'), name: '南アアウェン', qualifier: null },
  { id: id('c'), name: '???州', qualifier: '〈デーレ共和国〉' },
  // **年を持っている地物**（現状の検索はこれを属性として引っかけていた＝C10）。
  { id: id('d'), name: '1200年に作った国', qualifier: null },
];

const commands = [
  { id: 'file.save', label: '保存' },
  { id: 'view.fitAll', label: '全体表示' },
];

/**
 * 既定の時間軸は **保存できる年の範囲いっぱい**にしておく（2026-09-06）。
 * こうすると「保存できる年か」を見ている既存の検査は、時間軸の狭さに引っかからない。
 * 時間軸の狭さそのものは {@link runWithTimeline} を使う専用の検査で見る。
 */
const WIDE_TIMELINE = { min: -1_000_000, max: 1_000_000 };

function runWithTimeline(query: string, timelineYears: { min: number; max: number }) {
  return jumpCandidates({
    query,
    features,
    commands,
    yearLabel: (year) => `${String(year)}年 へ移動`,
    timelineYears,
    outOfTimelineLabel: (year, min, max) =>
      `${String(year)}年（時間軸の範囲外。いまの時間軸は ${String(min)}年〜${String(max)}年）`,
    moreLabel: (n) => `ほかに ${String(n)} 件（Enter で一覧に出す）`,
  });
}

function run(query: string) {
  return runWithTimeline(query, WIDE_TIMELINE);
}

describe('どこへでも移動 — 規則 1（数字だけなら年）', () => {
  it('「1」と打つと **年の候補だけ** が出る（775 件が全部出ない＝C10 の罠を作らない）', () => {
    const result = run('1');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.kind).toBe(JUMP_CANDIDATE_KIND.Year);
    // 「1200年に作った国」は **出ない**（名前に 1 を含むが、数字だけの入力は年である）。
    expect(
      result.candidates.some((c) => c.kind === JUMP_CANDIDATE_KIND.Feature),
    ).toBe(false);
  });

  it('紀元前（先頭の -）も年として扱う', () => {
    expect(isYearQuery('-500')).toBe(true);
    const result = run('-500');
    expect(result.candidates[0]).toEqual({
      kind: JUMP_CANDIDATE_KIND.Year,
      year: -500,
      label: '-500年 へ移動',
      outOfTimeline: false,
    });
  });

  it('全角の数字も年として扱う（NFKC で畳む）', () => {
    const result = run('１２００');
    expect(result.candidates[0]?.kind).toBe(JUMP_CANDIDATE_KIND.Year);
  });

  it('数字と文字が混じっていれば地物名として探す', () => {
    const result = run('1200年');
    expect(result.candidates.map((c) => c.kind)).toEqual([JUMP_CANDIDATE_KIND.Feature]);
  });
});

describe('どこへでも移動 — 規則 2（地物名だけ・前方一致 → 部分一致）', () => {
  it('前方一致が先、部分一致が後', () => {
    const result = run('アアウェン');
    expect(
      result.candidates.map((c) => (c.kind === JUMP_CANDIDATE_KIND.Feature ? c.label : '')),
    ).toEqual(['アアウェン州', '南アアウェン']);
  });

  it('属性値・年・詳細文書は対象にしない（名前だけ）', () => {
    // 「州」を含む名前だけが出る。種別ラベルや説明は見ない。
    const result = run('州');
    expect(
      result.candidates.every((c) => c.kind === JUMP_CANDIDATE_KIND.Feature),
    ).toBe(true);
    expect(result.candidates).toHaveLength(2);
  });
});

describe('どこへでも移動 — 規則 3（同名は台帳と同じ規則で区別）', () => {
  it('台帳が作った見分けをそのまま運ぶ', () => {
    const result = run('???');
    const hit = result.candidates[0];
    expect(hit?.kind).toBe(JUMP_CANDIDATE_KIND.Feature);
    if (hit?.kind !== JUMP_CANDIDATE_KIND.Feature) return;
    expect(hit.qualifier).toBe('〈デーレ共和国〉');
  });
});

describe('どこへでも移動 — 規則 4（コマンドは > のときだけ）', () => {
  it('先頭が > のときだけコマンドが候補に出る', () => {
    const result = run('>保存');
    expect(result.candidates).toEqual([
      { kind: JUMP_CANDIDATE_KIND.Command, commandId: 'file.save', label: '保存' },
    ]);
  });

  it('> が無ければコマンドは 1 つも出ない', () => {
    const result = run('保存');
    expect(
      result.candidates.some((c) => c.kind === JUMP_CANDIDATE_KIND.Command),
    ).toBe(false);
  });

  it('> だけならコマンドの全件が出る', () => {
    const result = run('>');
    expect(result.candidates).toHaveLength(commands.length);
  });
});

describe('どこへでも移動 — 規則 5（12 件で打ち切る）', () => {
  it('12 件を超えたら切り捨て、あふれた件数を返す', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: id(`f${String(i)}`),
      name: `テスト${String(i)}`,
      qualifier: null,
    }));
    const result = jumpCandidates({
      query: 'テスト',
      features: many,
      commands: [],
      yearLabel: (y) => String(y),
      timelineYears: WIDE_TIMELINE,
      outOfTimelineLabel: (y) => String(y),
      moreLabel: (n) => `ほかに ${String(n)} 件（Enter で一覧に出す）`,
    });
    // **「ほかに n 件」は本物の候補である**（手直し C3）。12 件＋最終行の 13 件で、
    // 最終行は打った語を持っている（Enter で一覧の絞り込みへ渡すため）。
    expect(result.candidates).toHaveLength(JUMP_MAX_CANDIDATES + 1);
    expect(result.truncated).toBe(30 - JUMP_MAX_CANDIDATES);
    const last = result.candidates[result.candidates.length - 1];
    expect(last?.kind).toBe(JUMP_CANDIDATE_KIND.More);
    expect(last?.kind === JUMP_CANDIDATE_KIND.More ? last.query : null).toBe('テスト');
  });

  it('保存できない大きさの年は候補にしない（打ち間違いを行き先にしない）', () => {
    // 旧版は「有限でありさえすれば」候補にしていたので、`99999999999999999999` に
    // 「その年へ移動」を出し、押すと黙って端へ丸められていた（表示と行き先が違う）。
    expect(run('99999999999999999999').candidates).toHaveLength(0);
    expect(run('1000001').candidates).toHaveLength(0);
    expect(run('1000000').candidates).toHaveLength(1);
  });
});

describe('どこへでも移動 — 時間軸の範囲外の年（2026-09-06、2 回目の手直し）', () => {
  // 旧版は「保存できる年」でありさえすれば普通の候補にしていたので、いまの企画の
  // 時間軸が 0〜1000 年でも「1500年 へ移動」を出し、押すと `setCurrentTime` が
  // **黙って 1000 年へ丸めて**いた（表示と行き先が違う）。
  it('範囲内の年はそのまま押せる', () => {
    const result = runWithTimeline('500', { min: 0, max: 1000 });
    expect(result.candidates[0]).toEqual({
      kind: JUMP_CANDIDATE_KIND.Year,
      year: 500,
      label: '500年 へ移動',
      outOfTimeline: false,
    });
  });

  it('範囲の外の年は候補に残るが **押せない**、文言が範囲を告げる', () => {
    const result = runWithTimeline('1500', { min: 0, max: 1000 });
    expect(result.candidates[0]).toEqual({
      kind: JUMP_CANDIDATE_KIND.Year,
      year: 1500,
      label: '1500年（時間軸の範囲外。いまの時間軸は 0年〜1000年）',
      outOfTimeline: true,
    });
  });

  it('範囲の下より前の年も同じ（紀元前）', () => {
    const result = runWithTimeline('-1', { min: 0, max: 1000 });
    const first = result.candidates[0];
    expect(first?.kind === JUMP_CANDIDATE_KIND.Year ? first.outOfTimeline : null).toBe(true);
  });

  it('境界の年ちょうどは範囲内（押せる）', () => {
    for (const q of ['0', '1000']) {
      const first = runWithTimeline(q, { min: 0, max: 1000 }).candidates[0];
      expect(first?.kind === JUMP_CANDIDATE_KIND.Year ? first.outOfTimeline : null).toBe(false);
    }
  });
});

describe('どこへでも移動 — 空の入力', () => {
  it('空なら候補を出さない', () => {
    expect(run('').candidates).toHaveLength(0);
    expect(run('   ').candidates).toHaveLength(0);
  });
});
