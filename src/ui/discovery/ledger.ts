// 地物一覧（台帳）の行を組み立てる純関数（設計書 §C.5 / C4 / FR-111 = R9）。
//
// **なぜ純関数に切り出すか**: 一覧は 775 行（将来 5,000 行）を扱うので、行の組み立て
// （階層のたたみ込み・絞り込み・重複名の見分け）を React の中に書くと、描画のたびに
// 走る仕事なのか一度だけの仕事なのかが読めなくなる。ここは入力（地物の一覧・展開状態・
// 絞り込み語・束）から行の配列を作るだけで、DOM も store も知らない（NFR 5.8）。
//
// **重複名の見分け方は 3 段**（設計書 §C.5。実データの「???州」10 件は**すべて
// デーレ共和国の子**なので、〈親名〉を足しても 10 行が同じ表示になる）:
//   1. 〈親名〉        … 親が違えば区別できる
//   2. 階層のみち      … 親も同じなら、根からの道を出す
//   3. 通し番号と座標  … それでも同じなら、束の通し番号（あれば）と代表点の座標
//
// **段は「足りるまで」上げる**。かたまりごとに独立に決めるので、親で区別できる 2 件は
// 〈親名〉のまま、区別できない 10 件だけが座標まで出る。

import { walkToRoot, type Forest } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';

import type { DomainFeatureKind } from './axes';
import { LEDGER_STRINGS } from './strings';

/** 台帳の 1 行が要る、地物 1 件ぶんの材料。呼び出し側（ホスト）が組み立てる。 */
export interface LedgerFeature {
  readonly id: FeatureId;
  /** 表示名（`featureDisplayName` の結果。名前が空なら id）。 */
  readonly name: string;
  readonly kind: DomainFeatureKind;
  /** 種別ラベル（FR-40）。付いていなければ空文字。 */
  readonly kindLabel: string;
  /** 親（上位領域）。無ければ null。 */
  readonly parentId: FeatureId | null;
  /** 行頭の色ドット（塗り色）。 */
  readonly color: string;
  /** 錨の本数（自分の系列を持たない地物は 0）。 */
  readonly anchorCount: number;
  /** 個別非表示（👁 トグルの状態）。 */
  readonly hidden: boolean;
  /**
   * 代表点（重複名の 3 段目でだけ使う）。引けないときは null。
   * **全件ぶん先に計算しない**のが呼び出し側の約束で、ここは受け取るだけである。
   */
  readonly point: { readonly lon: number; readonly lat: number } | null;
}

/** 台帳の 1 行。 */
export interface LedgerRow {
  readonly featureId: FeatureId;
  /** 木のインデント段数（最上位 = 0）。平のときは常に 0。 */
  readonly indent: number;
  readonly name: string;
  /**
   * 同名が複数あるときだけ足す見分けの文字列（〈親名〉/ 階層のみち / 通し番号と座標）。
   * 重複していなければ null。
   */
  readonly qualifier: string | null;
  /** 種別ラベル（FR-40）。空文字なら列は空。 */
  readonly kindLabel: string;
  readonly kind: DomainFeatureKind;
  readonly color: string;
  readonly anchorCount: number;
  readonly hidden: boolean;
  /** 子を持つか（展開の三角を出すか）。 */
  readonly hasChildren: boolean;
  /** いま展開しているか（子を持たない行は常に false）。 */
  readonly expanded: boolean;
  /** 束の通し番号（1 始まり）。束に入っていなければ null。 */
  readonly bundleIndex: number | null;
  /** 束の「済」（作った時点の名前・種別と、いまの名前・種別が違う）。 */
  readonly done: boolean;
}

/** 行の高さは 28px 固定・折り返しなし（設計書 §C.5 / §F.3）。 */
export const LEDGER_ROW_HEIGHT = 28;

/**
 * 仮想スクロールで、見えている範囲の前後に余分に描く行数。
 *
 * **2 行に抑えてある**のは受け入れ条件（5,000 行で DOM ノード 20 個以下）を、
 * いちばん背の高い窓でも満たすためである。余分を増やすとスクロール中のちらつきは
 * 減るが、その条件を落とす。
 */
export const LEDGER_OVERSCAN = 2;

/** 仮想スクロールの窓（描く行の範囲と、上に空ける高さ）。 */
export interface LedgerWindow {
  /** 描き始める行の添字（含む）。 */
  readonly startIndex: number;
  /** 描き終わる行の添字（含まない）。 */
  readonly endIndex: number;
  /** 描く前に空ける高さ（px）。 */
  readonly offsetY: number;
  /** 全行を並べたときの高さ（px）。スクロール条を出すために要る。 */
  readonly totalHeight: number;
}

/**
 * いまのスクロール位置と窓の高さから、描く行の範囲を出す。
 *
 * 高さが 0（レイアウトがまだ決まっていない・jsdom）のときは **先頭から
 * `LEDGER_OVERSCAN * 2 + 1` 行**を返す。0 行を返すと「一覧が空」と区別が付かず、
 * レイアウトを持たない環境の単体テストが中身を確かめられなくなる（教訓 5.49）。
 */
export function ledgerWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
): LedgerWindow {
  const totalHeight = rowCount * LEDGER_ROW_HEIGHT;
  if (rowCount === 0) return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 };
  const usableHeight =
    viewportHeight > 0 ? viewportHeight : LEDGER_ROW_HEIGHT * (LEDGER_OVERSCAN * 2 + 1);
  const safeScroll = Number.isFinite(scrollTop) && scrollTop > 0 ? scrollTop : 0;
  const firstVisible = Math.floor(safeScroll / LEDGER_ROW_HEIGHT);
  const visibleCount = Math.ceil(usableHeight / LEDGER_ROW_HEIGHT) + 1;
  const startIndex = Math.max(0, firstVisible - LEDGER_OVERSCAN);
  const endIndex = Math.min(rowCount, firstVisible + visibleCount + LEDGER_OVERSCAN);
  return {
    startIndex,
    endIndex,
    offsetY: startIndex * LEDGER_ROW_HEIGHT,
    totalHeight,
  };
}

/** 行を画面に入れるためのスクロール位置（行の上端が窓に入る最小の移動）。 */
export function scrollTopForRow(
  index: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const top = index * LEDGER_ROW_HEIGHT;
  const bottom = top + LEDGER_ROW_HEIGHT;
  if (top < scrollTop) return top;
  if (viewportHeight > 0 && bottom > scrollTop + viewportHeight) {
    return bottom - viewportHeight;
  }
  return scrollTop;
}

/** 絞り込みの正規化（検索と同じ折りたたみ規則: NFKC ＋ 小文字化）。 */
export function foldForFilter(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

/** 座標を 1 桁の短い形にする（行が 28px なので 6 桁は入らない）。 */
export function compactCoordinate(point: {
  readonly lon: number;
  readonly lat: number;
}): string {
  return LEDGER_STRINGS.coordinate(
    formatCompactLat(point.lat),
    formatCompactLon(point.lon),
  );
}

function formatCompactLat(lat: number): string {
  if (!Number.isFinite(lat)) return LEDGER_STRINGS.unknownCoordinate;
  const word = lat < 0 ? LEDGER_STRINGS.south : LEDGER_STRINGS.north;
  return `${word}${Math.abs(lat).toFixed(1)}°`;
}

function formatCompactLon(lon: number): string {
  if (!Number.isFinite(lon)) return LEDGER_STRINGS.unknownCoordinate;
  // 経度は周回を持つ連続量なので、代表値（-180 以上 180 未満）へ畳んでから出す。
  // 畳み方はドメインの単一真実源に合わせた式で、ここで新しい規則を作らない。
  const norm = ((((lon + 180) % 360) + 360) % 360) - 180;
  const word = norm < 0 ? LEDGER_STRINGS.west : LEDGER_STRINGS.east;
  return `${word}${Math.abs(norm).toFixed(1)}°`;
}

/** 重複名の見分けに使う段（検査で段そのものを見るために公開する）。 */
export const QUALIFIER_STAGE = {
  /** 重複していない（見分けは要らない）。 */
  None: 'none',
  /** 〈親名〉。 */
  Parent: 'parent',
  /** 階層のみち。 */
  Path: 'path',
  /** 束の通し番号と座標。 */
  Position: 'position',
} as const;

export type QualifierStage = (typeof QUALIFIER_STAGE)[keyof typeof QUALIFIER_STAGE];

export interface LedgerBuildInput {
  /** 一覧に出しうる地物の全件（母集団は呼び出し側が絞ってから渡す）。 */
  readonly features: readonly LedgerFeature[];
  /**
   * 親子関係。**ドメインの `buildForest` が作ったものをそのまま受け取る**（G-7）。
   * ここで親子を数え直さない（教訓 5.29 単一の真実源）。呼び出し側は `featuresAt` の
   * 結果に `buildForest` を掛けたものを、(ドメイン, 年) で使い回して渡す。
   */
  readonly forest: Forest;
  /** 展開している地物（木のとき）。 */
  readonly expanded: ReadonlySet<FeatureId>;
  /** 絞り込み語（名前・種別ラベルの部分一致）。空なら絞らない。 */
  readonly query: string;
  /** true = 木、false = 平（絞り込み結果を平らに見る）。 */
  readonly tree: boolean;
  /** 束の通し番号（1 始まり）。束が無ければ空。 */
  readonly bundleIndex?: ReadonlyMap<FeatureId, number>;
  /** 束の「済」。 */
  readonly done?: ReadonlySet<FeatureId>;
  /** 束の未処理だけに絞るか。 */
  readonly onlyUnfinished?: boolean;
}

/** 行の組み立て結果（行の配列と、母集団の件数）。 */
export interface LedgerBuildResult {
  readonly rows: readonly LedgerRow[];
  /** 絞り込む前の母集団の件数（「775 件中 30 件」の右側）。 */
  readonly totalCount: number;
  /** 絞り込みに一致した地物の件数（畳んだ親を含まない）。 */
  readonly matchCount: number;
  /** 絞り込みのために自動で開いた親（画面の三角の状態に足して使う）。 */
  readonly autoExpanded: ReadonlySet<FeatureId>;
}

/**
 * 台帳の行を組み立てる。
 *
 * **絞り込みは「一致した地物 ＋ その先祖」を残す**（木のとき）。先祖を落とすと、
 * 一致した子へ辿り着く道が画面から消えるので、木として意味を成さない。先祖は
 * 自動的に開いた状態にする（利用者が畳んだ状態を覚えたままにすると、絞り込んでも
 * 何も出ないように見える）。
 */
export function buildLedgerRows(input: LedgerBuildInput): LedgerBuildResult {
  const {
    features,
    forest,
    expanded,
    query,
    tree,
    bundleIndex,
    done,
    onlyUnfinished = false,
  } = input;

  const byId = new Map<FeatureId, LedgerFeature>();
  for (const f of features) byId.set(f.id, f);

  const qualifiers = buildQualifiers(features, byId, forest, bundleIndex);

  const trimmed = query.trim();
  const needle = trimmed === '' ? null : foldForFilter(trimmed);
  const doneIds = done ?? new Set<FeatureId>();

  const matched = new Set<FeatureId>();
  for (const f of features) {
    if (onlyUnfinished && bundleIndex !== undefined && bundleIndex.has(f.id) && doneIds.has(f.id)) {
      continue;
    }
    if (needle === null) {
      matched.add(f.id);
      continue;
    }
    const hay = foldForFilter(`${f.name} ${f.kindLabel}`);
    if (hay.includes(needle)) matched.add(f.id);
  }

  const autoExpanded = new Set<FeatureId>();
  // 一致した地物の先祖を残す（木のときだけ。平は一致したものだけを並べる）。
  const keep = new Set<FeatureId>(matched);
  if (tree && (needle !== null || onlyUnfinished)) {
    for (const id of matched) {
      const walk = walkToRoot(forest, id);
      const chain = walk.cyclic ? walk.cycle : walk.chain;
      for (const ancestor of chain) {
        if (ancestor === id) continue;
        keep.add(ancestor);
        autoExpanded.add(ancestor);
      }
    }
  }

  const rows: LedgerRow[] = [];
  const isExpanded = (id: FeatureId): boolean =>
    expanded.has(id) || autoExpanded.has(id);

  if (!tree) {
    for (const f of features) {
      if (!matched.has(f.id)) continue;
      rows.push(
        toRow(f, 0, forest, qualifiers, bundleIndex, doneIds, false),
      );
    }
    return {
      rows,
      totalCount: features.length,
      matchCount: matched.size,
      autoExpanded,
    };
  }

  // 木: 根から深さ優先で下る。**循環しても止まる**ように、通った id を覚える
  // （教訓 5.28。`buildForest` の `walkToRoot` と同じ規律）。
  const visited = new Set<FeatureId>();
  /**
   * `allowed` は「この行は親が出すと決めたか」。根は自分で絞り込みを通る必要があるが、
   * 子は親が既に判断している（自分で開いた親は、当たらない子も出す）。
   */
  const walkDown = (id: FeatureId, indent: number, allowed: boolean): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const f = byId.get(id);
    if (f === undefined) return;
    if (!allowed && !keep.has(id)) return;
    // **利用者が自分で開いた親は、絞り込みに当たらない子も出す。**
    // 絞り込み中に親の三角を押しても何も起きない、という「押しても何も起きないボタン」
    // （C9 の②）を作らないため。絞り込みのために自動で開いた親（`autoExpanded`）は
    // 当たった子だけを出す ―― そちらは「探した結果を見せる」ための開きだからである。
    const openedByUser = expanded.has(id);
    const children = (forest.childrenOf.get(id) ?? []).filter(
      (c) => (openedByUser && byId.has(c)) || keep.has(c),
    );
    const open = children.length > 0 && isExpanded(id);
    rows.push(toRow(f, indent, forest, qualifiers, bundleIndex, doneIds, open));
    if (!open) return;
    for (const child of children) walkDown(child, indent + 1, true);
  };
  for (const rootId of forest.rootIds) walkDown(rootId, 0, false);

  return { rows, totalCount: features.length, matchCount: matched.size, autoExpanded };
}

function toRow(
  f: LedgerFeature,
  indent: number,
  forest: Forest,
  qualifiers: ReadonlyMap<FeatureId, string>,
  bundleIndex: ReadonlyMap<FeatureId, number> | undefined,
  doneIds: ReadonlySet<FeatureId>,
  expanded: boolean,
): LedgerRow {
  const children = forest.childrenOf.get(f.id) ?? [];
  return {
    featureId: f.id,
    indent,
    name: f.name,
    qualifier: qualifiers.get(f.id) ?? null,
    kindLabel: f.kindLabel,
    kind: f.kind,
    color: f.color,
    anchorCount: f.anchorCount,
    hidden: f.hidden,
    hasChildren: children.length > 0,
    expanded,
    bundleIndex: bundleIndex?.get(f.id) ?? null,
    done: doneIds.has(f.id),
  };
}

/**
 * 重複名の見分け（3 段）。**かたまりごとに独立に段を上げる**ので、親で区別できる
 * かたまりは〈親名〉のままで、区別できないかたまりだけが座標まで出る。
 *
 * 段の判定は「そのかたまりの中で、その段の文字列が全部違うか」である。1 つでも
 * ぶつかっていれば次の段へ上げる。最後の段（通し番号と座標）はぶつかりうるが、
 * それ以上出せるものが無いのでそこで止める。
 */
export function buildQualifiers(
  features: readonly LedgerFeature[],
  byId: ReadonlyMap<FeatureId, LedgerFeature>,
  forest: Forest,
  bundleIndex?: ReadonlyMap<FeatureId, number>,
): ReadonlyMap<FeatureId, string> {
  const groups = new Map<string, LedgerFeature[]>();
  for (const f of features) {
    const bucket = groups.get(f.name);
    if (bucket === undefined) groups.set(f.name, [f]);
    else bucket.push(f);
  }

  const out = new Map<FeatureId, string>();
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;

    const parentNames = bucket.map((f) =>
      f.parentId === null
        ? LEDGER_STRINGS.noParent
        : (byId.get(f.parentId)?.name ?? LEDGER_STRINGS.noParent),
    );
    if (allDistinct(parentNames)) {
      bucket.forEach((f, i) => out.set(f.id, LEDGER_STRINGS.qualifierParent(parentNames[i] ?? '')));
      continue;
    }

    const paths = bucket.map((f) => pathOf(f.id, byId, forest));
    if (allDistinct(paths)) {
      bucket.forEach((f, i) => out.set(f.id, paths[i] ?? ''));
      continue;
    }

    bucket.forEach((f) => {
      const index = bundleIndex?.get(f.id) ?? null;
      const coordinate = f.point === null ? null : compactCoordinate(f.point);
      out.set(f.id, LEDGER_STRINGS.qualifierPosition(index, coordinate));
    });
  }
  return out;
}

/** そのかたまりの中で、その段の文字列が全部違うか。 */
function allDistinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** 根からその地物までの道（`デーレ共和国 › ???州`）。循環しても止まる。 */
function pathOf(
  id: FeatureId,
  byId: ReadonlyMap<FeatureId, LedgerFeature>,
  forest: Forest,
): string {
  const walk = walkToRoot(forest, id);
  const chain = walk.cyclic ? walk.cycle : walk.chain;
  const names: string[] = [];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const at = chain[i];
    if (at === undefined) continue;
    names.push(byId.get(at)?.name ?? '');
  }
  return names.join(LEDGER_STRINGS.pathSeparator);
}

/**
 * 見分けの段を返す（検査用）。実装は {@link buildQualifiers} と同じ材料を使い、
 * 段だけを返す。**画面の文字列と段が食い違わない**ように、判定の式はここ 1 か所に
 * 置いて両方が使う形にはせず、検査は文字列と段の両方をこの module から取る。
 */
export function qualifierStageOf(
  qualifier: string | null,
): QualifierStage {
  if (qualifier === null) return QUALIFIER_STAGE.None;
  if (qualifier.startsWith(LEDGER_STRINGS.qualifierParentOpen)) return QUALIFIER_STAGE.Parent;
  if (qualifier.includes(LEDGER_STRINGS.pathSeparator)) return QUALIFIER_STAGE.Path;
  return QUALIFIER_STAGE.Position;
}
