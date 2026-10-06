// Targeted fixes for alphaTab's MIDI generator (used by both playback and MIDI export).
// Each patch is small, guarded, and covered by tests/midi-export.test.ts.
import * as at from '@coderline/alphatab';

const proto = (at.midi.MidiFileGenerator as any).prototype;

// alphaTab 1.8: _generateNote returns right after tremolo picking, so a tremolo-picked note never gets
// its bend, vibrato or slide pitch curve. Generate the curve first, then the repeated notes.
if (proto && typeof proto._generateNote === 'function' && typeof proto._generateTremoloPicking === 'function' && !proto.__sixlineTremoloFx) {
  const generateNote = proto._generateNote;
  proto._generateNote = function (note: any, beatStart: number, beatDuration: number, tempoOnBeatStart: number, ...rest: any[]) {
    this.__sixlineTempo = tempoOnBeatStart;
    return generateNote.call(this, note, beatStart, beatDuration, tempoOnBeatStart, ...rest);
  };
  const tremolo = proto._generateTremoloPicking;
  proto._generateTremoloPicking = function (note: any, noteStart: number, noteDuration: any, noteKey: number, velocity: number, channel: number) {
    const tempo = this.__sixlineTempo ?? 120;
    const m = at.model;
    if (note.hasBend) this._generateBend(note, noteStart, noteDuration, noteKey, channel, tempo);
    else if (note.slideInType !== m.SlideInType.None || note.slideOutType !== m.SlideOutType.None) this._generateSlide(note, noteStart, noteDuration, noteKey, channel, tempo);
    else if (note.vibrato !== m.VibratoType.None) this._generateVibrato(note, noteStart, noteDuration, noteKey, channel);
    return tremolo.call(this, note, noteStart, noteDuration, noteKey, velocity, channel);
  };
  proto.__sixlineTremoloFx = true;
}
