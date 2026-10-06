import { describe, expect, it } from 'vitest';
import { parseMidi } from 'midi-file';
// @ts-expect-error plain JS fixture module
import { FIXTURES, buildMidi, groundTruth } from '../scripts/midi-fixtures.mjs';
import { buildSong, classify, importMidi, parseMidiBytes, proposeMapping } from '../src/io/midiImport';
import { exportMidi } from '../src/io/midiExport';
import { parseProject, serializeProject } from '../src/io/project';
import { Editor } from '../src/editor/editor';
import { createSong, isStringed, notePitch, type Song } from '../src/model/song';
import { barTicks, beatTicks } from '../src/model/rhythm';

interface N {
  track: number;
  pitch: number;
  start: number;
  dur: number;
  vel: number;
}
const sortN = (ns: N[]) => ns.sort((a, b) => a.track - b.track || a.start - b.start || a.pitch - b.pitch);

/** Parse an SMF with midi-file into absolute-time notes (960 PPQ) plus meta information. */
function readMidi(bin: Uint8Array) {
  const p = parseMidi(bin);
  const k = 960 / p.header.ticksPerBeat!;
  const notes: N[] = [];
  const tempos: [number, number][] = [];
  const sigs: [number, string][] = [];
  const programs: Record<number, number> = {};
  const channels: Record<number, number> = {};
  p.tracks.forEach((events, ti) => {
    let t = 0;
    const open = new Map<number, { s: number; v: number }[]>();
    for (const e of events as any[]) {
      t += e.deltaTime;
      const T = Math.round(t * k);
      if (e.type === 'setTempo') tempos.push([T, Math.round(60_000_000 / e.microsecondsPerBeat)]);
      if (e.type === 'timeSignature') sigs.push([T, `${e.numerator}/${e.denominator}`]);
      if (e.type === 'programChange') programs[ti] = e.programNumber;
      if (e.type === 'noteOn' && e.velocity > 0) {
        channels[ti] = e.channel;
        open.set(e.noteNumber, [...(open.get(e.noteNumber) ?? []), { s: T, v: e.velocity }]);
      } else if (e.type === 'noteOff' || e.type === 'noteOn') {
        const o = open.get(e.noteNumber)?.shift();
        if (o) notes.push({ track: ti, pitch: e.noteNumber, start: o.s, dur: T - o.s, vel: o.v });
      }
    }
  });
  return { notes: sortN(notes), tempos, sigs, programs, channels, header: p.header };
}

const roundTrip = (name: string) => {
  const def = (FIXTURES as any)[name];
  const { song, report } = importMidi(buildMidi(def));
  return { def, song, report, out: readMidi(exportMidi(song)) };
};

const EXACT = ['guitar-melody', 'guitar-chords', 'bass', 'piano', 'drums', 'multitrack', 'format0'];

describe('MIDI import: classification and mapping', () => {
  it('classifies channel 10, guitar/bass programs, names and everything else', () => {
    expect(classify({ channel: 9, program: 30, name: 'x' })).toBe('drums');
    expect(classify({ channel: 0, program: 27, name: '' })).toBe('guitar');
    expect(classify({ channel: 1, program: 34, name: '' })).toBe('bass');
    expect(classify({ channel: 1, program: 0, name: 'Bass gtr' })).toBe('bass');
    expect(classify({ channel: 1, program: 0, name: 'Rhythm Gtr' })).toBe('guitar');
    expect(classify({ channel: 0, program: 0, name: 'Piano' })).toBe('keys');
    expect(classify({ channel: 0, program: 81, name: '' })).toBe('keys');
    expect(classify({ channel: 0, program: 48, name: '' })).toBe('keys');
    expect(classify({ channel: 0, program: 73, name: 'Flute' })).toBe('keys');
  });

  it('proposes tracks, names and extended tunings from the part range', () => {
    const plans = proposeMapping(parseMidiBytes(buildMidi(FIXTURES.multitrack)));
    expect(plans.map((p) => [p.name, p.type])).toEqual([['Guitar', 'guitar'], ['Bass', 'bass'], ['Strings', 'keys'], ['Kit', 'drums']]);
    expect(plans[0].tuning).toEqual([64, 59, 55, 50, 45, 40]);
    const bass = proposeMapping(parseMidiBytes(buildMidi(FIXTURES.bass)));
    expect(bass[0].tuning).toEqual([43, 38, 33, 26]); // part goes down to D1: 4-string drop D
  });

  it('splits format-0 files per channel and names unnamed tracks after their instrument', () => {
    const { song } = importMidi(buildMidi(FIXTURES.format0));
    expect(song.tracks.map((t) => [t.name, t.type, t.program])).toEqual([['Steel Guitar', 'guitar', 25], ['Acoustic Bass', 'bass', 32], ['Drums', 'drums', 0]]);
  });

  it('honours mapping overrides: change type, tuning, exclude', () => {
    const raw = parseMidiBytes(buildMidi(FIXTURES.multitrack));
    const plans = proposeMapping(raw);
    plans[0] = { ...plans[0], type: 'keys' };
    plans[1] = { ...plans[1], tuning: [43, 38, 33, 28, 23] };
    plans[2] = { ...plans[2], include: false };
    const { song, report } = buildSong(raw, plans);
    expect(song.tracks.map((t) => t.type)).toEqual(['keys', 'bass', 'drums']);
    expect(song.tracks[1].tuning).toHaveLength(5);
    expect(report.lines.join()).toMatch(/1 track\(s\) were not imported/);
    expect(song.tracks.every((t) => t.measures.length === song.masterBars.length)).toBe(true);
  });
});

describe('MIDI -> SixLine -> MIDI round trip', () => {
  it.each(EXACT)('%s: pitch, start, duration and velocity survive exactly', (name) => {
    const { def, out, report } = roundTrip(name);
    // playback/export use one velocity per beat: the loudest note starting at that time in the track
    const gt: N[] = groundTruth(def);
    const want = sortN(gt.map((n) => ({ ...n, vel: Math.max(...gt.filter((m) => m.track === n.track && m.start === n.start).map((m) => m.vel)) })));
    expect(out.notes.map(({ track, pitch, start, dur, vel }) => ({ track, pitch, start, dur, vel }))).toEqual(want);
    expect(report.stats.movedStarts).toBe(0);
    expect(report.unplayable).toBe(0);
  });

  it.each(EXACT)('%s: tempo map, time signatures, programs and drum channel survive', (name) => {
    const { def, out } = roundTrip(name);
    expect(out.tempos).toEqual(def.tempos.map(([q, bpm]: number[]) => [q * 960, bpm]));
    // export always writes the opening signature; changes must match exactly
    const sigs = def.sigs.map(([q, n, d]: number[]) => [q * 960, `${n}/${d}`]);
    expect(out.sigs).toEqual(sigs);
    def.tracks.forEach((t: any, i: number) => {
      if (t.channel === 9) expect(out.channels[i]).toBe(9);
      else {
        expect(out.programs[i]).toBe(t.program);
        expect(out.channels[i]).not.toBe(9);
      }
    });
  });

  it('volume and pan controllers survive (GP 0-16 resolution)', () => {
    const { out, song } = roundTrip('guitar-melody');
    expect(song.tracks[0]).toMatchObject({ volume: Math.round(100 / 8), pan: 5 });
    const p = parseMidi(exportMidi(song));
    const cc = (n: number) => (p.tracks[0] as any[]).find((e) => e.type === 'controller' && e.controllerType === n).value;
    expect(Math.abs(cc(7) - 100)).toBeLessThanOrEqual(4);
    expect(Math.abs(cc(10) - 40)).toBeLessThanOrEqual(4);
    expect(out.notes.length).toBe(22);
  });

  it('notes tied across a bar line come back as one note', () => {
    const { song, out } = roundTrip('guitar-melody');
    const bar4 = song.tracks[0].measures[3].voices[0];
    expect(bar4[0].notes[0].tie).toBe(true);
    expect(bar4.some((b) => b.notes.some((n) => n.tie))).toBe(true);
    expect(out.notes).toContainEqual(expect.objectContaining({ pitch: 64, start: 10 * 960, dur: 4 * 960 }));
  });

  it('triplets are written as tuplets and keep exact timing', () => {
    const { song, report } = roundTrip('guitar-melody');
    expect(report.stats.tripletUnits).toBe(2);
    const beats = song.tracks[0].measures[1].voices[0];
    expect(beats.filter((b) => b.tuplet).length).toBe(6);
  });

  it('humanized timing is quantised to the grid, within tolerance, and reported', () => {
    const { def, out, report } = roundTrip('humanized');
    const want = groundTruth(def);
    expect(out.notes).toHaveLength(want.length);
    out.notes.forEach((n, i) => {
      expect(n.pitch).toBe(want[i].pitch);
      expect(n.start % 480).toBe(0); // landed on the eighth grid
      expect(Math.abs(n.start - want[i].start)).toBeLessThanOrEqual(60);
      expect(Math.abs(n.vel - want[i].vel)).toBeLessThanOrEqual(8); // velocity is stored exactly, played as GP dynamics
    });
    expect(report.stats.movedStarts).toBe(7);
    expect(report.lines.join(' ')).toMatch(/snapped to the rhythm grid/);
  });

  it('overlapping notes in one track are shortened and reported (single voice)', () => {
    const def = { ppq: 480, tempos: [[0, 120]], sigs: [[0, 4, 4]], tracks: [{ name: 'Keys', channel: 0, program: 4, notes: [[60, 0, 2, 95], [64, 1, 1, 95]] }] };
    const { out, report } = roundTrip2(def);
    expect(report.stats.truncated).toBe(1);
    expect(out.notes.map((n) => [n.pitch, n.start, n.dur])).toEqual([[60, 0, 960], [64, 960, 960]]);
    expect(report.lines.join(' ')).toMatch(/shortened/);
  });

  it('notes that cannot be fretted are kept on an extra notation track and still exported', () => {
    const def = { ppq: 480, tempos: [[0, 120]], sigs: [[0, 4, 4]], tracks: [{ name: 'Gtr', channel: 0, program: 29, notes: [[64, 0, 1, 95], [96, 1, 1, 95], [67, 2, 2, 95]] }] };
    const { song, out, report } = roundTrip2(def);
    expect(report.unplayable).toBe(1);
    expect(song.tracks.map((t) => [t.name, t.type])).toEqual([['Gtr', 'guitar'], ['Gtr (unplayable notes)', 'keys']]);
    expect(out.notes.map((n) => [n.pitch, n.start])).toEqual([[64, 0], [67, 1920], [96, 960]]);
  });

  it('guitar parts get string/fret fingerings that reconstruct every pitch', () => {
    const { song, def } = roundTrip('guitar-chords');
    const tr = song.tracks[0];
    const pitches = tr.measures.flatMap((m) => m.voices[0].flatMap((b) => b.notes.filter((n) => !n.tie).map((n) => notePitch(tr, n))));
    expect(pitches.sort()).toEqual(groundTruth(def).map((n: N) => n.pitch).sort());
    for (const m of tr.measures) for (const b of m.voices[0]) expect(new Set(b.notes.map((n) => n.string)).size).toBe(b.notes.length);
  });
});

function roundTrip2(def: any) {
  const { song, report } = importMidi(buildMidi(def));
  return { song, report, out: readMidi(exportMidi(song)) };
}

/** Musical content of a song: per track, sounding notes (ties merged) with pitch/start/duration. */
function musical(song: Song) {
  return song.tracks.map((tr) => {
    const out: [number, number, number][] = [];
    let barStart = 0;
    const last = new Map<number, [number, number, number]>();
    tr.measures.forEach((m, bi) => {
      let t = barStart;
      for (const b of m.voices[0]) {
        const d = beatTicks(b);
        for (const n of b.notes) {
          const p = notePitch(tr, n);
          if (n.tie && last.get(p)) last.get(p)![2] += d;
          else {
            const x: [number, number, number] = [p, t, d];
            out.push(x);
            last.set(p, x);
          }
        }
        t += d;
      }
      barStart += barTicks(song.masterBars[bi]);
    });
    return out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  });
}

describe('SixLine -> MIDI -> SixLine round trip', () => {
  function sample(): Song {
    const e = new Editor(createSong({ tracks: ['guitar', 'bass', 'keys', 'drums'], tempo: 132, bars: 4 }));
    e.setTimeSignature(6, 8, 2);
    e.songEdit('content', (s) => {
      s.masterBars[1].tempo = 90;
      s.tracks[0].measures[0].voices[0] = [
        { duration: 8, dots: 0, notes: [{ string: 5, fret: 0, velocity: 95 }, { string: 4, fret: 2, velocity: 95 }] },
        { duration: 8, dots: 0, notes: [{ string: 2, fret: 2, velocity: 95 }] },
        { duration: 4, dots: 1, notes: [{ string: 1, fret: 3, velocity: 79 }] },
        { duration: 8, dots: 0, tuplet: [3, 2], notes: [{ string: 0, fret: 0, velocity: 95 }] },
        { duration: 8, dots: 0, tuplet: [3, 2], notes: [{ string: 0, fret: 2, velocity: 95 }] },
        { duration: 8, dots: 0, tuplet: [3, 2], notes: [{ string: 0, fret: 3, velocity: 95 }] },
        { duration: 4, dots: 0, notes: [] },
      ];
      s.tracks[1].measures[1].voices[0] = [{ duration: 2, dots: 0, notes: [{ string: 3, fret: 3, velocity: 111 }] }, { duration: 2, dots: 0, notes: [{ string: 3, fret: 3, velocity: 111, tie: true }] }];
      s.tracks[2].program = 90;
      s.tracks[2].measures[2].voices[0] = [{ duration: 4, dots: 1, notes: [{ pitch: 60, velocity: 63 }, { pitch: 67, velocity: 63 }] }, { duration: 4, dots: 1, notes: [{ pitch: 62, velocity: 63 }] }];
      s.tracks[3].measures[3].voices[0] = [36, 42, 38, 42, 36, 42].map((k) => ({ duration: 8 as const, dots: 0, notes: [{ pitch: k, velocity: 95 }] }));
    });
    return e.song;
  }

  it('keeps bar structure, tempo map, track types/programs and every sounding note', () => {
    const a = sample();
    const { song: b, report } = importMidi(exportMidi(a));
    expect(b.masterBars.map((m) => [m.num, m.den, m.tempo])).toEqual(a.masterBars.map((m) => [m.num, m.den, m.tempo]));
    expect(b.tempo).toBe(a.tempo);
    expect(b.tracks.map((t) => [t.type, t.type === 'drums' ? 0 : t.program])).toEqual(a.tracks.map((t) => [t.type, t.type === 'drums' ? 0 : t.program]));
    expect(b.tracks.map((t) => t.name)).toEqual(a.tracks.map((t) => t.name));
    expect(musical(b)).toEqual(musical(a));
    expect(report.stats.movedStarts).toBe(0);
    // the guitar part comes back as tab (fingering may differ, pitches may not)
    expect(isStringed(b.tracks[0])).toBe(true);
  });

  it('imported songs are ordinary documents: editable, savable, re-exportable', () => {
    const { song } = importMidi(buildMidi(FIXTURES.multitrack));
    const e = new Editor(song);
    e.setCursor({ track: 0, bar: 0, beat: 0, string: 0 });
    e.setFret(12);
    e.setCursor({ track: 3 });
    e.togglePitch(49);
    e.setCursor({ track: 2 });
    e.typeNoteName('a'); // A3 (nearest to the C4 cursor) is added to the strings chord
    const back = parseProject(serializeProject(e.song));
    expect(back).toEqual(JSON.parse(JSON.stringify(e.song)));
    const out = readMidi(exportMidi(back));
    expect(out.notes).toContainEqual(expect.objectContaining({ track: 0, pitch: 76, start: 0 }));
    expect(out.notes).toContainEqual(expect.objectContaining({ track: 3, pitch: 49, start: 0 }));
    expect(out.notes).toContainEqual(expect.objectContaining({ track: 2, pitch: 57, start: 0 }));
  });
});

describe('tuning proposals', () => {
  it('picks the most standard preset that reaches the lowest note', async () => {
    const { tuningForRange } = await import('../src/model/tunings');
    expect(tuningForRange('guitar', 40)).toEqual([64, 59, 55, 50, 45, 40]);
    expect(tuningForRange('guitar', 38)).toEqual([64, 59, 55, 50, 45, 38]);
    expect(tuningForRange('guitar', 36)).toEqual([62, 57, 53, 48, 43, 36]);
    expect(tuningForRange('guitar', 35)).toHaveLength(7);
    expect(tuningForRange('guitar', 33)).toEqual([64, 59, 55, 50, 45, 40, 33]);
    expect(tuningForRange('guitar', 20)).toHaveLength(8); // nothing reaches: lowest-reaching preset, rest reported unplayable
    expect(tuningForRange('bass', 23)).toEqual([43, 38, 33, 28, 23]);
  });
});

// Real-world material: the private GP5 files (when present) exported to MIDI and re-imported.
import fs from 'node:fs';
import path from 'node:path';
import { loadGpBytes } from '../src/io/alphatab';
import { root } from './helpers';

const privateDir = path.join(root, 'gp5-examples');
const privateGp = fs.existsSync(privateDir) ? fs.readdirSync(privateDir).filter((f) => /\.gp[345]$/i.test(f)) : [];

describe.skipIf(!privateGp.length)('real-world: private GP files -> MIDI -> SixLine -> MIDI', () => {
  it.each(privateGp)('%s', (f) => {
    const mid = exportMidi(loadGpBytes(new Uint8Array(fs.readFileSync(path.join(privateDir, f)))));
    const t0 = performance.now();
    const { song, report } = importMidi(mid);
    const ms = performance.now() - t0;
    const names = (bin: Uint8Array) => (parseMidi(bin).tracks as any[][]).map((tr) => tr.find((e) => e.type === 'trackName')?.text ?? '');
    const keyed = (bin: Uint8Array) => {
      const n = names(bin);
      return readMidi(bin).notes.map((x) => ({ k: `${n[x.track]}:${x.pitch}`, t: x.start }));
    };
    const a = keyed(mid);
    const pool = new Map<string, number[]>();
    for (const x of keyed(exportMidi(song))) pool.set(x.k, [...(pool.get(x.k) ?? []), x.t]);
    let exact = 0;
    let near = 0;
    let miss = 0;
    for (const x of a) {
      const l = pool.get(x.k) ?? [];
      let i = l.indexOf(x.t);
      if (i >= 0) exact++;
      else if ((i = l.findIndex((t) => Math.abs(t - x.t) <= 240)) >= 0) near++;
      else miss++;
      if (i >= 0) l.splice(i, 1);
    }
    console.log(`${f}: import ${ms.toFixed(0)}ms; ${song.tracks.map((t) => `${t.name}=${t.type}${t.tuning.length ? '/' + t.tuning.length : ''}`).join(', ')}; ${a.length} notes: ${exact} exact, ${near} within a 16th, ${miss} missing; merged duplicates ${report.stats.merged}\n  ${report.lines.join('\n  ')}`);
    // benchmark (logged, not asserted): how often the automatic fingering equals the human-authored GP tab
    const gp = loadGpBytes(new Uint8Array(fs.readFileSync(path.join(privateDir, f))));
    const agree = gp.tracks.flatMap((t) => {
      const j = song.tracks.findIndex((x) => x.name === t.name);
      if (!isStringed(t) || j < 0 || song.tracks[j].tuning.join() !== t.tuning.join()) return [];
      const placed = (s: Song, ti: number) => {
        const tr = s.tracks[ti];
        const m = new Map<string, string>();
        let bs = 0;
        tr.measures.forEach((me, bi) => {
          let t = bs;
          for (const be of me.voices[0]) {
            for (const n of be.notes) if (!n.tie && n.string !== undefined) m.set(`${t}:${notePitch(tr, n)}`, `${n.string}/${n.fret}`);
            t += beatTicks(be);
          }
          bs += barTicks(s.masterBars[bi]);
        });
        return m;
      };
      const h = placed(gp, gp.tracks.indexOf(t));
      const auto = placed(song, j);
      const both = [...h].filter(([k]) => auto.has(k));
      const same = both.filter(([k, v]) => auto.get(k) === v).length;
      return [`${t.name} ${Math.round((100 * same) / both.length)}% of ${both.length} notes`];
    });
    if (agree.length) console.log(`  fingering identical to the human tab: ${agree.join(', ')}`);
    expect(report.unplayable).toBe(0);
    expect(miss).toBeLessThanOrEqual(report.stats.merged); // only merged unison duplicates may disappear
    expect(exact / a.length).toBeGreaterThan(0.95);
    expect(ms).toBeLessThan(2000);
  });
});
