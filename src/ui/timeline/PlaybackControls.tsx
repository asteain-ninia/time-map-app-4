// UI layer (U21 / timeline): play/pause + speed selector (FR-69).
//
// Pure presentation over a PlaybackController (usePlayback). The speed selector
// offers the fixed set (0.1/0.5/1/2/5/10 倍). The controller owns the timer and
// the auto-stop-at-end behavior; this component only reflects/commands it.

import { PLAYBACK_SPEEDS, type PlaybackSpeed } from './playback';
import type { PlaybackController } from './usePlayback';

export interface PlaybackControlsProps {
  readonly controller: PlaybackController;
}

export function PlaybackControls(props: PlaybackControlsProps): JSX.Element {
  const { controller } = props;

  // HB-13: アイコンのみのボタンに可視ラベル・最小サイズ・ツールチップを付与する。
  const toggleLabel = controller.isPlaying ? '一時停止' : '再生';

  return (
    <div className="timeline-playback" data-testid="timeline-playback">
      <button
        type="button"
        className="timeline-playback__button"
        aria-label={toggleLabel}
        aria-pressed={controller.isPlaying}
        title={controller.isPlaying ? '自動進行を一時停止します' : '時間を自動で進めます'}
        onClick={controller.toggle}
      >
        <span aria-hidden="true">{controller.isPlaying ? '⏸' : '▶'}</span>
        <span className="timeline-playback__label">{toggleLabel}</span>
      </button>

      <label className="timeline-playback__speed">
        <span className="timeline-playback__speed-caption">再生速度</span>
        <select
          aria-label="再生速度"
          title="自動進行の速さ(1倍 = 1年/秒)"
          value={controller.speed}
          onChange={(e) => controller.setSpeed(Number(e.target.value) as PlaybackSpeed)}
        >
          {PLAYBACK_SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}倍
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
