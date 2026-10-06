import type { Beat, Duration, MasterBar } from './song';

export const TICKS_PER_QUARTER = 960;

export const DURATIONS: Duration[] = [1, 2, 4, 8, 16, 32, 64];

export function beatTicks(b: Pick<Beat, 'duration' | 'dots' | 'tuplet'>): number {
  let t = (TICKS_PER_QUARTER * 4) / b.duration;
  let add = t;
  for (let i = 0; i < b.dots; i++) {
    add /= 2;
    t += add;
  }
  if (b.tuplet) t = (t * b.tuplet[1]) / b.tuplet[0];
  return Math.round(t);
}

export function barTicks(mb: Pick<MasterBar, 'num' | 'den'>): number {
  return Math.round((TICKS_PER_QUARTER * 4 * mb.num) / mb.den);
}

export function voiceTicks(beats: Beat[]): number {
  return beats.reduce((s, b) => s + beatTicks(b), 0);
}

/**
 * Split a tick span into the fewest plain (undotted) durations, largest first.
 * Used to pad bars with rests. Returns [] if the span is not representable.
 */
export function ticksToDurations(ticks: number): Duration[] {
  const out: Duration[] = [];
  let rest = ticks;
  for (const d of DURATIONS) {
    const t = beatTicks({ duration: d, dots: 0 });
    while (rest >= t) {
      out.push(d);
      rest -= t;
    }
  }
  return rest === 0 ? out : [];
}
