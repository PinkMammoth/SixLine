import { describe, expect, it } from 'vitest';
import * as at from '@coderline/alphatab';
import { parseMidi } from 'midi-file';
import { Editor } from '../src/editor/editor';
import { createSong, isStringed, notePitch, type TrackType } from '../src/model/song';
import { stringCounts, resizeTuning, TUNING_PRESETS } from '../src/model/tunings';
import { parsePitch, parseTuning, formatTuning } from '../src/ui/dialogs';
import { serializeProject, parseProject } from '../src/io/project';
import { songToScore, scoreToSong } from '../src/io/alphatab';
import { exportMidi } from '../src/io/midiExport';

const midiPitches = (e: Editor) => parseMidi(exportMidi(e.song)).tracks.flat().filter(e => e.type === 'noteOn').map(e => e.noteNumber).sort((a, b) => a - b);
const cases: [TrackType, number][] = [
  ...[6, 7, 8].map(n => ['guitar', n] as [TrackType, number]),
  ...[4, 5, 6].map(n => ['bass', n] as [TrackType, number]),
  ...Array.from({ length: 8 }, (_, i) => ['keys', i + 1] as [TrackType, number]),
];

describe('custom open-string notes', () => {
  it('accepts enharmonic spellings and the full MIDI range, rejecting out-of-range notes', () => {
    expect(parsePitch('C-1')).toBe(0); expect(parsePitch('G9')).toBe(127);
    expect(parsePitch('Bb2')).toBe(46); expect(parsePitch('B#3')).toBe(60);
    expect(parsePitch('Cb4')).toBe(59);
    for (const text of ['Cb-1', 'G#9', 'C10', 'C-2', 'H4', '64', 'C']) expect(parsePitch(text)).toBeNull();
    const tuning = [0, 127, 60, 60, 12, 90, 48, 43];
    expect(parseTuning(formatTuning(tuning))).toEqual(tuning);
    expect(parseTuning('C4 C4 C4 C4 C4 C4 C4 C4 C4')).toBeNull();
  });
  it('offers the requested counts and seeds extended bass/guitar strings without changing existing choices', () => {
    expect(stringCounts('guitar')).toEqual([6, 7, 8]);
    expect(stringCounts('bass')).toEqual([4, 5, 6]);
    expect(stringCounts('keys')).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(resizeTuning('guitar', [61, 48, 55, 55, 43, 40], 8)).toEqual([61, 48, 55, 55, 43, 40, 35, 30]);
    expect(resizeTuning('bass', [43, 38, 33, 28], 6)).toEqual([43, 38, 33, 28, 23, 18]);
    expect(TUNING_PRESETS['Bass 6-string']).toEqual([48, 43, 38, 33, 28, 23]);
  });
  it.each(cases)('edits, renders, stores and exports a custom %s track with %i strings', (type, count) => {
    const e = new Editor(createSong({ tracks: [type], bars: 2 }));
    // Repeated notes and pitches in a non-descending order are intentional.
    const tuning = [60, 43, 64, 64, 55, 36, 72, 48].slice(0, count);
    e.configureTrack(0, type, { tuning, ...(type === 'keys' ? { program: 81 } : {}) });
    expect(isStringed(e.track)).toBe(true); expect(e.rowCount).toBe(count);
    for (let string = 0; string < count; string++) { e.setCursor({ string }); e.setFret(string % 3); }
    const expected = tuning.map((pitch, string) => pitch + string % 3).sort((a, b) => a - b);
    const score = songToScore(e.song, new at.Settings());
    expect(score.tracks[0].staves[0].tuning).toEqual(tuning);
    expect(score.tracks[0].staves[0].showTablature).toBe(true);
    expect(score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.map(n => n.realValue).sort((a, b) => a - b)).toEqual(expected);
    expect(midiPitches(e)).toEqual(expected);
    expect(parseProject(serializeProject(e.song))).toEqual(e.song);
    const back = scoreToSong(score).tracks[0];
    expect(back.type).toBe(type); expect(back.tuning).toEqual(tuning);
    expect(back.measures[0].voices[0][0].notes.map(n => notePitch(back, n)).sort((a, b) => a - b)).toEqual(expected);
    e.setCursor({ bar: 0 }); e.selectMeasures(0); const passage = e.copy();
    e.setCursor({ bar: 1, beat: 0 }); e.paste(passage);
    expect(e.track.measures[1]).toEqual(e.track.measures[0]);
    e.undo(); expect(e.track.measures[1].voices[0][0].notes).toEqual([]);
    e.redo(); expect(e.track.measures[1]).toEqual(e.track.measures[0]);
  });
  it('keeps frets and effects when retuning, and restores the complete previous track with one undo', () => {
    const e = new Editor(createSong()); e.setCursor({ string: 4 }); e.setFret(3); e.setTechnique('palmMute');
    const original = structuredClone(e.track), tuning = [65, 62, 59, 56, 53, 50, 47, 44];
    e.configureTrack(0, 'guitar', { name: 'Custom eight', tuning, capo: 2 });
    expect(e.noteAtCursor()).toEqual(original.measures[0].voices[0][0].notes[0]);
    expect(notePitch(e.track, e.noteAtCursor()!)).toBe(58);
    e.undo(); expect(e.track).toEqual(original);
    e.redo(); expect(e.track.tuning).toEqual(tuning);
  });
  it('removes only notes on deleted strings across voices, clamps the caret and restores them with undo', () => {
    const e = new Editor(createSong()); e.setTrackProps(0, { tuning: resizeTuning('guitar', e.track.tuning, 8) });
    e.setCursor({ string: 7 }); e.setFret(3);
    e.track.measures[0].voices.push([{ duration: 1, dots: 0, notes: [{ string: 6, fret: 1, velocity: 70 }, { string: 0, fret: 0, velocity: 80 }] }]);
    const before = structuredClone(e.track);
    expect(e.configureTrack(0, 'guitar', { tuning: e.track.tuning.slice(0, 6) })).toBe(2);
    expect(e.cursor.string).toBe(5);
    expect(e.track.measures[0].voices[1][0].notes).toEqual([{ string: 0, fret: 0, velocity: 80 }]);
    e.undo(); expect(e.track).toEqual(before); expect(e.cursor.string).toBe(7);
  });
  it('converts synth notation to tab and back with pitches, ties and every voice intact', () => {
    const e = new Editor(createSong({ tracks: ['keys'], bars: 1 })); e.track.program = 81;
    e.track.measures[0].voices = [
      [{ duration: 2, dots: 0, notes: [{ pitch: 60, velocity: 95 }] }, { duration: 2, dots: 0, notes: [{ pitch: 60, velocity: 95, tie: true }] }],
      [{ duration: 1, dots: 0, notes: [{ pitch: 67, velocity: 80 }] }],
    ];
    const original = structuredClone(e.song), pitches = midiPitches(e);
    expect(e.configureTrack(0, 'keys', { tuning: [60, 67] })).toBe(0);
    expect(e.cursor.string).toBe(0); expect(e.track.program).toBe(81);
    expect(e.track.measures[0].voices).toHaveLength(2); expect(e.track.measures[0].voices[0][1].notes[0].tie).toBe(true);
    expect(midiPitches(e)).toEqual(pitches);
    e.configureTrack(0, 'keys', { tuning: [] });
    expect(isStringed(e.track)).toBe(false); expect(e.rowPitch()).toBe(60);
    expect(e.song).toEqual(original); expect(midiPitches(e)).toEqual(pitches);
    e.undo(); expect(e.track.tuning).toEqual([60, 67]);
    e.undo(); expect(e.song).toEqual(original);
  });
  it('reports unplayable synth pitches and undoes the whole properties change at once', () => {
    const e = new Editor(createSong({ tracks: ['keys'], bars: 1 })); e.togglePitch(30); e.togglePitch(64);
    const before = structuredClone(e.song);
    expect(e.configureTrack(0, 'keys', { tuning: [60], name: 'One string', program: 81 })).toBe(1);
    expect(e.beat.notes).toEqual([{ string: 0, fret: 4, velocity: 95 }]);
    e.undo(); expect(e.song).toEqual(before);
  });
  it('keeps repeated-pitch chords and ties on separate synth strings when converting notation', () => {
    const e = new Editor(createSong({ tracks: ['keys'], bars: 1 }));
    e.track.measures[0].voices[0] = [false, true].map(tie => ({ duration: 2, dots: 0, notes: [80, 95].map(velocity => ({ pitch: 60, velocity, ...(tie ? { tie: true } : {}) })) }));
    expect(e.configureTrack(0, 'keys', { tuning: [60, 60] })).toBe(0);
    expect(e.track.measures[0].voices[0][0].notes.map(n => n.string)).toEqual([0, 1]);
    expect(e.track.measures[0].voices[0][1].notes.map(n => [n.string, n.tie])).toEqual([[0, true], [1, true]]);
    e.configureTrack(0, 'keys', { tuning: [] });
    expect(e.track.measures[0].voices[0].map(b => b.notes.map(n => n.pitch))).toEqual([[60, 60], [60, 60]]);
  });
  it('allows synth chords to span all available frets without guitar hand-span limits', () => {
    const e = new Editor(createSong({ tracks: ['keys'], bars: 1 })); e.togglePitch(61); e.togglePitch(80);
    expect(e.configureTrack(0, 'keys', { tuning: [60, 60] })).toBe(0);
    expect(e.beat.notes.map(n => notePitch(e.track, n)).sort()).toEqual([61, 80]);
  });
  it('rejects incompatible synth clipboard modes and custom open notes without partial changes', () => {
    const e = new Editor(createSong({ tracks: ['keys'], bars: 1 })); e.togglePitch(64); const notation = e.copy();
    e.configureTrack(0, 'keys', { tuning: [60] }); const tab = e.copy();
    expect(() => e.paste(notation)).toThrow(/same tuning/);
    e.configureTrack(0, 'keys', { tuning: [] }); expect(() => e.paste(tab)).toThrow(/same tuning/);
    const before = structuredClone(e.song), undo = e.lastUndoLabel;
    for (const tuning of [[-1], [128], [60.5], Array(9).fill(60)]) expect(() => e.configureTrack(0, 'keys', { tuning })).toThrow(/Open-string/);
    expect(e.song).toEqual(before); expect(e.lastUndoLabel).toBe(undo);
  });
  it('plays both MIDI endpoints and rejects frets/retunings that move notes out of range atomically', () => {
    const e = new Editor(createSong({ tracks: ['keys'], bars: 1 })); e.configureTrack(0, 'keys', { tuning: [0, 127], program: 81 });
    e.setFret(0); e.setCursor({ string: 1 }); e.setFret(0);
    expect(midiPitches(e)).toEqual([0, 127]);
    const before = structuredClone(e.song);
    expect(() => e.setFret(1)).toThrow(/highest MIDI/);
    expect(() => e.configureTrack(0, 'keys', { capo: 1 })).toThrow(/MIDI range/);
    expect(e.song).toEqual(before);
  });
});
