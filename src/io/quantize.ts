// Quantises timed notes (960 PPQ) into SixLine's rhythmic model.
//
// Rules:
// - Bars come from the time-signature map; each bar is split into quarter-note units (960 ticks;
//   a final partial unit for odd /8 or /16 meters).
// - Each unit uses either a straight 32nd grid (120 ticks) or a 16th-triplet grid (160 ticks),
//   whichever fits that unit's note starts/ends clearly better. Note starts and ends snap to it.
// - A track is a single voice: notes starting together form a chord; a chord lasts until its longest
//   note ends or the next onset, whichever comes first (overlaps are cut and counted).
// - Spans are written with whole/half/quarter/eighth/16th/32nd values, dotted values and triplets,
//   split at bar lines and at triplet-unit boundaries; continuations are tied.
import type { Beat, Duration, MasterBar } from '../model/song';
import { barTicks } from '../model/rhythm';

export interface TimedNote {
  pitch: number;
  start: number;
  end: number;
  velocity: number;
}

export interface SkeletonNote {
  pitch: number;
  velocity: number;
  tie?: boolean;
}

/** A beat before notes are mapped to strings/frets. `group` links pieces of the same onset (for fingering). */
export interface SkeletonBeat extends Omit<Beat, 'notes'> {
  notes: SkeletonNote[];
  group: number;
}

export interface QuantizeStats {
  notes: number;
  /** Notes whose start moved when snapping to the grid. */
  movedStarts: number;
  /** Largest start shift in ticks (960 PPQ). */
  maxShift: number;
  /** Notes whose length changed by more than the grid step for reasons other than overlap/chord. */
  resized: number;
  /** Notes cut short because the next onset started before they ended (single voice per track). */
  truncated: number;
  /** Chord notes stretched to the chord's common length. */
  unified: number;
  /** Duplicate notes (same pitch, same quantised start) merged. */
  merged: number;
  /** Quarter-note units written on a triplet grid. */
  tripletUnits: number;
}

export interface QuantizedTrack {
  bars: SkeletonBeat[][];
  /** Onset groups in time order: index = SkeletonBeat.group; rest = silence before the onset (ticks). */
  groups: { pitches: number[]; rest: number }[];
  stats: QuantizeStats;
}

interface Unit {
  start: number;
  len: number;
  bar: number;
}

export function barStarts(masterBars: Pick<MasterBar, 'num' | 'den'>[]): number[] {
  const out: number[] = [];
  let t = 0;
  for (const mb of masterBars) {
    out.push(t);
    t += barTicks(mb);
  }
  out.push(t);
  return out;
}

function buildUnits(masterBars: Pick<MasterBar, 'num' | 'den'>[]): Unit[] {
  const starts = barStarts(masterBars);
  const units: Unit[] = [];
  masterBars.forEach((_, b) => {
    for (let t = starts[b]; t < starts[b + 1]; t += 960) units.push({ start: t, len: Math.min(960, starts[b + 1] - t), bar: b });
  });
  return units;
}

const STRAIGHT: [number, Duration, number][] = [
  [3840, 1, 0], [2880, 2, 1], [1920, 2, 0], [1440, 4, 1], [960, 4, 0], [720, 8, 1], [480, 8, 0], [360, 16, 1], [240, 16, 0], [120, 32, 0],
];
const TRIPLET: [number, Duration, number][] = [
  [640, 4, 0], [480, 8, 1], [320, 8, 0], [160, 16, 0],
];

export function quantizeTrack(notesIn: TimedNote[], masterBars: Pick<MasterBar, 'num' | 'den'>[]): QuantizedTrack {
  const units = buildUnits(masterBars);
  const songEnd = units.length ? units[units.length - 1].start + units[units.length - 1].len : 0;
  const stats: QuantizeStats = { notes: notesIn.length, movedStarts: 0, maxShift: 0, resized: 0, truncated: 0, unified: 0, merged: 0, tripletUnits: 0 };
  const unitAt = (t: number) => {
    let lo = 0;
    let hi = units.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (units[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // 1. choose a grid per unit from the points that fall in it
  const pts: number[][] = units.map(() => []);
  for (const n of notesIn) {
    pts[unitAt(n.start)].push(n.start);
    if (n.end < songEnd) pts[unitAt(n.end)].push(n.end);
  }
  const grid = units.map((u, i) => {
    if (u.len % 160 !== 0 || !pts[i].length) return 120;
    let errS = 0;
    let errT = 0;
    for (const p of pts[i]) {
      const r = p - u.start;
      errS += Math.abs(r - Math.round(r / 120) * 120);
      errT += Math.abs(r - Math.round(r / 160) * 160);
    }
    return errT + 1 < errS * 0.5 ? 160 : 120;
  });
  stats.tripletUnits = grid.filter((g, i) => g === 160 && pts[i].length).length;
  const snap = (t: number) => {
    const i = unitAt(t);
    const u = units[i];
    return Math.min(u.start + u.len, u.start + Math.round((t - u.start) / grid[i]) * grid[i]);
  };
  const stepAt = (t: number) => grid[unitAt(t)];

  // 2. snap and group simultaneous starts
  const byStart = new Map<number, { pitch: number; velocity: number; end: number; rawLen: number }[]>();
  for (const n of [...notesIn].sort((a, b) => a.start - b.start || a.pitch - b.pitch)) {
    const s = snap(n.start);
    const shift = Math.abs(s - n.start);
    if (shift > 0) stats.movedStarts++;
    stats.maxShift = Math.max(stats.maxShift, shift);
    const list = byStart.get(s) ?? [];
    const dup = list.find((x) => x.pitch === n.pitch);
    if (dup) {
      stats.merged++;
      dup.end = Math.max(dup.end, snap(n.end));
      dup.velocity = Math.max(dup.velocity, n.velocity);
    } else list.push({ pitch: n.pitch, velocity: n.velocity, end: snap(n.end), rawLen: n.end - n.start });
    byStart.set(s, list);
  }
  const onsets = [...byStart.keys()].sort((a, b) => a - b);

  // 3. timeline segments: sound [T, end) then rest [end, next)
  const groups: QuantizedTrack['groups'] = [];
  const bars: SkeletonBeat[][] = masterBars.map(() => []);
  let cursor = 0;
  let prevEnd = 0;
  onsets.forEach((T, gi) => {
    const next = onsets[gi + 1] ?? songEnd;
    const notes = byStart.get(T)!.sort((a, b) => b.pitch - a.pitch);
    const step = stepAt(T);
    let end = Math.max(...notes.map((n) => n.end));
    if (end > next) {
      stats.truncated += notes.filter((n) => n.end > next).length;
      end = next;
    }
    if (end <= T) end = Math.min(next, T + step);
    for (const n of notes) {
      const cut = n.end > next;
      if (!cut && n.end < end && end - n.end >= step) stats.unified++;
      else if (!cut && Math.abs(end - T - n.rawLen) > step) stats.resized++;
    }
    if (T > cursor) emit(cursor, T, null, -1);
    groups.push({ pitches: notes.map((n) => n.pitch), rest: Math.max(0, T - prevEnd) });
    emit(T, end, notes.map((n) => ({ pitch: n.pitch, velocity: n.velocity })), gi);
    cursor = end;
    prevEnd = end;
  });
  if (cursor < songEnd) emit(cursor, songEnd, null, -1);

  return { bars, groups, stats };

  /** Write [a, b) as beats, splitting at bar lines and triplet-unit boundaries. */
  function emit(a: number, b: number, notes: SkeletonNote[] | null, group: number) {
    let first = true;
    let pieceStart = a;
    let i = unitAt(a);
    while (pieceStart < b) {
      // extend the piece over following units while bar and grid type allow
      let j = i;
      let pieceEnd = Math.min(b, units[j].start + units[j].len);
      while (pieceEnd < b && units[j + 1] && units[j + 1].bar === units[i].bar && grid[j] === 120 && grid[j + 1] === 120) {
        j++;
        pieceEnd = Math.min(b, units[j].start + units[j].len);
      }
      const table = grid[i] === 160 ? TRIPLET : STRAIGHT;
      let len = pieceEnd - pieceStart;
      while (len > 0) {
        const entry = table.find(([t]) => t <= len) ?? table[table.length - 1];
        const beat: SkeletonBeat = { duration: entry[1], dots: entry[2], notes: [], group };
        if (table === TRIPLET) beat.tuplet = [3, 2];
        if (notes) beat.notes = notes.map((n) => (first ? { ...n } : { ...n, tie: true }));
        bars[units[i].bar].push(beat);
        first = false;
        len -= Math.min(len, entry[0]);
      }
      pieceStart = pieceEnd;
      i = j + 1;
    }
  }
}
