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

  return (
    <div className="timeline-playback" data-testid="timeline-playback">
      <button
        type="button"
        aria-label={controller.isPlaying ? '一時停止' : '再生'}
        aria-pressed={controller.isPlaying}
        onClick={controller.toggle}
      >
        {controller.isPlaying ? '⏸' : '▶'}
      </button>

      <select
        aria-label="再生速度"
        value={controller.speed}
        onChange={(e) => controller.setSpeed(Number(e.target.value) as PlaybackSpeed)}
      >
        {PLAYBACK_SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}倍
          </option>
        ))}
      </select>
    </div>
  );
}
