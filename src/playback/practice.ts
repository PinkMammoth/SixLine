import type { Song } from '../model/song';

export interface LoopRange { startTick: number; endTick: number }
/** Audio buffers may report a few ticks past a gated range; the musical playhead ends at B. */
export function clampLoopTick(tick: number, range: LoopRange | null) {
  return range ? Math.max(range.startTick, Math.min(range.endTick, tick)) : tick;
}
export class PracticeState {
  speed = 100;
  metronome = false;
  countIn: 0 | 1 | 2 = 0;
  loop: LoopRange | null = null;
  loopSource: 'selection' | 'ab' | null = null;
  a: number | null = null;
  b: number | null = null;
  looping = false;
  setSpeed(percent: number) {
    if (!Number.isFinite(percent) || percent < 25 || percent > 200) throw new Error('Speed must be between 25% and 200%.');
    this.speed = percent;
  }
  setLoop(range: LoopRange, source: 'selection' | 'ab') {
    if (range.startTick < 0 || range.endTick <= range.startTick) throw new Error('Loop end must follow loop start.');
    this.loop = { ...range }; this.loopSource = source; this.looping = true;
  }
  enableAB() {
    if (this.a === null || this.b === null) throw new Error('Set both A and B at the caret first. B is the exclusive end.');
    this.setLoop({ startTick: this.a, endTick: this.b }, 'ab');
  }
  clearLoop() { this.loop = null; this.loopSource = null; this.looping = false; this.a = this.b = null; }
}

export function tempoAtBar(song: Song, bar: number) {
  let tempo = song.tempo;
  for (let i = 0; i <= bar; i++) tempo = song.masterBars[i].tempo ?? tempo;
  return tempo;
}
export function countInPlan(num: number, den: number, tempo: number, bars: number, speed = 100) {
  const intervalMs = 60000 / tempo * 4 / den * 100 / speed;
  return { intervalMs, durationMs: intervalMs * num * bars, clicks: Array.from({ length: num * bars }, (_, i) => ({ timeMs: i * intervalMs, accent: i % num === 0 })) };
}

/** A separate practice pre-roll. Nothing is added to the score or exported MIDI. */
export class CountIn {
  private context: AudioContext | null = null;
  private timer = 0;
  private nodes: OscillatorNode[] = [];
  private generation = 0;
  active = false;
  cancel() {
    this.generation++;
    clearTimeout(this.timer);
    for (const n of this.nodes) { try { n.stop(); } catch { /* already finished */ } }
    this.nodes = []; this.active = false;
  }
  async start(num: number, den: number, tempo: number, bars: number, speed: () => number, done: () => void) {
    this.cancel(); this.active = true;
    const generation = this.generation;
    this.context ??= new AudioContext();
    await this.context.resume();
    if (generation !== this.generation) return;
    const unit = countInPlan(num, den, tempo, bars).intervalMs;
    let progress = 0, clicked = -1, last = performance.now();
    const pulse = () => {
      if (generation !== this.generation) return;
      const now = performance.now();
      progress += (now - last) / unit * speed() / 100; last = now;
      if (progress >= num * bars) { this.active = false; this.nodes = []; done(); return; }
      const index = Math.floor(progress);
      if (index !== clicked) {
        clicked = index;
        const ctx = this.context!, osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.frequency.value = index % num === 0 ? 1500 : 1000;
        gain.gain.setValueAtTime(0.24, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.05);
        this.nodes.push(osc);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); this.nodes = this.nodes.filter(n => n !== osc); };
      }
      this.timer = window.setTimeout(pulse, Math.min(10, Math.max(1, (num * bars - progress) * unit * 100 / speed())));
    };
    pulse();
  }
}
