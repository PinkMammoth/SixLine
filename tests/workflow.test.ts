import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import * as at from '@coderline/alphatab';
import { selectionRange, selectionTicks } from '../src/editor/selection';
import { createSong, type Beat, type TrackType } from '../src/model/song';
import { voiceTicks } from '../src/model/rhythm';
import { parseProject, serializeProject } from '../src/io/project';
import { songToScore, scoreToSong } from '../src/io/alphatab';
import { exportMidi } from '../src/io/midiExport';
import { PracticeState, countInPlan, tempoAtBar, clampLoopTick } from '../src/playback/practice';
import { clickPlan, elapsedMs, type ClickBar } from '../src/playback/metronome';

function riff(type: TrackType = 'guitar', bars = 4) {
  const s = createSong({ bars, tracks: [type, type] });
  s.tracks[0].measures.forEach((m, bar) => {
    m.voices[0] = Array.from({ length: 4 }, (_, beat): Beat => ({ duration: 4, dots: 0, notes: type === 'guitar' || type === 'bass'
      ? [{ string: 0, fret: bar + beat, velocity: 73, fx: { palmMute: true, bend: [{ offset: 0, value: 0 }, { offset: 60, value: 2 }] } }, { string: 1, fret: 5, velocity: 111 }]
      : [{ pitch: type === 'drums' ? 38 : 60 + bar + beat, velocity: 73, fx: { accent: true } }] }));
  });
  return new Editor(s);
}

describe('musical selection', () => {
  it('extends across bars in either direction without editing or adding beats', () => {
    const e = riff(); const before = structuredClone(e.song);
    e.setCursor({ bar: 1, beat: 0 }); e.extendSelection(-1); e.extendSelection(-1);
    expect(selectionRange(e.song, e.selection!)).toEqual({ start: { bar: 0, beat: 2 }, end: { bar: 1, beat: 0 } });
    expect(selectionTicks(e.song, e.selection!)).toEqual({ startTick: 1920, endTick: 4800 });
    expect(e.song).toEqual(before); expect(e.canUndo).toBe(false);
  });
  it('extends full measures and includes the implicit silence at the end', () => {
    const e = new Editor(createSong()); e.extendSelection(2, true);
    expect(selectionTicks(e.song, e.selection!)).toEqual({ startTick: 0, endTick: 11520 });
    expect(e.song.masterBars).toHaveLength(4);
  });
  it('clamps at both song boundaries', () => {
    const e = riff(); e.extendSelection(-1);
    expect(e.cursor).toMatchObject({ bar: 0, beat: 0 });
    e.setCursor({ bar: 3, beat: 3 }); e.extendSelection(1);
    expect(e.cursor).toMatchObject({ bar: 3, beat: 3 });
  });
  it('retains the anchor when reversing and collapses toward arrow direction', () => {
    const e = riff(); e.extendSelection(1); e.extendSelection(1); e.extendSelection(-1);
    expect(e.selection!.anchor).toEqual({ bar: 0, beat: 0 });
    e.moveLeft(); expect(e.cursor.beat).toBe(0); expect(e.selection).toBeNull();
    e.extendSelection(2); e.moveRight(); expect(e.cursor.beat).toBe(2);
  });
  it('shift-click extends; ordinary caret changes and Escape-equivalent clear', () => {
    const e = riff(); e.setCursor({ bar: 2, beat: 2 }, true);
    expect(e.selection!.anchor).toEqual({ bar: 0, beat: 0 });
    e.clearSelection(); expect(e.cursor.bar).toBe(2); expect(e.selection).toBeNull();
    e.select(); e.setCursor({ track: 1 }); expect(e.selection).toBeNull();
  });
  it('selection changes emit only cursor events', () => {
    const e = riff(); let changes = 0; e.onChange(() => changes++);
    e.select(); e.extendSelection(2); e.selectMeasures(0, 3); e.clearSelection();
    expect(changes).toBe(0);
  });
  it('toggles several string/pitch rows inside a range without shrinking its endpoints', () => {
    const e = riff(); e.select('beats',[0]); e.extendSelection(2);
    const previous = structuredClone(e.selection); e.setCursor({beat:1}); e.toggleSelectionRow(1,previous);
    expect(e.selection!.rows).toEqual([0,1]); expect(e.selection!.focus).toEqual({bar:0,beat:2});
    e.toggleSelectionRow(0); expect(e.selection!.rows).toEqual([1]); e.toggleSelectionRow(1); expect(e.selection).toBeNull();
  });
});

describe('clipboard fidelity and atomic history', () => {
  for (const type of ['guitar', 'bass', 'keys', 'drums'] as TrackType[]) {
    it(`copies and pastes complete ${type} measures including all note data`, () => {
      const e = riff(type); e.selectMeasures(0, 1); const p = e.copy();
      e.setCursor({ track: 1, bar: 2, beat: 0 }); e.paste(p);
      expect(e.song.tracks[1].measures.slice(2)).toEqual(e.song.tracks[0].measures.slice(0, 2));
      e.undo(); expect(e.song.tracks[1].measures[2].voices[0][0].notes).toEqual([]);
      e.redo(); expect(e.song.tracks[1].measures[2]).toEqual(p.measures[0]);
      p.measures[0].voices[0][0].notes[0].velocity = 1;
      expect(e.song.tracks[1].measures[2].voices[0][0].notes[0].velocity).toBe(73);
    });
  }
  it('preserves rests, dotted duration, tuplets, articulations, valid ties and secondary voices', () => {
    const e = riff();
    e.song.tracks[0].measures[0].voices = [[
      { duration: 8, dots: 1, notes: [{ string: 0, fret: 5, velocity: 73, fx: { slide: 2, vibrato: true, ghost: true } }] },
      { duration: 8, dots: 1, notes: [{ string: 0, fret: 5, velocity: 73, tie: true }] },
      { duration: 8, dots: 0, tuplet: [3, 2], tremolo: 1, notes: [] },
    ], [{ duration: 2, dots: 0, notes: [{ string: 1, fret: 2, velocity: 57 }] }]];
    e.selectMeasures(0); const p = e.copy(); e.setCursor({ bar: 2, beat: 0 }); e.paste(p);
    expect(e.measure).toEqual(p.measures[0]);
    expect(e.measure.voices[0][1].notes[0].tie).toBe(true);
  });
  it('converts an external tie to an attack while preserving internal ties', () => {
    const e = riff(); e.song.tracks[0].measures[0].voices[0][1].notes[0].tie = true;
    e.setCursor({ beat: 1 }); const p = e.copy();
    expect(p.measures[0].voices[0][0].notes[0].tie).toBeUndefined();
  });
  it('cuts to rests without shifting any track, then restores all data and selection with one undo', () => {
    const e = riff(); e.selectMeasures(0, 2); const before = structuredClone(e.song);
    const selection = structuredClone(e.selection); const p = e.cut();
    expect(p.measures).toHaveLength(3);
    expect(e.song.tracks[0].measures.slice(0, 3).every(m => m.voices[0].every(b => !b.notes.length))).toBe(true);
    expect(e.song.tracks[1]).toEqual(before.tracks[1]);
    e.undo(); expect(e.song).toEqual(before); expect(e.selection).toEqual(selection);
    expect(e.canUndo).toBe(false); e.redo(); expect(e.song.tracks[0].measures[0].voices[0][0].notes).toEqual([]);
  });
  it('pastes at the exact beat and extends all tracks together', () => {
    const e = riff('guitar', 1); e.extendSelection(1); const p = e.copy();
    e.setCursor({ beat: 3 }); e.paste(p);
    expect(e.song.masterBars).toHaveLength(2); expect(e.song.tracks[1].measures).toHaveLength(2);
    expect(e.song.tracks[0].measures[0].voices[0][3]).toEqual(p.measures[0].voices[0][0]);
    expect(e.song.tracks[0].measures[1].voices[0][0]).toEqual(p.measures[0].voices[0][1]);
    expect(e.song.tracks[0].measures.map(m => voiceTicks(m.voices[0]))).toEqual([3840, 3840]);
    e.undo(); expect(e.song.masterBars).toHaveLength(1);
  });
  it('extends with the source meter for whole measures', () => {
    const e = riff('guitar', 1); e.song.masterBars[0] = { num: 3, den: 4 };
    e.song.tracks[0].measures[0].voices[0].pop(); e.selectMeasures(0); const p = e.copy();
    p.measures.push(structuredClone(p.measures[0])); p.bars.push({ num: 3, den: 4 });
    e.setCursor({ bar: 0, beat: 0 }); e.paste(p);
    expect(e.song.masterBars).toEqual([{ num: 3, den: 4 }, { num: 3, den: 4 }]);
  });
  it('copies implicit silence across partial bars', () => {
    const e = new Editor(createSong({ bars: 2 })); e.extendSelection(1);
    expect(e.copy().measures[0].voices[0].reduce((n,b) => n + (3840 / b.duration), 0)).toBe(3840);
  });
  it('rejects incompatible types or tunings without edits or history entries', () => {
    const e = riff(); const p = e.copy(); const before = structuredClone(e.song);
    p.type = 'drums'; expect(() => e.paste(p)).toThrow(/Cannot paste drums/);
    p.type = 'guitar'; p.tuning[0]--; expect(() => e.paste(p)).toThrow(/same tuning/);
    expect(e.song).toEqual(before); expect(e.canUndo).toBe(false);
  });
  it('rejects partial note splitting, bar-line splitting and meter mismatch atomically', () => {
    const e = riff(); const p = e.copy(); p.measures[0].voices[0][0].duration = 8;
    const before = structuredClone(e.song);
    expect(() => e.paste(p)).toThrow(/split an existing note/); expect(e.song).toEqual(before);
    p.measures[0].voices[0][0].duration = 2; e.setCursor({ beat: 3 });
    expect(() => e.paste(p)).toThrow(/crosses a bar line/); expect(e.song).toEqual(before);
    e.selectMeasures(0); const measure = e.copy(); measure.bars[0].num = 3; e.setCursor({ beat: 0 });
    expect(() => e.paste(measure)).toThrow(/matching time/); expect(e.song).toEqual(before);
  });
  it('pastes into longer rests without changing total measure length', () => {
    const e = riff(); const p = e.copy(); p.measures[0].voices[0][0].duration = 8;
    e.song.tracks[1].measures[0].voices[0] = [{ duration: 1, dots: 0, notes: [] }];
    e.setCursor({ track: 1 }); e.paste(p);
    expect(voiceTicks(e.beats)).toBe(3840); expect(e.beat.duration).toBe(8);
  });
  it('note-only copy/cut/paste preserves other chord members', () => {
    const e = riff(); e.select('beats', [0]); const p = e.cut();
    expect(e.beat.notes.map(n => n.string)).toEqual([1]); e.undo();
    e.setCursor({ beat: 1 }); e.paste(p);
    expect(e.beat.notes.find(n => n.string === 0)?.fret).toBe(0);
    expect(e.beat.notes.find(n => n.string === 1)?.fret).toBe(5);
  });
  it('pastes a primary-voice measure from a mid-bar caret without shifting its time', () => {
    const e = riff(); e.selectMeasures(0); const p = e.copy(); e.setCursor({bar:2,beat:2}); e.paste(p);
    expect(e.song.tracks[0].measures[2].voices[0].slice(2)).toEqual(p.measures[0].voices[0].slice(0,2));
    expect(e.song.tracks[0].measures[3].voices[0].slice(0,2)).toEqual(p.measures[0].voices[0].slice(2));
    expect(e.song.masterBars).toHaveLength(4);
  });
  it('pastes triplets into empty bars with exact rest padding', () => {
    const e = new Editor(createSong()); e.beat.duration = 8; e.beat.tuplet = [3,2];
    e.beat.notes = [{string:0,fret:5,velocity:77}]; const p = e.copy(); e.setCursor({bar:1}); e.paste(p);
    expect(e.beat).toEqual(p.measures[0].voices[0][0]); expect(voiceTicks(e.beats)).toBe(3840);
  });
  it('retains valid ties across sparse chords within the copied passage', () => {
    const e = riff(); e.beats[1].notes = [{string:1,fret:5,velocity:95}];
    e.beats[2].notes = [{string:0,fret:0,velocity:73,tie:true}]; e.selectMeasures(0);
    expect(e.copy().measures[0].voices[0][2].notes[0].tie).toBe(true);
  });
  it('cutting a tie origin detaches its surviving continuation and undo restores it', () => {
    const e = riff(); e.beats[1].notes[0].fret = 0; e.beats[1].notes[0].tie = true;
    e.cut(); expect(e.beats[1].notes[0].tie).toBeUndefined(); e.undo(); expect(e.beats[1].notes[0].tie).toBe(true);
  });
  it('replacing a tie origin with a different pitch detaches the continuation', () => {
    const e = riff(); e.beats[1].notes[0].fret = 0; e.beats[1].notes[0].tie = true;
    const p = e.copy(); p.measures[0].voices[0][0].notes[0].fret = 9; e.paste(p);
    expect(e.beats[1].notes[0].tie).toBeUndefined();
  });
});

describe('duplicate', () => {
  it('duplicates selected measures immediately after themselves and restores structure with one undo', () => {
    const e = riff(); const before = structuredClone(e.song);
    e.selectMeasures(0, 3); e.duplicate();
    expect(e.song.masterBars).toHaveLength(8);
    expect(e.song.tracks[0].measures.slice(4)).toEqual(before.tracks[0].measures);
    expect(e.song.tracks[1].measures.slice(4).every(m => !m.voices[0][0].notes.length)).toBe(true);
    expect(e.selection!.anchor.bar).toBe(4);
    const after = structuredClone(e.song); e.undo(); expect(e.song).toEqual(before); expect(e.canUndo).toBe(false);
    e.redo(); expect(e.song).toEqual(after);
  });
  it('duplicates current measure with no selection, including secondary voices and meter', () => {
    const e = riff(); e.song.tracks[0].measures[0].voices.push([{ duration: 1, dots: 0, notes: [] }]);
    e.duplicate(); expect(e.song.tracks[0].measures[1]).toEqual(e.song.tracks[0].measures[0]);
    expect(e.song.masterBars).toHaveLength(5);
  });
  it('restores the source starting tempo when duplicating a section that changes tempo', () => {
    const e = riff(); e.song.masterBars[2].tempo = 140; e.selectMeasures(0,3); e.duplicate();
    expect(tempoAtBar(e.song,4)).toBe(120); expect(tempoAtBar(e.song,6)).toBe(140);
    e.undo(); expect(e.song.masterBars).toHaveLength(4);
  });
  it('inserts selected beats and shifts the following primary-voice music exactly', () => {
    const e = riff('guitar', 1); const before = structuredClone(e.song);
    e.extendSelection(1); e.duplicate();
    const frets = e.song.tracks[0].measures.flatMap(m => m.voices[0]).flatMap(b => b.notes.filter(n => n.string === 0).map(n => n.fret));
    expect(frets).toEqual([0, 1, 0, 1, 2, 3]);
    e.undo(); expect(e.song).toEqual(before); e.redo(); expect(e.song.masterBars).toHaveLength(2);
  });
  it('keeps a duplicated four-bar riff unchanged through edit, undo, redo, save and reopen', () => {
    const e = riff(); e.selectMeasures(0, 3); e.duplicate();
    const first = structuredClone(e.song.tracks[0].measures.slice(0, 4));
    e.setCursor({ bar: 4, beat: 1 }); e.setFret(19); e.undo(); e.redo();
    const loaded = parseProject(serializeProject(e.song));
    expect(loaded.tracks[0].measures.slice(0, 4)).toEqual(first);
    expect(loaded.tracks[0].measures[4].voices[0][1].notes[0].fret).toBe(19);
    expect(loaded.masterBars).toHaveLength(8);
  });
});

describe('markers and navigation', () => {
  it('persists markers in old-compatible projects and maps alphaTab/GP section data', () => {
    const e = riff(); e.setMarker('Intro', 0); e.setMarker('Verse', 1); e.setMarker('Chorus', 3);
    expect(parseProject(serializeProject(e.song))).toEqual(e.song);
    const score = songToScore(e.song, new at.Settings());
    expect(score.masterBars[3].section?.text).toBe('Chorus');
    expect(scoreToSong(score).masterBars.map(b => b.marker)).toEqual(['Intro','Verse',undefined,'Chorus']);
    expect(parseProject(serializeProject(createSong())).masterBars[0].marker).toBeUndefined();
  });
  it('renames, deletes and undoes markers without audio invalidation', () => {
    const e = riff(); const audio: (boolean | undefined)[] = []; e.onChange(c => audio.push(c.audio));
    e.setMarker(' Intro '); e.setMarker('Verse'); e.setMarker(''); e.undo();
    expect(e.song.masterBars[0].marker).toBe('Verse'); expect(audio).toEqual([false,false,false,false]);
  });
  it('markers follow insertions/deletions and navigation does not edit', () => {
    const e = riff(); e.setMarker('Chorus', 2); e.insertBars(1, 1);
    expect(e.song.masterBars[3].marker).toBe('Chorus'); e.deleteBar(0);
    expect(e.song.masterBars[2].marker).toBe('Chorus');
    e.goToMeasure(1); e.jumpMarker(1); expect(e.cursor.bar).toBe(2); e.jumpMarker(-1); expect(e.cursor.bar).toBe(2);
    e.goToMeasure(4); expect(e.cursor).toMatchObject({ bar: 3, beat: 0 });
    expect(() => e.goToMeasure(0)).toThrow(); expect(() => e.goToMeasure(1.5)).toThrow();
  });
});

describe('practice timing', () => {
  it('increases speed once per completed pass, caps at the target and resets on Stop', () => {
    const p = new PracticeState(), range = { startTick: 3840, endTick: 11520 };
    p.startProgressive({ firstBar: 2, lastBar: 3, startSpeed: 50, increment: 5, targetSpeed: 62 }, range);
    expect(p.speed).toBe(50);
    for (const speed of [55, 60, 62, 62]) { p.completePass(); expect(p.speed).toBe(speed); }
    expect(p.completedPasses).toBe(4);
    p.looping = false; p.completePass(); expect(p.completedPasses).toBe(4);
    p.resetProgress(); expect(p.speed).toBe(50); expect(p.completedPasses).toBe(0);
    p.clearLoop(); p.completePass(); expect(p.progressive).toBeNull(); expect(p.looping).toBe(false);
  });
  it('validates practice settings without changing an existing practice session', () => {
    const p = new PracticeState(), range = { startTick: 0, endTick: 3840 };
    const settings = { firstBar: 1, lastBar: 2, startSpeed: 50, increment: 5, targetSpeed: 100 };
    p.startProgressive(settings, range);
    const before = structuredClone(p);
    for (const invalid of [{ firstBar: 0 }, { lastBar: 0 }, { firstBar: 1.5 }, { startSpeed: 24 }, { targetSpeed: 201 }, { targetSpeed: 49 }, { increment: 0 }, { increment: NaN }]) {
      expect(() => p.startProgressive({ ...settings, ...invalid }, range)).toThrow();
      expect(p).toEqual(before);
    }
    expect(() => p.startProgressive(settings, { startTick: 0, endTick: NaN })).toThrow();
    expect(p).toEqual(before);
  });
  it('uses the increased speed for each count-in and supports fractional increases', () => {
    const p = new PracticeState();
    p.startProgressive({ firstBar: 1, lastBar: 1, startSpeed: 50, increment: 2.5, targetSpeed: 100 }, { startTick: 0, endTick: 3840 });
    const first = countInPlan(6, 8, 140, 2, p.speed);
    p.completePass();
    expect(p.speed).toBe(52.5);
    expect(countInPlan(6, 8, 140, 2, p.speed).durationMs).toBeCloseTo(first.durationMs * 50 / 52.5);
  });
  it('clamps audio-buffer overshoot to the exact musical loop boundary', () => {
    const range = { startTick: 3840, endTick: 7680 };
    expect(clampLoopTick(7689, range)).toBe(7680);
    expect(clampLoopTick(100, range)).toBe(3840);
    expect(clampLoopTick(5000, range)).toBe(5000);
    expect(clampLoopTick(7689, null)).toBe(7689);
  });
  it('keeps speed independent of the document and exported MIDI', () => {
    const e = riff(), before = structuredClone(e.song), midi = exportMidi(e.song), p = new PracticeState();
    for (const n of [50,60,70,80,90,100,110,120,77]) { p.setSpeed(n); expect(p.speed).toBe(n); }
    expect(() => p.setSpeed(NaN)).toThrow(); expect(() => p.setSpeed(0)).toThrow();
    p.metronome = true; p.countIn = 2; expect(e.song).toEqual(before); expect(exportMidi(e.song)).toEqual(midi);
    p.startProgressive({ firstBar: 1, lastBar: 2, startSpeed: 50, increment: 5, targetSpeed: 100 }, { startTick: 0, endTick: 7680 });
    p.completePass(); p.completePass();
    expect(e.song).toEqual(before); expect(exportMidi(e.song)).toEqual(midi);
  });
  it('shares exact exclusive loop boundaries across selection and A-B state', () => {
    const p = new PracticeState(); p.setLoop({ startTick: 3840, endTick: 11520 }, 'selection');
    expect(p.loop).toEqual({ startTick: 3840, endTick: 11520 }); p.a = 960; p.b = 2880; p.enableAB();
    expect(p.loopSource).toBe('ab'); expect(p.looping).toBe(true);
    p.b = 1; expect(() => p.enableAB()).toThrow(); p.clearLoop(); expect(p.looping).toBe(false); expect(p.a).toBeNull();
  });
  it('uses the tempo at bar 57 and the current meter for count-in', () => {
    const song = createSong({ bars: 60 }); song.masterBars[30].tempo = 140; song.masterBars[56] = { num: 3, den: 4 };
    const plan = countInPlan(3,4,tempoAtBar(song,56),1);
    expect(plan.clicks).toHaveLength(3); expect(plan.durationMs).toBeCloseTo(3 * 60000 / 140);
    expect(plan.clicks.map(c => c.accent)).toEqual([true,false,false]);
  });
  it('supports off and two-bar count-in at reduced speed and eighth-note meters', () => {
    expect(countInPlan(4,4,120,0).durationMs).toBe(0);
    const plan = countInPlan(6,8,120,2,50);
    expect(plan.durationMs).toBe(6000); expect(plan.clicks).toHaveLength(12);
    expect(plan.clicks.filter(c => c.accent).map(c => c.timeMs)).toEqual([0,3000]);
  });
  const bars: ClickBar[] = [
    { start: 0, end: 3840, num: 4, den: 4, tempos: [{tick:0,tempo:120}] },
    { start: 3840, end: 5280, num: 3, den: 8, tempos: [{tick:3840,tempo:140}] },
  ];
  it('accents the first beat at an arbitrary bar, including a meter change', () => {
    expect(clickPlan(bars, 3840, 70, 1000).map(c => [c.tick,c.accent])).toEqual([[3840,true],[4320,false],[4800,false]]);
    expect(elapsedMs(bars,3840,4320,70)).toBeCloseTo(60000/140/2/0.7);
    expect(clickPlan(bars,3841,70)[0]).toMatchObject({tick:3840,accent:true,delayMs:0});
  });
  it('schedules across exact loop edges and never includes the exclusive end', () => {
    const clicks = clickPlan(bars, 4750, 100, 1000, {startTick:3840,endTick:4800});
    expect(clicks.map(c => [c.tick,c.cycle])).toEqual([[3840,1],[4320,1]]);
    expect(clicks[0].delayMs).toBeCloseTo(50/960 * 60000/140);
    expect(clicks.some(c => c.tick === 4800)).toBe(false);
  });
  it('integrates tempo changes within the playback timeline', () => {
    expect(elapsedMs([{...bars[0],tempos:[{tick:0,tempo:120},{tick:1920,tempo:60}]}],0,3840,100)).toBe(3000);
  });
  it('does not schedule clicks beyond a progressive pass or into its next count-in', () => {
    expect(clickPlan(bars, 4750, 50, 1000, { startTick: 3840, endTick: 4800 }, false)).toEqual([]);
    expect(clickPlan(bars, 4320, 55, 1000, { startTick: 3840, endTick: 4800 }, false).map(c => [c.tick, c.cycle])).toEqual([[4320, 0]]);
  });
});
