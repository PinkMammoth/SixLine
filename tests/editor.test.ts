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

describe('drum entry', () => {
  it('starts on the snare row and toggles kit pieces as plain GM notes', async () => {
    const { DRUM_KIT, DRUM_BY_SHORTCUT } = await import('../src/model/drums');
    const e = new Editor(createSong({ tracks: ['guitar', 'drums'] }));
    e.setCursor({ track: 1 });
    expect(DRUM_KIT[e.cursor.string].name).toBe('Snare');
    e.toggleAtCursor();
    e.togglePitch(DRUM_BY_SHORTCUT.get('k')!.key);
    e.togglePitch(DRUM_BY_SHORTCUT.get('h')!.key);
    expect(e.beat.notes.map((n) => n.pitch)).toEqual([42, 38, 36]);
    expect(DRUM_KIT[e.cursor.string].name).toBe('Closed hi-hat');
    e.togglePitch(38); // toggling again removes
    expect(e.beat.notes.map((n) => n.pitch)).toEqual([42, 36]);
    e.setCursor({ string: DRUM_KIT.findIndex((d) => d.key === 36) });
    e.deleteNote();
    expect(e.beat.notes.map((n) => n.pitch)).toEqual([42]);
    e.undo();
    e.undo();
    expect(e.beat.notes.map((n) => n.pitch)).toEqual([42, 38, 36]);
    expect(e.song.tracks[1].measures[0].voices[0][0].notes.every((n) => n.string === undefined && n.fret === undefined)).toBe(true);
  });

  it('digits do nothing on drum tracks', () => {
    const e = new Editor(createSong({ tracks: ['drums'] }));
    e.typeDigit(5, 0);
    expect(e.beat.notes).toEqual([]);
  });
});

describe('keys entry', () => {
  it('enters note names near the cursor pitch, transposes, deletes', () => {
    const e = new Editor(createSong({ tracks: ['guitar', 'keys'] }));
    e.setCursor({ track: 1 });
    expect(e.rowPitch()).toBe(60);
    e.typeNoteName('e'); // E4 = 64 (nearest to C4)
    e.typeNoteName('g'); // G4 = 67
    e.typeNoteName('b'); // B4 = 71 (nearest to G4)
    expect(e.beat.notes.map((n) => n.pitch)).toEqual([71, 67, 64]);
    e.transposeNote(-1); // B4 -> Bb4
    expect(e.rowPitch()).toBe(70);
    e.transposeNote(-3); // would collide with G4 -> no-op
    expect(e.beat.notes.map((n) => n.pitch)).toEqual([70, 67, 64]);
    e.transposeNote(12);
    expect(e.beat.notes.map((n) => n.pitch)).toEqual([82, 67, 64]);
    e.moveString(1); // cursor down one semitone (81) -> no note there
    e.deleteNote();
    expect(e.beat.notes).toHaveLength(3);
    e.setCursor({ string: 127 - 67 });
    e.deleteNote();
    expect(e.beat.notes.map((n) => n.pitch)).toEqual([82, 64]);
    e.setDuration(2);
    expect(e.beat.duration).toBe(2);
    e.undo();
    e.undo();
    expect(e.beat.notes.map((n) => n.pitch)).toEqual([82, 67, 64]);
  });
});

describe('default cursor rows', () => {
  it('uses snare for drums and middle C for keys on load and when adding tracks', () => {
    const e = new Editor(createSong({ tracks: ['guitar'] }));
    e.load(createSong({ tracks: ['drums'] }));
    expect(e.rowPitch()).toBe(38);
    e.addTrack('keys');
    expect(e.rowPitch()).toBe(60);
  });
});

describe('track type conversion', () => {
  it('keys -> guitar fingers every pitch; guitar -> keys -> bass keeps pitches; undo restores', () => {
    const e = new Editor(createSong({ tracks: ['keys'], bars: 2 }));
    e.songEdit('notes', (s) => {
      s.tracks[0].measures[0].voices[0] = [
        { duration: 4, dots: 0, notes: [{ pitch: 64, velocity: 95 }, { pitch: 55, velocity: 95 }] },
        { duration: 4, dots: 0, notes: [{ pitch: 67, velocity: 95 }] },
        { duration: 2, dots: 0, notes: [{ pitch: 67, velocity: 95, tie: true }] },
      ];
      s.tracks[0].measures[1].voices[0] = [{ duration: 1, dots: 0, notes: [{ pitch: 30, velocity: 95 }] }];
    });
    const dropped = e.setTrackType(0, 'guitar');
    const t = e.song.tracks[0];
    expect(dropped).toBe(1); // F#1 is below a guitar's range
    expect(t.type).toBe('guitar');
    const beats = t.measures[0].voices[0];
    expect(beats.map((b) => b.notes.map((n) => t.tuning[n.string!] + n.fret!).sort())).toEqual([[55, 64], [67], [67]]);
    expect(beats[2].notes[0]).toMatchObject({ tie: true, string: beats[1].notes[0].string, fret: beats[1].notes[0].fret });
    e.setTrackType(0, 'keys');
    expect(e.song.tracks[0].measures[0].voices[0].map((b) => b.notes.map((n) => n.pitch).sort())).toEqual([[55, 64], [67], [67]]);
    e.setTrackType(0, 'bass');
    expect(e.song.tracks[0].tuning).toEqual([43, 38, 33, 28]);
    e.undo();
    e.undo();
    e.undo();
    expect(e.song.tracks[0].type).toBe('keys');
    expect(e.song.tracks[0].measures[1].voices[0][0].notes[0].pitch).toBe(30);
  });
});

describe('new editor default row', () => {
  it('a new editor on a drum song starts on the snare row', () => {
    expect(new Editor(createSong({ tracks: ['drums'] })).rowPitch()).toBe(38);
  });
});
