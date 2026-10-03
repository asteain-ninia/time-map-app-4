// UI layer (U28 / 所属変更): **新しい上位領域を台帳と同じツリーから選ぶ**（増分 7 の中身 2）。
//
// **これが直すもの**: 親を選ぶ画面は 2 つあり、どちらも階層を出していなかった ――
// 結合の板は `<select>` に **773 件を平らに並べ**（`MergeOptionsDialog` の旧実装）、
// 所属変更は「地図をクリックして親を拾う」しか無かった。773 件のプルダウンは
// 「デーレ共和国はどこ？」に答えられない（同名 10 件の「???州」も並ぶ）。
//
// **台帳の行組み立てをそのまま使う**（教訓 5.29 単一の真実源）: `buildLedgerRows` が
// 階層・絞り込み・自動展開・**同名の見分け**（〈親名〉→ 階層のみち → 座標）まで面倒を
// 見る。ここが持つのは「候補として選べるか」の関門と、行の見た目だけである。
//
// **窓の高さは実測しない**（教訓 5.49）: レイアウトを持たない検査環境で `clientHeight` を
// 測ると 0 になり、「1 行も出ない」状態が永久に緑になる。行の高さも窓の高さも定数で
// 決め、CSS 側に同じ数を書く。

import { useMemo, useState } from 'react';

import { featureDisplayName, type Feature } from '../../domain/feature';
import { buildForest } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';
import {
  LEDGER_ROW_HEIGHT,
  buildLedgerRows,
  ledgerWindow,
  type LedgerFeature,
} from '../discovery/index';
import type { DomainFeatureKind } from '../discovery/index';

import { REPARENT_STRINGS, REPARENT_TEXT } from './strings';

/** 候補の木に見せる行数（高さは CSS の `.parent-tree__scroller` と同じ数にする）。 */
export const PARENT_TREE_VISIBLE_ROWS = 8;

/** 候補の木の窓の高さ（px）。実測しない理由は見出しのとおり。 */
export const PARENT_TREE_VIEWPORT_HEIGHT = PARENT_TREE_VISIBLE_ROWS * LEDGER_ROW_HEIGHT;

export interface ParentTreePickerProps {
  /** その年に効いている地物の全件（候補の母集団）。 */
  readonly features: readonly Feature[];
  /**
   * 候補として選べるか。**null なら選べる／文字列なら断りの理由**（画面に出す）。
   * 判定そのものはドメインの `isLegalNewParent` を呼び出し側が回す（教訓 5.26: 候補の
   * 絞り込みと確定前検証は同じ述語）。
   */
  readonly eligibility: (featureId: FeatureId) => string | null;
  /** いま選んでいる候補。 */
  readonly value: FeatureId | null;
  readonly onChange: (featureId: FeatureId) => void;
  /** `data-testid` の前置き（板ごとに違う）。 */
  readonly testIdPrefix: string;
  /** 読み上げ名。 */
  readonly label: string;
}

/** 空の集合（同一性を保つ）。 */
const NO_IDS: ReadonlySet<FeatureId> = new Set();

export function ParentTreePicker(props: ParentTreePickerProps): JSX.Element {
  const { features, eligibility, value, onChange, testIdPrefix, label } = props;
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<FeatureId>>(NO_IDS);
  const [collapsed, setCollapsed] = useState<ReadonlySet<FeatureId>>(NO_IDS);
  const [scrollTop, setScrollTop] = useState(0);

  const forest = useMemo(() => buildForest(features), [features]);

  // 台帳の材料。**隠れている・錨の本数・代表点は親選びには要らない**ので空で渡す ――
  // 同名の見分けは 2 段目（階層のみち）まででほぼ足りる（3 段目の座標が要るのは
  // 「親も同じ 10 件」で、そこは台帳の仕事である）。
  const ledgerFeatures = useMemo<readonly LedgerFeature[]>(
    () =>
      features.map((f) => ({
        id: f.id,
        name: featureDisplayName(f),
        kind: f.kind as DomainFeatureKind,
        kindLabel: f.kindLabel ?? '',
        parentId: f.parentId ?? null,
        color: f.color.fillColor,
        anchorCount: 0,
        hidden: false,
        hiddenReason: null,
        point: null,
      })),
    [features],
  );

  const built = useMemo(
    () =>
      buildLedgerRows({
        features: ledgerFeatures,
        forest,
        expanded,
        collapsed,
        query,
        tree: true,
      }),
    [ledgerFeatures, forest, expanded, collapsed, query],
  );

  const win = ledgerWindow(built.rows.length, scrollTop, PARENT_TREE_VIEWPORT_HEIGHT);
  const visible = built.rows.slice(win.startIndex, win.endIndex);

  const toggle = (featureId: FeatureId, isOpen: boolean): void => {
    if (isOpen) {
      const nextCollapsed = new Set(collapsed);
      nextCollapsed.add(featureId);
      const nextExpanded = new Set(expanded);
      nextExpanded.delete(featureId);
      setCollapsed(nextCollapsed);
      setExpanded(nextExpanded);
      return;
    }
    const nextExpanded = new Set(expanded);
    nextExpanded.add(featureId);
    const nextCollapsed = new Set(collapsed);
    nextCollapsed.delete(featureId);
    setExpanded(nextExpanded);
    setCollapsed(nextCollapsed);
  };

  return (
    <div className="parent-tree" data-testid={`${testIdPrefix}-tree`}>
      <input
        type="search"
        className="parent-tree__filter"
        data-testid={`${testIdPrefix}-filter`}
        aria-label={REPARENT_STRINGS.parentExistingFilterLabel}
        placeholder={REPARENT_STRINGS.parentExistingFilterLabel}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setScrollTop(0);
        }}
      />
      {built.rows.length === 0 ? (
        <p className="parent-tree__empty" data-testid={`${testIdPrefix}-empty`}>
          {REPARENT_STRINGS.parentExistingEmpty}
        </p>
      ) : (
        <div
          className="parent-tree__scroller"
          data-testid={`${testIdPrefix}-scroller`}
          role="listbox"
          aria-label={label}
          style={{ height: `${String(PARENT_TREE_VIEWPORT_HEIGHT)}px` }}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div style={{ height: `${String(win.totalHeight)}px`, position: 'relative' }}>
            <div style={{ transform: `translateY(${String(win.offsetY)}px)` }}>
              {visible.map((row) => {
                const reason = eligibility(row.featureId);
                const selectable = reason === null;
                const isOpen = row.expanded;
                return (
                  <div
                    key={row.featureId}
                    className="parent-tree__row"
                    style={{ height: `${String(LEDGER_ROW_HEIGHT)}px` }}
                  >
                    {row.hasChildren ? (
                      <button
                        type="button"
                        className="parent-tree__expand"
                        data-testid={`${testIdPrefix}-expand-${row.featureId}`}
                        aria-label={isOpen ? REPARENT_TEXT.collapseAriaLabel : REPARENT_TEXT.expandAriaLabel}
                        onClick={() => toggle(row.featureId, isOpen)}
                      >
                        {isOpen ? '▾' : '▸'}
                      </button>
                    ) : (
                      <span className="parent-tree__expand parent-tree__expand--none" />
                    )}
                    <button
                      type="button"
                      className="parent-tree__pick"
                      data-testid={`${testIdPrefix}-item-${row.featureId}`}
                      role="option"
                      aria-selected={value === row.featureId}
                      aria-disabled={!selectable}
                      disabled={!selectable}
                      title={reason ?? undefined}
                      onClick={() => onChange(row.featureId)}
                    >
                      <span
                        className="parent-tree__indent"
                        style={{ width: `${String(row.indent * 12)}px` }}
                      />
                      <span className="parent-tree__name">{row.name}</span>
                      {row.qualifier !== null && (
                        <span className="parent-tree__qualifier">{row.qualifier}</span>
                      )}
                      {row.kindLabel !== '' && (
                        <span className="parent-tree__kind">{row.kindLabel}</span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
