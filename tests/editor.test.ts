import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { createSong } from '../src/model/song';
import { barTicks, beatTicks, ticksToDurations, voiceTicks } from '../src/model/rhythm';

const fresh = () => new Editor(createSong({ bars: 2 }));

describe('rhythm', () => {
  it('computes beat ticks for plain, dotted and tuplet values', () => {
    expect(beatTicks({ duration: 4, dots: 0 })).toBe(960);
    expect(beatTicks({ duration: 8, dots: 1 })).toBe(720);
    expect(beatTicks({ duration: 4, dots: 2 })).toBe(1680);
    expect(beatTicks({ duration: 8, dots: 0, tuplet: [3, 2] })).toBe(320);
    expect(barTicks({ num: 4, den: 4 })).toBe(3840);
    expect(barTicks({ num: 7, den: 8 })).toBe(3360);
  });
  it('splits spans into rest durations', () => {
    expect(ticksToDurations(3840)).toEqual([1]);
    expect(ticksToDurations(3360)).toEqual([2, 4, 8]);
    expect(ticksToDurations(7)).toEqual([]);
  });
});

describe('editor note entry', () => {
  it('enters a fret on the cursor string', () => {
    const e = fresh();
    e.setCursor({ string: 5 });
    e.typeDigit(3, 0);
    expect(e.beat.notes).toEqual([{ string: 5, fret: 3, velocity: 95 }]);
  });

  it('combines quick consecutive digits into multi-digit frets as one undo step', () => {
    const e = fresh();
    e.typeDigit(1, 0);
    e.typeDigit(2, 200);
    expect(e.noteAtCursor()?.fret).toBe(12);
    e.undo();
    expect(e.beat.notes).toEqual([]);
  });

  it('does not combine slow digits or digits that exceed the fret range', () => {
    const e = fresh();
    e.typeDigit(1, 0);
    e.typeDigit(2, 5000);
    expect(e.noteAtCursor()?.fret).toBe(2);
    e.typeDigit(5, 6000);
    e.typeDigit(5, 6100); // 55 is not a fret -> replaces with 5
    expect(e.noteAtCursor()?.fret).toBe(5);
  });

  it('replaces an existing note on the same string and keeps chords sorted', () => {
    const e = fresh();
    e.setCursor({ string: 4 });
    e.setFret(2);
    e.setCursor({ string: 1 });
    e.setFret(3);
    e.setCursor({ string: 4 });
    e.setFret(7);
    expect(e.beat.notes.map((n) => [n.string, n.fret])).toEqual([[1, 3], [4, 7]]);
  });

  it('deletes notes and undo/redo restores them', () => {
    const e = fresh();
    e.setFret(5);
    e.deleteNote();
    expect(e.beat.notes).toHaveLength(0);
    e.undo();
    expect(e.noteAtCursor()?.fret).toBe(5);
    e.redo();
    expect(e.beat.notes).toHaveLength(0);
  });
});

describe('editor rhythm and structure', () => {
  it('right arrow appends beats until the bar is full, then advances, then appends a bar', () => {
    const e = fresh();
    e.setDuration(4);
    for (let i = 0; i < 3; i++) e.moveRight();
    expect(e.beats).toHaveLength(4);
    expect(voiceTicks(e.beats)).toBe(3840);
    e.moveRight();
    expect(e.cursor).toMatchObject({ bar: 1, beat: 0 });
    for (let i = 0; i < 4; i++) e.moveRight();
    expect(e.song.masterBars).toHaveLength(3);
    expect(e.song.tracks[0].measures).toHaveLength(3);
    expect(e.cursor.bar).toBe(2);
  });

  it('appended beats shrink to fit the remaining space', () => {
    const e = fresh();
    e.setDuration(2);
    e.setDuration(2);
    e.moveRight(); // half + half
    e.setDuration(4);
    expect(voiceTicks(e.beats)).toBe(2880);
    e.moveRight();
    expect(e.beat.duration).toBe(4);
    expect(e.barFull()).toBe(true);
  });

  it('changes durations, dots, triplets', () => {
    const e = fresh();
    e.setDuration(8);
    expect(e.beat.duration).toBe(8);
    e.stepDuration(1);
    expect(e.beat.duration).toBe(16);
    e.stepDuration(-1);
    e.toggleDot();
    expect(e.beat.dots).toBe(1);
    e.toggleTriplet();
    expect(e.beat.tuplet).toEqual([3, 2]);
  });

  it('inserts and deletes beats, keeping at least one beat per bar', () => {
    const e = fresh();
    e.setFret(1);
    e.insertBeat();
    expect(e.beats).toHaveLength(2);
    expect(e.beats[0].notes).toHaveLength(0);
    expect(e.beats[1].notes[0].fret).toBe(1);
    e.deleteBeat();
    e.deleteBeat();
    expect(e.beats).toHaveLength(1);
    expect(e.beats[0].notes).toHaveLength(0);
  });

  it('inserts and deletes bars across all tracks with undo', () => {
    const e = new Editor(createSong({ bars: 2, tracks: ['guitar', 'bass'] }));
    e.insertBars(1, 2);
    expect(e.song.masterBars).toHaveLength(4);
    expect(e.song.tracks.every((t) => t.measures.length === 4)).toBe(true);
    e.deleteBar(0);
    expect(e.song.masterBars).toHaveLength(3);
    e.undo();
    e.undo();
    expect(e.song.masterBars).toHaveLength(2);
    expect(e.song.tracks[1].measures).toHaveLength(2);
  });

  it('notifies listeners with the first changed bar', () => {
    const e = fresh();
    const changes: number[] = [];
    e.onChange((c) => changes.push(c.firstBar));
    e.setCursor({ bar: 1 });
    e.setFret(3);
    expect(changes).toEqual([1]);
  });
});

describe('tracks and song structure', () => {
  it('adds and removes tracks with matching bar counts and default tunings', () => {
    const e = new Editor(createSong({ bars: 3 }));
    e.addTrack('bass');
    e.addTrack('drums');
    e.addTrack('guitar');
    expect(e.song.tracks.map((t) => t.name)).toEqual(['Guitar', 'Bass', 'Drums', 'Guitar 2']);
    expect(e.song.tracks[1].tuning).toEqual([43, 38, 33, 28]);
    expect(e.song.tracks[2].tuning).toEqual([]);
    expect(e.song.tracks.every((t) => t.measures.length === 3)).toBe(true);
    expect(e.cursor.track).toBe(3);
    e.removeTrack(0);
    expect(e.song.tracks.map((t) => t.name)).toEqual(['Bass', 'Drums', 'Guitar 2']);
    e.undo();
    expect(e.song.tracks).toHaveLength(4);
  });

  it('changing tuning to fewer strings drops notes on removed strings', () => {
    const e = new Editor(createSong());
    e.setCursor({ string: 5 });
    e.setFret(3);
    e.setCursor({ string: 0 });
    e.setFret(1);
    e.setTrackProps(0, { tuning: [43, 38, 33, 28] });
    expect(e.song.tracks[0].measures[0].voices[0][0].notes).toEqual([{ string: 0, fret: 1, velocity: 95 }]);
  });

  it('sets time signatures over the following run of equal bars', () => {
    const e = new Editor(createSong({ bars: 4 }));
    e.setTimeSignature(3, 4, 2);
    e.setTimeSignature(7, 8, 0);
    expect(e.song.masterBars.map((m) => `${m.num}/${m.den}`)).toEqual(['7/8', '7/8', '3/4', '3/4']);
  });
});
