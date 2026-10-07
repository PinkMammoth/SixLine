/** Ephemeral transport intent; selecting a score location does not seek a running player. */
export class TransportState {
  fromCaret = true;
  chooseCaret(playing: boolean) { if (!playing) this.fromCaret = true; }
  usePosition() { this.fromCaret = false; }
  stopped() { this.fromCaret = true; }
}

export interface TransportBar { start: number; end: number; masterBar: { index: number } }
/** Navigate the actual playback timeline, including repeat occurrences and meter changes. */
export function transportDestination(bars: TransportBar[], tick: number, direction: 'first' | -1 | 1) {
  if (!bars.length) throw new Error('Wait for playback to finish loading.');
  let index = bars.findIndex(b => tick >= b.start && tick < b.end);
  if (index < 0) index = tick < bars[0].start ? 0 : bars.length - 1;
  const target = direction === 'first' ? 0 : Math.max(0, Math.min(bars.length - 1, index + direction));
  return { bar: bars[target].masterBar.index, tick: bars[target].start, index: target };
}
