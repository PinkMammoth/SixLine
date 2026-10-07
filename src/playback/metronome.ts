import type { LoopRange } from './practice';

export interface ClickBar {
  start: number;
  end: number;
  num: number;
  den: number;
  tempos: { tick: number; tempo: number }[];
}
/** Time on the player's repeat-expanded timeline, including tempo changes. */
export function elapsedMs(bars: ClickBar[], start: number, end: number, speed: number) {
  let ms = 0;
  for (const b of bars) {
    const a = Math.max(start, b.start), z = Math.min(end, b.end);
    if (z <= a) continue;
    let at = a, tempo = b.tempos.filter(t => t.tick <= a).at(-1)?.tempo ?? 120;
    for (const t of b.tempos) if (t.tick > a && t.tick < z) {
      ms += (t.tick - at) / 960 * 60000 / tempo;
      at = t.tick; tempo = t.tempo;
    }
    ms += (z - at) / 960 * 60000 / tempo;
  }
  return ms * 100 / speed;
}
export function clickPlan(bars: ClickBar[], tick: number, speed: number, horizonMs = 140, loop: LoopRange | null = null) {
  // The synth's time-to-tick conversion rounds a bar/beat boundary up by one tick.
  const current = bars.find(b => b.start <= tick && tick < b.end);
  if (current) {
    const unit = 960 * 4 / current.den;
    const boundary = current.start + Math.floor((tick - current.start) / unit) * unit;
    if (tick - boundary <= 1 && (!loop || boundary >= loop.startTick)) tick = boundary;
  }
  const out: { tick: number; delayMs: number; accent: boolean; cycle: number }[] = [];
  const add = (from: number, to: number, delay: number, cycle: number) => {
    for (const b of bars) {
      if (b.end <= from || b.start >= to) continue;
      const unit = 960 * 4 / b.den;
      const first = Math.max(0, Math.ceil((from - b.start) / unit));
      for (let i = first; i < b.num; i++) {
        const point = b.start + i * unit;
        if (point >= to) break;
        const delayMs = delay + elapsedMs(bars, from, point, speed);
        if (delayMs <= horizonMs) out.push({ tick: point, delayMs, accent: i === 0, cycle });
        else break;
      }
    }
  };
  add(tick, loop?.endTick ?? Infinity, 0, 0);
  if (loop && tick < loop.endTick) {
    const delay = elapsedMs(bars, tick, loop.endTick, speed);
    if (delay <= horizonMs) add(loop.startTick, loop.endTick, delay, 1);
  }
  return out;
}

/** Short lookahead uses the same ticks as playback, avoiding a second independent musical clock. */
export class Metronome {
  private context: AudioContext | null = null;
  private scheduled = new Map<string, { node: OscillatorNode; time: number }>();
  private lastTick = -1;
  private cycle = 0;
  private speed = 100;
  async ready() { this.context ??= new AudioContext(); await this.context.resume(); }
  cancel() {
    for (const { node } of this.scheduled.values()) { try { node.stop(); } catch { /* finished */ } }
    this.scheduled.clear(); this.lastTick = -1; this.cycle = 0;
  }
  update(bars: ClickBar[], tick: number, speed: number, loop: LoopRange | null, seek = false) {
    const ctx = this.context;
    if (!ctx || ctx.state !== 'running') return;
    const wrapped = !!loop && this.lastTick >= loop.endTick - 1 && tick <= loop.startTick + 1;
    if (speed !== this.speed || seek && !wrapped) this.cancel();
    this.speed = speed;
    if (tick < this.lastTick) {
      if (wrapped) this.cycle++;
      else this.cancel();
    }
    this.lastTick = tick;
    for (const [key, value] of this.scheduled) if (value.time < ctx.currentTime - 0.3) this.scheduled.delete(key);
    for (const click of clickPlan(bars, tick, speed, 140, loop)) {
      const key = `${this.cycle + click.cycle}:${click.tick}`;
      if (this.scheduled.has(key)) continue;
      const time = ctx.currentTime + click.delayMs / 1000;
      const node = ctx.createOscillator(), gain = ctx.createGain();
      node.frequency.value = click.accent ? 1500 : 1000;
      gain.gain.setValueAtTime(click.accent ? 0.25 : 0.16, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
      node.connect(gain); gain.connect(ctx.destination);
      node.start(time); node.stop(time + 0.05);
      node.onended = () => { node.disconnect(); gain.disconnect(); };
      this.scheduled.set(key, { node, time });
    }
  }
}
