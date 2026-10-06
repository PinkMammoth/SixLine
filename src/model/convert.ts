// Track-type conversion. Pitches are preserved; guitar/bass targets get fresh string/fret fingering.
import { assignFingering } from './fingering';
import { DEFAULT_PROGRAMS, notePitch, STANDARD_TUNINGS, type Note, type Track, type TrackType } from './song';

/** Returns the converted track and the number of notes that could not be placed (dropped). */
export function convertTrack(src: Track, type: TrackType, tuning?: number[]): { track: Track; dropped: number } {
  const stringed = type === 'guitar' || type === 'bass';
  const track: Track = structuredClone(src);
  track.type = type;
  if ((src.type === 'drums') !== (type === 'drums')) track.program = DEFAULT_PROGRAMS[type];
  track.tuning = stringed ? [...(tuning ?? (src.type === type && src.tuning.length ? src.tuning : STANDARD_TUNINGS[type]))] : [];
  track.capo = stringed ? track.capo : 0;
  const pitchOf = (n: Note) => notePitch(src, n);
  const beats = track.measures.flatMap((m) => m.voices[0]);
  const srcBeats = src.measures.flatMap((m) => m.voices[0]);

  if (!stringed) {
    beats.forEach((b, i) => {
      b.notes = srcBeats[i].notes.map((n) => ({ pitch: pitchOf(n), velocity: n.velocity, ...(n.tie && type !== 'drums' ? { tie: true } : {}) }));
      if (type === 'drums') b.notes = b.notes.filter((_, j) => !srcBeats[i].notes[j].tie);
    });
    for (const m of track.measures) m.voices = m.voices.slice(0, 1);
    return { track, dropped: 0 };
  }

  // fingering over the sequence of struck (non-tied) notes
  const struck = srcBeats.map((b) => b.notes.filter((n) => !n.tie).map(pitchOf));
  const idx = struck.map((p, i) => (p.length ? i : -1)).filter((i) => i >= 0);
  const fing = assignFingering(idx.map((i) => ({ pitches: struck[i] })), { tuning: track.tuning, capo: track.capo });
  const byBeat = new Map(idx.map((bi, k) => [bi, fing[k]]));
  let dropped = 0;
  const lastPlace = new Map<number, { string: number; fret: number }>();
  beats.forEach((b, i) => {
    const out: Note[] = [];
    for (const n of srcBeats[i].notes) {
      const p = pitchOf(n);
      if (n.tie) {
        const pl = lastPlace.get(p);
        if (pl) out.push({ ...pl, velocity: n.velocity, tie: true });
        continue;
      }
      const pl = byBeat.get(i)?.placed.find((x) => x.pitch === p);
      if (!pl) {
        dropped++;
        continue;
      }
      lastPlace.set(p, { string: pl.string, fret: pl.fret });
      out.push({ string: pl.string, fret: pl.fret, velocity: n.velocity, ...(n.fx ? { fx: n.fx } : {}) });
    }
    b.notes = out.sort((x, y) => x.string! - y.string!);
  });
  for (const m of track.measures) m.voices = m.voices.slice(0, 1);
  return { track, dropped };
}
