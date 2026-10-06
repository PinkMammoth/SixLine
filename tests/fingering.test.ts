import { describe, expect, it } from 'vitest';
import { assignFingering, positionsFor, type FingerEvent, type FingeringResult } from '../src/model/fingering';

const STD = [64, 59, 55, 50, 45, 40];
const DROP_D = [64, 59, 55, 50, 45, 38];
const BASS = [43, 38, 33, 28];
const ev = (...seq: (number | number[])[]): FingerEvent[] => seq.map((p) => ({ pitches: Array.isArray(p) ? p : [p] }));

/** Every placed note reconstructs its pitch; strings unique per event. */
function checkValid(r: FingeringResult[], events: FingerEvent[], tuning: number[]) {
  r.forEach((res, i) => {
    for (const p of res.placed) expect(tuning[p.string] + p.fret).toBe(p.pitch);
    expect(new Set(res.placed.map((p) => p.string)).size).toBe(res.placed.length);
    const all = [...res.placed.map((p) => p.pitch), ...res.unsupported].sort();
    expect(all).toEqual([...new Set(events[i].pitches)].sort());
  });
}
/** Hand position per event: a 4-fret window [h, h+3] that moves only when a fretted note falls outside it. */
function handPositions(r: FingeringResult[]) {
  let h = -1;
  return r.map((x) => {
    const fr = x.placed.filter((p) => p.fret > 0).map((p) => p.fret);
    if (!fr.length) return Math.max(h, 1);
    const lo = Math.min(...fr);
    const hi = Math.max(...fr);
    if (h < 0) h = lo;
    if (lo < h) h = lo;
    if (hi > h + 3) h = Math.min(lo, hi - 3);
    return h;
  });
}
const maxJump = (r: FingeringResult[]) => {
  const h = handPositions(r);
  return Math.max(0, ...h.slice(1).map((x, i) => Math.abs(x - h[i])));
};
const totalMove = (r: FingeringResult[]) => {
  const h = handPositions(r);
  return h.slice(1).reduce((s, x, i) => s + Math.abs(x - h[i]), 0);
};
const span = (x: FingeringResult) => {
  const fr = x.placed.filter((p) => p.fret > 0).map((p) => p.fret);
  return fr.length ? Math.max(...fr) - Math.min(...fr) : 0;
};
/** Naive baseline: every note independently on its lowest fret. */
const greedy = (events: FingerEvent[], tuning: number[]): FingeringResult[] =>
  events.map((e) => ({ placed: e.pitches.map((p) => positionsFor(p, tuning).sort((a, b) => a.fret - b.fret)[0]), unsupported: [] }));

describe('fingering', () => {
  it('1. ascending C major scale stays in compact positions', () => {
    const events = ev(48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72);
    const r = assignFingering(events, { tuning: STD });
    checkValid(r, events, STD);
    expect(maxJump(r)).toBeLessThanOrEqual(5);
    expect(Math.max(...r.flatMap((x) => x.placed.map((p) => p.fret)))).toBeLessThanOrEqual(10);
  });

  it('2. descending melody stays in compact positions', () => {
    const events = ev(76, 74, 72, 71, 69, 67, 65, 64, 62, 60, 59, 57);
    const r = assignFingering(events, { tuning: STD });
    checkValid(r, events, STD);
    expect(maxJump(r)).toBeLessThanOrEqual(5);
  });

  it('3. repeated pitch keeps one fingering', () => {
    const events = ev(57, 57, 57, 57, 57);
    const r = assignFingering(events, { tuning: STD });
    checkValid(r, events, STD);
    expect(new Set(r.map((x) => `${x.placed[0].string}/${x.placed[0].fret}`)).size).toBe(1);
  });

  it('4. open-string riff uses the open low E and first position', () => {
    const events = ev(40, 40, 43, 45, 40, 40, 47, 45, 43, 40);
    const r = assignFingering(events, { tuning: STD });
    checkValid(r, events, STD);
    for (const x of r.filter((x) => x.placed[0].pitch === 40)) expect(x.placed[0]).toEqual({ pitch: 40, string: 5, fret: 0 });
    expect(Math.max(...r.map((x) => x.placed[0].fret))).toBeLessThanOrEqual(3);
  });

  it('5. phrase-aware: moves the hand far less than greedy lowest-fret', () => {
    const events = ev(71, 73, 74, 73, 71, 69, 66, 69, 71, 74, 76, 74);
    const r = assignFingering(events, { tuning: STD });
    checkValid(r, events, STD);
    const g = greedy(events, STD);
    expect(totalMove(r)).toBeLessThan(totalMove(g) / 2);
    expect(maxJump(r)).toBeLessThanOrEqual(4);
  });

  it('6. power chords sit on adjacent strings with small span', () => {
    const events = ev([40, 47], [43, 50], [45, 52], [48, 55], [47, 54]);
    const r = assignFingering(events, { tuning: STD });
    checkValid(r, events, STD);
    for (const x of r) {
      expect(x.unsupported).toEqual([]);
      const [a, b] = x.placed.map((p) => p.string).sort();
      expect(b - a).toBe(1);
      expect(span(x)).toBeLessThanOrEqual(2);
    }
  });

  it('7. common triads/open chords: complete, compact shapes', () => {
    const events = ev([48, 52, 55, 60, 64], [43, 47, 50, 55, 59, 67], [45, 52, 57, 60, 64], [50, 57, 62, 66]);
    const r = assignFingering(events, { tuning: STD });
    checkValid(r, events, STD);
    for (const x of r) {
      expect(x.unsupported).toEqual([]);
      expect(span(x)).toBeLessThanOrEqual(3);
    }
    // open G uses all six strings in first position
    expect(r[1].placed).toHaveLength(6);
    expect(Math.max(...r[1].placed.map((p) => p.fret))).toBeLessThanOrEqual(3);
  });

  it('8. simultaneous notes get unique strings, including semitone clusters', () => {
    const events = ev([52, 53, 55], [64, 59, 55], [52, 57, 62, 67]);
    const r = assignFingering(events, { tuning: STD });
    checkValid(r, events, STD);
    for (const x of r) expect(x.unsupported).toEqual([]);
  });

  it('9. notes at the limits of the range', () => {
    const events = ev(40, 88, 89, 39);
    const r = assignFingering(events, { tuning: STD, maxFret: 24 });
    checkValid(r, events, STD);
    expect(r[0].placed[0]).toEqual({ pitch: 40, string: 5, fret: 0 });
    expect(r[1].placed[0]).toEqual({ pitch: 88, string: 0, fret: 24 });
    expect(r[2]).toEqual({ placed: [], unsupported: [89] });
    expect(r[3]).toEqual({ placed: [], unsupported: [39] });
  });

  it('10. bass tuning: low line stays in first position', () => {
    const events = ev(28, 31, 33, 35, 36, 35, 33, 31);
    const r = assignFingering(events, { tuning: BASS });
    checkValid(r, events, BASS);
    expect(Math.max(...r.map((x) => x.placed[0].fret))).toBeLessThanOrEqual(5);
    expect(maxJump(r)).toBeLessThanOrEqual(3);
  });

  it('11. alternate tuning: drop-D power chord is played open', () => {
    const events = ev([38, 45, 50], [40, 47, 52]);
    const r = assignFingering(events, { tuning: DROP_D });
    checkValid(r, events, DROP_D);
    expect(r[0].placed.map((p) => [p.string, p.fret]).sort()).toEqual([[3, 0], [4, 0], [5, 0]]);
    expect(new Set(r[1].placed.map((p) => p.fret)).size).toBe(1); // one-finger barre
  });

  it('12. impossible chords and pitches are reported, never re-pitched', () => {
    const events = ev([40, 45, 50, 55, 59, 64, 69], [20, 64], [40, 41, 42, 43, 44]);
    const r = assignFingering(events, { tuning: STD });
    checkValid(r, events, STD);
    expect(r[0].unsupported).toHaveLength(1);
    expect(r[0].placed).toHaveLength(6);
    expect(r[1].unsupported).toEqual([20]);
    expect(r[2].unsupported.length).toBeGreaterThan(0); // 5 notes within 4 semitones: not playable at once
  });

  it('12b. a cluster needing a 7-fret stretch drops a note rather than producing an absurd shape', () => {
    const r = assignFingering(ev([60, 61, 62]), { tuning: STD });
    checkValid(r, ev([60, 61, 62]), STD);
    expect(r[0].unsupported).toHaveLength(1);
    expect(span(r[0])).toBeLessThanOrEqual(5);
  });

  it('respects capo and max fret', () => {
    const r = assignFingering(ev(42, 66), { tuning: STD, capo: 2, maxFret: 12 });
    expect(r[0].placed[0]).toEqual({ pitch: 42, string: 5, fret: 0 });
    for (const p of r[1].placed) expect(STD[p.string] + 2 + p.fret).toBe(66);
  });

  it('is deterministic and fast on long inputs', () => {
    const events: FingerEvent[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 5000; i++) events.push({ pitches: i % 4 === 0 ? [40 + Math.floor(rnd() * 12), 52 + Math.floor(rnd() * 12)] : [52 + Math.floor(rnd() * 20)] });
    const t0 = performance.now();
    const a = assignFingering(events, { tuning: STD });
    const ms = performance.now() - t0;
    expect(assignFingering(events, { tuning: STD })).toEqual(a);
    checkValid(a, events, STD);
    expect(ms).toBeLessThan(3000);
  });
});
