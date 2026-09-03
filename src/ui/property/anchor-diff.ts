// UI layer (U32 / property panel): 隣り合う 2 本の錨を見比べて「その年に何が変わったか」
// を出す純粋ロジック（設計書 §C.6 の錨表 / §N-15 / 実装計画 増分 2 の中身 4・5）。
//
// **同じ計算が 2 か所で要る**ので 1 つにまとめてある（教訓 5.29 単一の真実源）。
//   - 錨表の行に添える差分の文（「1200年 — 名前が変わった: アアウェン州 → 北アアウェン州」）。
//     現物の行は「0年 → 継続中」しか書いておらず、錨が 10 本に育つと同じ行が 10 行並んで
//     **その年に何が起きたのか読み取れない**（現状分析 N-45）。
//   - まとめ役の子（実データで 86 件 = 3 つの集約の子ぜんぶ）を選んだときに、親の系列から
//     **その子に関わる錨だけ**を選り分ける判定（裁定 §N-15 の (A)）。「関わる」＝前後 2 本を
//     見比べて、その地物の名前・種別・親・形のどれかが違うこと。
//
// 保存形式には何も足さない（既存データから計算する）。計算は**画面に載っている行だけ**
// 行い、結果は錨 ID を鍵に使い回す（設計書 §C.6 の錨表の規模）。

import type { AnchorEntry } from '../../domain/anchor-series';
import type { AnchorSnapshot } from '../../domain/anchor';
import { featureDisplayName, referencedVertexIds, type Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';

import { formatTimePoint } from '../timeline/time-display';

/** 変わったものの種類。分岐識別子は定数を経由する（教訓 5.19）。 */
export const ANCHOR_CHANGE = {
  /** その錨からこの地物が現れた（前の錨には居なかった）。 */
  Appeared: 'appeared',
  /** その錨からこの地物が居なくなった。 */
  Disappeared: 'disappeared',
  Name: 'name',
  KindLabel: 'kindLabel',
  Parent: 'parent',
  Shape: 'shape',
} as const;

export type AnchorChangeKind = (typeof ANCHOR_CHANGE)[keyof typeof ANCHOR_CHANGE];

export interface AnchorChange {
  readonly kind: AnchorChangeKind;
  /** 前の値（無いとき null）。画面には「A → B」の形で出す。 */
  readonly before: string | null;
  /** 後の値（無いとき null）。 */
  readonly after: string | null;
}

/** スナップショットからその地物を引く（居なければ null）。 */
export function featureInSnapshot(
  snapshot: AnchorSnapshot,
  featureId: FeatureId,
): Feature | null {
  return snapshot.features.find((f) => f.id === featureId) ?? null;
}

/**
 * 形が変わったか。頂点の **並び** と **座標** の両方を見る。
 *
 * id だけを比べると「同じ頂点を動かした」編集を取りこぼす（id は変わらない）。座標だけを
 * 比べると「頂点を足した／消した」を取りこぼしうる。文字列に畳まず、違いが出た時点で
 * 止める（実データには 2,230 頂点の地物があるので、毎回全部を連結するのは高くつく）。
 */
export function shapeChanged(
  before: Feature,
  beforeSnapshot: AnchorSnapshot,
  after: Feature,
  afterSnapshot: AnchorSnapshot,
): boolean {
  const beforeIds = referencedVertexIds(before);
  const afterIds = referencedVertexIds(after);
  if (beforeIds.length !== afterIds.length) return true;
  for (let i = 0; i < beforeIds.length; i += 1) {
    const bid = beforeIds[i];
    const aid = afterIds[i];
    if (bid !== aid) return true;
    if (bid === undefined || aid === undefined) continue;
    const bv = beforeSnapshot.vertices.byId.get(bid);
    const av = afterSnapshot.vertices.byId.get(aid);
    if (bv === undefined || av === undefined) {
      // 片方だけ引けないのは形の違いとして扱う（黙って「同じ」にしない）。
      if (bv !== av) return true;
      continue;
    }
    if (bv.coordinate.lon !== av.coordinate.lon || bv.coordinate.lat !== av.coordinate.lat) {
      return true;
    }
  }
  return false;
}

/**
 * 隣り合う 2 本の錨のあいだで、その地物に起きた変化を全部並べる。`previous` が null なら
 * 「最初の錨」なので、その錨に地物が居れば「現れた」1 件を返す。
 */
export function changesBetween(
  previous: AnchorEntry | null,
  current: AnchorEntry,
  featureId: FeatureId,
  displayNameOfParent: (id: FeatureId) => string,
): readonly AnchorChange[] {
  const after = featureInSnapshot(current.anchor.snapshot, featureId);
  const before =
    previous === null ? null : featureInSnapshot(previous.anchor.snapshot, featureId);

  if (before === null && after === null) return [];
  if (before === null && after !== null) {
    return [
      { kind: ANCHOR_CHANGE.Appeared, before: null, after: featureDisplayName(after) },
    ];
  }
  if (before !== null && after === null) {
    return [
      { kind: ANCHOR_CHANGE.Disappeared, before: featureDisplayName(before), after: null },
    ];
  }
  if (before === null || after === null) return [];

  const changes: AnchorChange[] = [];
  if (before.attributes.name !== after.attributes.name) {
    changes.push({
      kind: ANCHOR_CHANGE.Name,
      before: featureDisplayName(before),
      after: featureDisplayName(after),
    });
  }
  if ((before.kindLabel ?? '') !== (after.kindLabel ?? '')) {
    changes.push({
      kind: ANCHOR_CHANGE.KindLabel,
      before: before.kindLabel ?? null,
      after: after.kindLabel ?? null,
    });
  }
  if (before.parentId !== after.parentId) {
    changes.push({
      kind: ANCHOR_CHANGE.Parent,
      before: before.parentId === undefined ? null : displayNameOfParent(before.parentId),
      after: after.parentId === undefined ? null : displayNameOfParent(after.parentId),
    });
  }
  if (
    previous !== null &&
    shapeChanged(before, previous.anchor.snapshot, after, current.anchor.snapshot)
  ) {
    changes.push({ kind: ANCHOR_CHANGE.Shape, before: null, after: null });
  }
  return changes;
}

/** 画面に出す言葉（1 か所に集める、NFR 5.7）。 */
export const ANCHOR_DIFF_STRINGS = {
  /** 何も変わっていない行（最初の錨でも消滅でもない）。 */
  noChange: 'この地物に関する変化はありません',
  appeared: (name: string): string => `ここから記録が始まります: ${name}`,
  disappeared: (name: string): string => `${name} がこの記録から外れました`,
  name: (before: string, after: string): string => `名前が変わった: ${before} → ${after}`,
  kindLabel: (before: string | null, after: string | null): string =>
    `種別が変わった: ${before ?? '（なし）'} → ${after ?? '（なし）'}`,
  parent: (before: string | null, after: string | null): string =>
    `親が変わった: ${before ?? 'なし'} → ${after ?? 'なし'}`,
  shape: '形が変わった',
  /** 複数の変化を 1 行に並べるときの区切り。 */
  separator: '／',
} as const;

/** 変化 1 件を日本語にする。 */
export function changeSentence(change: AnchorChange): string {
  switch (change.kind) {
    case ANCHOR_CHANGE.Appeared:
      return ANCHOR_DIFF_STRINGS.appeared(change.after ?? '');
    case ANCHOR_CHANGE.Disappeared:
      return ANCHOR_DIFF_STRINGS.disappeared(change.before ?? '');
    case ANCHOR_CHANGE.Name:
      return ANCHOR_DIFF_STRINGS.name(change.before ?? '', change.after ?? '');
    case ANCHOR_CHANGE.KindLabel:
      return ANCHOR_DIFF_STRINGS.kindLabel(change.before, change.after);
    case ANCHOR_CHANGE.Parent:
      return ANCHOR_DIFF_STRINGS.parent(change.before, change.after);
    case ANCHOR_CHANGE.Shape:
      return ANCHOR_DIFF_STRINGS.shape;
  }
}

/**
 * 錨 1 行に添える文。「1200年 — 名前が変わった: A → B」の後半にあたる部分だけを返す
 * （年は行の左側が持っている）。変化が無ければ {@link ANCHOR_DIFF_STRINGS.noChange}。
 */
export function diffSentence(
  previous: AnchorEntry | null,
  current: AnchorEntry,
  featureId: FeatureId,
  displayNameOfParent: (id: FeatureId) => string,
): string {
  const changes = changesBetween(previous, current, featureId, displayNameOfParent);
  if (changes.length === 0) return ANCHOR_DIFF_STRINGS.noChange;
  return changes.map(changeSentence).join(ANCHOR_DIFF_STRINGS.separator);
}

/**
 * その錨がこの地物に「関わる」か（裁定 §N-15 の (A)）。前後 2 本を見比べて、名前・種別・
 * 親・形のどれかが変わっていれば関わる。最初の錨は、そこにこの地物が居れば関わる。
 */
export function isRelevantAnchor(
  previous: AnchorEntry | null,
  current: AnchorEntry,
  featureId: FeatureId,
): boolean {
  return changesBetween(previous, current, featureId, () => '').length > 0;
}

/**
 * 親の系列から、その子に関わる錨だけを選り分ける（設計書 §C.6「まとめ役の子の錨」）。
 * 比較は **元の系列の並び順** で行うので、飛ばした錨があっても前後関係は崩れない。
 */
export function relevantEntriesFor(
  entries: readonly AnchorEntry[],
  featureId: FeatureId,
): readonly AnchorEntry[] {
  const out: AnchorEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const current = entries[i];
    if (current === undefined) continue;
    const previous = i === 0 ? null : (entries[i - 1] ?? null);
    if (isRelevantAnchor(previous, current, featureId)) out.push(current);
  }
  return out;
}

/** 行の左に出す年（「1200年」「継続中」は行の別の場所が持つ）。 */
export function anchorYearLabel(entry: AnchorEntry): string {
  return formatTimePoint(entry.start);
}
