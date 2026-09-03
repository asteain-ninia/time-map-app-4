// Domain layer (U44 / 編集): 保存した属性を「次にその属性が本当に変わる錨」まで
// 前へ引き継ぐ（増分 2 の手直し A1。反証 F1）。
//
// **なぜ要るのか。** 錨は「その時点の全体の写し」である。だから T より後ろにある錨は、
// T で直したはずの値の **古い写し** をそのまま持っている。錨が 1 本しか無いうちは
// 気づかないが、まとめ役（集約地物）の下では兄弟を直すたびに親の系列へ錨が立つので、
// 「2000 年に兄弟を直した」あとで「1000 年に改名」すると、2000 年の錨が持つ旧名が
// **その年から復活する**。利用者から見れば「1000 年に改名したのに 2000 年で元に戻る」
// であり、国名変更というイベントを正しく扱えていない。
//
// **規則**（所有者の裁定「保存は必ずいま見ている年に効く」から司令塔が導いた決定。
// 裁定で覆せる）:
//
// > T で属性 X を「旧値 → 新値」に保存したら、系列の T より後ろの錨を順に見て、
// > X が **T の直前で効いていた旧値** と等しい間は新値に書き換え、**最初に異なる値を
// > 持つ錨で止める**。止まる位置は属性ごとに独立に決まる。
//
// つまり「意図しない巻き戻し」だけを消し、「本当の変更」は 1 つも壊さない。
// 書き換えた錨が何本あっても **1 回の押下＝1 つの取り消し単位** である（この module は
// 系列を丸ごと作り替えて返すので、呼び出し側の 1 コマンドに収まる）。
//
// **引き継ぐのは保存の対象 4 つ（名前・種別ラベル・見た目・詳細文書）だけ**である
// （設計書 §C.6「保存の対象」）。形（頂点）と親（所属）は引き継がない — 形の編集は
// 別の意味を持つし、親の変更は古い親と新しい親の両方に錨を立てる別経路である。
// 飾りの開始年／終了年も引き継がない（保存の対象ではない、GPT#8）。
//
// 純粋（I/O・時計・乱数なし）。時刻比較は U02 の `compare` 1 本を通す（教訓 5.16）。

import { createAnchorSnapshot, type AnchorSnapshot } from '../anchor';
import { withEntrySnapshot, type AnchorEntry, type AnchorSeries } from '../anchor-series';
import { createColorInfo, withName } from '../attributes';
import {
  withAttributes,
  withColor,
  withDetailDocument,
  withKindLabel,
  type Feature,
} from '../feature';
import type { FeatureId } from '../ids';
import type { Calendar } from '../time/calendar';
import { compare } from '../time/normalized';
import type { TimePoint } from '../time/time-point';

/**
 * 引き継ぐ属性の平たい形。**保存の対象 4 つ**（名前・種別ラベル・見た目・詳細文書）を
 * 1 つずつ独立に持つ。「無い」は空文字で表す（ドメイン側の absent と 1 対 1、教訓 5.18）。
 *
 * UI の `PropertyEditValues` はこの形をそのまま含むので、画面側は下書きを変換せずに
 * 渡せる（＝画面が出す「効く範囲」の予告と、ドメインが実際に書く範囲が同じ計算になる、
 * 教訓 5.29 単一の真実源）。
 */
export interface CarriedAttributes {
  readonly name: string;
  readonly kindLabel: string;
  readonly detailDocument: string;
  readonly autoColorEnabled: boolean;
  readonly fillColor: string;
  readonly fillOpacity: number;
  readonly selectedColor: string;
  readonly selectedOpacity: number;
  readonly borderColor: string;
  readonly paletteTheme: string;
}

/** 引き継ぎの単位（分岐識別子は定数を経由する、教訓 5.19）。 */
export const CARRIED_ATTRIBUTE = {
  Name: 'name',
  KindLabel: 'kindLabel',
  DetailDocument: 'detailDocument',
  AutoColorEnabled: 'autoColorEnabled',
  FillColor: 'fillColor',
  FillOpacity: 'fillOpacity',
  SelectedColor: 'selectedColor',
  SelectedOpacity: 'selectedOpacity',
  BorderColor: 'borderColor',
  PaletteTheme: 'paletteTheme',
} as const;

export type CarriedAttributeKey =
  (typeof CARRIED_ATTRIBUTE)[keyof typeof CARRIED_ATTRIBUTE];

/** 全部の鍵（網羅性は `Record<CarriedAttributeKey, ...>` の型で守られる）。 */
const ALL_KEYS: readonly CarriedAttributeKey[] = Object.values(CARRIED_ATTRIBUTE);

/** 地物から引き継ぐ属性を取り出す。 */
export function carriedAttributesOf(feature: Feature): CarriedAttributes {
  return {
    name: feature.attributes.name,
    kindLabel: feature.kindLabel ?? '',
    detailDocument: feature.detailDocument ?? '',
    autoColorEnabled: feature.color.autoColorEnabled,
    fillColor: feature.color.fillColor,
    fillOpacity: feature.color.fillOpacity,
    selectedColor: feature.color.selectedColor,
    selectedOpacity: feature.color.selectedOpacity,
    borderColor: feature.color.borderColor,
    paletteTheme: feature.color.paletteTheme,
  };
}

/** その属性が 2 つの値のあいだで違うか。 */
function differs(
  key: CarriedAttributeKey,
  a: CarriedAttributes,
  b: CarriedAttributes,
): boolean {
  return a[key] !== b[key];
}

/** 保存で実際に変わった属性の一覧（順序は {@link CARRIED_ATTRIBUTE} の並び）。 */
export function changedCarriedAttributes(
  before: CarriedAttributes,
  after: CarriedAttributes,
): readonly CarriedAttributeKey[] {
  return ALL_KEYS.filter((k) => differs(k, before, after));
}

/** スナップショットからその地物を引く（居なければ null）。 */
function featureIn(snapshot: AnchorSnapshot, featureId: FeatureId): Feature | null {
  return snapshot.features.find((f) => f.id === featureId) ?? null;
}

/**
 * 引き継ぎの歩き方（{@link carryForwardTargets} と {@link applyCarryForward} が
 * **同じ 1 つ**を使う、教訓 5.29）。`visit` には書き換える錨と、その錨で書き換える
 * 属性の一覧を渡す。
 */
function walkCarryForward(
  entries: readonly AnchorEntry[],
  baseTime: TimePoint,
  featureId: FeatureId,
  before: CarriedAttributes,
  after: CarriedAttributes,
  calendar: Calendar,
  visit: (entry: AnchorEntry, keys: readonly CarriedAttributeKey[]) => void,
): void {
  const carrying = new Set<CarriedAttributeKey>(changedCarriedAttributes(before, after));
  if (carrying.size === 0) return;

  for (const entry of entries) {
    // 「T より後ろ」だけ。T ちょうどの錨は保存そのものが書いている。
    if (compare(entry.start, baseTime, calendar) <= 0) continue;
    const feature = featureIn(entry.anchor.snapshot, featureId);
    // その地物がもう居ない錨から先は、この地物の話ではない。**黙って飛ばさず止める**
    // （飛ばすと、いったん消えて再び現れた地物の姿を勝手に書き換えてしまう）。
    if (feature === null) return;

    const current = carriedAttributesOf(feature);
    const applicable: CarriedAttributeKey[] = [];
    for (const key of [...carrying]) {
      if (differs(key, current, before)) {
        // **ここでその属性が本当に変わっている。** これは意図しない巻き戻しではなく
        // 記録された歴史なので、この属性の引き継ぎはここで終わり。
        carrying.delete(key);
      } else {
        applicable.push(key);
      }
    }
    if (applicable.length > 0) visit(entry, applicable);
    if (carrying.size === 0) return;
  }
}

/**
 * その保存が **書き換える先の錨** を古い順に返す（画面が押す前に見せるための予告）。
 * 空なら「この保存はこの年より後ろに触らない」。
 */
export function carryForwardTargets(
  entries: readonly AnchorEntry[],
  baseTime: TimePoint,
  featureId: FeatureId,
  before: CarriedAttributes,
  after: CarriedAttributes,
  calendar: Calendar,
): readonly AnchorEntry[] {
  const out: AnchorEntry[] = [];
  walkCarryForward(entries, baseTime, featureId, before, after, calendar, (entry) => {
    out.push(entry);
  });
  return out;
}

/**
 * その保存の後、**この姿が続かなくなる最初の錨**（＝引き継ぎが止まった先で、実際に
 * 何かが変わる錨）。無ければ null（＝この先ずっと同じ姿）。画面の「この姿は 1500 年まで」
 * に使う。
 */
export function nextDivergingEntry(
  entries: readonly AnchorEntry[],
  baseTime: TimePoint,
  featureId: FeatureId,
  before: CarriedAttributes,
  after: CarriedAttributes,
  calendar: Calendar,
): AnchorEntry | null {
  // **引き継ぎが済んだあとの姿**で見る。引き継ぎで新値になる錨は「姿が変わる」に
  // 数えない（数えると、保存の直後に「この姿は 2000 年まで」と嘘をつく）。
  const carrying = new Set<CarriedAttributeKey>(changedCarriedAttributes(before, after));
  for (const entry of entries) {
    if (compare(entry.start, baseTime, calendar) <= 0) continue;
    const feature = featureIn(entry.anchor.snapshot, featureId);
    if (feature === null) return entry;
    const current = carriedAttributesOf(feature);
    const post: Record<string, unknown> = { ...current };
    for (const key of [...carrying]) {
      if (differs(key, current, before)) carrying.delete(key);
      else post[key] = after[key];
    }
    if (changedCarriedAttributes(post as unknown as CarriedAttributes, after).length > 0) {
      return entry;
    }
  }
  return null;
}

/** 1 つの地物に、引き継ぐ属性だけを流し込む。 */
function withCarried(
  feature: Feature,
  after: CarriedAttributes,
  keys: readonly CarriedAttributeKey[],
): Feature {
  let next = feature;
  const set = new Set<CarriedAttributeKey>(keys);
  if (set.has(CARRIED_ATTRIBUTE.Name)) {
    next = withAttributes(next, withName(next.attributes, after.name));
  }
  if (set.has(CARRIED_ATTRIBUTE.KindLabel)) {
    next = withKindLabel(next, after.kindLabel === '' ? undefined : after.kindLabel);
  }
  if (set.has(CARRIED_ATTRIBUTE.DetailDocument)) {
    next = withDetailDocument(next, after.detailDocument);
  }
  const colorKeys: readonly CarriedAttributeKey[] = [
    CARRIED_ATTRIBUTE.AutoColorEnabled,
    CARRIED_ATTRIBUTE.FillColor,
    CARRIED_ATTRIBUTE.FillOpacity,
    CARRIED_ATTRIBUTE.SelectedColor,
    CARRIED_ATTRIBUTE.SelectedOpacity,
    CARRIED_ATTRIBUTE.BorderColor,
    CARRIED_ATTRIBUTE.PaletteTheme,
  ];
  if (colorKeys.some((k) => set.has(k))) {
    const c = next.color;
    next = withColor(
      next,
      createColorInfo(
        set.has(CARRIED_ATTRIBUTE.AutoColorEnabled) ? after.autoColorEnabled : c.autoColorEnabled,
        set.has(CARRIED_ATTRIBUTE.FillColor) ? after.fillColor : c.fillColor,
        set.has(CARRIED_ATTRIBUTE.SelectedColor) ? after.selectedColor : c.selectedColor,
        set.has(CARRIED_ATTRIBUTE.BorderColor) ? after.borderColor : c.borderColor,
        set.has(CARRIED_ATTRIBUTE.PaletteTheme) ? after.paletteTheme : c.paletteTheme,
        set.has(CARRIED_ATTRIBUTE.FillOpacity) ? after.fillOpacity : c.fillOpacity,
        set.has(CARRIED_ATTRIBUTE.SelectedOpacity) ? after.selectedOpacity : c.selectedOpacity,
      ),
    );
  }
  return next;
}

/**
 * 引き継ぎを実際に適用した系列を返す（入力は変えない）。書き換えが 1 本も無ければ
 * **入力をそのまま返す**（同一性を保つので、呼び出し側の memo が無駄に外れない）。
 */
export function applyCarryForward(
  series: AnchorSeries,
  baseTime: TimePoint,
  featureId: FeatureId,
  before: CarriedAttributes,
  after: CarriedAttributes,
  calendar: Calendar,
): AnchorSeries {
  const rewrites = new Map<AnchorEntry, readonly CarriedAttributeKey[]>();
  walkCarryForward(series.entries, baseTime, featureId, before, after, calendar, (entry, keys) => {
    rewrites.set(entry, keys);
  });
  if (rewrites.size === 0) return series;

  const entries = series.entries.map((entry) => {
    const keys = rewrites.get(entry);
    if (keys === undefined) return entry;
    const snapshot = entry.anchor.snapshot;
    const features = snapshot.features.map((f) =>
      f.id === featureId ? withCarried(f, after, keys) : f,
    );
    // 開始・終了・錨 ID は動かさない（引き継ぎは「その錨が持つ写しの中身」だけを直す）。
    return withEntrySnapshot(entry, createAnchorSnapshot(features, snapshot.vertices));
  });
  return { entries };
}
