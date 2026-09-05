// 「どこへでも移動」（Ctrl+P。設計書 §C.2 の 26）の絞り込み規則。純粋。
//
// **なぜ規則を明記して別 module にするか**: 現状の「地物を検索」は年を属性の検索対象に
// 入れているので、**数字 1 文字でほぼ全件が一致する**（C10。`HelpToolsController` が
// `String(startYear)` / `String(endYear)` を属性値に混ぜ、`search.ts` が部分一致で見る）。
// 同じ罠を作り直さないために、規則を 5 つに固定してここへ置き、単体で検査できるようにする。
//
// 規則（設計書 §C.2 の 26）:
//   1. **入力が数字だけなら年として扱う。**「1200」と打ったら「1200 年へ移動」の候補だけを
//      出し、地物は出さない。
//   2. **文字を含むなら地物名だけを探す。** 並びは前方一致 → 部分一致。
//      **属性値・年・詳細文書は対象にしない。**
//   3. **同名があれば台帳と同じ規則で区別する**（〈親名〉→ 階層のみち → 通し番号と座標）。
//   4. **コマンドは `>` を先頭に付けたときだけ**候補に出す。
//   5. 候補は最大 12 件。それ以上あるときは「ほかに n 件（Enter で台帳に出す）」を最終行に置く。

import type { FeatureId } from '../../domain/ids';

import { foldForFilter } from './ledger';

/** 候補の種類。 */
export const JUMP_CANDIDATE_KIND = {
  Year: 'year',
  Feature: 'feature',
  Command: 'command',
} as const;

export type JumpCandidateKind =
  (typeof JUMP_CANDIDATE_KIND)[keyof typeof JUMP_CANDIDATE_KIND];

export type JumpCandidate =
  | {
      readonly kind: typeof JUMP_CANDIDATE_KIND.Year;
      readonly year: number;
      readonly label: string;
    }
  | {
      readonly kind: typeof JUMP_CANDIDATE_KIND.Feature;
      readonly featureId: FeatureId;
      readonly label: string;
      /** 同名が複数あるときだけ付く見分け（台帳と同じ文字列）。 */
      readonly qualifier: string | null;
    }
  | {
      readonly kind: typeof JUMP_CANDIDATE_KIND.Command;
      readonly commandId: string;
      readonly label: string;
    };

/** 候補の上限（規則 5）。 */
export const JUMP_MAX_CANDIDATES = 12;

export interface JumpInput {
  /** 打った文字（そのまま。折りたたみはこの module が行う）。 */
  readonly query: string;
  /** 一覧に出しうる地物（母集団は呼び出し側が絞ってから渡す）。 */
  readonly features: readonly {
    readonly id: FeatureId;
    readonly name: string;
    /** 同名が複数あるときの見分け（台帳が作ったものをそのまま渡す）。 */
    readonly qualifier: string | null;
  }[];
  /** 打てるコマンド（`>` のときだけ使う）。 */
  readonly commands: readonly { readonly id: string; readonly label: string }[];
  /** 年の候補の文言（`formatYear` を通した文字列を作る関数）。 */
  readonly yearLabel: (year: number) => string;
}

export interface JumpResult {
  readonly candidates: readonly JumpCandidate[];
  /** 上限で切り捨てた件数（0 なら最終行を出さない）。 */
  readonly truncated: number;
}

/** 数字だけか（全角も NFKC で畳んでから見る。先頭の `-` は紀元前）。 */
export function isYearQuery(folded: string): boolean {
  return /^-?[0-9]+$/.test(folded);
}

/**
 * 候補を作る（規則 1〜5）。**年を地物の属性として探さない**のが要点で、
 * 数字だけの入力は年の 1 件しか返さない。
 */
export function jumpCandidates(input: JumpInput): JumpResult {
  const raw = input.query.trim();
  if (raw === '') return { candidates: [], truncated: 0 };

  // 規則 4: コマンドは `>` を先頭に付けたときだけ。
  if (raw.startsWith('>')) {
    const needle = foldForFilter(raw.slice(1).trim());
    const hits = input.commands
      .filter((c) => needle === '' || foldForFilter(c.label).includes(needle))
      .map<JumpCandidate>((c) => ({
        kind: JUMP_CANDIDATE_KIND.Command,
        commandId: c.id,
        label: c.label,
      }));
    return cap(hits);
  }

  const folded = foldForFilter(raw);

  // 規則 1: 数字だけなら年。**地物は出さない。**
  if (isYearQuery(folded)) {
    const year = Number.parseInt(folded, 10);
    if (Number.isFinite(year)) {
      return {
        candidates: [
          { kind: JUMP_CANDIDATE_KIND.Year, year, label: input.yearLabel(year) },
        ],
        truncated: 0,
      };
    }
  }

  // 規則 2: 文字を含むなら地物名だけ。前方一致 → 部分一致の順。
  const prefix: JumpCandidate[] = [];
  const infix: JumpCandidate[] = [];
  for (const f of input.features) {
    const name = foldForFilter(f.name);
    if (name.startsWith(folded)) {
      prefix.push({
        kind: JUMP_CANDIDATE_KIND.Feature,
        featureId: f.id,
        label: f.name,
        qualifier: f.qualifier,
      });
    } else if (name.includes(folded)) {
      infix.push({
        kind: JUMP_CANDIDATE_KIND.Feature,
        featureId: f.id,
        label: f.name,
        qualifier: f.qualifier,
      });
    }
  }
  return cap([...prefix, ...infix]);
}

/** 規則 5: 12 件で打ち切り、あふれた件数を返す。 */
function cap(all: readonly JumpCandidate[]): JumpResult {
  if (all.length <= JUMP_MAX_CANDIDATES) {
    return { candidates: all, truncated: 0 };
  }
  return {
    candidates: all.slice(0, JUMP_MAX_CANDIDATES),
    truncated: all.length - JUMP_MAX_CANDIDATES,
  };
}
