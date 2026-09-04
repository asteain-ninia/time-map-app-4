// UI layer (U20 / shell): the option bar — the tool's own row (設計書 §C.4 / §B.4).
//
// 「いま持っている道具の、いまの状況」を 1 行で見せる帯。5 区画（道具名 112 / 対象 240 /
// 次の一手 1fr / 設定 可変 / 確定 176）の**器だけ**をここが持ち、中身は道具の実装が
// {@link OptionBarStore} の 4 本の API で押し込む。
//
// **地図セルの外のシェル行である**（K-4 / 結合点 #1）。地図セルの DOM の入れ子
// （`map-area > map-canvas-mount + map-input-layer`）に一切触れないので、`onMapMount` の
// `querySelector` も `data-zoom` / `data-pan-x` / `data-pan-y` の取り付け先（T-3）も
// 崩さない。地図に重なる部品ではないので K-2 の事故（クリックを奪う）も構造的に起きない。
//
// **確定ボタンはここに置く**（U-10。位置は地図下端中央から移すが「全ツールで同じ場所」
// は守る）。地図の中に確定ボタンを置かないのが K-2 に対する構造的な答えである。

import { useSyncExternalStore } from 'react';

import { OPTION_BAR_STRINGS } from './strings';
import type { OptionBarState, OptionBarStore } from './option-bar';

export interface OptionBarProps {
  readonly store: OptionBarStore;
}

export function OptionBar(props: OptionBarProps): JSX.Element {
  const { store } = props;
  const state: OptionBarState = useSyncExternalStore(
    (onChange) => store.subscribe(onChange),
    () => store.get(),
    () => store.get(),
  );

  const target = state.target;

  return (
    <div
      className="option-bar"
      role="toolbar"
      aria-label={OPTION_BAR_STRINGS.ariaLabel}
      data-testid="option-bar"
    >
      <div className="option-bar__tool" data-testid="option-bar-tool">
        {state.toolName ?? OPTION_BAR_STRINGS.defaultToolName}
      </div>

      <div className="option-bar__target" data-testid="option-bar-target">
        {target.stage !== null && (
          <span className="option-bar__stage" data-testid="option-bar-stage">
            {target.stage}
          </span>
        )}
        {target.name !== null ? (
          <span className="option-bar__target-name">{target.name}</span>
        ) : (
          <span className="option-bar__muted">{OPTION_BAR_STRINGS.noTarget}</span>
        )}
      </div>

      <div className="option-bar__next" data-testid="option-bar-next-step">
        {state.nextStep ?? OPTION_BAR_STRINGS.defaultNextStep}
      </div>

      <div className="option-bar__settings" data-testid="option-bar-settings">
        {state.slots.length === 0 ? (
          <span className="option-bar__muted">{OPTION_BAR_STRINGS.noSettings}</span>
        ) : (
          state.slots.map((slot) => (
            <span key={slot.id} className="option-bar__slot" data-testid={`option-slot-${slot.id}`}>
              {slot.node}
            </span>
          ))
        )}
      </div>

      {/* 確定欄: 確定の要らない道具のときも空の 176px として残す（K-3, 設計書 §B.4）。 */}
      <div className="option-bar__commit" data-testid="option-bar-commit">
        {state.commit.map((button) => (
          <button
            key={button.id}
            type="button"
            className="option-bar__commit-button"
            data-testid={button.testId ?? `option-bar-commit-${button.id}`}
            disabled={button.disabled ?? false}
            onClick={button.onClick}
          >
            {button.label}
          </button>
        ))}
      </div>
    </div>
  );
}
