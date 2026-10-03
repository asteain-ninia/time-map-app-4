// UI layer (U32 / property panel): the open-detail-panels container (FR-99後段).
//
// Renders every open detail panel from the pure DetailPanelsState model, each
// independently draggable / closable, each at its own cascaded position. Z-order
// is the shell's ZOrder model (front-most highest): a press on any panel brings
// it to the front (教訓 5.14 入力層 + 描画順を同時設計). Panels for DIFFERENT
// features can be open at once (FR-99: 複数同時表示). Closing one leaves the rest.

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

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
  /**
   * **時刻が動いたら描き直す**ための口（増分 8E / 設計書 §J.4 の結合点 #12）。
   *
   * パネルは「いまの年に在る姿」を `featureLookup` で都度引くが、引くのは **描くとき**
   * だけである。宿主（App）は時刻の変化では描き直さないので、年を動かしてその地物が
   * 無くなってもパネルが残り、次に何かで描き直されたときに 1 つ遅れて消えていた
   * （実機の探針で確認: 1000 年へ動かしても残り、1300 年へ戻すと消えた）。
   * 現在時刻を購読して、変わったらこの部品だけを描き直す。渡されない宿主（単体試験）
   * では購読しない。
   */
  readonly liveStore?: DetailPanelsLiveStore;
}

/** {@link DetailPanelsProps.liveStore} の形（zustand の StoreApi がそのまま入る）。 */
export interface DetailPanelsLiveStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getState: () => { readonly currentTime: unknown };
}

const NO_LIVE_SNAPSHOT = { currentTime: null } as const;
const NO_LIVE_STORE: DetailPanelsLiveStore = {
  subscribe: () => () => {},
  getState: () => NO_LIVE_SNAPSHOT,
};

export function DetailPanels(props: DetailPanelsProps): JSX.Element {
  const {
    state,
    featureLookup,
    assetResolver,
    detailDocumentOf,
    onClose,
    onSelectFeature,
  } = props;

  // 現在時刻を購読する（結合点 #12）。値そのものは使わず、変わったら描き直すだけ。
  const live = props.liveStore ?? NO_LIVE_STORE;
  useSyncExternalStore(live.subscribe, () => live.getState().currentTime);

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
