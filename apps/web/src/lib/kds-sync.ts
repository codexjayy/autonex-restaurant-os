export type KdsConnectionMode =
  | 'CONNECTING'
  | 'LIVE_WS'
  | 'POLLING_FALLBACK'
  | 'OFFLINE'
  | 'BLOCKED';

export {
  applyKdsEventToState,
  applySingleTicketUpdateToState,
  createInitialKdsSyncState,
  reconcileKdsPollResponse,
  type KdsSyncState,
} from '@autonex/shared';

export function playKdsChime(audioCtx: AudioContext | null): boolean {
  if (!audioCtx || audioCtx.state !== 'running') return false;
  try {
    const now = audioCtx.currentTime;
    const playNote = (freq: number, startOffset: number, duration: number) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + startOffset);
      gain.gain.setValueAtTime(0.001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.28, now + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + duration);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now + startOffset);
      osc.stop(now + startOffset + duration);
    };

    // Distinct 2-note kitchen bell chime
    playNote(880, 0, 0.22);
    playNote(1174.66, 0.18, 0.35);
    return true;
  } catch {
    return false;
  }
}
