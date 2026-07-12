// UI layer (U32 / property panel): one modal detail panel (FR-99後段 / FR-98).
//
// A draggable, independently-closable floating panel showing ALL of a feature's
// attributes plus its detail document (sanitized Markdown). It reuses the shell's
// DraggablePanel (drag handle + bring-to-front + close, 教訓 5.8 / 5.14): the
// panel is an input-capturing front layer so a transparent backdrop never steals
// the drag handle (教訓 5.14). Edit integration in detail mode is gated by the
// same `editable` judgment as the sidebar (教訓 5.13) — here, view-only renders
// the document read-only; the edit form lives in the sidebar panel.

import type { Feature } from '../../domain/feature';
import type { FeatureId } from '../../domain/ids';

import { DraggablePanel } from '../shell/DraggablePanel';
import type { Point } from '../shell/drag';
import { formatYear } from '../timeline/time-display';

import type { AssetResolver } from './contracts';
import { MarkdownView } from './MarkdownView';
import { PROPERTY_STRINGS, featureKindJaLabel } from './messages';

export interface DetailPanelProps {
  readonly id: string;
  readonly feature: Feature;
  /** The raw Markdown detail document for the feature ('' when none). */
  readonly detailDocument: string;
  readonly assetResolver: AssetResolver;
  readonly initialPosition: Point;
  readonly zIndex: number;
  readonly onFocusPanel?: (id: string) => void;
  readonly onClose?: (id: string) => void;
  /** Object-reference link click → select the target feature (U22). */
  readonly onSelectFeature?: (featureId: FeatureId) => void;
}

export function DetailPanel(props: DetailPanelProps): JSX.Element {
  const {
    id,
    feature,
    detailDocument,
    assetResolver,
    initialPosition,
    zIndex,
    onFocusPanel,
    onClose,
    onSelectFeature,
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
            <dt>種別</dt>
            <dd>{featureKindJaLabel(feature.kind)}</dd>
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
            <dd>{feature.color.autoColorEnabled ? 'はい' : 'いいえ'}</dd>
          </dl>
        </section>

        <section className="detail-panel__document">
          <h4>{PROPERTY_STRINGS.detailDocumentTitle}</h4>
          <MarkdownView
            source={detailDocument}
            assetResolver={assetResolver}
            {...(onSelectFeature ? { onSelectFeature } : {})}
          />
        </section>
      </div>
    </DraggablePanel>
  );
}
