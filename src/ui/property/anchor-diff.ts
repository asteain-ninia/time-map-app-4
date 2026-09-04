// UI layer (U32 / property panel): 隣り合う 2 本の錨を見比べて「その年に何が変わったか」
// を出す純粋ロジック（設計書 §C.6 の錨表 / §N-15 / 実装計画 増分 2 の中身 4・5）。
//
// **同じ計算が 2 か所で要る**ので 1 つにまとめてある（教訓 5.29 単一の真実源）。
//   - 錨表の行に添える差分の文（「1200年 — 名前が変わった: アアウェン州 → 北アアウェン州」）。
//     現物の行は「0年 → 継続中」しか書いておらず、錨が 10 本に育つと同じ行が 10 行並んで
//     **その年に何が起きたのか読み取れない**（現状分析 N-45）。
//   - まとめ役の子（実データで 86 件 = 3 つの集約の子ぜんぶ）を選んだときに、親の系列から
//     **その子に関わる錨だけ**を選り分ける判定（裁定 §N-15 の (A)）。
//
// **比べる語彙は「保存の対象」と同じ広さでなければならない**（増分 2 の手直し B1 /
// バグ狩り #1 / GPT#3 / 設計 B4）。旧版は名前・種別ラベル・親・頂点だけを見ていたので、
//   - 見た目だけ・詳細文書だけを直して作った錨が、まとめ役の子の錨表から消えた、
//   - その行の文が「この地物に関する変化はありません」と **嘘をついた**、
//   - リングの構成だけが変わった錨（穴を開けた・外周を分けた）も落ちた。
// いまは保存の対象 4 つ（名前・種別ラベル・見た目・詳細文書）＋親＋形の全部を見る。
// 形は頂点の並びと座標に加えて、**地物の種類・リングの種別 / ID / 親リング / 境界**まで
// 見る。
//
// **「前の錨」は 1 か所でしか決めない**（増分 2 の手直し B2 / 設計 B4）。旧版は
// 選り分け（親の系列の隣）と行の文（絞り込んだあとの隣）で別々に決めていた。いまは
// {@link anchorRowsOf} が組（錨とその前の錨）を作り、選り分けも行の文もその組を使う。
//
// 保存形式には何も足さない（既存データから計算する）。

import type { AnchorEntry } from '../../domain/anchor-series';
import type { AnchorSnapshot } from '../../domain/anchor';
import type { Calendar } from '../../domain/time/calendar';
import { compare } from '../../domain/time/normalized';
import type { TimePoint } from '../../domain/time/time-point';
import {
  FEATURE_KIND,
  featureDisplayName,
  referencedVertexIds,
  type Feature,
} from '../../domain/feature';
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
  /**
   * 見た目（塗り色・境界色・不透明度・パレット・自動配色）。**保存の対象 4 つのうちの
   * 1 つ**なのに旧版は見ていなかったので、見た目だけを歴史にした錨が子の錨表から消え、
   * 行の文も「変化はありません」と嘘をついた（B1）。
   */
  Style: 'style',
  /** 詳細文書（同上）。 */
  DetailDocument: 'detailDocument',
} as const;

export type AnchorChangeKind = (typeof ANCHOR_CHANGE)[keyof typeof ANCHOR_CHANGE];

export interface AnchorChange {
  readonly kind: AnchorChangeKind;
  /** 前の値（無いとき null）。画面には「A → B」の形で出す。 */
  readonly before: string | null;
  /** 後の値（無いとき null）。 */
  readonly after: string | null;
}

/**
 * 親の表示名を引く口。**前と後で別の口を渡す**（増分 2 の手直し B4 / GPT#11）。
 * 親が変わったとき、旧親の名前は **前の錨のスナップショット**、新親の名前は **後の錨の
 * スナップショット**にしか居ない。1 つの口で両方を引くと「不明な親 → 不明な親」や
 * 「新しい名前を旧親にも使う」誤表示になる。
 */
export interface ParentNameResolvers {
  readonly before: (id: FeatureId) => string;
  readonly after: (id: FeatureId) => string;
}

/** 名前を引かない（選り分けの判定は名前を使わないので、文字列は要らない）。 */
const NO_PARENT_NAMES: ParentNameResolvers = { before: () => '', after: () => '' };

/** スナップショットからその地物を引く（居なければ null）。 */
export function featureInSnapshot(
  snapshot: AnchorSnapshot,
  featureId: FeatureId,
): Feature | null {
  return snapshot.features.find((f) => f.id === featureId) ?? null;
}

/**
 * 形の骨組み（頂点の座標を除いた構造）が変わったか。**地物の種類・リングの種別・
 * リング ID・親リング・リングの境界（頂点の並び）**を見る（B1 / GPT#3）。
 * 旧版は「参照している頂点 id の平らな並び」しか見ていなかったので、
 * 「同じ頂点で外周を 2 本に分けた」「穴を親リングごと付け替えた」を取りこぼした。
 */
function shapeStructureChanged(before: Feature, after: Feature): boolean {
  if (before.kind !== after.kind) return true;
  if (before.kind === FEATURE_KIND.Leaf && after.kind === FEATURE_KIND.Leaf) {
    const b = before.shape.rings;
    const a = after.shape.rings;
    if (b.length !== a.length) return true;
    for (let i = 0; i < b.length; i += 1) {
      const br = b[i];
      const ar = a[i];
      if (br === undefined || ar === undefined) return true;
      if (br.kind !== ar.kind) return true;
      if (br.id !== ar.id) return true;
      if (br.parentRingId !== ar.parentRingId) return true;
      if (br.vertexIds.length !== ar.vertexIds.length) return true;
      for (let j = 0; j < br.vertexIds.length; j += 1) {
        if (br.vertexIds[j] !== ar.vertexIds[j]) return true;
      }
    }
    return false;
  }
  if (before.kind === FEATURE_KIND.Aggregate && after.kind === FEATURE_KIND.Aggregate) {
    // まとめ役は自分の形を持たない。子の顔ぶれが変われば「形が変わった」と読む。
    if (before.childIds.length !== after.childIds.length) return true;
    for (let i = 0; i < before.childIds.length; i += 1) {
      if (before.childIds[i] !== after.childIds[i]) return true;
    }
    return false;
  }
  return false;
}

/**
 * 形が変わったか。骨組み（上）に加えて、頂点の **並び** と **座標** の両方を見る。
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
  if (shapeStructureChanged(before, after)) return true;
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

/** 見た目（色・不透明度・パレット・自動配色）が変わったか。 */
function styleChanged(before: Feature, after: Feature): boolean {
  const b = before.color;
  const a = after.color;
  return (
    b.autoColorEnabled !== a.autoColorEnabled ||
    b.fillColor !== a.fillColor ||
    b.fillOpacity !== a.fillOpacity ||
    b.selectedColor !== a.selectedColor ||
    b.selectedOpacity !== a.selectedOpacity ||
    b.borderColor !== a.borderColor ||
    b.paletteTheme !== a.paletteTheme
  );
}

/**
 * 隣り合う 2 本の錨のあいだで、その地物に起きた変化を全部並べる。`previous` が null なら
 * 「最初の錨」なので、その錨に地物が居れば「現れた」1 件を返す。
 */
export function changesBetween(
  previous: AnchorEntry | null,
  current: AnchorEntry,
  featureId: FeatureId,
  parentNames: ParentNameResolvers = NO_PARENT_NAMES,
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
      // **前の名前は前のスナップショットから、後の名前は後のスナップショットから**（B4）。
      before: before.parentId === undefined ? null : parentNames.before(before.parentId),
      after: after.parentId === undefined ? null : parentNames.after(after.parentId),
    });
  }
  if (styleChanged(before, after)) {
    changes.push({ kind: ANCHOR_CHANGE.Style, before: null, after: null });
  }
  if ((before.detailDocument ?? '') !== (after.detailDocument ?? '')) {
    changes.push({ kind: ANCHOR_CHANGE.DetailDocument, before: null, after: null });
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
  /**
   * 前の錨と何も変わっていない行（最初の錨でも消滅でもない）。**比べる語彙が保存の対象と
   * 同じ広さになった**（B1）ので、ここに残るのは本当に「値を変えずに作った錨」だけである
   * （Ctrl+K で「この年から同じ姿が続く」を記録したときの行）。
   */
  noChange: 'この年から同じ姿が続くことを記録しました',
  appeared: (name: string): string => `ここから記録が始まります: ${name}`,
  disappeared: (name: string): string => `${name} がこの記録から外れました`,
  name: (before: string, after: string): string => `名前が変わった: ${before} → ${after}`,
  kindLabel: (before: string | null, after: string | null): string =>
    `種別が変わった: ${before ?? '（なし）'} → ${after ?? '（なし）'}`,
  parent: (before: string | null, after: string | null): string =>
    `親が変わった: ${before ?? 'なし'} → ${after ?? 'なし'}`,
  shape: '形が変わった',
  style: '見た目が変わった',
  detailDocument: '詳細文書が変わった',
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
    case ANCHOR_CHANGE.Style:
      return ANCHOR_DIFF_STRINGS.style;
    case ANCHOR_CHANGE.DetailDocument:
      return ANCHOR_DIFF_STRINGS.detailDocument;
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
  parentNames: ParentNameResolvers = NO_PARENT_NAMES,
): string {
  const changes = changesBetween(previous, current, featureId, parentNames);
  if (changes.length === 0) return ANCHOR_DIFF_STRINGS.noChange;
  return changes.map(changeSentence).join(ANCHOR_DIFF_STRINGS.separator);
}

/**
 * その錨がこの地物に「関わる」か（裁定 §N-15 の (A)）。前後 2 本を見比べて、保存の対象・
 * 親・形のどれかが変わっていれば関わる。最初の錨は、そこにこの地物が居れば関わる。
 */
export function isRelevantAnchor(
  previous: AnchorEntry | null,
  current: AnchorEntry,
  featureId: FeatureId,
): boolean {
  return changesBetween(previous, current, featureId).length > 0;
}

/**
 * 錨表に出す 1 行ぶんの材料。**「前の錨」をここで 1 回だけ決める**（B2）。旧版は
 * 選り分け（親の系列の隣）と行の文（絞り込んだあとの隣）で別々に決めていたので、
 * 同じ画面の 2 つの表示が別の根拠を持っていた。
 */
export interface AnchorRow {
  readonly entry: AnchorEntry;
  /** 元の系列での 1 つ前の錨（先頭なら null）。 */
  readonly previous: AnchorEntry | null;
}

/**
 * 系列を行の並びにする。`onlyRelevant` を立てると、その地物に関わる錨だけに絞る
 * （まとめ役の子は親の系列を借りるので、60 人ぶんの他人の変化を混ぜない。§N-15 の (A)）。
 * **絞ったあとも「前の錨」は元の系列の隣のまま**なので、飛ばした錨があっても前後関係は
 * 崩れない。
 */
export function anchorRowsOf(
  entries: readonly AnchorEntry[],
  featureId: FeatureId,
  options?: { readonly onlyRelevant?: boolean },
): readonly AnchorRow[] {
  const onlyRelevant = options?.onlyRelevant ?? false;
  const out: AnchorRow[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const previous = i === 0 ? null : (entries[i - 1] ?? null);
    if (onlyRelevant && !isRelevantAnchor(previous, entry, featureId)) continue;
    out.push({ entry, previous });
  }
  return out;
}

/** 行の左に出す年（「1200年」「継続中」は行の別の場所が持つ）。 */
export function anchorYearLabel(entry: AnchorEntry): string {
  return formatTimePoint(entry.start);
}

/**
 * その地物が **実際に存在している期間** を、系列から連続した区間の並びとして出す
 * （増分 2 の手直し B3 / 設計 C4 / 反証 F7 / バグ狩り #7）。
 *
 * 旧版の「続く」行は `displaySeries`（まとめ役の子では **絞り込んだあと**の並び）の
 * 先頭と末尾だけを見ていたので、
 *   - 子の存在期間ではなく「その子に関わる錨の最初と最後」を出していた、
 *   - 途中に存在しない期間（穴）があっても「0年 → 継続中」と 1 本に見せていた。
 * ここでは **親の系列そのもの** を歩き、「その錨にこの地物が居るか」と「前の錨の終わりが
 * 次の錨の始まりに繋がっているか」の 2 つで区間を切る。
 */
export interface ExistenceRun {
  readonly start: TimePoint;
  /** 区間の終わり。null は「継続中」。 */
  readonly end: TimePoint | null;
}

export function existenceRunsOf(
  entries: readonly AnchorEntry[],
  featureId: FeatureId,
  calendar: Calendar,
): readonly ExistenceRun[] {
  const runs: ExistenceRun[] = [];
  let current: ExistenceRun | null = null;
  for (const entry of entries) {
    const present = featureInSnapshot(entry.anchor.snapshot, featureId) !== null;
    if (!present) {
      if (current !== null) {
        runs.push(current);
        current = null;
      }
      continue;
    }
    if (current === null) {
      current = { start: entry.start, end: entry.end };
      continue;
    }
    // 前の区間が終わっていて、その終わりが次の始まりと繋がっていなければ穴が開いている。
    // 時刻の比較は U02 の 1 本を通す（粒度の違いで取り違えない、教訓 5.16）。
    const continuous =
      current.end === null || compare(current.end, entry.start, calendar) === 0;
    if (continuous) {
      current = { start: current.start, end: entry.end };
    } else {
      runs.push(current);
      current = { start: entry.start, end: entry.end };
    }
  }
  if (current !== null) runs.push(current);
  return runs;
}
