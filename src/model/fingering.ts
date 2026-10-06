// Automatic string/fret assignment for MIDI pitches on fretted instruments.
//
// Phrase-aware: a Viterbi/beam search over candidate fingerings of successive events. A state is
// (candidate fingering, hand position); the hand covers a four-fret window [h, h+3] and only moves
// as far as it must, so open strings and notes inside the window cost no movement. All tuning knobs
// live in DEFAULT_WEIGHTS.

export interface FingeringWeights {
  /** Cost per fret the hand window moves. */
  move: number;
  /** Moves larger than this many frets are additionally penalised... */
  bigJumpThreshold: number;
  /** ...by this much per fret beyond the threshold. */
  bigJump: number;
  /** Cost per string beyond one between successive events (melodic continuity). */
  stringJump: number;
  /** Repeating the same pitch(es) with a different fingering. */
  samePitchSwitch: number;
  /** Cost per fret of hand position above first position (prefer lower positions). */
  fretHeight: number;
  /** Frets above this are additionally penalised... */
  highFretStart: number;
  /** ...by this much per fret. */
  highFret: number;
  /** Chord span (frets between lowest and highest fretted note) allowed without penalty. */
  spanComfort: number;
  /** Cost per fret of span beyond spanComfort. */
  span: number;
  /** Chords with a wider span are rejected outright. */
  maxSpan: number;
  /** Cost per unused string inside a chord shape. */
  stringGap: number;
  /** Cost per pair of chord notes whose pitch order contradicts string order. */
  crossing: number;
  /** Bonus (subtracted) per open string when the hand is at or below openFarFrom. */
  openBonus: number;
  /** Cost per open string when the hand is above openFarFrom. */
  openFarPenalty: number;
  openFarFrom: number;
  /** Silence (ticks) between events that halves transition costs. */
  restRelief: number;
  /** Candidate fingerings kept per event (cheapest first). */
  maxCandidates: number;
  /** Search states kept per event. */
  beam: number;
}

export const DEFAULT_WEIGHTS: FingeringWeights = {
  move: 1.0,
  bigJumpThreshold: 4,
  bigJump: 1.5,
  stringJump: 0.6,
  samePitchSwitch: 2.0,
  fretHeight: 0.15,
  highFretStart: 12,
  highFret: 0.4,
  spanComfort: 3,
  span: 1.5,
  maxSpan: 5,
  stringGap: 0.8,
  crossing: 3.0,
  openBonus: 0.4,
  openFarPenalty: 0.5,
  openFarFrom: 5,
  restRelief: 1920,
  maxCandidates: 60,
  beam: 48,
};

export interface FingeringOptions {
  /** MIDI note per string, index 0 = highest string. */
  tuning: number[];
  maxFret?: number;
  capo?: number;
  weights?: Partial<FingeringWeights>;
}

export interface FingerEvent {
  pitches: number[];
  /** Silence in ticks between the previous event's end and this event (0 = legato). */
  rest?: number;
}

export interface Placement {
  pitch: number;
  string: number;
  fret: number;
}

export interface FingeringResult {
  placed: Placement[];
  /** Pitches that cannot be played on this instrument/tuning, or not alongside the rest of the chord. */
  unsupported: number[];
}

interface Candidate {
  placed: Placement[];
  unary: number;
  minFret: number; // lowest fretted fret (Infinity if all open)
  maxFret: number; // highest fretted fret (-1 if all open)
  avgString: number;
  opens: number;
}

/** Every string/fret on which `pitch` can be played. */
export function positionsFor(pitch: number, tuning: number[], maxFret = 24, capo = 0): Placement[] {
  const out: Placement[] = [];
  tuning.forEach((open, string) => {
    const fret = pitch - open - capo;
    if (fret >= 0 && fret <= maxFret) out.push({ pitch, string, fret });
  });
  return out;
}

export function assignFingering(events: FingerEvent[], opts: FingeringOptions): FingeringResult[] {
  const w = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const maxFret = opts.maxFret ?? 24;
  const capo = opts.capo ?? 0;

  // candidates per event (+ unsupported pitches)
  const cands: Candidate[][] = [];
  const unsupported: number[][] = [];
  for (const ev of events) {
    const { candidates, dropped } = chordCandidates(ev.pitches, opts.tuning, maxFret, capo, w);
    cands.push(candidates);
    unsupported.push(dropped);
  }

  // Viterbi with beam. State key = candidate index + hand position.
  interface State {
    cand: number;
    hand: number;
    cost: number;
    back: State | null;
    ev: number;
  }
  let states: State[] = [];
  let prevEvent = -1;

  for (let i = 0; i < events.length; i++) {
    const cs = cands[i];
    if (!cs.length) continue; // nothing playable: leave the chain untouched
    const next = new Map<string, State>();
    const relief = w.restRelief / (w.restRelief + Math.max(0, events[i].rest ?? 0));
    const prevCands = prevEvent >= 0 ? cands[prevEvent] : null;
    cs.forEach((c, ci) => {
      if (!states.length) {
        const hand = c.maxFret < 0 ? 1 : handFor(c, Math.max(1, c.minFret));
        const s: State = { cand: ci, hand, cost: c.unary + positionCost(c, hand, w), back: null, ev: i };
        put(next, s);
        return;
      }
      for (const p of states) {
        const pc = prevCands![p.cand];
        const hand = c.maxFret < 0 ? p.hand : handFor(c, p.hand);
        const t = transition(pc, c, p.hand, hand, w) * relief;
        const s: State = { cand: ci, hand, cost: p.cost + c.unary + positionCost(c, hand, w) + t, back: p, ev: i };
        put(next, s);
      }
    });
    states = [...next.values()].sort((a, b) => a.cost - b.cost || a.cand - b.cand || a.hand - b.hand).slice(0, w.beam);
    prevEvent = i;
  }

  // backtrack from the best final state
  const chosen: (Candidate | null)[] = new Array(events.length).fill(null);
  let s: State | null = states[0] ?? null;
  while (s) {
    chosen[s.ev] = cands[s.ev][s.cand];
    s = s.back;
  }
  return events.map((_, i) => ({ placed: chosen[i]?.placed ?? [], unsupported: unsupported[i] }));

  function put(m: Map<string, State>, s: State) {
    const k = s.cand + ':' + s.hand;
    const e = m.get(k);
    if (!e || s.cost < e.cost) m.set(k, s);
  }
}

/** Hand window [h, h+3]: move from `from` only as far as needed to cover the fretted notes. */
function handFor(c: Candidate, from: number): number {
  const lo = Math.max(1, c.maxFret - 3);
  const hi = Math.max(1, c.minFret);
  if (lo > hi) return hi; // stretch: anchor index finger on the lowest fret
  return Math.min(hi, Math.max(lo, from));
}

function positionCost(c: Candidate, hand: number, w: FingeringWeights) {
  let cost = w.fretHeight * (hand - 1) + w.highFret * Math.max(0, c.maxFret - w.highFretStart);
  cost += c.opens * (hand <= w.openFarFrom ? -w.openBonus : w.openFarPenalty);
  return cost;
}

function transition(p: Candidate, c: Candidate, fromHand: number, toHand: number, w: FingeringWeights) {
  const d = Math.abs(toHand - fromHand);
  let cost = w.move * d + w.bigJump * Math.max(0, d - w.bigJumpThreshold);
  cost += w.stringJump * Math.max(0, Math.abs(c.avgString - p.avgString) - 1);
  if (samePitches(p, c) && !samePlacement(p, c)) cost += w.samePitchSwitch;
  return cost;
}

const samePitches = (a: Candidate, b: Candidate) =>
  a.placed.length === b.placed.length && a.placed.every((x, i) => x.pitch === b.placed[i].pitch);
const samePlacement = (a: Candidate, b: Candidate) => a.placed.every((x, i) => x.string === b.placed[i].string);

/**
 * All complete chord assignments (one note per string). If the full chord is unplayable, notes are
 * dropped (fewest options first, then lowest pitch) until it is, and reported as unsupported.
 */
function chordCandidates(pitchesIn: number[], tuning: number[], maxFret: number, capo: number, w: FingeringWeights) {
  const dropped: number[] = [];
  let pitches = [...new Set(pitchesIn)].sort((a, b) => b - a);
  for (const p of [...pitches]) if (!positionsFor(p, tuning, maxFret, capo).length) {
    dropped.push(p);
    pitches = pitches.filter((x) => x !== p);
  }
  for (;;) {
    if (!pitches.length) return { candidates: [], dropped };
    const found = enumerate(pitches, tuning, maxFret, capo, w);
    if (found.length) {
      found.sort((a, b) => a.unary - b.unary || key(a).localeCompare(key(b)));
      return { candidates: found.slice(0, w.maxCandidates), dropped };
    }
    // drop the hardest note to place
    const victim = [...pitches].sort((a, b) => positionsFor(a, tuning, maxFret, capo).length - positionsFor(b, tuning, maxFret, capo).length || a - b)[0];
    dropped.push(victim);
    pitches = pitches.filter((x) => x !== victim);
  }
}

const key = (c: Candidate) => c.placed.map((p) => `${p.string}.${p.fret}`).join(',');

function enumerate(pitches: number[], tuning: number[], maxFret: number, capo: number, w: FingeringWeights): Candidate[] {
  const options = pitches.map((p) => positionsFor(p, tuning, maxFret, capo));
  const out: Candidate[] = [];
  const cur: Placement[] = [];
  const used = new Set<number>();
  const LIMIT = 2000;
  const rec = (i: number, lo: number, hi: number) => {
    if (out.length >= LIMIT) return;
    if (i === pitches.length) {
      out.push(describe([...cur], w));
      return;
    }
    for (const o of options[i]) {
      if (used.has(o.string)) continue;
      const nlo = o.fret > 0 ? Math.min(lo, o.fret) : lo;
      const nhi = o.fret > 0 ? Math.max(hi, o.fret) : hi;
      if (nhi >= 0 && nlo !== Infinity && nhi - nlo > w.maxSpan) continue;
      used.add(o.string);
      cur.push(o);
      rec(i + 1, nlo, nhi);
      cur.pop();
      used.delete(o.string);
    }
  };
  rec(0, Infinity, -1);
  return out;
}

function describe(placed: Placement[], w: FingeringWeights): Candidate {
  const fretted = placed.filter((p) => p.fret > 0).map((p) => p.fret);
  const minFret = fretted.length ? Math.min(...fretted) : Infinity;
  const maxFret = fretted.length ? Math.max(...fretted) : -1;
  const strings = placed.map((p) => p.string);
  const span = fretted.length ? maxFret - minFret : 0;
  let unary = w.span * Math.max(0, span - w.spanComfort);
  if (placed.length > 1) {
    const sMin = Math.min(...strings);
    const sMax = Math.max(...strings);
    unary += w.stringGap * (sMax - sMin + 1 - placed.length);
    // placed is in descending pitch order; higher pitch should sit on a higher (lower-index) string
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) if (placed[i].string > placed[j].string) unary += w.crossing;
  }
  return {
    placed,
    unary,
    minFret,
    maxFret,
    avgString: strings.reduce((a, b) => a + b, 0) / strings.length,
    opens: placed.length - fretted.length,
  };
}
