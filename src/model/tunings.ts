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
};

/** Order of preference when a part goes below standard tuning. */
const GUITAR_ORDER = ['Guitar standard', 'Guitar drop D', 'Guitar drop C', '7-string standard', '7-string drop A', '8-string standard'];
const BASS_ORDER = ['Bass 4-string', 'Bass drop D', 'Bass 5-string'];

/** The most standard preset whose lowest string covers `lowestPitch` (falls back to the lowest-reaching one). */
export function tuningForRange(type: TrackType, lowestPitch: number): number[] {
  const order = type === 'bass' ? BASS_ORDER : GUITAR_ORDER;
  const name = order.find((n) => Math.min(...TUNING_PRESETS[n]) <= lowestPitch) ?? order[order.length - 1];
  return [...TUNING_PRESETS[name]];
}
