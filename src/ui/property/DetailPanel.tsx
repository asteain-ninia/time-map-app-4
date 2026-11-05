// UI layer (U32 / property panel): one modal detail panel (FR-99後段 / FR-98).
//
// A draggable, independently-closable floating panel showing ALL of a feature's
// attributes (参照名 included) plus its 作業メモ (plain text — FR-98: no formatting, no images, no
// in-document links; shown as React text, never as HTML). It reuses the shell's
// DraggablePanel (drag handle + bring-to-front + close, 教訓 5.8 / 5.14): the
// panel is an input-capturing front layer so a transparent backdrop never steals
// the drag handle (教訓 5.14). Edit integration in detail mode is gated by the
// same `editable` judgment as the sidebar (教訓 5.13) — here, view-only renders
// the document read-only; the edit form lives in the sidebar panel.

import type { Feature } from '../../domain/feature';

import { DraggablePanel } from '../shell/DraggablePanel';
import type { Point } from '../shell/drag';
import { formatYear } from '../timeline/time-display';

import { PROPERTY_STRINGS, PROPERTY_TEXT, featureKindJaLabel } from './messages';

export interface DetailPanelProps {
  readonly id: string;
  readonly feature: Feature;
  /** The作業メモ (plain text) for the feature ('' when none). */
  readonly detailDocument: string;
  readonly initialPosition: Point;
  readonly zIndex: number;
  readonly onFocusPanel?: (id: string) => void;
  readonly onClose?: (id: string) => void;
}

export function DetailPanel(props: DetailPanelProps): JSX.Element {
  const {
    id,
    feature,
    detailDocument,
    initialPosition,
    zIndex,
    onFocusPanel,
    onClose,
  } = props;

  return (
    <DraggablePanel
      id={id}
      title={`${PROPERTY_STRINGS.detailPanelTitlePrefix}${feature.attributes.name}`}
      initialPosition={initialPosition}
      zIndex={zIndex}
      {...(onFocusPanel ? { onFocusPanel } : {})}
      {...(onClose ? { onClose } : {})}
    >
      <div className="detail-panel" data-testid={`detail-panel-${feature.id}`}>
        <section className="detail-panel__attributes">
          <h4>{PROPERTY_STRINGS.detailAttributesTitle}</h4>
          <dl>
            <dt>{PROPERTY_STRINGS.nameLabel}</dt>
            <dd>{feature.attributes.name}</dd>
            <dt>{PROPERTY_TEXT.detailKindLabel}</dt>
            <dd>{featureKindJaLabel(feature.kind)}</dd>
            {/* FR-98 / FR-99: 参照名（外の資料を指す名前 1 件）。名前を出すだけで、開かない。 */}
            <dt>{PROPERTY_STRINGS.referenceNameLabel}</dt>
            <dd data-testid="detail-panel-reference-name">
              {feature.referenceName ?? PROPERTY_STRINGS.referenceNameNone}
            </dd>
            <dt>{PROPERTY_STRINGS.startYearLabel}</dt>
            <dd>{formatYear(feature.attributes.startYear)}</dd>
            <dt>{PROPERTY_STRINGS.endYearLabel}</dt>
            <dd>{formatYear(feature.attributes.endYear)}</dd>
            <dt>{PROPERTY_STRINGS.fillColorLabel}</dt>
            <dd>{feature.color.fillColor}</dd>
            <dt>{PROPERTY_STRINGS.selectedColorLabel}</dt>
            <dd>{feature.color.selectedColor}</dd>
            <dt>{PROPERTY_STRINGS.borderColorLabel}</dt>
            <dd>{feature.color.borderColor}</dd>
            <dt>{PROPERTY_STRINGS.autoColorLabel}</dt>
            <dd>{feature.color.autoColorEnabled ? PROPERTY_TEXT.detailYes : PROPERTY_TEXT.detailNo}</dd>
          </dl>
        </section>

        <section className="detail-panel__document">
          <h4>{PROPERTY_STRINGS.detailDocumentTitle}</h4>
          {detailDocument.length > 0 ? (
            <p className="detail-panel__memo" data-testid="detail-panel-memo">
              {detailDocument}
            </p>
          ) : (
            <p className="detail-document__empty" data-testid="detail-panel-memo-empty">
              {PROPERTY_STRINGS.detailDocEmpty}
            </p>
          )}
        </section>
      </div>
    </DraggablePanel>
  );
}
