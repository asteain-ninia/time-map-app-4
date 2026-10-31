// UI layer (U20 / shell): 編集モードの道具の帯（設計書 §C.4）。
//
// **これが埋める穴**: オプションバーは「器 ＋ 道具が押し込む」形（`option-bar.ts`）で、
// いま押し込んでいるのは追加の道具（点・線・面）だけだった。編集モードの 8 つの道具は
// 1 つも押し込んでいないので、**ナイフを構えているのに帯は「✦ 選択」「（選んでいません）」
// 「地図か地物一覧から選ぶ」と出たまま**になっていた（実測の欠陥。間違った道具名が出る）。
// この部品は、いま構えている道具の名前と、選んでいる地物の名前だけを帯へ押し込む。
//
// **この増分で押し込むのは 2 つだけ**（道具名・対象）。次の一手／設定／確定は道具ごとの
// 中身が要るので後の増分に回す。ただし **間違った内容が出たままにしない** のが目的なので、
// 道具を構えたら必ず `claim` して帯を空へ戻してから押し込む（残りの 3 区画は既定へ戻る）。
//
// **実機で見つかった 2 つの穴**（この部品で塞ぐ）:
//   A. **編集モードに入った直後（まだ道具を構えていない）に地物を選んでも対象欄が変わらない**。
//      帯を持つ条件が「名前のある編集道具を構えている」だったので、道具が null の間は
//      誰も帯を持たず、選んだ地物の名前がどこにも出なかった。→ 帯を持つ条件を
//      **「編集モードであること」** に広げる（下の `holdsBar`）。
//   B. **「所属」と「結ぶ」だけ対象欄が「（選んでいません）」のまま**。この 2 つは自前の
//      選択（`useReparentTool` の `targetId` / `useMergeTool` の `targetIds`）を持ち、
//      セッションの `activeFeature` を書かない。→ この 2 つについては **対象を押し込まない**
//      （下の `TOOLS_WITH_OWN_TARGET`）。道具側が自分で押し込む。
//
// **帯の所有権**（`option-bar.ts` の `claim` の注記）:
//   1. 帯は 1 つの道具だけが持つ。持った瞬間に中身は空へ戻る。
//   2. 手放しは自分が持っているときだけ効く。
//   3. 追加の道具（`AddToolController`）とは喧嘩しない ―― **追加モードでは `claim` しない**。
//      モードは排他なので「追加モードの道具」と「編集モードの道具」が同時に構えられる
//      ことはなく、React は「（全部の）後片付け → （全部の）effect」の順に走らせるので、
//      道具を持ち替えた瞬間も「前の道具が手放す → 次の道具が持つ」の順になる。
//   4. 押し込みは持ち主を見ない規約なので、**「所属」「結ぶ」は `claim` せずに対象だけを
//      押し込む**。帯の持ち主はこの部品のままで、道具名・設定・確定はここが面倒を見る。
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
import { EDIT_MODE, type ToolId } from '../state/session';
import type { SessionStore } from '../state/store';

import type { OptionBarStore } from './option-bar';
import { useOptionBarEpoch } from './useToolBarChrome';
import { EDIT_TOOL_STRINGS } from './strings';
import { TOOL_ID, editToolName } from './tools';

/**
 * **対象欄を自分で押し込む道具**の一覧（穴 B）。ここに載っている道具については、この部品は
 * 対象を押し込まない。
 *
 * **なぜこの 2 つだけ別扱いなのか**: 「所属」と「結ぶ」は自前の選択機構を持つ ――
 * `useReparentTool` の `targetId`（変更する地物）と `useMergeTool` の `targetIds`
 * （結合する地物の集合）である。どちらも **セッションの `activeFeature` を書かない**
 * ので、`activeFeature` から作るこの部品の対象欄は常に null になる。にもかかわらず
 * ここが毎回 null を押し込むと、道具側が入れた名前を **上書きして消してしまう**
 * （押し込みは持ち主を見ない規約＝`option-bar.ts` の `claim` 注記 3）。他の 6 つの道具は
 * `activeFeature` を書くので、ここが押し込むほうが 1 か所で済む。
 *
 * 判定を道具 id の表 1 つに寄せてあるのは、道具ごとに `if` を散らすと「自前の選択を
 * 持つ道具を足したのに、ここへ足し忘れて対象欄が消える」が起きるため（教訓 5.19 /
 * 5.29: 分岐は 1 か所の表で持つ）。
 */
const TOOLS_WITH_OWN_TARGET: ReadonlySet<ToolId> = new Set<ToolId>([
  TOOL_ID.EditReparent,
  TOOL_ID.EditMerge,
  // 増分 5 の手直し C2（バグ狩り #5 / #6 / Fable J）: ナイフ・輪郭・穴あけも **自前の
  // 対象**（`knife.targetId` / `ringEdit.targetId` / `drill.targetId`）を持つ。
  // ところがこの 3 つは対象を選択へ昇格させる（`setActiveFeature`）ので、ここが
  // `activeFeature` から作った名前を押し込むと **まだ掴んでいない地物の名前が対象欄に
  // 出る** ―― 一覧で選んでからナイフを構えると、対象を 1 度も押していないのに
  // 「アアウェン州（面・州）」と出て、次の一手の「切る面を押してください」と矛盾した。
  // 所属・結ぶと同じく、押し込みは道具側に任せる。
  TOOL_ID.EditKnife,
  TOOL_ID.EditRing,
  TOOL_ID.EditDrill,
]);

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

  // 帯を持つ条件: **追加モードでも測量中でもないこと**（穴 A ＋ 増分 5 の手直し C2）。
  //
  // 道具を構えていなくても持つ ―― 編集モードに入った直後に地図や一覧から地物を選んだ
  // ときも、対象欄にその名前を出すためである。
  //
  // **読むだけ（鍵が閉じている）ときも持つ。** 旧版は `mode === Edit` だったので、
  // 鍵を閉じたまま地図や一覧で地物を選んでも **対象欄が「（選んでいません）」のまま**
  // だった ―― 所有者の裁定は「読むだけでも選べる・読める」なので、選んだものの名前が
  // どこにも出ないのは裁定に反する（バグ狩り #5）。読むだけでは道具名が既定の「✦ 選択」
  // に留まるだけで、対象欄の役割は変わらない。
  //
  // 追加モードでは持たない（`AddToolController` の持ち場）。測量中も持たない
  // （`SurveyOptionBar` の持ち場＝司令塔の決定 (4)）。
  const surveyActive = useStore(store, (s) => s.survey.active);
  const holdsBar = mode !== EDIT_MODE.Add && !surveyActive;

  // 道具名。道具を構えていなければ null。`editToolName` は編集道具にしか名前を持たない
  // ので、万一 追加の道具 id が残っていても null になる。
  //
  // **道具が無いときに何を押し込むか**: `null` を押し込む＝**器の既定に任せる**。
  // 既定の「✦ 選択」を同じ文字列でここからも押し込むこともできるが、そうすると同じ
  // 文言が器（`OPTION_BAR_STRINGS.defaultToolName`）と道具の 2 か所に載り、片方だけ
  // 直したときに割れる（教訓 5.29）。器が既に「何も押されていなければ既定を出す」と
  // 決めているので、ここは黙って任せるほうが真実源が 1 本で済む。
  const toolName = holdsBar && activeTool !== null ? editToolName(activeTool) : null;

  // 自前の選択を持つ道具（所属・結ぶ）を構えているか（穴 B）。構えているあいだ、
  // 対象欄は **道具側が押し込む**ので、ここは触らない。
  const toolPushesOwnTarget = activeTool !== null && TOOLS_WITH_OWN_TARGET.has(activeTool);

  // いま選んでいる地物の説明。選んでいなければ null（器が「（選んでいません）」を出す）。
  // 所属・結ぶのときは **引きもしない** ―― 押し込まないので引くだけ無駄である
  // （押し込まないという規律そのものは下の effect にある。同じ条件がここに出るのは
  // 重複ではなく、「押し込まない ⇒ 引かない」という順接の帰結）。
  const targetName =
    !holdsBar || toolPushesOwnTarget || activeFeature === null
      ? null
      : describeTargetOf(resolveFeature(domain, currentTime, activeFeature));

  // --- 帯を持つ / 手放す ------------------------------------------------------
  //
  // 道具が替わるたびに持ち直す（`claim` はその瞬間に中身を空へ戻すので、前の道具が
  // 残した道具名・対象・次の一手・設定・確定は持ち越されない＝教訓 5.2）。**道具を外した
  // だけでは手放さない**（編集モードのあいだは持ったまま、道具名だけが既定へ戻る）。
  // モードを離れると後片付けが走り、帯は空へ戻る。
  useEffect(() => {
    if (!holdsBar) return;
    const owner = {};
    return optionBar.claim(owner);
    // `activeTool` を依存に入れるのは、道具の持ち替えで claim を踏み直して帯を空へ
    // 戻すため（前の道具が入れた設定欄・確定ボタンを持ち越さない）。
  }, [optionBar, holdsBar, activeTool]);

  // --- 道具名と対象を押し込む -------------------------------------------------
  //
  // **押し込む側が持ち主である**のが規約なので、持っていないとき（編集モードでない）は
  // 押し込まない。対象は選んでいないときも null を押し込む ―― 選択を外した瞬間に
  // 前の名前が残らないようにするためで、`setTarget` は変化が無ければ何もしない。
  // 器が持ち直されたら押し直す（手直し 3 回目）。**自分の `claim` でも代は進む**ので、
  // 持った直後の空へ戻した中身がこの effect で埋め直される。
  const optionBarEpoch = useOptionBarEpoch(optionBar);
  useEffect(() => {
    if (!holdsBar) return;
    optionBar.setToolName(toolName);
    // 所属・結ぶのときは対象を触らない。ここで null を押すと、道具側が入れた
    // 「いま相手にしているもの」を毎回消してしまう（上の表の注記）。
    if (toolPushesOwnTarget) return;
    // 段階表示（「手順 1/3」）を持つのは複数段の道具だけなので、ここでは常に null。
    optionBar.setTarget(null, targetName);
  }, [optionBar, optionBarEpoch, holdsBar, toolName, toolPushesOwnTarget, targetName]);

  return null;
}

/** 引けなかった地物（その年には居ない等）は名前を出さない ―― 内部 id は見せない（U-1）。 */
function describeTargetOf(feature: Feature | undefined): string | null {
  return feature === undefined ? null : describeOptionBarTarget(feature);
}
