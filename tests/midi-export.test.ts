import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import { parseMidi } from 'midi-file';
import { exportMidi, generateMidi } from '../src/io/midiExport';
import { channelFor, loadGpBytes } from '../src/io/alphatab';
import { Editor } from '../src/editor/editor';
import { createSong, notePitch, type Song } from '../src/model/song';
import { barTicks, beatTicks } from '../src/model/rhythm';
import { fixture, root } from './helpers';

interface N {
  track: number;
  channel: number;
  key: number;
  start: number;
  dur: number;
  vel: number;
}
const sortNotes = (ns: N[]) => ns.sort((a, b) => a.start - b.start || a.track - b.track || a.key - b.key || a.dur - b.dur);

/** Notes from an SMF, decoded by the independent `midi-file` parser. */
function fileNotes(bin: Uint8Array): N[] {
  const p = parseMidi(bin);
  const out: N[] = [];
  p.tracks.forEach((events, track) => {
    let t = 0;
    const open = new Map<string, { start: number; vel: number }[]>();
    for (const e of events as any[]) {
      t += e.deltaTime;
      const on = e.type === 'noteOn' && e.velocity > 0;
      const off = e.type === 'noteOff' || (e.type === 'noteOn' && e.velocity === 0);
      const k = `${e.channel}:${e.noteNumber}`;
      if (on) open.set(k, [...(open.get(k) ?? []), { start: t, vel: e.velocity }]);
      else if (off) {
        const s = open.get(k)?.shift();
        if (s) out.push({ track, channel: e.channel, key: e.noteNumber, start: s.start, dur: t - s.start, vel: s.vel });
      }
    }
  });
  return sortNotes(out);
}

/** Notes from alphaTab's in-memory MIDI model: exactly what the playback synth consumes. */
function playbackNotes(song: Song): N[] {
  const mf = generateMidi(song);
  const out: N[] = [];
  const open = new Map<string, { start: number; vel: number }[]>();
  const T = at.midi.MidiEventType;
  const events = mf.tracks.flatMap((t, ti) => t.events.map((e: any) => ({ e, ti })));
  for (const { e, ti } of events as any[]) {
    e.track = ti;
    if (e.type !== T.NoteOn && e.type !== T.NoteOff) continue;
    const k = `${e.track}:${e.channel}:${e.noteKey}`;
    if (e.type === T.NoteOn && e.noteVelocity > 0) open.set(k, [...(open.get(k) ?? []), { start: e.tick, vel: e.noteVelocity }]);
    else {
      const s = open.get(k)?.shift();
      if (s) out.push({ track: e.track, channel: e.channel, key: e.noteKey, start: s.start, dur: e.tick - s.start, vel: s.vel });
    }
  }
  return sortNotes(out);
}

/** Reference notes computed straight from our song model (plain notes, no repeats/effects). */
function modelNotes(song: Song): N[] {
  const out: N[] = [];
  song.tracks.forEach((tr, ti) => {
    let barStart = 0;
    const lastByKey = new Map<number, N>();
    tr.measures.forEach((m, bi) => {
      for (const voice of m.voices) {
        let t = barStart;
        for (const b of voice) {
          const d = beatTicks(b);
          for (const n of b.notes) {
            const key = notePitch(tr, n);
            const prev = lastByKey.get(key);
            if (n.tie && prev) {
              prev.dur += d;
              continue;
            }
            const note = { track: ti, channel: channelFor(song, ti), key, start: t, dur: d, vel: 15 + 16 * Math.round((n.velocity - 15) / 16) };
            out.push(note);
            lastByKey.set(key, note);
          }
          t += d;
        }
      }
      barStart += barTicks(song.masterBars[bi]);
    });
  });
  return sortNotes(out);
}

function metaEvents(bin: Uint8Array) {
  const p = parseMidi(bin);
  const tempos: [number, number][] = [];
  const sigs: [number, string][] = [];
  const names: string[] = [];
  const ctl: Record<number, { program?: number; volume?: number; pan?: number; channel?: number }> = {};
  p.tracks.forEach((events, ti) => {
    let t = 0;
    ctl[ti] = {};
    for (const e of events as any[]) {
      t += e.deltaTime;
      if (e.type === 'setTempo') tempos.push([t, Math.round(60_000_000 / e.microsecondsPerBeat)]);
      if (e.type === 'timeSignature') sigs.push([t, `${e.numerator}/${e.denominator}`]);
      if (e.type === 'trackName') names.push(e.text);
      if (e.type === 'programChange') Object.assign(ctl[ti], { program: e.programNumber, channel: e.channel });
      if (e.type === 'controller' && e.controllerType === 7) ctl[ti].volume = e.value;
      if (e.type === 'controller' && e.controllerType === 10) ctl[ti].pan = e.value;
    }
  });
  return { header: p.header, tempos, sigs, names, ctl };
}

/** A song exercising keys, drums, bass, ties, dots, triplets, tempo and time-signature changes. */
function richSong(): Song {
  const e = new Editor(createSong({ tracks: ['guitar', 'bass', 'keys', 'drums'], tempo: 100, bars: 3 }));
  e.setDuration(8);
  e.setFret(5); // guitar bar 1 beat 1: string 0 fret 5 (E4+5 = A4 = 69)
  e.moveRight();
  e.setCursor({ string: 5 });
  e.typeDigit(1, 0);
  e.typeDigit(2, 100); // low E fret 12 = 52
  e.toggleDot();
  e.moveRight();
  e.setDuration(16);
  e.toggleTriplet();
  e.setFret(3);
  e.songEdit('tempo change', (s) => (s.masterBars[1].tempo = 140));
  e.setTimeSignature(3, 4, 2);
  e.songEdit('notes', (s) => {
    s.tracks[0].measures[1].voices[0] = [
      { duration: 2, dots: 0, notes: [{ string: 1, fret: 3, velocity: 79 }] },
      { duration: 2, dots: 0, notes: [{ string: 1, fret: 3, velocity: 79, tie: true }] },
    ];
    s.tracks[1].measures[0].voices[0] = [1, 2, 3, 4].map((f) => ({ duration: 4 as const, dots: 0, notes: [{ string: 3, fret: f, velocity: 111 }] }));
    s.tracks[2].measures[0].voices[0] = [{ duration: 2, dots: 0, notes: [{ pitch: 60, velocity: 95 }, { pitch: 64, velocity: 95 }, { pitch: 67, velocity: 95 }] }];
    s.tracks[3].measures[0].voices[0] = [36, 42, 38, 42].map((k) => ({ duration: 4 as const, dots: 0, notes: [{ pitch: k, velocity: 95 }] }));
    s.tracks[1].volume = 10;
    s.tracks[1].pan = 4;
    s.tracks[2].program = 81;
  });
  return e.song;
}

const privateDir = path.join(root, 'gp5-examples');
const privateFiles = fs.existsSync(privateDir) ? fs.readdirSync(privateDir).filter((f) => /\.gp[345]$/i.test(f)).map((f) => 'gp5-examples/' + f) : [];

describe('MIDI export', () => {
  it('writes a format-1 SMF with one named track per song track', () => {
    const song = richSong();
    const m = metaEvents(exportMidi(song));
    expect(m.header).toMatchObject({ format: 1, numTracks: 4, ticksPerBeat: 960 });
    expect(m.names).toEqual(['Guitar', 'Bass', 'Keys', 'Drums']);
  });

  it('exported notes match the reference computed from the song model (pitch, start, duration, channel, velocity)', () => {
    const song = richSong();
    const got = fileNotes(exportMidi(song));
    const want = modelNotes(song);
    expect(got).toEqual(want);
    // spot checks on edited content
    expect(got).toContainEqual(expect.objectContaining({ track: 0, key: 52, start: 480, dur: 720 })); // dotted eighth, fret 12
    expect(got).toContainEqual(expect.objectContaining({ track: 0, key: 62, start: 3840, dur: 3840 })); // tied halves -> whole
    expect(got).toContainEqual(expect.objectContaining({ track: 3, channel: 9, key: 38, start: 1920 }));
    expect(got.filter((n) => n.track === 2 && n.start === 0).map((n) => n.key)).toEqual([60, 64, 67]);
  });

  it('exports the tempo map, time signatures, programs, volume and pan', () => {
    const song = richSong();
    const m = metaEvents(exportMidi(song));
    expect(m.tempos).toEqual([[0, 100], [3840, 140]]);
    expect(m.sigs).toEqual([[0, '4/4'], [7680, '3/4']]);
    expect(m.ctl[0]).toMatchObject({ program: 29, channel: 0 });
    expect(m.ctl[1]).toMatchObject({ program: 33, channel: 1, volume: 10 * 8, pan: 4 * 8 }); // alphaTab scales GP 0-16 by 8 (capped at 127)
    expect(m.ctl[0]).toMatchObject({ volume: 104, pan: 64 });
    expect(m.ctl[2]).toMatchObject({ program: 81, channel: 2 });
    expect(m.ctl[3]).toMatchObject({ channel: 9 });
  });

  it.each(['fixtures/fixture.gp3', 'fixtures/fixture.gp4', 'fixtures/fixture.gp5'])('%s: export equals the model reference', (f) => {
    const song = loadGpBytes(fixture(f));
    expect(fileNotes(exportMidi(song))).toEqual(modelNotes(song));
  });

  it.each(['fixtures/fixture.gp5', ...privateFiles])('%s: exported file is semantically identical to playback', (f) => {
    const song = loadGpBytes(fixture(f));
    const file = fileNotes(exportMidi(song));
    const play = playbackNotes(song);
    expect(file.length).toBeGreaterThan(0);
    expect(file).toEqual(play);
  });

  it('reflects edits made after importing a GP file', () => {
    const song = loadGpBytes(fixture('fixtures/fixture.gp5'));
    const e = new Editor(song);
    e.setCursor({ bar: 3, beat: 0, string: 0 });
    e.typeDigit(1, 0);
    e.typeDigit(7, 50); // high E fret 17 = 81
    const notes = fileNotes(exportMidi(e.song));
    expect(notes).toContainEqual(expect.objectContaining({ track: 0, key: 81, start: 3 * 3840, dur: 3840 }));
  });
});

describe('MIDI export of drum and keys edits', () => {
  it('reflects drum and keys entry made through the editor', () => {
    const e = new Editor(createSong({ tracks: ['drums', 'keys'], bars: 1 }));
    e.setDuration(8);
    e.togglePitch(36);
    e.togglePitch(42);
    e.moveRight();
    e.togglePitch(42);
    e.moveRight();
    e.togglePitch(38);
    e.togglePitch(42);
    e.setCursor({ track: 1, bar: 0, beat: 0 });
    e.setDuration(2);
    e.typeNoteName('c');
    e.typeNoteName('e');
    e.transposeNote(-1); // E -> Eb: C minor third
    const got = fileNotes(exportMidi(e.song));
    expect(got).toEqual(modelNotes(e.song));
    expect(got.filter((n) => n.track === 0).map((n) => [n.channel, n.key, n.start])).toEqual([
      [9, 36, 0], [9, 42, 0], [9, 42, 480], [9, 38, 960], [9, 42, 960],
    ]);
    expect(got.filter((n) => n.track === 1).map((n) => [n.key, n.start, n.dur])).toEqual([[60, 0, 1920], [63, 0, 1920]]);
  });
});
