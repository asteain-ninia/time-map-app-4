// UI layer (U20 / shell): 編集モードの道具の帯（設計書 §C.4）。
//
// **これが埋める穴**: オプションバーは「器 ＋ 道具が押し込む」形（`option-bar.ts`）で、
// いま押し込んでいるのは追加の道具（点・線・面）だけだった。編集モードの 8 つの道具は
// 1 つも押し込んでいないので、**ナイフを構えているのに帯は「✦ 選ぶ」「（選んでいません）」
// 「地図か台帳から地物を選ぶ」と出たまま**になっていた（実測の欠陥。間違った道具名が出る）。
// この部品は、いま構えている道具の名前と、選んでいる地物の名前だけを帯へ押し込む。
//
// **この増分で押し込むのは 2 つだけ**（道具名・対象）。次の一手／設定／確定は道具ごとの
// 中身が要るので後の増分に回す。ただし **間違った内容が出たままにしない** のが目的なので、
// 道具を構えたら必ず `claim` して帯を空へ戻してから押し込む（残りの 3 区画は既定へ戻る）。
//
// **帯の所有権**（`option-bar.ts` の `claim` の注記）:
//   1. 帯は 1 つの道具だけが持つ。持った瞬間に中身は空へ戻る。
//   2. 手放しは自分が持っているときだけ効く。
//   3. 追加の道具（`AddToolController`）とは喧嘩しない ―― **追加モードでは `claim` しない**。
//      モードは排他なので「追加モードの道具」と「編集モードの道具」が同時に構えられる
//      ことはなく、React は「（全部の）後片付け → （全部の）effect」の順に走らせるので、
//      道具を持ち替えた瞬間も「前の道具が手放す → 次の道具が持つ」の順になる。
//
// **描画するものは無い**（`null` を返す）。帯の見た目は `OptionBar.tsx` が持ち、ここは
// 押し込むだけの配線である。合成ルートの好きな場所へ 1 つだけ置けばよい。

import { useEffect } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { featureDisplayName, type Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';
import type { TimePoint } from '../../domain/time/time-point';
// 種別の日本語は素性欄（詳細パネル）と同じ 1 本を使う（教訓 5.29: 写像表を増やさない）。
// `ui/property/index.ts` ではなく `messages.ts` を直に読むのは、index 経由だと
// PropertyPanel → `shell/permissions` と輪になるため（messages.ts はドメインしか読まない）。
import { featureKindJaLabel } from '../property/messages';
import { EDIT_MODE } from '../state/session';
import type { SessionStore } from '../state/store';

import type { OptionBarStore } from './option-bar';
import { EDIT_TOOL_STRINGS } from './strings';
import { editToolName } from './tools';

export interface ToolOptionBarProps<S> {
  /** セッションストア（U16）。道具・モード・選択・年・ドメインをここから読む。 */
  readonly store: StoreApi<SessionStore<S>>;
  /** 押し込み先の帯（設計書 §C.4）。 */
  readonly optionBar: OptionBarStore;
  /**
   * いまの年に効いている地物を id から引く口（U10 / `ui/live-lookup.ts` の
   * `featureByIdAt` をそのまま渡せる形にしてある）。**必須**にしてあるのは、
   * 渡し忘れると対象欄が黙って空のままになり、原因を追えないため（`AddToolController`
   * の `onCommitted` を必須にしたのと同じ理由）。
   */
  readonly resolveFeature: (
    domain: S,
    time: TimePoint,
    featureId: FeatureId,
  ) => Feature | undefined;
}

/**
 * 対象欄（240px）の文字列。設計書 §C.4 の例「アアウェン州（面・州）」の書式で、
 * 表示名 ＋ 丸括弧の種類（＋ 種別ラベルがあれば「・」で足す）。
 *
 * 名前は `featureDisplayName`（名前が空なら id を出す）、種類は `featureKindJaLabel`
 * を使う ―― どちらも既にある 1 本で、ここで写像表を作り直さない（教訓 5.29）。
 */
export function describeOptionBarTarget(feature: Feature): string {
  const name = featureDisplayName(feature);
  const kind = featureKindJaLabel(feature.kind);
  const kindLabel = feature.kindLabel;
  // 教訓 5.18: 空かどうかは長さで決める（空文字の種別ラベルで「・」だけが残らないように）。
  if (kindLabel === undefined || kindLabel.length === 0) {
    return EDIT_TOOL_STRINGS.target(name, kind);
  }
  return EDIT_TOOL_STRINGS.targetWithKindLabel(name, kind, kindLabel);
}

export function ToolOptionBar<S>(props: ToolOptionBarProps<S>): null {
  const { store, optionBar, resolveFeature } = props;

  // **選ぶのは必要な値だけ**（`AddToolController` と同じ作法）。zustand の `useStore` は
  // 選んだ値を Object.is で比べるので、60Hz で動く経路（カメラのパン・カーソル座標）が
  // 変わってもこの部品は再レンダーしない。年とドメインは「選んでいる地物の名前が
  // 変わりうる」入力なので購読するが、どちらも 1 コミット / 1 目盛りに 1 回である。
  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);
  const activeFeature = useStore(store, (s) => s.activeFeature);
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);

  // 帯を持つ条件: **編集モードで、名前の付いた編集道具を構えている**こと。
  // `editToolName` は編集道具にしか名前を持たないので、追加モードの点・線・面では
  // null になる。モードも併せて見るのは、道具だけが残ったまま表示専用へ落ちる経路
  // （`setMode` は道具も畳むが、規則を 1 か所に頼らない）で持ち続けないためである。
  const toolName =
    mode === EDIT_MODE.Edit && activeTool !== null ? editToolName(activeTool) : null;

  // いま選んでいる地物の説明。選んでいなければ null（器が「（選んでいません）」を出す）。
  const targetName =
    toolName === null || activeFeature === null
      ? null
      : describeTargetOf(resolveFeature(domain, currentTime, activeFeature));

  // --- 帯を持つ / 手放す ------------------------------------------------------
  //
  // 道具が替わるたびに持ち直す（`claim` はその瞬間に中身を空へ戻すので、前の道具が
  // 残した道具名・対象・次の一手・設定・確定は持ち越されない＝教訓 5.2）。道具を外す・
  // モードを離れる（`toolName` が null になる）と後片付けが走り、帯は空へ戻る。
  useEffect(() => {
    if (toolName === null) return;
    const owner = {};
    return optionBar.claim(owner);
  }, [optionBar, toolName]);

  // --- 道具名と対象を押し込む -------------------------------------------------
  //
  // **押し込む側が持ち主である**のが規約なので、持っていないとき（`toolName === null`）は
  // 押し込まない。対象は選んでいないときも null を押し込む ―― 選択を外した瞬間に
  // 前の名前が残らないようにするためで、`setTarget` は変化が無ければ何もしない。
  useEffect(() => {
    if (toolName === null) return;
    optionBar.setToolName(toolName);
    // 段階表示（「手順 1/3」）を持つのは複数段の道具だけなので、ここでは常に null。
    optionBar.setTarget(null, targetName);
  }, [optionBar, toolName, targetName]);

  return null;
}

/** 引けなかった地物（その年には居ない等）は名前を出さない ―― 内部 id は見せない（U-1）。 */
function describeTargetOf(feature: Feature | undefined): string | null {
  return feature === undefined ? null : describeOptionBarTarget(feature);
}
