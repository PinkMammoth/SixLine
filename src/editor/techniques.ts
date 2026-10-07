import { isStringed, notePitch, type Note, type Track, type NoteEffects, type MasterBar } from '../model/song';
import { barTicks, voiceTicks } from '../model/rhythm';

export interface NotePosition { note: Note; bar: number; beat: number; voice: number }
export const notePositions = (track: Track): NotePosition[] => track.measures.flatMap((m, bar) => m.voices.flatMap((v, voice) => v.flatMap((b, beat) => b.notes.map(note => ({ note, bar, beat, voice })))));

/** Same-voice, next same-string note, within alphaTab's three-bar search window. */
export function nextOnString(track: Track, from: NotePosition, positions = notePositions(track)): NotePosition | undefined {
  return positions.find(p => p.voice === from.voice && p.bar <= from.bar + 3 &&
    (p.bar > from.bar || p.bar === from.bar && p.beat > from.beat) && p.note.string === from.note.string);
}
export function requireTransition(track: Track, from: NotePosition, meters?: MasterBar[]) {
  const next = nextOnString(track, from);
  if (!next || next.note.tie || next.note.fret === from.note.fret || from.note.tie || from.note.fx?.dead || next.note.fx?.dead)
    throw new Error(`Bar ${from.bar + 1}, beat ${from.beat + 1}: hammer-on / slide needs a different, struck following fret on the same string. Include or enter its target first.`);
  // New transitions must be continuous, rather than jumping over a rest or an unplayed string.
  const following = track.measures[from.bar].voices[from.voice][from.beat + 1] ?? track.measures[from.bar + 1]?.voices[from.voice]?.[0];
  if (!following?.notes.includes(next.note)) throw new Error('Hammer-on / slide needs a note on the same string in the following beat (no intervening rest).');
  if (meters && next.bar > from.bar && voiceTicks(track.measures[from.bar].voices[from.voice].filter(b => !b.grace)) < barTicks(meters[from.bar]))
    throw new Error('Fill the measure before linking across its bar line; there is unplayed time before the target.');
  return next;
}
export function tidyFx(note: Note) { if (note.fx && !Object.keys(note.fx).length) delete note.fx; }
export const hasLinkedFx = (n: Note) => !!n.fx?.hammer || n.fx?.slide === 1 || n.fx?.slide === 2;

export interface Relationship { from: NotePosition; to: NotePosition; tie: boolean; fromFret?: number; toFret?: number }
/** Capture identities before a structural edit, so a deleted target never reattaches to an unrelated note. */
export function relationships(track: Track): Relationship[] {
  if (!isStringed(track)) return [];
  const positions = notePositions(track), out: Relationship[] = [];
  const previous = new Map<string, NotePosition>();
  for (const p of positions) {
    const key = `${p.voice}:${p.note.string}`, origin = previous.get(key);
    if (p.note.tie && origin) out.push({ from: p, to: origin, tie: true, fromFret:p.note.fret, toFret:origin.note.fret });
    previous.set(key, p);
    if (hasLinkedFx(p.note)) {
      const next = nextOnString(track, p, positions);
      if (next) out.push({ from: p, to: next, tie: false, fromFret:p.note.fret, toFret:next.note.fret });
    }
  }
  return out;
}
export function repairRelationships(track: Track, before: Relationship[]): number | null {
  const positions = notePositions(track), present = new Map(positions.map(p => [p.note, p]));
  let first: number | null = null;
  for (const {from, to, tie, fromFret, toFret} of before) {
    if (!present.has(from.note)) continue;
    const unchanged = from.note.fret === fromFret && to.note.fret === toFret;
    const valid = present.has(to.note) && from.note.string === to.note.string &&
      (tie ? unchanged || notePitch(track, from.note) === notePitch(track, to.note) : nextOnString(track, present.get(from.note)!, positions)?.note === to.note && (unchanged || !to.note.tie && from.note.fret !== to.note.fret));
    if (valid) continue;
    if (tie) delete from.note.tie;
    else if (from.note.fx) { delete from.note.fx.hammer; if (from.note.fx.slide === 1 || from.note.fx.slide === 2) delete from.note.fx.slide; tidyFx(from.note); }
    const bar = present.get(from.note)!.bar;
    first = Math.min(first ?? bar, bar);
  }
  return first;
}
/** Standard playable touch nodes. Imported nonstandard/fractional values stay untouched. */
export const NATURAL_NODES: Record<number, number> = { 2:2.4, 3:3.2, 4:4, 5:5, 7:7, 8:8.2, 9:9, 10:9.6, 12:12, 14:14.7, 15:14.7, 16:16, 17:17, 19:19, 21:21.7, 22:21.7, 24:24 };
export function bendCurve(amount: number, release = false): NonNullable<NoteEffects['bend']> {
  if (![1,2,4,6].includes(amount)) throw new Error('Bend amount must be quarter, half, whole or 1½ step.');
  return release ? [{offset:0,value:0},{offset:20,value:amount},{offset:40,value:amount},{offset:60,value:0}]
    : [{offset:0,value:0},{offset:30,value:amount},{offset:60,value:amount}];
}
