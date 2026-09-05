// 作業のまとまり（内部語では「束」。設計書 §C.5 の「束の定義」/ V4）。純粋。
//
// > **束 ＝「絞り込み式を 1 回だけ走らせた結果を、そのときの並びと名前ごと固定したもの」。**
//
// **なぜ要るか**: 実データには仮名が 600 件以上ある。素朴に「絞り込み欄に『付近の領域』と
// 打って上から直す」をやると、**直した瞬間にその行が絞り込みから外れて一覧が組み替わる**
// ので、見ていた場所を毎回見失う（報告 E §2.10 の「改名すると 0/775 件になる」）。束は
// 並びを固定するので、220 件を順に片付けられる。
//
// **「済」は保存しない。導出する**（設計書 §C.5）。保存形式には何も足さない（K-9 適合）。
//
// **開き直しても続けられる仕掛け**（旧版はここが「セッション限りの印」で、日をまたいだ
// 220 件の作業が続けられなかった）: 式に当てはまるかを **通史で** 見る。
//   - メンバー ＝「**過去または現在のどこかの錨で**、その式に名前が当てはまった地物」
//   - 基準の名前・種別 ＝ 当てはまった **いちばん古い錨** での名前・種別
//   - 済 ＝ いまの名前・種別が基準と違う
// こうすると、改名して式に当てはまらなくなった地物も束から落ちず、開き直して同じ式を
// 選び直せば同じ 220 件が同じ並びで出て、直したものが済として出る。
//
// **組み込みの判定**（重複名・種別なし・この年に変わったもの・家族・手で印）は通史では
// 決まらないので、**基準は作った時点の値**にする（＝そのセッションの中だけ済が続く）。
// 上の仕掛けが効くのは式（正規表現）の束だけである、と割り切って明示しておく。

import type { FeatureId } from '../../domain/ids';

import { BUNDLE_STRINGS } from './strings';

/** 束の作り方の種類。式（正規表現）か、組み込みの判定か。 */
export const BUNDLE_KIND = {
  /** 名前の正規表現。**通史で当てはめる**ので、改名しても束から落ちない。 */
  Expression: 'expression',
  /** いま同じ表示名を持つものが 2 件以上ある。 */
  DuplicateName: 'duplicateName',
  /** 種別が付いていない。 */
  NoKindLabel: 'noKindLabel',
  /** 現在時刻に錨の開始がある（＝この年に変わった）。 */
  ChangedThisYear: 'changedThisYear',
  /** 選んでいる地物の親・自分・子孫。 */
  Family: 'family',
  /** 手で印を付けたもの（`markedFeatures`）。 */
  Marked: 'marked',
} as const;

export type BundleKind = (typeof BUNDLE_KIND)[keyof typeof BUNDLE_KIND];

/** 既定で用意する束（設計書 §C.5 の表の 10 種）。 */
export interface BundlePreset {
  readonly id: string;
  readonly label: string;
  readonly kind: BundleKind;
  /** 式（`kind` が Expression のときだけ意味がある）。 */
  readonly expression: string;
  /**
   * いま選べるか（既定は true）。**false のものは画面で選べない**（手直し G5）。
   *
   * 「手で印を付けたもの」は印を付ける手段そのものが増分 7 なので、選べると必ず
   * 0 件で断られる ―― 押しても何も起きないボタンを置かない（C9 の②）。
   */
  readonly available?: boolean;
}

/**
 * 既定の式 10 種。**実データの命名規約はアプリが知らない**ので、式そのものを画面に
 * 出して編集できるようにする（設計書 §C.5）。件数は実データ 2026-08-16 版のもので、
 * ここには **書かない**（数えるのはアプリの仕事で、書き写すと古びる＝開発ガイド §2.6）。
 */
export const BUNDLE_PRESETS: readonly BundlePreset[] = [
  {
    id: 'kana-area',
    label: BUNDLE_STRINGS.presetKana1,
    kind: BUNDLE_KIND.Expression,
    expression: '付近の領域[0-9]+$',
  },
  {
    id: 'kana-island',
    label: BUNDLE_STRINGS.presetKana2,
    kind: BUNDLE_KIND.Expression,
    expression: 'の島[0-9]+$',
  },
  {
    id: 'kana-unknown',
    label: BUNDLE_STRINGS.presetKana3,
    kind: BUNDLE_KIND.Expression,
    expression: '^（.*不明国',
  },
  {
    id: 'kana-sea',
    label: BUNDLE_STRINGS.presetKana4,
    kind: BUNDLE_KIND.Expression,
    expression: 'の海域[0-9]+$',
  },
  {
    id: 'kana-question',
    label: BUNDLE_STRINGS.presetKana5,
    kind: BUNDLE_KIND.Expression,
    expression: '\\?',
  },
  {
    id: 'duplicate-name',
    label: BUNDLE_STRINGS.presetDuplicateName,
    kind: BUNDLE_KIND.DuplicateName,
    expression: '',
  },
  {
    id: 'no-kind-label',
    label: BUNDLE_STRINGS.presetNoKindLabel,
    kind: BUNDLE_KIND.NoKindLabel,
    expression: '',
  },
  {
    id: 'changed-this-year',
    label: BUNDLE_STRINGS.presetChangedThisYear,
    kind: BUNDLE_KIND.ChangedThisYear,
    expression: '',
  },
  {
    id: 'family',
    label: BUNDLE_STRINGS.presetFamily,
    kind: BUNDLE_KIND.Family,
    expression: '',
  },
  {
    id: 'marked',
    label: BUNDLE_STRINGS.presetMarked,
    kind: BUNDLE_KIND.Marked,
    expression: '',
    // 印を付ける手段が増分 7 なので、いまは必ず 0 件になる。選べないようにしておく。
    available: false,
  },
];

/** 束の 1 件。**作った時点（＝基準）の名前と種別**を持つ（「済」の導出に使う）。 */
export interface BundleMember {
  readonly featureId: FeatureId;
  readonly baselineName: string;
  readonly baselineKindLabel: string;
}

/** 束そのもの。**保存形式には何も足さない**（K-9）。 */
export interface Bundle {
  /** どの既定から作ったか（自分で式を書いたときは null）。 */
  readonly presetId: string | null;
  readonly label: string;
  readonly kind: BundleKind;
  /** 画面に出して編集できる式（組み込みの判定では空）。 */
  readonly expression: string;
  /** 並び（作った時点の順）。**改名しても動かない。** */
  readonly members: readonly BundleMember[];
  /** いま何番目か（0 始まり）。空の束では 0。 */
  readonly cursor: number;
}

/** 束を作るための材料（呼び出し側が現在のドメインから組み立てる）。 */
export interface BundleSource {
  /** 母集団（一覧に出しうる地物）。並びはそのまま束の並びになる。 */
  readonly features: readonly {
    readonly id: FeatureId;
    readonly name: string;
    readonly kindLabel: string;
  }[];
  /**
   * その地物が過去から現在までに名乗った名前と種別を、**古い順**に返す。
   * 式の束はこれを使って「当てはまったいちばん古い姿」を基準にする。
   * 自分の系列を持たない地物（まとめ役の子）は空でよい ―― そのときは現在値を使う。
   */
  readonly historyOf: (featureId: FeatureId) => readonly {
    readonly name: string;
    readonly kindLabel: string;
  }[];
  /** 現在時刻に錨の開始があるか（`ChangedThisYear`）。 */
  readonly changedThisYear: (featureId: FeatureId) => boolean;
  /** 家族（親・自分・子孫）の集合（`Family`）。選んでいなければ空。 */
  readonly family: ReadonlySet<FeatureId>;
  /** 手で印を付けた集合（`Marked`）。 */
  readonly marked: ReadonlySet<FeatureId>;
}

/** 式を組み立てた結果。読めない式はここで止める（例外を投げない）。 */
export type BundleBuild =
  | { readonly ok: true; readonly bundle: Bundle }
  | { readonly ok: false; readonly message: string };

/**
 * 束を作る。**並びは母集団の並びのまま**なので、改名しても行が動かない。
 *
 * 式（正規表現）が読めないときは理由を返す（`RegExp` の例外をそのまま画面へ出さない
 * ―― 内部の英語を出さないため、理由は 1 行に丸めて日本語の枠へ入れる）。
 */
export function buildBundle(
  spec: {
    readonly presetId: string | null;
    readonly label: string;
    readonly kind: BundleKind;
    readonly expression: string;
  },
  source: BundleSource,
): BundleBuild {
  const members: BundleMember[] = [];

  if (spec.kind === BUNDLE_KIND.Expression) {
    let re: RegExp;
    try {
      // **絞り込み欄と同じ畳み方にそろえる**（手直し B11）。絞り込み欄は NFKC で
      // 畳んで小文字にしてから比べるので、式のほうだけ生のままだと「全角で打った
      // 式は当たらないのに、同じ字を絞り込み欄に打つと当たる」という食い違いになる。
      // 式は正規表現なので小文字化はできない（文字クラスが壊れる）から、**NFKC で
      // 畳み、大文字小文字を無視する印（i）**を付ける形でそろえる。
      re = new RegExp(spec.expression.normalize('NFKC'), 'i');
    } catch {
      // **エンジンの英語の文言を画面へ出さない**（手直し B11）。読めない式は
      // 「読めない」で足り、内部の表現を見せても直し方は分からない。
      return { ok: false, message: BUNDLE_STRINGS.invalidExpression };
    }
    const matches = (name: string): boolean => re.test(name.normalize('NFKC'));
    for (const f of source.features) {
      // **通史で当てはめる**。当てはまったいちばん古い姿を基準にするので、改名して
      // 式から外れた地物も束に残り、済として出る（開き直しても続けられる）。
      const past = source.historyOf(f.id);
      const oldest = past.find((snap) => matches(snap.name));
      if (oldest !== undefined) {
        members.push({
          featureId: f.id,
          baselineName: oldest.name,
          baselineKindLabel: oldest.kindLabel,
        });
        continue;
      }
      if (matches(f.name)) {
        members.push({
          featureId: f.id,
          baselineName: f.name,
          baselineKindLabel: f.kindLabel,
        });
      }
    }
  } else {
    const inSet = predicateFor(spec.kind, source);
    for (const f of source.features) {
      if (!inSet(f.id, f.name, f.kindLabel)) continue;
      members.push({
        featureId: f.id,
        baselineName: f.name,
        baselineKindLabel: f.kindLabel,
      });
    }
  }

  return {
    ok: true,
    bundle: {
      presetId: spec.presetId,
      label: spec.label,
      kind: spec.kind,
      expression: spec.expression,
      members,
      cursor: 0,
    },
  };
}

function predicateFor(
  kind: BundleKind,
  source: BundleSource,
): (id: FeatureId, name: string, kindLabel: string) => boolean {
  switch (kind) {
    case BUNDLE_KIND.DuplicateName: {
      const counts = new Map<string, number>();
      for (const f of source.features) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
      return (_id, name) => (counts.get(name) ?? 0) >= 2;
    }
    case BUNDLE_KIND.NoKindLabel:
      // 教訓 5.18: 空かどうかは長さで決める。
      return (_id, _name, kindLabel) => kindLabel.length === 0;
    case BUNDLE_KIND.ChangedThisYear:
      return (id) => source.changedThisYear(id);
    case BUNDLE_KIND.Family:
      return (id) => source.family.has(id);
    case BUNDLE_KIND.Marked:
      return (id) => source.marked.has(id);
    case BUNDLE_KIND.Expression:
      // 呼ばれない（上の枝で処理する）。分岐の網羅のために置く。
      return () => false;
  }
}

/** いまの姿（名前・種別）。「済」の判定に要る。 */
export interface BundleCurrent {
  readonly name: string;
  readonly kindLabel: string;
}

/**
 * その 1 件が「済」か。**作った時点の名前・種別と、いまの名前・種別が違うか**だけで
 * 決める（設計書 §C.5）。地物がいまの年に居なければ「済ではない」とみなす ―― 消えた
 * ことを「直した」と言うのは嘘になる。
 */
export function isMemberDone(
  member: BundleMember,
  current: BundleCurrent | undefined,
): boolean {
  if (current === undefined) return false;
  return (
    current.name !== member.baselineName ||
    current.kindLabel !== member.baselineKindLabel
  );
}

/** 束の「済」の集合を導く。 */
export function doneIdsOf(
  bundle: Bundle,
  currentOf: (featureId: FeatureId) => BundleCurrent | undefined,
): Set<FeatureId> {
  const out = new Set<FeatureId>();
  for (const m of bundle.members) {
    if (isMemberDone(m, currentOf(m.featureId))) out.add(m.featureId);
  }
  return out;
}

/** 束の通し番号（1 始まり）。重複名の 3 段目で使う。 */
export function bundleIndexOf(bundle: Bundle): Map<FeatureId, number> {
  const out = new Map<FeatureId, number>();
  bundle.members.forEach((m, i) => out.set(m.featureId, i + 1));
  return out;
}

/**
 * 次の未処理の位置（`from` の**次**から探し、末尾まで無ければ先頭から `from` まで
 * 回り込む）。全部済んでいれば null。
 *
 * 回り込むのは、220 件を上から片付けている途中で 1 件だけ飛ばしたときに、末尾まで
 * 行ってから「もう無い」と言われるより、飛ばした 1 件へ戻るほうが作業が終わるからである。
 */
export function nextUnfinishedIndex(
  bundle: Bundle,
  done: ReadonlySet<FeatureId>,
  from: number,
  available: MemberAvailability = ALWAYS_AVAILABLE,
): number | null {
  const n = bundle.members.length;
  if (n === 0) return null;
  for (let step = 1; step <= n; step += 1) {
    const at = (from + step) % n;
    const m = bundle.members[at];
    if (m === undefined) continue;
    if (!available(m.featureId)) continue;
    if (!done.has(m.featureId)) return at;
  }
  return null;
}

/**
 * その 1 件がいま選べるか（手直し G2）。**削除された地物・その年に居ない地物**は
 * 束の並びには残す（通し番号が動くと重複名の 3 段目が意味を失う）が、送りでは飛ばす。
 * 飛ばさないと「次へ」で **素性欄が空・カメラも動かない幽霊**が選ばれる。
 */
export type MemberAvailability = (featureId: FeatureId) => boolean;

const ALWAYS_AVAILABLE: MemberAvailability = () => true;

/** 束のうち、いまは選べない（居ない）メンバーの件数。 */
export function unavailableMemberCount(
  bundle: Bundle,
  available: MemberAvailability,
): number {
  let n = 0;
  for (const m of bundle.members) if (!available(m.featureId)) n += 1;
  return n;
}

/** 先頭の未処理（束を作った瞬間に選ぶもの）。全部済んでいれば null。 */
export function firstUnfinishedIndex(
  bundle: Bundle,
  done: ReadonlySet<FeatureId>,
  available: MemberAvailability = ALWAYS_AVAILABLE,
): number | null {
  for (let i = 0; i < bundle.members.length; i += 1) {
    const m = bundle.members[i];
    if (m === undefined) continue;
    if (!available(m.featureId)) continue;
    if (!done.has(m.featureId)) return i;
  }
  return null;
}

/** カーソルを動かした束を返す（範囲外は端で止める）。 */
export function withCursor(bundle: Bundle, cursor: number): Bundle {
  const n = bundle.members.length;
  if (n === 0) return bundle.cursor === 0 ? bundle : { ...bundle, cursor: 0 };
  const next = Math.min(Math.max(cursor, 0), n - 1);
  return next === bundle.cursor ? bundle : { ...bundle, cursor: next };
}

/**
 * 束の中でその地物の位置を返す（Ctrl+Z で戻った地物へカーソルを移すために要る）。
 * 束に入っていなければ null。
 */
export function indexOfMember(bundle: Bundle, featureId: FeatureId): number | null {
  const at = bundle.members.findIndex((m) => m.featureId === featureId);
  return at < 0 ? null : at;
}

/**
 * 送り（◀前へ / 次へ▶ / 素性欄の Enter）で行く先の位置。
 *
 * - 進むとき（`delta > 0`）は **次の未処理**へ。全部済んでいれば単に 1 つ進める
 *   （利用者が「済のものも見直したい」ときに詰まらないようにする）。
 * - 戻るとき（`delta < 0`）は **1 つ前**へ。済かどうかは見ない ―― 戻る操作は
 *   「さっき直したものを見直す」ためのものなので、済を飛ばすと目的が果たせない。
 *
 * 束が空なら null。
 */
export function stepIndex(
  bundle: Bundle,
  done: ReadonlySet<FeatureId>,
  delta: number,
  available: MemberAvailability = ALWAYS_AVAILABLE,
): number | null {
  const n = bundle.members.length;
  if (n === 0) return null;
  if (delta < 0) {
    // **居ないものは飛ばして戻る**（手直し G2）。全部居なければその場に留まる。
    for (let at = bundle.cursor - 1; at >= 0; at -= 1) {
      const m = bundle.members[at];
      if (m !== undefined && available(m.featureId)) return at;
    }
    return bundle.cursor;
  }
  const next = nextUnfinishedIndex(bundle, done, bundle.cursor, available);
  if (next !== null) return next;
  for (let at = bundle.cursor + 1; at < n; at += 1) {
    const m = bundle.members[at];
    if (m !== undefined && available(m.featureId)) return at;
  }
  return bundle.cursor;
}
