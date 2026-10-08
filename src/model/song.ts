// Canonical, renderer-independent document model. Plain JSON-serialisable data.

export type TrackType = 'guitar' | 'bass' | 'keys' | 'drums';

/** Note value: 1 = whole, 2 = half, 4 = quarter ... 64 = sixty-fourth. */
export type Duration = 1 | 2 | 4 | 8 | 16 | 32 | 64;

export interface Song {
  title: string;
  artist: string;
  /** Initial tempo in BPM. */
  tempo: number;
  /** Shared bar structure (time signature, tempo changes, repeats). */
  masterBars: MasterBar[];
  tracks: Track[];
}

export interface MasterBar {
  num: number;
  den: number;
  /** Tempo change (BPM) at the start of this bar. */
  tempo?: number;
  repeatStart?: boolean;
  /** Number of plays when this bar closes a repeat (>= 2). */
  repeatCount?: number;
  /** Bitflag of alternate ending numbers (bit 0 = 1st ending). */
  altEndings?: number;
  /** Rehearsal label at this measure boundary. */
  marker?: string;
}

export interface Track {
  name: string;
  type: TrackType;
  /** GM program 0-127 (ignored for drums). */
  program: number;
  /** MIDI note per open string, index 0 = top tab line. Empty for notation-only keys/drums. */
  tuning: number[];
  capo: number;
  /** 0-16, as Guitar Pro. */
  volume: number;
  /** 0-16, 8 = centre. */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** One per master bar. */
  measures: Measure[];
}

export interface Measure {
  /** voices[0] is the primary (editable) voice. A beat with no notes is a rest. */
  voices: Beat[][];
}

export interface Beat {
  duration: Duration;
  dots: number;
  /** e.g. [3, 2] = triplet. */
  tuplet?: [number, number];
  /** Grace beat: 1 = on beat, 2 = before beat (alphaTab GraceType). */
  grace?: number;
  /** Tremolo picking: number of slashes (1 = eighths, 2 = sixteenths, 3 = thirty-seconds). */
  tremolo?: number;
  notes: Note[];
}

export interface Note {
  /** Stringed tracks: 0 = top tab line. */
  string?: number;
  fret?: number;
  /** Keys: MIDI pitch. Drums: GM percussion key. */
  pitch?: number;
  velocity: number;
  tie?: boolean;
  fx?: NoteEffects;
}

export interface NoteEffects {
  dead?: boolean;
  ghost?: boolean;
  palmMute?: boolean;
  letRing?: boolean;
  /** Origin of a hammer-on/pull-off to the next note on this string in the same voice. */
  hammer?: boolean;
  /** alphaTab SlideOutType: 1 shift, 2 legato, 3 out-up, 4 out-down, 5/6 pick slide. */
  slide?: number;
  /** alphaTab SlideInType: 1 from below, 2 from above. */
  slideIn?: number;
  /** true = normal/slight (compatible with existing projects). */
  vibrato?: boolean | 'wide';
  /** Harmonic node value is alphaTab's relative touch position, not a MIDI pitch. */
  harmonic?: { type: HarmonicType; value: number };
  accent?: boolean;
  staccato?: boolean;
  /** Bend points: offset 0-60, value in quarter tones. */
  bend?: { offset: number; value: number }[];
}

/** GP/alphaTab harmonic types; all imported variants are retained. */
export enum HarmonicType { Natural = 1, Artificial = 2, Pinch = 3, Tap = 4, Semi = 5, Feedback = 6 }
export const MAX_FRET = 30;

export const STANDARD_TUNINGS: Record<'guitar' | 'bass', number[]> = {
  guitar: [64, 59, 55, 50, 45, 40],
  bass: [43, 38, 33, 28],
};

export const DEFAULT_PROGRAMS: Record<TrackType, number> = {
  guitar: 29, // overdriven guitar
  bass: 33, // fingered bass
  keys: 0, // acoustic grand
  drums: 0,
};

export const isStringed = (t: Track) => t.type === 'guitar' || t.type === 'bass' || t.type === 'keys' && t.tuning.length > 0;

/** MIDI pitch of a note on a track (drum key for drums). */
export function notePitch(track: Track, note: Note): number {
  if (note.pitch !== undefined) return note.pitch;
  return track.tuning[note.string!] + track.capo + note.fret!;
}

export function createTrack(type: TrackType, barCount: number, name?: string): Track {
  return {
    name: name ?? { guitar: 'Guitar', bass: 'Bass', keys: 'Keys', drums: 'Drums' }[type],
    type,
    program: DEFAULT_PROGRAMS[type],
    tuning: type === 'guitar' || type === 'bass' ? [...STANDARD_TUNINGS[type]] : [],
    capo: 0,
    volume: 13,
    pan: 8,
    mute: false,
    solo: false,
    measures: Array.from({ length: barCount }, () => emptyMeasure()),
  };
}

export function emptyMeasure(): Measure {
  return { voices: [[{ duration: 4, dots: 0, notes: [] }]] };
}

export function createSong(opts: { tempo?: number; num?: number; den?: number; bars?: number; tracks?: TrackType[]; title?: string } = {}): Song {
  const bars = opts.bars ?? 4;
  return {
    title: opts.title ?? 'Untitled',
    artist: '',
    tempo: opts.tempo ?? 120,
    masterBars: Array.from({ length: bars }, () => ({ num: opts.num ?? 4, den: opts.den ?? 4 })),
    tracks: (opts.tracks ?? ['guitar']).map((t) => createTrack(t, bars)),
  };
}
