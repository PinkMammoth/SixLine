import { type Beat, type Duration, type MasterBar, type Measure, type Note, type Song, type Track, isStringed, notePitch } from '../model/song';
import { barTicks, beatTicks, ticksToDurations, voiceTicks } from '../model/rhythm';
import { selectionRange, type Position, type Selection } from './selection';

export interface Passage {
  type: Track['type'];
  tuning: number[];
  capo: number;
  kind: Selection['kind'];
  rows?: number[];
  bars: MasterBar[];
  measures: Measure[];
}
const clone = <T>(v: T): T => structuredClone(v);
/** Tie origins follow the nearest previous note on the string/pitch, as in the GP bridge. */
export function tieOrigins(track: Track): Map<Note, Note> {
  const origins = new Map<Note, Note>();
  for (let vi = 0; vi < Math.max(...track.measures.map(m => m.voices.length)); vi++) {
    const previous = new Map<number, Note>();
    for (const m of track.measures) for (const b of m.voices[vi] ?? []) for (const n of b.notes) {
      const key = isStringed(track) ? n.string! : n.pitch!;
      const origin = previous.get(key);
      if (n.tie && origin && notePitch(track, origin) === notePitch(track, n)) origins.set(n, origin);
      previous.set(key, n);
    }
  }
  return origins;
}
function sanitizeTies(track: Track) {
  const origins = tieOrigins(track);
  for (const m of track.measures) for (const v of m.voices) for (const b of v) for (const n of b.notes)
    if (n.tie && !origins.has(n)) delete n.tie;
}
export function copyPassage(song: Song, s: Selection): Passage {
  const { start, end } = selectionRange(song, s);
  const t = song.tracks[s.track];
  const measures = clone(t.measures.slice(start.bar, end.bar + 1));
  if (s.kind === 'beats') {
    for (let i = 0; i < measures.length; i++) measures[i].voices = [measures[i].voices[0].slice(i === 0 ? start.beat : 0, i === measures.length - 1 ? end.beat + 1 : undefined)];
  }
  if (s.kind === 'beats' || s.rows) for (let i = 0; i < measures.length; i++) {
    if (i === measures.length - 1 && s.kind === 'beats') continue;
    const original = t.measures[start.bar + i].voices[0];
    if (original.some(b => b.grace)) continue;
    const missing = barTicks(song.masterBars[start.bar + i]) - voiceTicks(original);
    if (missing < 0) throw new Error('Cannot copy an overfull beat range.');
    measures[i].voices[0].push(...rests(missing));
  }
  if (s.rows) for (const m of measures) for (const v of m.voices) for (const b of v)
    b.notes = b.notes.filter(n => s.rows!.includes(isStringed(t) ? n.string! : n.pitch!));
  // A tie whose origin lies outside the copied passage becomes an ordinary attack.
  sanitizeTies({ ...t, measures });
  return { type: t.type, tuning: [...t.tuning], capo: t.capo, kind: s.kind, rows: s.rows && [...s.rows], bars: clone(song.masterBars.slice(start.bar, end.bar + 1)), measures };
}

export function assertCompatible(t: Track, p: Passage) {
  if (t.type !== p.type) throw new Error(`Cannot paste ${p.type} material into a ${t.type} track.`);
  if (isStringed(t) && (t.capo !== p.capo || JSON.stringify(t.tuning) !== JSON.stringify(p.tuning)))
    throw new Error('Paste requires the same tuning and capo to preserve pitch and fingering.');
}
function rests(ticks: number): Beat[] {
  if (!ticks) return [];
  const ds = ticksToDurations(ticks);
  if (ds.length) return ds.map(duration => ({ duration, dots: 0, notes: [] }));
  // Triplet passages can leave triplet-sized silence in an otherwise empty bar.
  const candidates = ([1, 2, 4, 8, 16, 32, 64] as Duration[]).flatMap(duration => [
    { duration, dots: 0, notes: [] } as Beat,
    { duration, dots: 0, tuplet: [3, 2], notes: [] } as Beat,
  ]).sort((a,b) => beatTicks(b) - beatTicks(a));
  const out: Beat[] = []; let remaining = ticks;
  for (const b of candidates) while (remaining >= beatTicks(b)) { out.push(clone(b)); remaining -= beatTicks(b); }
  if (remaining) throw new Error('This rhythm cannot be placed exactly. Choose a measure range instead.');
  return out;
}
function padded(song: Song, track: number, bar: number): Beat[] {
  const voice = clone(song.tracks[track].measures[bar].voices[0]);
  if (voice.some(b => b.grace)) throw new Error('For grace notes, copy and paste whole measures.');
  const missing = barTicks(song.masterBars[bar]) - voiceTicks(voice);
  if (missing < 0) throw new Error('Resolve the overfull measure before pasting.');
  return [...voice, ...rests(missing)];
}
function extend(song: Song, reference: MasterBar) {
  song.masterBars.push({ num: reference.num, den: reference.den });
  for (const t of song.tracks) t.measures.push({ voices: [rests(barTicks(reference))] });
}

/** Build the complete result before committing: failure never changes the document. Paste overwrites time. */
export function pastePassage(source: Song, track: number, at: Position, p: Passage): Song {
  assertCompatible(source.tracks[track], p);
  const song = clone(source);
  const t = song.tracks[track];
  if (p.kind === 'measures' && !p.rows && at.beat === 0) {
    p.measures.forEach((m, i) => {
      const bar = at.bar + i;
      if (!song.masterBars[bar]) extend(song, p.bars[i]);
      const dest = song.masterBars[bar], src = p.bars[i];
      if (dest.num !== src.num || dest.den !== src.den) throw new Error('Measure paste requires matching time signatures.');
      if (m.voices.some(v => voiceTicks(v.filter(b => !b.grace)) > barTicks(dest))) throw new Error('Cannot paste an overfull measure.');
      t.measures[bar] = clone(m);
    });
    sanitizeTies(t); return song;
  }
  if (p.kind === 'measures' && !p.rows && p.measures.some(m => m.voices.length > 1)) throw new Error('Paste measures with multiple voices at a measure boundary.');
  const material = clone(p.measures.flatMap((m, i) => p.kind === 'measures' && !p.rows
    ? [...m.voices[0], ...rests(barTicks(p.bars[i]) - voiceTicks(m.voices[0].filter(b => !b.grace)))] : m.voices[0]));
  if (p.rows && p.measures.some(m => m.voices.slice(1).some(v => v.some(b => b.notes.length)))) throw new Error('Note-only paste supports the primary voice. Select whole measures to include other voices.');
  if (material.some(b => b.grace)) throw new Error('For grace notes, copy and paste whole measures.');
  let bar = at.bar;
  let offset = voiceTicks(t.measures[bar].voices[0].slice(0, at.beat));
  for (const beat of material) {
    if (offset === barTicks(song.masterBars[bar])) { bar++; offset = 0; }
    if (!song.masterBars[bar]) extend(song, song.masterBars[bar - 1]);
    const size = beatTicks(beat);
    if (offset + size > barTicks(song.masterBars[bar])) throw new Error('A pasted beat crosses a bar line. Paste at a matching beat or select whole measures.');
    const v = padded(song, track, bar);
    let ticks = 0, first = -1, last = -1;
    for (let i = 0; i <= v.length; i++) {
      if (ticks === offset) first = i;
      if (ticks === offset + size) { last = i; break; }
      if (i < v.length) ticks += beatTicks(v[i]);
    }
    // Splitting rests is safe; splitting existing notes would change rhythm and articulation.
    if (first < 0 || last < 0) {
      let tick = 0;
      const prefix: Beat[] = [], suffix: Beat[] = [];
      for (const b of v) {
        const end = tick + beatTicks(b);
        if (end <= offset) prefix.push(b);
        else if (tick >= offset + size) suffix.push(b);
        else if (p.rows || b.notes.length && (tick < offset || end > offset + size)) throw new Error('Paste would split an existing note. Choose matching rhythmic boundaries.');
        else { if (tick < offset) prefix.push(...rests(offset - tick)); if (end > offset + size) suffix.push(...rests(end - offset - size)); }
        tick = end;
      }
      t.measures[bar].voices[0] = [...prefix, beat, ...suffix];
    } else if (p.rows) {
      if (last !== first + 1) throw new Error('Note-only paste requires matching beat durations.');
      v[first].notes = [...v[first].notes.filter(n => !p.rows!.includes(isStringed(t) ? n.string! : n.pitch!)), ...beat.notes];
      t.measures[bar].voices[0] = v;
    } else { v.splice(first, last - first, beat); t.measures[bar].voices[0] = v; }
    offset += size;
  }
  sanitizeTies(t); return song;
}

/** Beat duplication inserts time and reflows the primary voice. Never split notes implicitly. */
export function insertPassage(source: Song, track: number, at: Position, p: Passage): Song {
  assertCompatible(source.tracks[track], p);
  const song = clone(source);
  const t = song.tracks[track];
  if (t.measures.slice(at.bar).some(m => m.voices.length > 1)) throw new Error('Duplicate whole measures when the passage has multiple voices.');
  const prefix = clone(t.measures[at.bar].voices[0].slice(0, at.beat));
  const suffix = t.measures.slice(at.bar).flatMap((_m, i) => padded(song, track, at.bar + i).slice(i === 0 ? at.beat : 0));
  const beats = [...prefix, ...clone(p.measures.flatMap(m => m.voices[0])), ...suffix];
  let bar = at.bar, used = 0, voice: Beat[] = [];
  for (const b of beats) {
    if (b.grace) throw new Error('Duplicate whole measures for grace notes.');
    if (!song.masterBars[bar]) extend(song, song.masterBars[bar - 1]);
    if (used + beatTicks(b) > barTicks(song.masterBars[bar])) throw new Error('Duplication would split a beat at a bar line. Select whole measures instead.');
    voice.push(b); used += beatTicks(b);
    if (used === barTicks(song.masterBars[bar])) { t.measures[bar].voices[0] = voice; bar++; used = 0; voice = []; }
  }
  if (voice.length) t.measures[bar].voices[0] = voice;
  sanitizeTies(t); return song;
}
