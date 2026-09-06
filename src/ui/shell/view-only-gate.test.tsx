// 「読むだけ」（表示専用モード）で、**変更経路がひとつも編集を通さない**ことと、**読むための
// 部品はそのまま使える**ことを、1 本の表で固定する（設計書 §A.1 の K-6、実装計画 増分 1 の
// 中身 4b）。
//
// 教訓 5.13「表示専用モードでは編集経路を一括無効化する」(引用):「表示専用モードでは、編集
// UI・編集メニュー項目・編集ショートカットを同じ権限判定で一括無効化する。**部品ごとに個別
// 判定を書くと、見た目だけ非表示でショートカットや右クリック操作が残る。** モード境界は共通
// ヘルパーまたは状態機械で表現する。」
//
// 教訓 5.36「プロジェクト設定とアプリ全体設定の境界を先に定義する」(引用):「プロジェクト固有
// 設定とアプリ全体設定の境界を先に定義し、保存先と反映先を一貫させる。…」
//
// 適用: 判定は `permissions.ts` の `canEdit(mode)` 1 本に寄せた（PropertyPanel の 3 か所が
// `mode !== EDIT_MODE.View` を素書きしていたのを含む）。だが「1 本に寄せた」という**申告**は
// 何度も現物と食い違ってきた（N-03: 値を変える入力 10 個は全部 disabled なのに、いちばん
// 取り返しのつかない「地物を削除」だけが押せた）ので、申告ではなく**経路ごとの実測**で固定
// する。表の行を増やすことが、新しい編集経路を足したときの手続きになる。設定まわりは
// 教訓 5.36 の区分をそのまま境界に使う: プロジェクト設定（＝保存ファイルの中身）は止め、
// アプリ全体設定は止めない（所有者裁定）。
//
// 表は 2 方向に読む。
//   - 禁止側: 「読むだけ」で編集が **通らない** / 「直せる」で編集が **通る**
//     （後者が無いと、全部 false を返す壊れ方でも表は緑のまま通ってしまう）
//   - 許可側: 「読むだけ」でも読むための部品は **使える**（禁止側を広げすぎて、
//     読むことまで巻き添えにしていないかを同じ表で見る）
//
// **件数は検査しない**。以前ここには「経路の数が 10 のままである」という行があったが、これは
// 経路が増えたときに落ちる検査ではなく「増やすと落ちる」検査で、表を育てる手続きそのものを
// 妨げていた（循環的で、守るべき性質を何ひとつ表していない）。代わりに固定するのは「表が空
// でないこと」だけ — `it.each([])` は 1 件も実行せずに緑になるので、そこだけは押さえる。

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { StoreApi } from 'zustand/vanilla';
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

import type { DomainProject } from '../../domain/persistence/index';

import { buildEmptyProject } from '../file-ops/index';
import { HelpToolsController } from '../help-tools/index';
import { DISPATCH_TARGET, HIT_KIND, POINTER_BUTTON, decideDispatch } from '../map/dispatch';
import { GridToggleControl } from '../map/index';
import { PROJECT_FIELD_STRINGS } from '../settings/index';
import { PropertyPanel } from '../property/PropertyPanel';
import { DELETE_BUTTON_LABEL } from '../property/DeleteFeatureButton';
import { PROPERTY_STRINGS } from '../property/messages';
import type {
  AnchorIntervalEditDispatch,
  AnchorSeriesLookup,
  EditDispatch,
  FeatureLookup,
  PropertyEditIntent,
} from '../property/contracts';
import { EDIT_MODE, type EditMode } from '../state/session';
import { createSessionStore, type SessionStore } from '../state/store';

import { AppShell } from './AppShell';
import { CommandRegistry, COMMAND_ID } from './commands';
import { canEdit, resolveCommandEnabled } from './permissions';
import { TOOL_ID } from './tools';

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
  readonly onDeleteFeature?: (id: FeatureId) => void;
  /** 別窓での「詳細表示」要求（読むだけでも押せる側の観測口）。 */
  readonly onOpenDetail?: (id: FeatureId) => void;
  /** 錨列の差し替え（「編集対象の切替」を見るために錨 2 本の列を使う行がある）。 */
  readonly anchorLookup?: AnchorSeriesLookup;
}

function renderPanel(mode: EditMode, wiring: PanelWiring = {}): void {
  render(
    <PropertyPanel
      store={sessionStore(mode)}
      featureLookup={featureLookup}
      anchorLookup={wiring.anchorLookup ?? anchorLookup}
      editDispatch={wiring.editDispatch ?? { dispatchEdit: () => {} }}
      calendar={cal}
      ownerLookup={ownerLookup}
      {...(wiring.anchorIntervalDispatch
        ? { anchorIntervalDispatch: wiring.anchorIntervalDispatch }
        : {})}
      {...(wiring.onDeleteFeature ? { onDeleteFeature: wiring.onDeleteFeature } : {})}
      {...(wiring.onOpenDetail ? { onOpenDetail: wiring.onOpenDetail } : {})}
    />,
  );
}

// --- 設定ダイアログの道具立て（本物の結線をそのまま通す） --------------------
//
// 設定まわりの行は `SettingsDialog` を直接描かず、**合成ルートと同じ経路**で開く:
// HelpToolsController が「設定を開く」コマンドを登録し、そこで store のモードから
// `canEdit` を解いてダイアログへ渡す。ダイアログに canEdit を手で渡してしまうと
// 「誰も渡していない」という一番ありがちな結線漏れを、この表が見逃す（教訓 5.7）。

function projectStore(mode: EditMode): StoreApi<SessionStore<DomainProject>> {
  return createSessionStore<DomainProject>({
    initialDomain: buildEmptyProject(),
    initial: { mode },
  });
}

/** 設定ダイアログを「ツール → 設定」コマンド経由で開く。戻り値は覗いている store。 */
function openSettingsDialog(
  mode: EditMode,
  wiring: { readonly onRequestBasemapReplace?: () => void } = {},
): StoreApi<SessionStore<DomainProject>> {
  const store = projectStore(mode);
  const registry = new CommandRegistry();
  render(
    <HelpToolsController
      store={store}
      registry={registry}
      {...(wiring.onRequestBasemapReplace
        ? { onRequestBasemapReplace: wiring.onRequestBasemapReplace }
        : {})}
    />,
  );
  act(() => {
    registry.dispatch(COMMAND_ID.ToolsSettings);
  });
  return store;
}

/** 右クリックの品揃えのうち「編集」に当たるもの（表示制御は View でも出る＝仕様）。 */
const EDITING_MENU_ITEMS: ReadonlySet<string> = new Set<string>([
  MENU_ITEM_KIND.Delete,
  MENU_ITEM_KIND.DeleteVertex,
  MENU_ITEM_KIND.EditProperties,
  // FR-57「この年に錨を作る」も保存形式を書き換えるので編集項目に数える。
  MENU_ITEM_KIND.CreateAnchorHere,
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
      // **増分 5b で見方を変えた。** 旧版は「道具のボタンが 1 つでも出ているか」を
      // 数えていたが、道具は 1 段になって **鍵が閉じていても並ぶ**（灰色で）。
      // 出ているかどうかではなく **押して構えられるか** を見る ―― 「出るなら起きる」
      // の逆で、「出ていても起きない」ことをここで固定する。
      const store = sessionStore(mode);
      render(<AppShell store={store} />);
      const knife = screen.getByTestId(`tool-${TOOL_ID.EditKnife}`) as HTMLButtonElement;
      if (knife.disabled) return false;
      fireEvent.click(knife);
      return store.getState().activeTool === TOOL_ID.EditKnife;
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
      // **増分 5b で見方を変えた**（②と同じ理由）。面の道具は鍵が閉じていても
      // レールに並ぶので、「在るか」ではなく「構えられるか」を見る。構えられれば
      // 内部の mode は add になる（設計書 §D.1 の導出式）。
      const store = sessionStore(mode);
      render(<AppShell store={store} />);
      const area = screen.getByTestId(`tool-${TOOL_ID.AddArea}`) as HTMLButtonElement;
      if (area.disabled) return false;
      fireEvent.click(area);
      return store.getState().activeTool === TOOL_ID.AddArea;
    },
  },
  {
    name: '⑦ 素性欄の保存（名前を直して保存）',
    canChange: (mode) => {
      const intents: unknown[] = [];
      renderPanel(mode, { editDispatch: { dispatchEdit: (i) => intents.push(i) } });
      // 錨の行を押すと現在時刻がその錨の開始（1560年1月1日）へ揃う。錨を選ぶこと自体は
      // 編集ではないので「読むだけ」でもできる。
      fireEvent.click(screen.getByTestId('anchor-row-a1'));
      const save = screen.queryByTestId('save-button') as HTMLButtonElement | null;
      if (save === null) return false;
      // 増分 2 の手直し A6 から、**値を変えるまで保存ボタンは押せない**（無変更で押しても
      // 黙って何も起きなかったのをやめた）。だから可否を見るのは名前を直した **あと**。
      fireEvent.change(screen.getByLabelText(PROPERTY_STRINGS.nameLabel), {
        target: { value: '羽柴領' },
      });
      // 押せない保存ボタンだと、押しても何も飛ばないので**この行が空振りする**
      // （「読むだけで通らない」も「直せるなら通る」も同じ理由で false になってしまう）。
      if (save.disabled) return false;
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
      // 増分 2 から、存続期間のエディタは **選んでいる錨 1 本ぶんだけ** 一覧の下に出る
      // （行ごとに畳んだエディタを埋めると行の高さが変わり、錨が増えたときに持たない）。
      // 錨を選ぶこと自体は編集ではないので、「読むだけ」でもここまでは進める。
      fireEvent.click(screen.getByTestId('anchor-row-a1'));
      const year = screen.queryByTestId('anchor-interval-start-a1-year');
      const confirm = screen.queryByTestId('anchor-interval-start-a1-confirm');
      if (year === null || confirm === null) return false;
      fireEvent.change(year, { target: { value: '1500' } });
      fireEvent.click(confirm);
      return intents.length > 0;
    },
  },
  {
    // 詳細文書に専用の保存ボタンがあった頃の名残ではない。増分 2 で保存の場所を素性欄の
    // 下端の 1 本にまとめた（N-46）ので、本文も **同じ保存列** から確定する。経路として
    // 別に残すのは、本文だけを直したときにも関門が効くことを見るためである。
    name: '⑨ 詳細文書の保存（素性欄の保存列から）',
    canChange: (mode) => {
      const intents: PropertyEditIntent[] = [];
      renderPanel(mode, { editDispatch: { dispatchEdit: (i) => intents.push(i) } });
      const toEdit = screen.queryByTestId('detail-doc-mode-edit');
      if (toEdit === null) return false;
      fireEvent.click(toEdit);
      const textarea = screen.queryByTestId('detail-doc-textarea');
      if (textarea === null) return false;
      fireEvent.change(textarea, { target: { value: '書き足した本文' } });
      const save = screen.queryByTestId('save-button') as HTMLButtonElement | null;
      if (save === null || save.disabled) return false;
      fireEvent.click(save);
      // 名前と同じ 1 つの意図に本文が載って飛ぶ（取り消しも 1 手）。
      return intents.some((i) => i.attributes.detailDocument === '書き足した本文');
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
  // --- ここから プロジェクト設定（＝保存ファイルの中身）を書き換える経路 -------
  //
  // 教訓 5.36 の区分で「プロジェクト設定」に分類される鍵は、押しただけで未保存状態に
  // なり .gimoza に入る。所有者裁定「読むだけの間は保存ファイルの中身を書き換える操作
  // をすべて止める」に従い、ここも禁止側の表に載せる。アプリ全体設定（FR-110）は
  // 裁定どおり変更可なので、この表には載せない（別途 SettingsDialog.test.tsx が
  // 「読むだけでも触れること」を固定している）。
  {
    name: '⑪ 設定ダイアログの確定（カスタムパレットに色を足す）',
    canChange: (mode) => {
      const store = openSettingsDialog(mode);
      const add = screen.getByTestId('settings-palette-add') as HTMLButtonElement;
      if (add.disabled) return false;
      fireEvent.click(add);
      fireEvent.click(screen.getByTestId('settings-save'));
      return store.getState().projectSettings.customPalette.length > 0;
    },
  },
  {
    name: '⑫ 背景地図の差し替え（設定ダイアログの差し替えボタン）',
    canChange: (mode) => {
      // 差し替えの実処理は U39 側にあるので、ここでは「起動要求が飛ぶか」を見る。
      // 飛ばなければ差し替えは絶対に起きない（要求以外の入口が無いことは実装で確認済み）。
      const requests: number[] = [];
      openSettingsDialog(mode, { onRequestBasemapReplace: () => requests.push(1) });
      const button = screen.getByTestId('settings-basemap-replace') as HTMLButtonElement;
      if (button.disabled) return false;
      fireEvent.click(button);
      return requests.length > 0;
    },
  },
  {
    name: '⑬ タイムライン範囲（設定ダイアログのタイムライン最大年）',
    canChange: (mode) => {
      const store = openSettingsDialog(mode);
      const input = screen.getByLabelText(
        PROJECT_FIELD_STRINGS.timelineMaxYear,
      ) as HTMLInputElement;
      if (input.disabled) return false;
      fireEvent.change(input, { target: { value: '4000' } });
      fireEvent.click(screen.getByTestId('settings-save'));
      return store.getState().projectSettings.timelineMaxYear === 4000;
    },
  },
  {
    // 増分 4 の手直し C1。「どこへでも移動」（Ctrl+P）の `>` はコマンドを直に
    // `registry.dispatch` へ渡していたので、**権限の軸を素通り**していた
    // （読むだけでも `>削除` `>面を描く` が走る）。可否も実行も
    // `resolveCommandEnabled` の 1 本を通す形にしたので、ここで経路として固定する。
    name: '⑭ どこへでも移動（Ctrl+P）の「> 削除」',
    canChange: (mode) =>
      resolveCommandEnabled(COMMAND_ID.EditDelete, { runnable: true, mode }),
  },
  {
    name: '⑮ どこへでも移動（Ctrl+P）の「> 面を描く」',
    canChange: (mode) =>
      resolveCommandEnabled(COMMAND_ID.ToolsAddFace, { runnable: true, mode }),
  },
  {
    // 増分 5 の手直し F3。**2 回目の手直しで「打ちかけの無い欄では大域の打鍵を通す」
    // 緩和（`data-pristine`）を入れた**ので、緩和が権限の関門まで開けていないことを
    // ここで固定する。F2（その場で名前を変える）は保存ファイルへ書く操作なので、
    // 読むだけでは走ってはいけない。
    name: '⑯ 一覧の F2（その場で名前を変える）',
    canChange: (mode) => {
      const registry = new CommandRegistry();
      const run = vi.fn();
      registry.register(COMMAND_ID.ListRename, { run });
      render(<AppShell store={sessionStore(mode)} registry={registry} />);
      fireEvent.keyDown(window, { key: 'F2' });
      return run.mock.calls.length > 0;
    },
  },
  {
    // 増分 5 の手直し F3。素性欄の Enter は「保存して次へ」なので、読むだけでは
    // **欄そのものが押せない**（`disabled`）ことと、打鍵が保存へ届かないことの両方を見る。
    name: '⑰ 素性欄の Enter（保存して次へ）',
    canChange: (mode) => {
      const dispatchEdit = vi.fn();
      renderPanel(mode, { editDispatch: { dispatchEdit } });
      const name = screen.getByLabelText(PROPERTY_STRINGS.nameLabel) as HTMLInputElement;
      if (name.disabled) return false;
      fireEvent.change(name, { target: { value: '新しい名前' } });
      fireEvent.keyDown(name, { key: 'Enter' });
      return dispatchEdit.mock.calls.length > 0;
    },
  },
];

// --- 許可側の表（読むだけでも使えるべき部品） --------------------------------
//
// 禁止側だけを増やしていくと、いつか「読むこと」まで巻き添えで塞いでしまう。所有者裁定
// の「読むだけ」＝**選べる・読める**・直せない、の前半を同じ表で固定する。ここに並ぶのは
// どれも「保存ファイルに何も書かない」操作である — 分かれ目は「見え方かどうか」ではなく
// 「保存ファイルに書くかどうか」。
//
// **上部バーのグリッド表示トグルは、この分かれ目の使い方を一度誤った例である。** 実体が
// プロジェクト設定の書き換えだったので禁止側へ入れたが、**起動直後は常に読むだけ**なので
// 「開いて眺めるだけの人が一度もグリッドを消せない」状態になった（裁定の「読める」を
// 損ねる）。直し方は関門をゆるめることではなく **置き場を分ける**ことで、トグルは
// セッション限りの上書き（`gridVisibleOverride`）だけを書くようにした。だからいまは
// 許可側にいる。保存ファイルへ書く経路（設定ダイアログのグリッド項目）は禁止側のまま。

interface AllowedPath {
  /** 利用者から見た部品の名前。 */
  readonly name: string;
  /** そのモードで「その部品が使えるか」を実際に試して返す。 */
  readonly canUse: (mode: EditMode) => boolean;
}

/** 錨 2 本の列（「編集対象の切替」が動いたことを錨の選択状態で観測するため）。 */
function twoAnchorSeries(): AnchorSeries {
  const snap = createAnchorSnapshot([], createVertexStore([]));
  return {
    entries: [
      createAnchorEntry(
        createAnchor(asAnchorId('a1'), snap),
        timePointYearMonthDay(1560, 1, 1),
        null,
      ),
      createAnchorEntry(
        createAnchor(asAnchorId('a2'), snap),
        timePointYearMonthDay(1600, 1, 1),
        null,
      ),
    ],
  };
}

const ALLOWED_PATHS: readonly AllowedPath[] = [
  {
    name: '上部バーのグリッド表示トグル（セッション限りの見え方。保存ファイルに書かない）',
    canUse: (mode) => {
      const store = sessionStore(mode);
      render(<GridToggleControl store={store} />);
      const button = screen.getByTestId('grid-toggle') as HTMLButtonElement;
      if (button.disabled) return false;
      const before = store.getState().gridVisibleOverride ?? store.getState().projectSettings.gridVisible;
      fireEvent.click(button);
      const after = store.getState().gridVisibleOverride;
      // 押せて、見え方が変わり、**保存ファイルにも未保存の印にも触っていない**こと。
      return (
        after === !before &&
        store.getState().projectSettings.gridVisible === true &&
        store.getState().projectDirty === false
      );
    },
  },
  {
    name: '素性欄の「詳細表示」（別窓で読む）',
    canUse: (mode) => {
      const opened: FeatureId[] = [];
      renderPanel(mode, { onOpenDetail: (id) => opened.push(id) });
      const button = screen.getByTestId('open-detail-button') as HTMLButtonElement;
      if (button.disabled) return false;
      fireEvent.click(button);
      return opened.length > 0;
    },
  },
  {
    name: '錨の行を押して編集対象を切り替える（どの錨を見るかを選ぶ）',
    canUse: (mode) => {
      const twoAnchorLookup: AnchorSeriesLookup = {
        anchorSeriesOf: (id) => (id === fA ? twoAnchorSeries() : null),
      };
      renderPanel(mode, { anchorLookup: twoAnchorLookup });
      const row = screen.getByTestId('anchor-row-a2') as HTMLButtonElement;
      if (row.disabled) return false;
      // 前提: 押す前は a2 が編集対象ではない（そうでないと押しても何も観測できない）。
      if (row.getAttribute('aria-selected') === 'true') return false;
      fireEvent.click(row);
      return screen.getByTestId('anchor-row-a2').getAttribute('aria-selected') === 'true';
    },
  },
  {
    // 増分 5 の手直し F3。**送り（Alt+↑ / Alt+↓）は読むだけでも通る**（`permissions.ts` の
    // `EDITING_COMMANDS` に入れていない）。220 件の作業のまとまりを順に「見て回る」のは
    // 読む操作だからで、禁止側だけを増やしていくとここが巻き添えで塞がる。
    name: '作業のまとまりの送り（Alt+↓ で次へ）',
    canUse: (mode) => {
      const registry = new CommandRegistry();
      const run = vi.fn();
      registry.register(COMMAND_ID.ListBundleNext, { run });
      render(<AppShell store={sessionStore(mode)} registry={registry} />);
      fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true });
      return run.mock.calls.length > 0;
    },
  },
  {
    name: '右クリックの表示切替・強調（この地物を非表示 / この地物を強調）',
    canUse: (mode) => {
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
      const items = (model as { items: readonly ContextMenuItem[] }).items;
      const hide = items.find((i) => i.kind === MENU_ITEM_KIND.HideFeature);
      const emphasize = items.find((i) => i.kind === MENU_ITEM_KIND.EmphasizeFeature);
      return (
        hide !== undefined && hide.enabled && emphasize !== undefined && emphasize.enabled
      );
    },
  },
];

describe('K-6 — 「読むだけ」では変更経路がひとつも編集を通さない（教訓 5.13 / 5.36, 設計書 §A.1）', () => {
  // 件数は固定しない（表を増やすのが手続きなので）。ただし空表は `it.each` が 1 件も
  // 実行せずに緑になるため、そこだけ押さえる。
  it('表が空でない（空の表は何も検査せずに緑になる）', () => {
    expect(CHANGE_PATHS.length).toBeGreaterThan(0);
  });

  it('経路の名前が重複していない（同じ行を二度書くと片方の壊れ方が隠れる）', () => {
    expect(new Set(CHANGE_PATHS.map((p) => p.name)).size).toBe(CHANGE_PATHS.length);
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

describe('K-6 — 「読むだけ」でも読むための部品は使える（所有者裁定: 選べる・読める・直せない）', () => {
  it('表が空でない（空の表は何も検査せずに緑になる）', () => {
    expect(ALLOWED_PATHS.length).toBeGreaterThan(0);
  });

  it.each(ALLOWED_PATHS)('$name は「読むだけ」でも使える', ({ canUse }) => {
    expect(canUse(EDIT_MODE.View)).toBe(true);
  });

  it.each(ALLOWED_PATHS)(
    '$name は「直せる」でも当然使える（モードで挙動が変わっていない証）',
    ({ canUse }) => {
      expect(canUse(EDIT_MODE.Edit)).toBe(true);
    },
  );
});
