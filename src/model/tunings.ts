// Tuning presets (index 0 = highest string), shared by the track dialog and MIDI import.
import { STANDARD_TUNINGS, type TrackType } from './song';

export const TUNING_PRESETS: Record<string, number[]> = {
  'Guitar standard': STANDARD_TUNINGS.guitar,
  'Guitar drop D': [64, 59, 55, 50, 45, 38],
  'Guitar D standard': [62, 57, 53, 48, 43, 38],
  'Guitar drop C': [62, 57, 53, 48, 43, 36],
  '7-string standard': [64, 59, 55, 50, 45, 40, 35],
  '7-string drop A': [64, 59, 55, 50, 45, 40, 33],
  '8-string standard': [64, 59, 55, 50, 45, 40, 35, 30],
  'Bass 4-string': STANDARD_TUNINGS.bass,
  'Bass drop D': [43, 38, 33, 26],
  'Bass 5-string': [43, 38, 33, 28, 23],
  'Bass 6-string': [48, 43, 38, 33, 28, 23],
};

/** Synths can also use their existing notation-only mode (zero strings). */
export function stringCounts(type: TrackType): number[] {
  return type === 'guitar' ? [6, 7, 8] : type === 'bass' ? [4, 5, 6] : type === 'keys' ? [0, 1, 2, 3, 4, 5, 6, 7, 8] : [0];
}

export function presetsFor(type: TrackType): string[] {
  return Object.keys(TUNING_PRESETS).filter(name => type === 'keys' || (type === 'bass' ? name.startsWith('Bass') : type === 'guitar' && !name.startsWith('Bass')));
}

/** Keep existing string choices; start from a standard, extending existing tunings in fourths. */
export function resizeTuning(type: TrackType, tuning: number[], count: number): number[] {
  const standard = type === 'bass' ? TUNING_PRESETS[`Bass ${count}-string`] : TUNING_PRESETS[count === 7 || count === 8 ? `${count}-string standard` : 'Guitar standard'];
  const out = tuning.slice(0, count);
  while (out.length < count) out.push(tuning.length ? Math.max(0, out[out.length - 1] - 5) : standard?.[out.length] ?? 60);
  return out;
}

export function validateTuning(type: TrackType, tuning: number[]) {
  if (!Array.isArray(tuning) || tuning.length > 8 || (type === 'drums' ? tuning.length !== 0 : type !== 'keys' && tuning.length === 0) || tuning.some(p => !Number.isInteger(p) || p < 0 || p > 127))
    throw new Error('Open-string notes must be whole MIDI pitches from 0 to 127, with at most 8 strings.');
}

/** Order of preference when a part goes below standard tuning. */
const GUITAR_ORDER = ['Guitar standard', 'Guitar drop D', 'Guitar drop C', '7-string standard', '7-string drop A', '8-string standard'];
const BASS_ORDER = ['Bass 4-string', 'Bass drop D', 'Bass 5-string'];

/** The most standard preset whose lowest string covers `lowestPitch` (falls back to the lowest-reaching one). */
export function tuningForRange(type: TrackType, lowestPitch: number): number[] {
  const order = type === 'bass' ? BASS_ORDER : GUITAR_ORDER;
  const name = order.find((n) => Math.min(...TUNING_PRESETS[n]) <= lowestPitch) ?? order[order.length - 1];
  return [...TUNING_PRESETS[name]];
}
