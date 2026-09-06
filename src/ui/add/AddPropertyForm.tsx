// U23 — 追加を確定したあとの「新規の姿」の素性欄（FR-76 / FR-97 / FR-77、
// 設計書 §C.2 の 27、N-15 / G-8）。
//
// **置き場所が変わった（増分 3）**。以前は地図の真ん中に浮くフォームで、**いま描いた形を
// 覆っていた**（実測 rect 375,259,431×134 ＝ N-15）。いまは右パネルの素性欄の位置に出す。
// 地図を覆わないので、名前を入れながら形を確かめられる。差し込みは
// {@link AddDraftStore}（道具 → 素性欄の細い口）を通す。
//
// **聞くものが増えた（G-8 / R5）**。以前は名前だけを聞き、年代は `DEFAULT_START_YEAR = 0`
// の固定だった。5080 年で追加しても「開始年 0 / 終了年 0」になるので、**毎回あとから
// プロパティ欄で打ち直す後始末**が要り、実測でタスク全体の 44%（17.2 秒）を占めていた。
// いまは **いま見ている年をそのまま継ぐ**（画面にも出す）。**種別ラベルの欄**も足した
// （R5。実データ 775 件は全件に種別ラベルが入っているのに、追加では付けられなかった）。
//
// 保存ボタンは `data-testid="add-save"` のまま **素性欄の保存ボタン**になる（T-1 の
// 付け替え 2 件のうちの 1 件。役割「追加した地物の値を確定する」は変わらない）。

import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import {
  createBasicAttributes,
  createColorInfo,
  withFillOpacity,
  DEFAULT_NEW_FEATURE_FILL_OPACITY,
  type BasicAttributes,
  type ColorInfo,
} from '../../domain/attributes';
import {
  parentSelectableFor,
  type AddProperties,
  type ParentCandidate,
} from '../../domain/add/index';
import type { FeatureId } from '../../domain/ids';

import type { AddDraftPrompt, AddDraftStore } from './add-draft-store';
import { ADD_STRINGS } from './strings';

// A sensible default color for a freshly-added feature (FR-97 auto-color on). HB3-13:
// new features default to a slightly TRANSLUCENT fill (DEFAULT_NEW_FEATURE_FILL_OPACITY
// = 0.7) so overlapping 面 stay legible; the selected alpha stays opaque so a selected
// feature pops. The user can edit both opacities later in the property panel (U33).
const DEFAULT_COLOR: ColorInfo = withFillOpacity(
  createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1'),
  DEFAULT_NEW_FEATURE_FILL_OPACITY,
);

export interface AddPropertyFormProps {
  /** Show the parent selector (face only; FR-77). */
  readonly showParent: boolean;
  /** The eligible face parents at the current time (FR-77). */
  readonly parentCandidates: readonly ParentCandidate[];
  /**
   * 候補が 1 つに決まるときの既定（決まらなければ null）。増分 3 の手直し B2:
   * 入れ子として通した形が黙って「上位領域なし」で保存されるのを防ぐ。
   */
  readonly defaultParentId: FeatureId | null;
  /**
   * 年代の既定に使う「いま見ている年」（G-8）。開始年・終了年ともこの年から始める。
   * 固定の 0 年を入れない ―― 入れると必ず後始末が要る。
   */
  readonly currentYear: number;
  /** Choose a parent (null = 親なし / 最上位, FR-39). */
  readonly onChooseParent: (featureId: FeatureId | null) => void;
  /** SAVE — the property-form完了 trigger (教訓 5.7). */
  readonly onSave: (properties: AddProperties) => void;
  /** Cancel the whole add (教訓 5.2). */
  readonly onCancel: () => void;
}

export function AddPropertyForm(props: AddPropertyFormProps): JSX.Element {
  const {
    showParent,
    parentCandidates,
    defaultParentId,
    currentYear,
    onChooseParent,
    onSave,
    onCancel,
  } = props;
  const [name, setName] = useState('');
  const [kindLabel, setKindLabel] = useState('');
  // **上位領域の欄は「選ばれている値」を持つ**（増分 3 の手直し B2）。`defaultValue` だと
  // 部品が載った瞬間の値しか効かない ―― 候補の絞り込みは形を確定した直後の 1 拍あとに
  // 決まるので、既定が届いたときには欄はもう空のままだった（画面と実際の保存値が割れる）。
  const [parentValue, setParentValue] = useState(defaultParentId ?? '');
  const lastDefaultRef = useRef(defaultParentId);
  if (lastDefaultRef.current !== defaultParentId) {
    // 既定が変わったら（＝絞り込みが決まったら）欄も追従する。利用者が自分で選び直した
    // あとは既定が変わらない限り触らない。
    lastDefaultRef.current = defaultParentId;
    setParentValue(defaultParentId ?? '');
  }

  const submit = (): void => {
    // 年代は「いま見ている年」を継ぐ（G-8）。開始と終了に同じ年を入れるのは、
    // これまで 0 / 0 を入れていたのと同じ形（飾りの 2 欄。実際の存続は錨が決める）で、
    // 変えたのは **値の出どころ**だけである。
    const attributes: BasicAttributes = createBasicAttributes(name, currentYear, currentYear);
    const trimmedKind = kindLabel.trim();
    const properties: AddProperties =
      trimmedKind === ''
        ? { attributes, color: DEFAULT_COLOR }
        : { attributes, color: DEFAULT_COLOR, kindLabel: trimmedKind };
    onSave(properties);
  };

  return (
    <form
      className="add-property-form"
      data-testid="add-property-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 className="add-property-form__title">{ADD_STRINGS.formTitle}</h2>

      {/* **欄が「まだ何も打っていない」と自分で名乗る**（`data-pristine`。増分 5 の手直し
          A2）。焦点がこの欄にあるあいだ、Escape は道具が受けて「やめる」になるが、
          **打ちかけがあるときだけ 1 度確認を出す** ―― 打った文字を黙って失わないためで、
          その判定はこの属性 1 本を読む（素性欄の名前欄と同じ作法＝教訓 5.13）。
          名乗りが無いと欄が空でも「打ちかけあり」に倒れ、空欄で Escape を押しても
          板が出る（実装したときに見つかった取りこぼし）。 */}
      <label className="add-property-form__field">
        {ADD_STRINGS.fieldName}
        <input
          type="text"
          data-testid="add-name"
          value={name}
          data-pristine={name.length === 0 ? 'true' : 'false'}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
      </label>

      {/* R5: 種別ラベル。実データは全 775 件が値を持っているのに、追加では付けられなかった。 */}
      <label className="add-property-form__field">
        {ADD_STRINGS.fieldKindLabel}
        <input
          type="text"
          data-testid="add-kind-label"
          value={kindLabel}
          data-pristine={kindLabel.length === 0 ? 'true' : 'false'}
          onChange={(e) => setKindLabel(e.target.value)}
          placeholder={ADD_STRINGS.fieldKindLabelHint}
        />
      </label>

      {showParent && (
        <label className="add-property-form__field">
          {ADD_STRINGS.fieldParent}
          <select
            data-testid="add-parent"
            value={parentValue}
            onChange={(e) => {
              setParentValue(e.target.value);
              onChooseParent(e.target.value === '' ? null : (e.target.value as FeatureId));
            }}
          >
            <option value="">{ADD_STRINGS.parentNone}</option>
            {parentCandidates.map((c) => (
              <option key={c.featureId} value={c.featureId}>
                {c.displayName}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* G-8: 年代は「いま見ている年」を継ぐ。何年に記録されるのかを押す前に見せる
          （黙って 0 年に入れない）。飾りの 2 欄なので読み取り専用で出す（増分 2 の A7）。 */}
      <p className="add-property-form__era" data-testid="add-era">
        {ADD_STRINGS.eraFromCurrent(currentYear)}
      </p>

      <div className="add-property-form__actions">
        {/* SAVE — property-form完了 trigger (教訓 5.7). Enter also submits. */}
        <button type="submit" data-testid="add-save">
          {ADD_STRINGS.save}
        </button>
        <button type="button" data-testid="add-form-cancel" onClick={onCancel}>
          {ADD_STRINGS.cancel}
        </button>
      </div>
    </form>
  );
}

/**
 * 素性欄の位置に、入力待ちがあれば **新規の姿**を、無ければ `children`（普段の素性欄）を
 * 出す（設計書 §C.2 の 27）。
 *
 * **購読するのはこの 1 ノードだけ**である。追加の下書きは 60Hz で動く入力から来るので、
 * シェル全体を再レンダーさせない（技術方針 2.3。`OptionBar` と同じ考え方）。
 */
export function AddDraftForm(props: {
  readonly store: AddDraftStore;
  readonly children?: ReactNode;
}): JSX.Element | null {
  const prompt = useSyncExternalStore(
    (onChange) => props.store.subscribe(onChange),
    () => props.store.get(),
    () => props.store.get(),
  );
  if (prompt === null) return <>{props.children ?? null}</>;
  return <AddPropertyForm {...addPromptToFormProps(prompt)} />;
}

/**
 * 素性欄の位置に「新規の姿」を出す口（設計書 §C.2 の 27）。入力待ちが無ければ `null` を
 * 返すので、呼び出し側は「あれば新規の姿、無ければ普段の素性欄」を書ける。
 */
export function addPromptToFormProps(prompt: AddDraftPrompt): AddPropertyFormProps {
  return {
    // 上位領域を聞くのは面だけ。**既定の上位領域を決める側と同じ述語**を見る
    // （2026-09-06、2 回目の手直し。片方だけ落ちていたのが調査 8 の事故）。
    //
    // **押し込む側が明示したときはそれに従う**（司令塔の決定 (5)）。ナイフの非継承側と
    // 穴あけの新地物は面だが、上位領域はドメインが元の地物から引き継ぐので聞かない。
    showParent: prompt.showParent ?? parentSelectableFor(prompt.tool),
    parentCandidates: prompt.parentCandidates,
    defaultParentId: prompt.defaultParentId,
    currentYear: prompt.currentYear,
    onChooseParent: prompt.onChooseParent,
    onSave: prompt.onSave,
    onCancel: prompt.onCancel,
  };
}
