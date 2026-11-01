// 状態行の元に戻す枠に出す「何が戻るのか」（設計書 §C.8「元に戻せます: 南ケナ州の改名（Ctrl+Z）」。B10）。
//
// `Command` は操作の種類（label）しか持たない。対象の名前は確定の瞬間にしか分からない（取り消した
// あとは今の根からは引けないことがある）ので、`redo-preference.ts` と同じく **コマンドをキーに
// 覚える**。純粋な Command には載せない（表示のための値を中核へ持ち込まない）。WeakMap なので、
// 履歴から落ちたコマンドの覚えは一緒に消える。
//
// 確定の経路ごとに名前を渡す形にはしない。全部の確定が通る 1 か所で、結果の `touched` から引く
// （経路ごとに渡すと、渡し忘れた経路だけ黙って名前が出なくなる）。

import type { Command, History } from '../../domain/command/index';
import type { DomainId, FeatureId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/serialize';
import type { TimePoint } from '../../domain/time/time-point';

import { featureByIdAt } from '../live-lookup';
import { commandLabelJa, RESULT_STRINGS } from '../shell/command-result';

/**
 * この確定の対象の名前。触った地物が **1 つに定まるときだけ** 返す。2 つ以上（分割の片・結合・
 * 自動配色で色が変わった隣など）や、名前が空なら null で、枠は操作名だけを言う。消えた地物は
 * 確定前の根から引く。
 */
export function soleTouchedFeatureName(
  touched: ReadonlySet<DomainId>,
  before: DomainProject,
  after: DomainProject,
  at: TimePoint,
): string | null {
  let name: string | null = null;
  let found = false;
  for (const id of touched) {
    // `touched` は頂点などの id も含みうる。地物として引けないものは数えない。
    const featureId = id as FeatureId;
    const feature = featureByIdAt(after, at, featureId) ?? featureByIdAt(before, at, featureId);
    if (feature === undefined) continue;
    if (found) return null;
    found = true;
    name = feature.attributes.name;
  }
  return name === null || name === '' ? null : name;
}

/** コマンドごとの「枠に出す言葉」の覚え。 */
export interface UndoFrameLabels<S> {
  /** 確定したコマンドを、対象の名前（無ければ null）と一緒に覚える。 */
  remember(command: Command<S>, targetName: string | null): void;
  /** 操作名の代わりに出す言葉を決める（重なりの解消のように、利用者が最後に答えたものを言うとき）。 */
  rename(command: Command<S>, text: string): void;
  /** このコマンドを言う言葉。覚えが無ければ操作名だけ。 */
  labelOf(command: Command<S> | undefined): string;
  /**
   * 枠に出す言葉。戻せるものが履歴に無ければ null。
   *
   * `nextUndoIsElsewhere` が真のとき、次の Ctrl+Z は履歴ではなく別のもの（消した測量の線・道具の
   * 打った点）を戻す。履歴の先頭の名前を言うと嘘になるので null を返し、枠は可否だけを言う。
   */
  frameLabel(history: History<S>, nextUndoIsElsewhere: boolean): string | null;
}

export function createUndoFrameLabels<S>(): UndoFrameLabels<S> {
  const byCommand = new WeakMap<Command<S>, string>();
  const labelOf = (command: Command<S> | undefined): string => {
    if (command === undefined) return commandLabelJa(undefined);
    return byCommand.get(command) ?? commandLabelJa(command.label);
  };
  return {
    remember(command, targetName): void {
      byCommand.set(command, RESULT_STRINGS.undoTarget(commandLabelJa(command.label), targetName));
    },
    rename(command, text): void {
      byCommand.set(command, text);
    },
    labelOf,
    frameLabel(history, nextUndoIsElsewhere): string | null {
      if (nextUndoIsElsewhere) return null;
      const top = history.undoStack.at(-1);
      return top === undefined ? null : labelOf(top);
    },
  };
}
