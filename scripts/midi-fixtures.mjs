// Original MIDI test fixtures defined as explicit ground truth, written with midi-file's writer.
// `node scripts/midi-fixtures.mjs` writes fixtures/midi/*.mid. Tests import the definitions directly.
import midiFile from 'midi-file';
import fs from 'node:fs';
import path from 'node:path';

const { writeMidi } = midiFile;
const Q = 960; // ticks per quarter used in definitions (scaled to each fixture's ppq)

/** note helper: [pitch, startQuarters, lengthQuarters, velocity] */
const seq = (pitches, len, vel = 95, at = 0) => pitches.map((p, i) => (p === null ? null : [p, at + i * len, len, vel])).filter(Boolean);
const chord = (pitches, at, len, vel = 95) => pitches.map((p) => [p, at, len, vel]);

export const FIXTURES = {
  'guitar-melody': {
    ppq: 480,
    tempos: [[0, 100]],
    sigs: [[0, 4, 4]],
    tracks: [
      {
        name: 'Lead Guitar', channel: 0, program: 27, volume: 100, pan: 40,
        notes: [
          ...seq([64, 67, 69, 71, 72, 71, 69, 67], 0.5), // eighths, bar 1
          [69, 4, 0.75, 111], [71, 4.75, 0.25, 79], [72, 5, 1, 95], // dotted eighth + 16th, quarter
          ...seq([74, 72, 71], 1 / 3, 95, 6), ...seq([69, 67, 64], 1 / 3, 95, 7), // eighth triplets
          [64, 10, 4, 95], // half-bar into next bar: tied across the bar line
          [76, 14, 0.25, 95], [74, 14.25, 0.25, 95], [72, 14.5, 0.5, 95], [71, 15, 1, 95],
        ],
      },
    ],
  },
  'guitar-chords': {
    ppq: 960,
    tempos: [[0, 120]],
    sigs: [[0, 4, 4]],
    tracks: [
      {
        name: 'Rhythm', channel: 0, program: 29,
        notes: [
          ...chord([40, 47, 52], 0, 1), ...chord([43, 50, 55], 1, 1), ...chord([45, 52, 57], 2, 1), ...chord([43, 50, 55], 3, 1),
          ...chord([48, 52, 55, 60, 64], 4, 2), ...chord([43, 47, 50, 55, 59, 67], 6, 2),
          ...chord([45, 52, 57, 60, 64], 8, 4, 79),
        ],
      },
    ],
  },
  bass: {
    ppq: 480,
    tempos: [[0, 96]],
    sigs: [[0, 4, 4]],
    tracks: [{ name: 'Bass', channel: 1, program: 33, notes: [...seq([28, 28, 31, 33, 28, 28, 35, 33], 0.5, 111), ...seq([26, 26, 29, 31], 1, 111, 4)] }],
  },
  piano: {
    ppq: 480,
    tempos: [[0, 80]],
    sigs: [[0, 3, 4]],
    tracks: [{ name: 'Piano', channel: 0, program: 0, notes: [...chord([48, 60, 64, 67], 0, 1), ...chord([53, 60, 65, 69], 1, 1), ...chord([55, 59, 62, 67], 2, 1), ...chord([48, 60, 64, 67, 72], 3, 3, 79)] }],
  },
  drums: {
    ppq: 480,
    tempos: [[0, 120]],
    sigs: [[0, 4, 4]],
    tracks: [
      {
        name: 'Drums', channel: 9, program: 0,
        notes: [
          ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => [42, i * 0.5, 0.25, 79]),
          [36, 0, 0.25, 111], [38, 1, 0.25, 111], [36, 2, 0.25, 111], [36, 2.5, 0.25, 111], [38, 3, 0.25, 111],
          [49, 4, 0.5, 111], [36, 4, 0.5, 111], ...[0, 1, 2, 3].map((i) => [51, 4.5 + i * 0.75, 0.25, 79]), [38, 7.5, 0.25, 111],
          [46, 7.75, 0.25, 95],
        ].map(([p, s, l, v]) => [p, s, l, v]),
      },
    ],
  },
  multitrack: {
    ppq: 480,
    tempos: [[0, 100], [8, 140]],
    sigs: [[0, 4, 4], [12, 3, 4], [18, 6, 8]],
    conductor: true,
    tracks: [
      { name: 'Guitar', channel: 0, program: 30, notes: [...chord([40, 47, 52], 0, 2), ...chord([43, 50, 55], 2, 2), ...seq([64, 66, 67, 69], 1, 95, 4), ...chord([45, 52, 57], 8, 4), ...seq([67, 69, 71], 1, 95, 12), ...seq([72, 71, 69], 1, 95, 15), ...seq([64, 67, 64, 67, 64, 67], 0.5, 95, 18)] },
      { name: 'Bass', channel: 1, program: 34, notes: [...seq([28, 28, 31, 31, 33, 33, 35, 35], 0.5), ...seq([33, 33, 33, 33], 1, 95, 8), ...seq([31, 33, 35, 36, 35, 33], 1, 95, 12), [28, 18, 3, 95]] },
      { name: 'Strings', channel: 2, program: 48, volume: 80, pan: 100, notes: [...chord([52, 59, 64], 0, 8, 63), ...chord([57, 60, 64], 8, 4, 63), ...chord([55, 59, 62], 12, 6, 63)] },
      { name: 'Kit', channel: 9, program: 0, notes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap((b) => [[b % 2 ? 38 : 36, b, 0.5, 111], [42, b, 0.5, 79]]) },
    ],
  },
  format0: {
    ppq: 480,
    format: 0,
    tempos: [[0, 110]],
    sigs: [[0, 4, 4]],
    tracks: [
      { name: '', channel: 0, program: 25, notes: seq([60, 62, 64, 65, 67, 65, 64, 62], 0.5) },
      { name: '', channel: 1, program: 32, notes: seq([36, 36, 43, 43], 1) },
      { name: '', channel: 9, program: 0, notes: [0, 1, 2, 3].map((b) => [b % 2 ? 38 : 36, b, 0.5, 111]) },
    ],
  },
  humanized: {
    ppq: 480,
    tempos: [[0, 120]],
    sigs: [[0, 4, 4]],
    tracks: [
      {
        name: 'Played Guitar', channel: 0, program: 25,
        // straight eighths played slightly early/late; arbitrary velocities
        notes: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((s, i) => [57 + i, s + [0.02, -0.03, 0.01, 0.04, -0.02, 0, 0.03, -0.01][i], 0.45, 70 + i * 7]),
      },
    ],
  },
};

/** Ground-truth notes in 960-PPQ ticks: { track, pitch, start, dur, vel } (track = index in def.tracks). */
export function groundTruth(def) {
  return def.tracks.flatMap((t, ti) => t.notes.map(([p, s, l, v]) => ({ track: ti, pitch: p, start: Math.round(s * Q), dur: Math.round(l * Q), vel: v })));
}

export function buildMidi(def) {
  const k = def.ppq / Q;
  const tick = (q) => Math.round(q * Q * k);
  const toTrack = (abs) => {
    abs.sort((a, b) => a.t - b.t || a.order - b.order);
    let last = 0;
    const out = abs.map(({ t, e }) => {
      const d = t - last;
      last = t;
      return { deltaTime: d, ...e };
    });
    out.push({ deltaTime: 0, meta: true, type: 'endOfTrack' });
    return out;
  };
  const meta = () => [
    ...def.tempos.map(([q, bpm]) => ({ t: tick(q), order: 0, e: { meta: true, type: 'setTempo', microsecondsPerBeat: Math.round(60_000_000 / bpm) } })),
    ...def.sigs.map(([q, n, d]) => ({ t: tick(q), order: 0, e: { meta: true, type: 'timeSignature', numerator: n, denominator: d, metronome: 24, thirtyseconds: 8 } })),
  ];
  const trackEvents = (t) => {
    const ev = [];
    if (t.name) ev.push({ t: 0, order: 0, e: { meta: true, type: 'trackName', text: t.name } });
    ev.push({ t: 0, order: 1, e: { type: 'programChange', channel: t.channel, programNumber: t.program } });
    if (t.volume !== undefined) ev.push({ t: 0, order: 1, e: { type: 'controller', channel: t.channel, controllerType: 7, value: t.volume } });
    if (t.pan !== undefined) ev.push({ t: 0, order: 1, e: { type: 'controller', channel: t.channel, controllerType: 10, value: t.pan } });
    for (const [p, s, l, v] of t.notes) {
      ev.push({ t: tick(s), order: 3, e: { type: 'noteOn', channel: t.channel, noteNumber: p, velocity: v } });
      ev.push({ t: tick(s + l), order: 2, e: { type: 'noteOff', channel: t.channel, noteNumber: p, velocity: 0 } });
    }
    return ev;
  };
  let tracks;
  if (def.format === 0) tracks = [toTrack([...meta(), ...def.tracks.flatMap(trackEvents)])];
  else if (def.conductor) tracks = [toTrack(meta()), ...def.tracks.map((t) => toTrack(trackEvents(t)))];
  else tracks = def.tracks.map((t, i) => toTrack([...(i === 0 ? meta() : []), ...trackEvents(t)]));
  return new Uint8Array(writeMidi({ header: { format: def.format ?? 1, numTracks: tracks.length, ticksPerBeat: def.ppq }, tracks }));
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const dir = process.argv[2] ?? 'fixtures/midi';
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, def] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(dir, name + '.mid'), buildMidi(def));
    console.log('wrote', path.join(dir, name + '.mid'));
  }
}
