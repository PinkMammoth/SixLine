// Standard MIDI File import -> ordinary SixLine Song.
//
// Pipeline: midi-file parse (format 0/1; each MTrk split per channel)
//   -> RawMidi (all times rescaled to 960 PPQ)
//   -> proposeMapping (track type / tuning per MIDI track; editable in the import dialog)
//   -> buildSong: bar layout from time signatures, tempo map, quantize each track,
//      string/fret assignment for guitar/bass, report of everything that had to change.
import { parseMidi } from 'midi-file';
import { createTrack, type Beat, type MasterBar, type Note, type Song, type Track, type TrackType } from '../model/song';
import { barTicks } from '../model/rhythm';
import { assignFingering } from '../model/fingering';
import { GM_PROGRAMS } from '../model/gm';
import { tuningForRange } from '../model/tunings';
import { quantizeTrack, type QuantizeStats, type TimedNote } from './quantize';

export interface RawTrack {
  name: string;
  channel: number;
  program: number;
  volume?: number;
  pan?: number;
  notes: TimedNote[];
}

export interface RawMidi {
  format: number;
  ppq: number;
  tempos: { tick: number; bpm: number }[];
  timeSigs: { tick: number; num: number; den: number }[];
  tracks: RawTrack[];
  /** Program changes after a channel's first program (ignored: one instrument per track). */
  programChanges: number;
}

export interface TrackPlan {
  include: boolean;
  type: TrackType;
  name: string;
  /** Guitar/bass tuning (index 0 = highest string). */
  tuning: number[];
}

export interface ImportReport {
  tracks: number;
  notes: number;
  stats: QuantizeStats;
  /** Notes that cannot be fretted on the chosen tuning; kept in an extra keys track. */
  unplayable: number;
  tempoMoved: number;
  timeSigMoved: number;
  /** Human-readable summary of everything that changed. */
  lines: string[];
}

const PPQ = 960;
/** GP dynamic level (ppp=0 .. fff=7) used by playback/export for a velocity. */
const dynLevel = (v: number) => Math.max(0, Math.min(7, Math.round((v - 15) / 16)));

export function parseMidiBytes(bytes: Uint8Array): RawMidi {
  const midi = parseMidi(bytes);
  const ppq = midi.header.ticksPerBeat ?? 480;
  const scale = (t: number) => Math.round((t * PPQ) / ppq);
  const tempos: RawMidi['tempos'] = [];
  const timeSigs: RawMidi['timeSigs'] = [];
  const tracks: RawTrack[] = [];
  let programChanges = 0;
  midi.tracks.forEach((events) => {
    let t = 0;
    let name = '';
    // split each MTrk per channel; program/volume/pan = first value seen on that channel
    const byCh = new Map<number, { program?: number; volume?: number; pan?: number; notes: TimedNote[]; open: Map<number, { start: number; velocity: number }[]> }>();
    const ch = (c: number) => {
      if (!byCh.has(c)) byCh.set(c, { notes: [], open: new Map() });
      return byCh.get(c)!;
    };
    for (const e of events as any[]) {
      t += e.deltaTime;
      const T = scale(t);
      switch (e.type) {
        case 'trackName':
          if (!name) name = String(e.text ?? '').trim();
          break;
        case 'setTempo':
          tempos.push({ tick: T, bpm: Math.round((60_000_000 / e.microsecondsPerBeat) * 100) / 100 });
          break;
        case 'timeSignature':
          timeSigs.push({ tick: T, num: e.numerator, den: e.denominator });
          break;
        case 'programChange': {
          const c = ch(e.channel);
          if (c.program === undefined) c.program = e.programNumber;
          else if (c.program !== e.programNumber) programChanges++;
          break;
        }
        case 'controller': {
          const c = ch(e.channel);
          if (e.controllerType === 7 && c.volume === undefined) c.volume = e.value;
          if (e.controllerType === 10 && c.pan === undefined) c.pan = e.value;
          break;
        }
        case 'noteOn':
        case 'noteOff': {
          const c = ch(e.channel);
          if (e.type === 'noteOn' && e.velocity > 0) c.open.set(e.noteNumber, [...(c.open.get(e.noteNumber) ?? []), { start: T, velocity: e.velocity }]);
          else {
            const o = c.open.get(e.noteNumber)?.shift();
            if (o) c.notes.push({ pitch: e.noteNumber, start: o.start, end: Math.max(T, o.start + 1), velocity: o.velocity });
          }
          break;
        }
      }
    }
    const used = [...byCh.entries()].filter(([, c]) => c.notes.length);
    for (const [channel, c] of used) {
      // notes never switched off end with the track
      for (const [pitch, list] of c.open) for (const o of list) c.notes.push({ pitch, start: o.start, end: Math.max(scale(t), o.start + 1), velocity: o.velocity });
      c.notes.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
      tracks.push({ name: used.length > 1 && name ? `${name} (ch ${channel + 1})` : name, channel, program: c.program ?? 0, volume: c.volume, pan: c.pan, notes: c.notes });
    }
  });
  return { format: midi.header.format, ppq, tempos, timeSigs, tracks, programChanges };
}

/**
 * Classification: channel 10 -> drums; GM 24-31 -> guitar; 32-39 -> bass; a program-0 track named
 * like a guitar/bass -> that; everything else (pianos, synths, strings, winds...) -> keys (notation).
 */
export function classify(t: Pick<RawTrack, 'channel' | 'program' | 'name'>): TrackType {
  if (t.channel === 9) return 'drums';
  if (t.program >= 24 && t.program <= 31) return 'guitar';
  if (t.program >= 32 && t.program <= 39) return 'bass';
  if (t.program === 0 && /\bbass\b/i.test(t.name)) return 'bass';
  if (t.program === 0 && /guit|gtr/i.test(t.name)) return 'guitar';
  return 'keys';
}

/** Standard tuning, extended (drop D/C, 7/8-string, 5-string bass) when the part goes lower. */
export function proposeTuning(type: TrackType, notes: TimedNote[]): number[] {
  if (type !== 'guitar' && type !== 'bass') return [];
  const low = notes.length ? Math.min(...notes.map((n) => n.pitch)) : 127;
  return tuningForRange(type, low);
}

export function trackLabel(t: RawTrack, i: number) {
  if (t.name) return t.name;
  return t.channel === 9 ? 'Drums' : GM_PROGRAMS[t.program] ?? `Track ${i + 1}`;
}

export function proposeMapping(raw: RawMidi): TrackPlan[] {
  return raw.tracks.map((t, i) => {
    const type = classify(t);
    return { include: true, type, name: trackLabel(t, i), tuning: proposeTuning(type, t.notes) };
  });
}

export function buildSong(raw: RawMidi, plans: TrackPlan[] = proposeMapping(raw), title = 'Imported MIDI'): { song: Song; report: ImportReport } {
  const lines: string[] = [];
  const used = raw.tracks.map((t, i) => ({ t, plan: plans[i] })).filter((x) => x.plan.include);
  const lastEnd = Math.max(1, ...used.flatMap((x) => x.t.notes.map((n) => n.end)));

  // ---- bars from time signatures (changes apply at the next bar line if they fall mid-bar)
  const sigs = [...raw.timeSigs].sort((a, b) => a.tick - b.tick);
  const masterBars: MasterBar[] = [];
  let t = 0;
  let sig = { num: 4, den: 4 };
  let si = 0;
  let timeSigMoved = 0;
  while (t < lastEnd || masterBars.length === 0) {
    while (si < sigs.length && sigs[si].tick <= t) {
      if (sigs[si].tick < t && masterBars.length && sigs[si].tick > t - barTicks(masterBars[masterBars.length - 1])) timeSigMoved++;
      sig = { num: sigs[si].num, den: sigs[si].den };
      si++;
    }
    masterBars.push({ ...sig });
    t += barTicks(sig);
  }
  if (timeSigMoved) lines.push(`${timeSigMoved} time-signature change(s) not on a bar line were applied at the next bar.`);

  // ---- tempo map (changes apply at bar starts)
  const starts: number[] = [];
  let acc = 0;
  for (const mb of masterBars) {
    starts.push(acc);
    acc += barTicks(mb);
  }
  const tempos = [...raw.tempos].sort((a, b) => a.tick - b.tick);
  const tempoAt = (tick: number) => {
    let bpm = 120;
    for (const x of tempos) if (x.tick <= tick) bpm = x.bpm;
    return bpm;
  };
  let tempoMoved = 0;
  for (const x of tempos) if (x.tick > 0 && !starts.includes(x.tick)) tempoMoved++;
  const initial = tempoAt(0);
  let running = initial;
  masterBars.forEach((mb, i) => {
    if (i === 0) return;
    const bpm = tempoAt(starts[i]);
    if (bpm !== running) mb.tempo = bpm;
    running = bpm;
  });
  if (tempoMoved) lines.push(`${tempoMoved} tempo change(s) inside a bar were moved to the bar line.`);

  // ---- tracks
  const total: QuantizeStats = { notes: 0, movedStarts: 0, maxShift: 0, resized: 0, truncated: 0, unified: 0, merged: 0, tripletUnits: 0 };
  let unplayable = 0;
  const tracks: Track[] = [];
  for (const { t: rt, plan } of used) {
    const q = quantizeTrack(rt.notes, masterBars);
    for (const k of Object.keys(total) as (keyof QuantizeStats)[]) total[k] = k === 'maxShift' ? Math.max(total[k], q.stats[k]) : total[k] + q.stats[k];
    const track = createTrack(plan.type, masterBars.length, plan.name);
    if (plan.type !== 'drums') track.program = rt.program;
    if (rt.volume !== undefined) track.volume = Math.min(16, Math.round(rt.volume / 8));
    if (rt.pan !== undefined) track.pan = Math.min(16, Math.round(rt.pan / 8));

    let leftovers: Track | null = null;
    if (plan.type === 'guitar' || plan.type === 'bass') {
      track.tuning = [...plan.tuning];
      const fing = assignFingering(q.groups, { tuning: track.tuning });
      const lost = fing.reduce((s, f) => s + f.unsupported.length, 0);
      track.measures = q.bars.map((beats) => ({
        voices: [beats.map((b) => mapBeat(b, (n) => {
          const p = b.group >= 0 ? fing[b.group].placed.find((x) => x.pitch === n.pitch) : undefined;
          return p ? { string: p.string, fret: p.fret } : null;
        }))],
      }));
      if (lost) {
        unplayable += lost;
        // keep unplayable notes audible and editable on a notation track instead of re-pitching them
        leftovers = createTrack('keys', masterBars.length, `${plan.name} (unplayable notes)`);
        leftovers.program = rt.program;
        leftovers.volume = track.volume;
        leftovers.pan = track.pan;
        leftovers.measures = q.bars.map((beats) => ({
          voices: [beats.map((b) => mapBeat(b, (n) => (b.group >= 0 && fing[b.group].unsupported.includes(n.pitch) ? { pitch: n.pitch } : null)))],
        }));
        lines.push(`${lost} note(s) in "${plan.name}" cannot be fretted on the chosen tuning; they were kept in "${leftovers.name}".`);
      }
    } else {
      track.measures = q.bars.map((beats) => ({
        voices: [beats.map((b) => mapBeat(b, (n) => ({ pitch: n.pitch, ...(plan.type === 'drums' && n.tie ? { drop: true } : {}) })))],
      }));
    }
    tracks.push(track);
    if (leftovers) tracks.push(leftovers);
  }

  const s = total;
  if (s.movedStarts) lines.push(`${s.movedStarts} of ${s.notes} note starts were snapped to the rhythm grid (largest shift ${Math.round((s.maxShift / 960) * 100)}% of a beat).`);
  if (s.tripletUnits) lines.push(`${s.tripletUnits} beat(s) were written as triplets.`);
  if (s.truncated) lines.push(`${s.truncated} note(s) were shortened because the next note started before they ended (one voice per track).`);
  if (s.unified) lines.push(`${s.unified} chord note(s) were lengthened to their chord's common length.`);
  if (s.resized) lines.push(`${s.resized} note length(s) were rounded to the nearest representable value.`);
  if (s.merged) lines.push(`${s.merged} duplicate note(s) were merged.`);
  let sharedVel = 0;
  for (const tr of tracks)
    for (const m of tr.measures)
      for (const b of m.voices[0]) {
        const top = Math.max(0, ...b.notes.filter((n) => !n.tie).map((n) => dynLevel(n.velocity)));
        sharedVel += b.notes.filter((n) => !n.tie && dynLevel(n.velocity) < top).length;
      }
  if (sharedVel) lines.push(`${sharedVel} note(s) are quieter than other notes starting with them; playback and export use one velocity per beat (the loudest).`);
  const offLevel = used.reduce((n, x) => n + x.t.notes.filter((m) => 15 + 16 * dynLevel(m.velocity) !== m.velocity).length, 0);
  if (offLevel) lines.push(`${offLevel} note velocities are stored exactly but play/export at the nearest of 8 dynamic levels (ppp-fff).`);
  if (raw.programChanges) lines.push(`${raw.programChanges} mid-track program change(s) were ignored (one instrument per track).`);
  const skipped = raw.tracks.length - used.length;
  if (skipped) lines.push(`${skipped} track(s) were not imported.`);

  const song: Song = { title, artist: '', tempo: initial, masterBars, tracks };
  return { song, report: { tracks: tracks.length, notes: s.notes, stats: s, unplayable, tempoMoved, timeSigMoved, lines } };

  function mapBeat(b: Beat & { group: number; notes: { pitch: number; velocity: number; tie?: boolean }[] }, map: (n: { pitch: number; tie?: boolean }) => (Partial<Note> & { drop?: boolean }) | null): Beat {
    const out: Beat = { duration: b.duration, dots: b.dots, notes: [] };
    if (b.tuplet) out.tuplet = b.tuplet;
    for (const n of b.notes) {
      const m = map(n);
      if (!m || m.drop) continue;
      const { drop: _drop, ...rest } = m;
      const note: Note = { ...rest, velocity: n.velocity };
      if (n.tie) note.tie = true;
      out.notes.push(note);
    }
    return out;
  }
}

export function importMidi(bytes: Uint8Array, plans?: TrackPlan[], title?: string) {
  const raw = parseMidiBytes(bytes);
  return buildSong(raw, plans ?? proposeMapping(raw), title);
}
