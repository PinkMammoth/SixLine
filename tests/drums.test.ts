import { describe, expect, it } from 'vitest';
import { Editor } from '../src/editor/editor';
import { createSong, type Beat } from '../src/model/song';
import { DRUM_KIT, DRUM_BY_SHORTCUT, drumName } from '../src/model/drums';
import { drumBarLayout, drumDuration } from '../src/ui/drumscore';
import { parseProject, serializeProject } from '../src/io/project';
import { generateMidi } from '../src/io/midiExport';
import * as at from '@coderline/alphatab';

const fresh = () => new Editor(createSong({ tracks: ['drums'], bars: 2 }));
const enter = (e: Editor, n: number) => { e.typeDrumDigit(Math.floor(n / 10), 0); e.typeDrumDigit(n % 10, 100); };

describe('MIDI number drum entry', () => {
  it('buffers the first digit without mutating the song or creating history', () => {
    const e = fresh(), before = structuredClone(e.song);
    e.typeDrumDigit(3, 0);
    expect(e.drumDigits).toBe('3');
    expect(e.song).toEqual(before);
    expect(e.canUndo).toBe(false);
    expect(e.dirty).toBe(false);
  });
  it('enters complete numbers as one undo action, retaining other chord notes', () => {
    const e = fresh();
    enter(e, 38); enter(e, 42); enter(e, 36);
    expect(e.beat.notes).toEqual([42, 38, 36].map(pitch => ({ pitch, velocity: 95 })));
    e.undo(); expect(e.beat.notes.map(n => n.pitch)).toEqual([42, 38]);
    e.undo(); expect(e.beat.notes.map(n => n.pitch)).toEqual([38]);
    e.undo(); expect(e.beat.notes).toEqual([]);
    expect(e.canUndo).toBe(false);
    e.redo(); expect(e.beat.notes).toEqual([{ pitch: 38, velocity: 95 }]);
  });
  it('toggles an existing instrument without disturbing its neighbours', () => {
    const e = fresh();
    enter(e, 38); enter(e, 42); enter(e, 38);
    expect(e.beat.notes.map(n => n.pitch)).toEqual([42]);
    e.undo(); expect(e.beat.notes.map(n => n.pitch)).toEqual([42, 38]);
  });
  it('rejects out-of-range numbers without editing or adding an undo entry', () => {
    for (const n of [0, 34, 82, 99]) {
      const e = fresh();
      expect(() => enter(e, n)).toThrow(/35 to 81/);
      expect(e.beat.notes).toEqual([]);
      expect(e.canUndo).toBe(false);
      expect(e.drumDigits).toBe('');
    }
  });
  it('expires incomplete entry and starts a new two-digit number', () => {
    const e = fresh();
    e.typeDrumDigit(3, 0); e.typeDrumDigit(4, 2000); e.typeDrumDigit(2, 2100);
    expect(e.beat.notes.map(n => n.pitch)).toEqual([42]);
  });
  it('refreshes pending input feedback when undo/redo has no musical history', () => {
    const e = fresh(); let feedback = '';
    e.onCursor(() => { feedback = e.drumDigits; });
    e.typeDrumDigit(3, 0); expect(feedback).toBe('3');
    e.undo(); expect(feedback).toBe('');
    e.typeDrumDigit(4, 0); e.redo(); expect(feedback).toBe('');
    expect(e.canUndo).toBe(false); expect(e.dirty).toBe(false);
  });
  it('clears partial entry on caret movement, track changes and history operations', () => {
    const e = fresh(); enter(e, 38);
    e.typeDrumDigit(4, 0); e.setCursor({ beat: 1 });
    expect(e.drumDigits).toBe('');
    e.typeDrumDigit(4, 0); e.undo(); expect(e.drumDigits).toBe('');
    e.typeDrumDigit(4, 0); e.redo(); expect(e.drumDigits).toBe('');
    e.typeDrumDigit(4, 0); e.addTrack('guitar'); expect(e.drumDigits).toBe('');
  });
  it('cancels partial entry when another musical edit occurs', () => {
    const e = fresh(); e.typeDrumDigit(3, 0); e.setDuration(8);
    expect(e.drumDigits).toBe('');
  });
  it('accepts every standard GM percussion key with a matching caret and Delete', () => {
    expect(new Set(DRUM_KIT.map(d => d.key))).toEqual(new Set(Array.from({ length: 47 }, (_, i) => i + 35)));
    for (let pitch = 35; pitch <= 81; pitch++) {
      const e = fresh(); enter(e, pitch);
      expect(e.rowPitch()).toBe(pitch);
      expect(e.noteAtCursor()?.pitch).toBe(pitch);
      e.deleteNote(); expect(e.beat.notes).toEqual([]);
      e.undo(); expect(e.noteAtCursor()?.pitch).toBe(pitch);
    }
  });
  it('retains letters and names for kick, snare, hats, crash and cowbell', () => {
    expect(DRUM_BY_SHORTCUT.get('h')?.key).toBe(42);
    expect(DRUM_BY_SHORTCUT.get('s')?.key).toBe(38);
    expect(DRUM_BY_SHORTCUT.get('k')?.key).toBe(36);
    expect(DRUM_BY_SHORTCUT.get('c')?.key).toBe(49);
    expect(drumName(56)).toBe('Cowbell');
    expect(drumName(57)).toBe('Crash 2');
    expect(drumName(47)).toBe('Low-mid tom');
  });
  it('does not enter MIDI drum numbers on guitar or keys tracks', () => {
    for (const type of ['guitar', 'keys'] as const) {
      const e = new Editor(createSong({ tracks: [type] })); enter(e, 38);
      expect(e.beat.notes).toEqual([]); expect(e.canUndo).toBe(false);
    }
  });
  it('persists numeric notes and exports their original pitches on channel 10', () => {
    const e = fresh(); for (const n of [35, 36, 38, 40, 42, 49, 56, 57, 81]) enter(e, n);
    const song = parseProject(serializeProject(e.song));
    expect(song).toEqual(e.song);
    const notes = generateMidi(song).tracks.flatMap(t => t.events).filter(ev => ev.type === at.midi.MidiEventType.NoteOn) as at.midi.NoteOnEvent[];
    expect(notes.filter(n => n.tick === 0).map(n => n.noteKey).sort((a,b) => a-b)).toEqual([35,36,38,40,42,49,56,57,81]);
    expect(notes.every(n => n.channel === 9)).toBe(true);
  });
});

describe('numbered drum score timing', () => {
  const beat = (duration: Beat['duration'], dots = 0): Beat => ({ duration, dots, notes: [] });
  it('aligns voices to common bar ticks with dotted and triplet durations', () => {
    const measure = { voices: [[beat(8, 1), { ...beat(8), tuplet: [3, 2] as [number,number] }, beat(4)], [beat(2), beat(2)]] };
    expect(drumBarLayout(measure, { num: 4, den: 4 })).toEqual([
      [{start:0,width:720,length:3840},{start:720,width:320,length:3840},{start:1040,width:960,length:3840}],
      [{start:0,width:1920,length:3840},{start:1920,width:1920,length:3840}],
    ]);
  });
  it('shows overfull bars without truncating their last beat', () => {
    const layout = drumBarLayout({ voices: [[beat(1), beat(4)]] }, { num: 4, den: 4 });
    expect(layout[0][1]).toEqual({ start: 3840, width: 960, length: 4800 });
  });
  it('uses readable duration labels for rests, dots, tuplets and grace notes', () => {
    expect(drumDuration(beat(8, 1))).toBe('1/8.');
    expect(drumDuration({ ...beat(16), tuplet: [3, 2], grace: 1 })).toBe('1/16 ×2/3 grace');
  });
});
