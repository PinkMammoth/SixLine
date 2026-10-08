// Track-type / synth notation-tab conversion. Sounding pitches get fresh string/fret fingering.
import { assignFingering, positionsFor } from './fingering';
import { DEFAULT_PROGRAMS, MAX_FRET, notePitch, STANDARD_TUNINGS, type Note, type Track, type TrackType } from './song';

/** Returns the converted track and the number of notes that could not be placed (dropped). */
export function convertTrack(src: Track, type: TrackType, tuning?: number[], capo = src.capo): { track: Track; dropped: number } {
  const stringed = type === 'guitar' || type === 'bass' || type === 'keys' && !!tuning?.length;
  const track: Track = structuredClone(src);
  track.type = type;
  if ((src.type === 'drums') !== (type === 'drums')) track.program = DEFAULT_PROGRAMS[type];
  track.tuning = stringed ? [...(tuning ?? (src.type === type && src.tuning.length ? src.tuning : STANDARD_TUNINGS[type as 'guitar' | 'bass']))] : [];
  track.capo = stringed ? capo : 0;
  const pitchOf = (n: Note) => notePitch(src, n);
  if (!stringed) {
    track.measures.forEach((m, bar) => m.voices.forEach((v, voice) => v.forEach((b, beat) => {
      b.notes = src.measures[bar].voices[voice][beat].notes.filter(n => type !== 'drums' || !n.tie)
        .map(n => ({ pitch: pitchOf(n), velocity: n.velocity, ...(n.tie && type !== 'drums' ? { tie: true } : {}) }));
    })));
    return { track, dropped: 0 };
  }

  let dropped = 0;
  // Assign each voice independently, retaining imported secondary voices and their rhythm.
  const voiceCount = Math.max(1, ...src.measures.map(m => m.voices.length));
  for (let voice = 0; voice < voiceCount; voice++) {
    const beats = track.measures.flatMap(m => m.voices[voice] ?? []);
    const srcBeats = src.measures.flatMap(m => m.voices[voice] ?? []);
    const struck = srcBeats.map(b => b.notes.filter(n => !n.tie).map(pitchOf));
    const idx = struck.map((p, i) => p.length ? i : -1).filter(i => i >= 0);
    const fing = assignFingering(idx.map(i => ({ pitches: struck[i] })), {
      tuning: track.tuning, capo: track.capo, maxFret: MAX_FRET,
      // Synth rows have no physical hand-span restriction.
      weights: type === 'keys' ? { maxSpan: MAX_FRET } : undefined,
    });
    const byBeat = new Map(idx.map((bi, k) => [bi, fing[k]]));
    const lastPlace = new Map<number, { string: number; fret: number }[]>();
    beats.forEach((b, i) => {
      const out: Note[] = [], replaced = new Set<number>();
      const available = (pl: { string: number }) => !out.some(n => n.string === pl.string);
      for (const n of srcBeats[i].notes) {
        const p = pitchOf(n);
        if (n.tie) {
          const pl = lastPlace.get(p)?.find(available);
          if (pl) out.push({ ...pl, velocity: n.velocity, tie: true });
          else dropped++;
          continue;
        }
        const placed = byBeat.get(i)?.placed;
        // The phrase fingerer deduplicates pitches. Keep playable unisons on separate strings.
        const pl = placed?.find(x => x.pitch === p && available(x)) ?? (placed?.some(x => x.pitch === p)
          ? positionsFor(p, track.tuning, MAX_FRET, track.capo).filter(available).sort((a, b) => a.fret - b.fret)[0] : undefined);
        if (!pl) { dropped++; continue; }
        if (!replaced.has(p)) { lastPlace.set(p, []); replaced.add(p); }
        lastPlace.get(p)!.push({ string: pl.string, fret: pl.fret });
        out.push({ string: pl.string, fret: pl.fret, velocity: n.velocity, ...(n.fx ? { fx: n.fx } : {}) });
      }
      b.notes = out.sort((x, y) => x.string! - y.string!);
    });
  }
  return { track, dropped };
}
