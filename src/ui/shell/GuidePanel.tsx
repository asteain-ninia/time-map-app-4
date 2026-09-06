// UI layer (U20 / shell): 初回ガイドの **共通の器**（FR-118 / 設計書 §H.3）。
//
// **器を写して 2 枚にしない**（教訓 5.44）。重なり解決の使い方（現行の唯一まともな
// FR-118 の実例）と、初回起動のガイド 4 枚は、**同じ形**である ―― 番号つきの手順・
// 画面上の実物の名指し・恒久 OFF の 3 つ。中身だけを差し替える。
//
// **恒久 OFF の戻し先を必ず持たせる**（`onSuppress` を渡す側が設定へ書く）。押したきり
// 二度と出せないガイドは、行き止まりを 1 つ作るのと同じである（設定ダイアログに同じ
// 項目を置いてある）。

import type { ReactNode } from 'react';

/** ガイド 1 枚ぶんの中身。文言は呼び出し側の `strings.ts` が持つ（教訓 5.64）。 */
export interface GuideContent {
  readonly heading: string;
  readonly steps: readonly string[];
  /** 恒久 OFF のボタン。 */
  readonly dismiss: string;
  /** 今回だけ閉じるボタン。 */
  readonly close: string;
}

export interface GuidePanelProps {
  readonly content: GuideContent;
  /** 器の class（既存の見た目をそのまま持ち越すため）。 */
  readonly className: string;
  /** 器の `data-testid`。**役割で維持し、改名しない**（T-1）。 */
  readonly testId: string;
  /** 今回だけ閉じる。 */
  readonly onClose: () => void;
  /** 恒久 OFF（設定へ書く）。渡さなければそのボタンを出さない。 */
  readonly onSuppress?: (() => void) | undefined;
  /** 手順の下に足す中身（任意）。 */
  readonly children?: ReactNode;
}

export function GuidePanel(props: GuidePanelProps): JSX.Element {
  const { content, className, testId, onClose, onSuppress, children } = props;
  return (
    <section className={className} data-testid={testId} aria-label={content.heading}>
      <h3>{content.heading}</h3>
      <ol>
        {content.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {children}
      <div className={`${className}__actions`}>
        {onSuppress !== undefined && (
          <button
            type="button"
            data-testid={`${testId}-dismiss`}
            onClick={() => {
              onClose();
              onSuppress();
            }}
          >
            {content.dismiss}
          </button>
        )}
        <button type="button" data-testid={`${testId}-close`} onClick={onClose}>
          {content.close}
        </button>
      </div>
    </section>
  );
}
