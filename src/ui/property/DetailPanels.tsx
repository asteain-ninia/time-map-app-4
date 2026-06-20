// UI layer (U32 / property panel): the open-detail-panels container (FR-99後段).
//
// Renders every open detail panel from the pure DetailPanelsState model, each
// independently draggable / closable, each at its own cascaded position. Z-order
// is the shell's ZOrder model (front-most highest): a press on any panel brings
// it to the front (教訓 5.14 入力層 + 描画順を同時設計). Panels for DIFFERENT
// features can be open at once (FR-99: 複数同時表示). Closing one leaves the rest.

import { useCallback, useMemo, useState } from 'react';

import type { FeatureId } from '../../domain/ids';

import { ZOrder } from '../shell/z-order';

import type { AssetResolver, FeatureLookup } from './contracts';
import { DetailPanel } from './DetailPanel';
import {
  type DetailPanelsState,
  EMPTY_DETAIL_PANELS,
  closePanel,
} from './detail-panels';

export interface DetailPanelsController {
  /** Open a detail panel for a feature (idempotent per feature). */
  open(featureId: FeatureId): void;
  /** Whether a detail panel is open for the feature. */
  isOpen(featureId: FeatureId): boolean;
}

export interface DetailPanelsProps {
  readonly state: DetailPanelsState;
  readonly featureLookup: FeatureLookup;
  readonly assetResolver: AssetResolver;
  /** Resolve a feature's raw Markdown detail document ('' when none). */
  readonly detailDocumentOf: (featureId: FeatureId) => string;
  readonly onClose: (id: string) => void;
  readonly onSelectFeature?: (featureId: FeatureId) => void;
}

export function DetailPanels(props: DetailPanelsProps): JSX.Element {
  const {
    state,
    featureLookup,
    assetResolver,
    detailDocumentOf,
    onClose,
    onSelectFeature,
  } = props;

  // Z-order is its own model; bring-to-front rebuilds it. A render tick bumps so
  // the new order takes effect (the model is mutable, so we mirror a version).
  const zorder = useMemo(() => new ZOrder(), []);
  const [, bump] = useState(0);

  for (const panel of state.panels) zorder.add(panel.id);

  const handleFocus = useCallback(
    (id: string) => {
      zorder.bringToFront(id);
      bump((n) => n + 1);
    },
    [zorder],
  );

  return (
    <div className="detail-panels" data-testid="detail-panels">
      {state.panels.map((panel) => {
        const feature = featureLookup.featureAt(panel.featureId);
        if (feature === null) return null;
        return (
          <DetailPanel
            key={panel.id}
            id={panel.id}
            feature={feature}
            detailDocument={detailDocumentOf(panel.featureId)}
            assetResolver={assetResolver}
            initialPosition={panel.position}
            zIndex={zorder.indexOf(panel.id) + 1}
            onFocusPanel={handleFocus}
            onClose={onClose}
            {...(onSelectFeature ? { onSelectFeature } : {})}
          />
        );
      })}
    </div>
  );
}

/** Helper close that removes a panel from the state model (for the host). */
export function closeDetailPanel(
  state: DetailPanelsState,
  id: string,
): DetailPanelsState {
  return closePanel(state, id);
}

export { EMPTY_DETAIL_PANELS };
