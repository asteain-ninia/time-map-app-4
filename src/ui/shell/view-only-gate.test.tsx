// 「読むだけ」（表示専用モード）で、**10 の変更経路すべてが編集を通さない**ことを 1 本の
// 表で固定する（設計書 §A.1 の K-6、実装計画 増分 1 の中身 4b）。
//
// 教訓 5.13「表示専用モードでは編集経路を一括無効化する」(引用):「表示専用モードでは、編集
// UI・編集メニュー項目・編集ショートカットを同じ権限判定で一括無効化する。**部品ごとに個別
// 判定を書くと、見た目だけ非表示でショートカットや右クリック操作が残る。** モード境界は共通
// ヘルパーまたは状態機械で表現する。」
//
// 適用: 判定は `permissions.ts` の `canEdit(mode)` 1 本に寄せた（PropertyPanel の 3 か所が
// `mode !== EDIT_MODE.View` を素書きしていたのを含む）。だが「1 本に寄せた」という**申告**は
// 何度も現物と食い違ってきた（N-03: 値を変える入力 10 個は全部 disabled なのに、いちばん
// 取り返しのつかない「地物を削除」だけが押せた）ので、申告ではなく**経路ごとの実測**で固定
// する。表の行を増やすことが、新しい編集経路を足したときの手続きになる。
//
// 表は 2 方向に読む。
//   - 「読むだけ」で編集が **通らない**（K-6 の本体）
//   - 「直せる」で編集が **通る**（検査が空振りしていない証。全部 false を返す壊れ方だと
//     片方向だけの表は緑のまま通ってしまう）

/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { type AnchorSeries, createAnchorEntry } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  EMPTY_CONTEXT,
  ownerLookupFromMap,
  type VertexOwnerLookup,
} from '../../domain/selection';
import { createPointFeature, type Feature } from '../../domain/feature';
import { asAnchorId, asFeatureId, asVertexId, type FeatureId } from '../../domain/ids';
import { getCalendar } from '../../domain/time/calendar';
import { timePointYearMonthDay } from '../../domain/time/time-point';
import { createVertexStore } from '../../domain/vertex';
import {
  FEATURE_KIND,
  MENU_ITEM_KIND,
  MENU_TOOL_KIND,
  NO_AXIS_EMPHASIS,
  NO_MENU,
  composeContextMenu,
  featureKindLookupFromMap,
  sharedLookupFromSet,
  type ContextMenuItem,
} from '../../domain/context-menu';

import { DISPATCH_TARGET, HIT_KIND, POINTER_BUTTON, decideDispatch } from '../map/dispatch';
import { PropertyPanel } from '../property/PropertyPanel';
import { DELETE_BUTTON_LABEL } from '../property/DeleteFeatureButton';
import { PROPERTY_STRINGS } from '../property/messages';
import type {
  AnchorIntervalEditDispatch,
  AnchorSeriesLookup,
  DetailDocumentDispatch,
  EditDispatch,
  FeatureLookup,
} from '../property/contracts';
import { EDIT_MODE, type EditMode } from '../state/session';
import { createSessionStore } from '../state/store';

import { AppShell } from './AppShell';
import { CommandRegistry, COMMAND_ID } from './commands';
import { canEdit } from './permissions';

// --- 素性欄の道具立て（最小の 1 地物 + 錨 1 本） ----------------------------

const cal = getCalendar('gregorian');
const color = createColorInfo(true, '#111111', '#222222', '#333333');
const fA = asFeatureId('A');
const vA1 = asVertexId('A-v1');

function featureA(): Feature {
  return createPointFeature(fA, createBasicAttributes('織田領', 1560, 1582), color, vA1);
}

function seriesFor(): AnchorSeries {
  const snap = createAnchorSnapshot([], createVertexStore([]));
  return {
    entries: [
      createAnchorEntry(
        createAnchor(asAnchorId('a1'), snap),
        timePointYearMonthDay(1560, 1, 1),
        null,
      ),
    ],
  };
}

const featureLookup: FeatureLookup = { featureAt: (id) => (id === fA ? featureA() : null) };
const anchorLookup: AnchorSeriesLookup = {
  anchorSeriesOf: (id) => (id === fA ? seriesFor() : null),
};
const ownerLookup: VertexOwnerLookup = ownerLookupFromMap(new Map([[vA1, fA]]));

function sessionStore(mode: EditMode) {
  return createSessionStore<Record<string, never>>({
    initialDomain: {},
    initial: { mode, activeFeature: fA },
  });
}

interface PanelWiring {
  readonly editDispatch?: EditDispatch;
  readonly anchorIntervalDispatch?: AnchorIntervalEditDispatch;
  readonly detailDocumentDispatch?: DetailDocumentDispatch;
  readonly onDeleteFeature?: (id: FeatureId) => void;
}

function renderPanel(mode: EditMode, wiring: PanelWiring = {}): void {
  render(
    <PropertyPanel
      store={sessionStore(mode)}
      featureLookup={featureLookup}
      anchorLookup={anchorLookup}
      editDispatch={wiring.editDispatch ?? { dispatchEdit: () => {} }}
      calendar={cal}
      ownerLookup={ownerLookup}
      {...(wiring.anchorIntervalDispatch
        ? { anchorIntervalDispatch: wiring.anchorIntervalDispatch }
        : {})}
      {...(wiring.detailDocumentDispatch
        ? { detailDocumentDispatch: wiring.detailDocumentDispatch }
        : {})}
      {...(wiring.onDeleteFeature ? { onDeleteFeature: wiring.onDeleteFeature } : {})}
    />,
  );
}

/** 右クリックの品揃えのうち「編集」に当たるもの（表示制御は View でも出る＝仕様）。 */
const EDITING_MENU_ITEMS: ReadonlySet<string> = new Set<string>([
  MENU_ITEM_KIND.Delete,
  MENU_ITEM_KIND.DeleteVertex,
  MENU_ITEM_KIND.EditProperties,
  MENU_ITEM_KIND.Unshare,
  MENU_ITEM_KIND.Split,
  MENU_ITEM_KIND.ChangeAffiliation,
  MENU_ITEM_KIND.Merge,
]);

// --- 表 ---------------------------------------------------------------------

interface ChangePath {
  /** 利用者から見た経路の名前。 */
  readonly name: string;
  /** そのモードで「変更が通るか」を実際に試して返す。 */
  readonly canChange: (mode: EditMode) => boolean;
  /** 「通る」側を試すモード。既定は編集モード（道具の経路だけ追加モード）。 */
  readonly editableMode?: EditMode;
}

const CHANGE_PATHS: readonly ChangePath[] = [
  {
    name: '① メニュー（編集 → 削除）',
    canChange: (mode) => {
      const registry = new CommandRegistry();
      registry.register(COMMAND_ID.EditDelete, { run: vi.fn() });
      render(<AppShell store={sessionStore(mode)} registry={registry} />);
      fireEvent.click(screen.getByTestId('menu-edit'));
      const item = screen
        .getByTestId('menu-items-edit')
        .querySelector(`[data-command="${COMMAND_ID.EditDelete}"]`) as HTMLButtonElement | null;
      return item !== null && !item.disabled;
    },
  },
  {
    name: '② ツールバー（編集の道具を持つ）',
    canChange: (mode) => {
      render(<AppShell store={sessionStore(mode)} />);
      return screen.getByTestId('toolbar-tools').children.length > 0;
    },
  },
  {
    name: '③ ショートカット（Ctrl+Z）',
    canChange: (mode) => {
      const registry = new CommandRegistry();
      const run = vi.fn();
      registry.register(COMMAND_ID.EditUndo, { run });
      render(<AppShell store={sessionStore(mode)} registry={registry} />);
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
      return run.mock.calls.length > 0;
    },
  },
  {
    name: '④ 右クリック（地図の文脈メニュー）',
    canChange: (mode) => {
      const model = composeContextMenu({
        activeFeature: fA,
        vertexIds: new Set(),
        vertexContext: EMPTY_CONTEXT,
        hitVertexId: null,
        position: { x: 10, y: 10 },
        toolKind: MENU_TOOL_KIND.Select,
        canEdit: canEdit(mode),
        featureKindLookup: featureKindLookupFromMap(new Map([[fA, FEATURE_KIND.Leaf]])),
        sharedLookup: sharedLookupFromSet(new Set()),
        emphasizedFeatureIds: new Set(),
        axisEmphasisLookup: NO_AXIS_EMPHASIS,
      });
      if (model.kind === NO_MENU.kind) return false;
      return (model as { items: readonly ContextMenuItem[] }).items.some((item) =>
        EDITING_MENU_ITEMS.has(item.kind),
      );
    },
  },
  {
    name: '⑤ 地図ドラッグ（左ボタンの行き先）',
    canChange: (mode) => {
      const target = decideDispatch({
        mode,
        button: POINTER_BUTTON.Left,
        hit: { kind: HIT_KIND.Empty },
      });
      // 変更に届くのは Add（作図）と SelectEdit（選択・頂点ドラッグ）だけ。View は
      // 左ボタンがパンに割り当てられているので、構造的に編集へ落ちない。
      return target === DISPATCH_TARGET.Add || target === DISPATCH_TARGET.SelectEdit;
    },
  },
  {
    name: '⑥ 道具の確定（面の道具を構える）',
    editableMode: EDIT_MODE.Add,
    canChange: (mode) => {
      render(<AppShell store={sessionStore(mode)} />);
      // 道具そのものが出ない ⇒ 構えられない ⇒ 確定ボタンも存在し得ない。
      return screen.queryByTestId('tool-add.area') !== null;
    },
  },
  {
    name: '⑦ 素性欄の保存（名前を直して保存）',
    canChange: (mode) => {
      const intents: unknown[] = [];
      renderPanel(mode, { editDispatch: { dispatchEdit: (i) => intents.push(i) } });
      // 錨を選んで編集対象を確定させる（教訓 5.15: 編集時刻は選んだ錨の開始時刻）。
      // 錨を選ぶこと自体は編集ではないので「読むだけ」でもできる。
      fireEvent.click(screen.getByTestId('anchor-row-a1'));
      const save = screen.queryByTestId('save-button');
      if (save === null) return false;
      fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
        target: { value: '羽柴領' },
      });
      fireEvent.click(save);
      return intents.length > 0;
    },
  },
  {
    name: '⑧ 存続期間の編集（錨の開始年を動かす）',
    canChange: (mode) => {
      const intents: unknown[] = [];
      renderPanel(mode, {
        anchorIntervalDispatch: { dispatchAnchorInterval: (i) => intents.push(i) },
      });
      const year = screen.queryByTestId('anchor-interval-start-a1-year');
      const confirm = screen.queryByTestId('anchor-interval-start-a1-confirm');
      if (year === null || confirm === null) return false;
      fireEvent.change(year, { target: { value: '1500' } });
      fireEvent.click(confirm);
      return intents.length > 0;
    },
  },
  {
    name: '⑨ 詳細文書の保存',
    canChange: (mode) => {
      const intents: unknown[] = [];
      renderPanel(mode, {
        detailDocumentDispatch: { dispatchDetailDocument: (i) => intents.push(i) },
      });
      fireEvent.click(screen.getByTestId('anchor-row-a1'));
      const toEdit = screen.queryByTestId('detail-doc-mode-edit');
      if (toEdit === null) return false;
      fireEvent.click(toEdit);
      const textarea = screen.queryByTestId('detail-doc-textarea');
      if (textarea === null) return false;
      fireEvent.change(textarea, { target: { value: '書き足した本文' } });
      const save = screen.queryByTestId('detail-doc-save');
      if (save === null) return false;
      fireEvent.click(save);
      return intents.length > 0;
    },
  },
  {
    name: '⑩ 削除ボタン（地物を削除）',
    canChange: (mode) => {
      const deleted: FeatureId[] = [];
      renderPanel(mode, { onDeleteFeature: (id) => deleted.push(id) });
      const button = within(screen.getByTestId('delete-feature')).getByRole('button', {
        name: DELETE_BUTTON_LABEL,
      }) as HTMLButtonElement;
      if (button.disabled) return false;
      fireEvent.click(button);
      const confirm = screen.queryByRole('button', { name: '削除を確定' });
      if (confirm === null) return false;
      fireEvent.click(confirm);
      return deleted.length > 0;
    },
  },
];

describe('K-6 — 「読むだけ」では 10 の変更経路すべてが編集を通さない（教訓 5.13, 設計書 §A.1）', () => {
  it('経路の数が 10 のままである（新しい編集経路を足したらこの表にも足す）', () => {
    expect(CHANGE_PATHS).toHaveLength(10);
  });

  it.each(CHANGE_PATHS)('$name は「読むだけ」で変更を通さない', ({ canChange }) => {
    expect(canChange(EDIT_MODE.View)).toBe(false);
  });

  it.each(CHANGE_PATHS)(
    '$name は「直せる」で変更を通す（検査が空振りしていない証）',
    ({ canChange, editableMode }) => {
      expect(canChange(editableMode ?? EDIT_MODE.Edit)).toBe(true);
    },
  );
});
