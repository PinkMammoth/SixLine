import type { Song } from '../model/song';
import { barTicks, beatTicks } from '../model/rhythm';

export interface Position { bar: number; beat: number }
/** Inclusive endpoints, anchored on one track. Rows optionally restrict notes within the range. */
export interface Selection {
  track: number;
  anchor: Position;
  focus: Position;
  kind: 'beats' | 'measures';
  rows?: number[];
}
export const comparePosition = (a: Position, b: Position) => a.bar - b.bar || a.beat - b.beat;
export function selectionRange(song: Song, s: Selection) {
  const [a, b] = comparePosition(s.anchor, s.focus) <= 0 ? [s.anchor, s.focus] : [s.focus, s.anchor];
  return {
    start: { bar: a.bar, beat: s.kind === 'measures' ? 0 : a.beat },
    end: { bar: b.bar, beat: s.kind === 'measures' ? song.tracks[s.track].measures[b.bar].voices[0].length - 1 : b.beat },
  };
}
export function positionTick(song: Song, track: number, p: Position) {
  return song.masterBars.slice(0, p.bar).reduce((n, b) => n + barTicks(b), 0)
    + song.tracks[track].measures[p.bar].voices[0].slice(0, p.beat).reduce((n, b) => n + (b.grace ? 0 : beatTicks(b)), 0);
}
export function selectionTicks(song: Song, s: Selection) {
  const { start, end } = selectionRange(song, s);
  const endTick = s.kind === 'measures'
    ? song.masterBars.slice(0, end.bar + 1).reduce((n, b) => n + barTicks(b), 0)
    : positionTick(song, s.track, end) + (song.tracks[s.track].measures[end.bar].voices[0][end.beat].grace ? 0 : beatTicks(song.tracks[s.track].measures[end.bar].voices[0][end.beat]));
  return { startTick: positionTick(song, s.track, start), endTick };
}
