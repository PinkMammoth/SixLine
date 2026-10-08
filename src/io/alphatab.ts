// Bridge between our canonical Song model and alphaTab's Score model.
// alphaTab is used for GP3/4/5 parsing, engraving, and synth playback; it never owns the document.
import * as at from '@coderline/alphatab';
import './alphatabPatches';
import { isStringed } from '../model/song';
import type { Beat, Duration, MasterBar, Note, NoteEffects, HarmonicType, Song, Track, TrackType } from '../model/song';
import { barTicks, ticksToDurations } from '../model/rhythm';

const m = at.model;

// GP dynamics ppp..fff <-> velocity, matching alphaTab's MidiUtils (15 + 16 * level).
const dynToVel = (d: number) => (d >= 0 && d <= 7 ? 15 + 16 * d : 95);
const velToDyn = (v: number) => Math.max(0, Math.min(7, Math.round((v - 15) / 16)));

// ---------------------------------------------------------------- import

export function loadGpBytes(bytes: Uint8Array): Song {
  const score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, new at.Settings());
  return scoreToSong(score);
}

function classify(track: at.model.Track): TrackType {
  const st = track.staves[0];
  if (st.isPercussion) return 'drums';
  const prog = track.playbackInfo.program;
  if (prog >= 32 && prog <= 39) return 'bass';
  if (prog >= 24 && prog <= 31) return 'guitar';
  if (prog < 24 || (prog >= 80 && prog < 104)) return 'keys';
  if (st.tuning.length && st.tuning.length <= 5 && Math.min(...st.tuning) < 40) return 'bass';
  return 'guitar';
}

export function scoreToSong(score: at.model.Score): Song {
  let running = score.tempo;
  const masterBars: MasterBar[] = score.masterBars.map((mb, i) => {
    const out: MasterBar = { num: mb.timeSignatureNumerator, den: mb.timeSignatureDenominator };
    const tempo = mb.tempoAutomations.length ? mb.tempoAutomations[0].value : undefined;
    if (tempo !== undefined && i > 0 && tempo !== running) out.tempo = tempo;
    if (tempo !== undefined) running = tempo;
    if (mb.isRepeatStart) out.repeatStart = true;
    if (mb.repeatCount > 1) out.repeatCount = mb.repeatCount;
    if (mb.alternateEndings) out.altEndings = mb.alternateEndings;
    if (mb.section) out.marker = mb.section.text || mb.section.marker;
    return out;
  });
  const first = score.masterBars[0]?.tempoAutomations[0]?.value ?? score.tempo;

  const tracks: Track[] = score.tracks.map((t) => {
    const type = classify(t);
    const st = t.staves[0];
    const stringed = type === 'guitar' || type === 'bass' || type === 'keys' && st.showTablature && st.tuning.length > 0;
    const n = st.tuning.length;
    const measures = st.bars.map((bar, bi) => {
      const voices: Beat[][] = [];
      bar.voices.forEach((v, vi) => {
        if (vi > 0 && v.isEmpty) return;
        if (v.isEmpty) {
          voices.push(ticksToDurations(barTicks(masterBars[bi])).map((d) => ({ duration: d, dots: 0, notes: [] })));
          return;
        }
        voices.push(
          v.beats.map((b) => {
            const beat: Beat = { duration: b.duration as number as Duration, dots: b.dots, notes: [] };
            if (b.hasTuplet) beat.tuplet = [b.tupletNumerator, b.tupletDenominator];
            if (b.graceType) beat.grace = b.graceType;
            if (b.tremoloPicking) beat.tremolo = b.tremoloPicking.marks;
            if (b.isEmpty) return beat;
            for (const nt of b.notes) {
              const note: Note = { velocity: dynToVel(nt.dynamics) };
              if (type === 'drums') note.pitch = nt.percussionArticulation;
              else if (stringed && nt.isStringed) {
                note.string = n - nt.string;
                note.fret = nt.fret;
              } else note.pitch = nt.realValue;
              if (nt.isTieDestination) note.tie = true;
              const fx = readFx(nt);
              if (fx) note.fx = fx;
              beat.notes.push(note);
            }
            return beat;
          }),
        );
      });
      return { voices };
    });
    return {
      name: t.name || type,
      type,
      program: t.playbackInfo.program,
      tuning: stringed ? [...st.tuning] : [],
      capo: st.capo,
      volume: t.playbackInfo.volume,
      pan: t.playbackInfo.balance,
      mute: t.playbackInfo.isMute,
      solo: t.playbackInfo.isSolo,
      measures,
    };
  });

  return { title: score.title, artist: score.artist, tempo: first, masterBars, tracks };
}

function readFx(n: at.model.Note): NoteEffects | undefined {
  const fx: NoteEffects = {};
  if (n.isDead) fx.dead = true;
  if (n.isGhost) fx.ghost = true;
  if (n.isPalmMute) fx.palmMute = true;
  if (n.isLetRing) fx.letRing = true;
  if (n.isHammerPullOrigin) fx.hammer = true;
  if (n.slideOutType !== m.SlideOutType.None) fx.slide = n.slideOutType;
  if (n.slideInType !== m.SlideInType.None) fx.slideIn = n.slideInType;
  if (n.vibrato !== m.VibratoType.None) fx.vibrato = n.vibrato === m.VibratoType.Wide ? 'wide' : true;
  if (n.harmonicType !== m.HarmonicType.None) fx.harmonic = { type: n.harmonicType as number as HarmonicType, value: n.harmonicValue };
  if (n.accentuated !== m.AccentuationType.None) fx.accent = true;
  if (n.isStaccato) fx.staccato = true;
  if (n.hasBend && n.bendPoints) fx.bend = n.bendPoints.map((p) => ({ offset: p.offset, value: p.value }));
  return Object.keys(fx).length ? fx : undefined;
}

// ---------------------------------------------------------------- export to alphaTab (render + playback)

/** Assign MIDI channels: drums on 9, everyone else sequentially skipping 9. */
export function channelFor(song: Song, trackIndex: number): number {
  let ch = 0;
  for (let i = 0; i < trackIndex; i++) if (song.tracks[i].type !== 'drums') ch++;
  if (song.tracks[trackIndex].type === 'drums') return 9;
  if (ch >= 9) ch++;
  return Math.min(ch, 15);
}

export function songToScore(song: Song, settings: at.Settings): at.model.Score {
  const score = new m.Score();
  score.title = song.title;
  score.artist = song.artist;

  song.masterBars.forEach((mb, i) => {
    const out = new m.MasterBar();
    out.timeSignatureNumerator = mb.num;
    out.timeSignatureDenominator = mb.den;
    const bpm = i === 0 ? song.tempo : mb.tempo;
    if (bpm !== undefined) out.tempoAutomations.push(m.Automation.buildTempoAutomation(false, 0, bpm, 2));
    out.isRepeatStart = !!mb.repeatStart;
    out.repeatCount = mb.repeatCount ?? 0;
    if (mb.marker) { out.section = new m.Section(); out.section.text = mb.marker; }
    out.alternateEndings = mb.altEndings ?? 0;
    score.addMasterBar(out);
  });

  song.tracks.forEach((tr, ti) => {
    const t = new m.Track();
    t.name = tr.name;
    t.shortName = tr.name.slice(0, 8);
    const ch = channelFor(song, ti);
    t.playbackInfo.program = tr.type === 'drums' ? 0 : tr.program;
    t.playbackInfo.primaryChannel = ch;
    t.playbackInfo.secondaryChannel = ch;
    t.playbackInfo.volume = tr.volume;
    t.playbackInfo.balance = tr.pan;
    t.playbackInfo.isMute = tr.mute;
    t.playbackInfo.isSolo = tr.solo;
    const st = new m.Staff();
    t.addStaff(st);
    const stringed = isStringed(tr);
    st.isPercussion = tr.type === 'drums';
    if (stringed) {
      st.stringTuning.tunings = [...tr.tuning];
      st.capo = tr.capo;
      st.displayTranspositionPitch = tr.type === 'keys' ? 0 : -12;
    }
    st.showTablature = stringed;
    st.showStandardNotation = true;
    score.addTrack(t);

    // alphaTab chains each voice through every bar. Empty secondary voices are renderer data only.
    const voiceCount = Math.max(1, ...tr.measures.map(meas => meas.voices.length));
    tr.measures.forEach((meas) => {
      const bar = new m.Bar();
      bar.clef = tr.type === 'drums' ? m.Clef.Neutral : tr.type === 'bass' ? m.Clef.F4 : m.Clef.G2;
      st.addBar(bar);
      const voices = Array.from({ length: voiceCount }, (_, vi) => meas.voices[vi] ?? []);
      for (const beats of voices) {
        const v = new m.Voice();
        bar.addVoice(v);
        if (!beats.length) {
          const b = new m.Beat();
          b.isEmpty = true;
          v.addBeat(b);
        }
        for (const bt of beats) v.addBeat(buildBeat(tr, bt));
      }
    });
  });

  score.finish(settings);
  return score;
}

function buildBeat(tr: Track, bt: Beat): at.model.Beat {
  const b = new m.Beat();
  b.duration = bt.duration as number as at.model.Duration;
  b.dots = bt.dots;
  if (bt.tuplet) {
    b.tupletNumerator = bt.tuplet[0];
    b.tupletDenominator = bt.tuplet[1];
  }
  if (bt.grace) b.graceType = bt.grace;
  if (bt.tremolo) {
    b.tremoloPicking = new m.TremoloPickingEffect();
    b.tremoloPicking.marks = bt.tremolo;
  }
  let maxVel = 0;
  for (const nt of bt.notes) {
    const n = new m.Note();
    if (tr.type === 'drums') n.percussionArticulation = nt.pitch!;
    else if (nt.string !== undefined) {
      n.string = tr.tuning.length - nt.string;
      n.fret = nt.fret!;
    } else {
      n.octave = Math.floor(nt.pitch! / 12);
      n.tone = nt.pitch! % 12;
    }
    n.isTieDestination = !!nt.tie;
    n.dynamics = velToDyn(nt.velocity);
    maxVel = Math.max(maxVel, nt.velocity);
    const fx = nt.fx;
    if (fx) {
      n.isDead = !!fx.dead;
      n.isGhost = !!fx.ghost;
      n.isPalmMute = !!fx.palmMute;
      n.isLetRing = !!fx.letRing;
      n.isHammerPullOrigin = !!fx.hammer;
      if (fx.slide) n.slideOutType = fx.slide;
      if (fx.slideIn) n.slideInType = fx.slideIn;
      if (fx.vibrato) n.vibrato = fx.vibrato === 'wide' ? m.VibratoType.Wide : m.VibratoType.Slight;
      if (fx.harmonic) { n.harmonicType = fx.harmonic.type; n.harmonicValue = fx.harmonic.value; }
      if (fx.accent) n.accentuated = m.AccentuationType.Normal;
      n.isStaccato = !!fx.staccato;
      if (fx.bend) for (const p of fx.bend) n.addBendPoint(new m.BendPoint(p.offset, p.value));
    }
    b.addNote(n);
  }
  if (bt.notes.length) b.dynamics = velToDyn(maxVel);
  return b;
}
