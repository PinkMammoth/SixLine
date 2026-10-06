// Standard MIDI File export. Uses alphaTab's MidiFileGenerator, the same generator that feeds the
// playback synth, so the exported file and playback are semantically identical.
import * as at from '@coderline/alphatab';
import type { Song } from '../model/song';
import { songToScore } from './alphatab';

/** Generate the MIDI event model used by both playback and export. */
export function generateMidi(song: Song, settings = new at.Settings()): at.midi.MidiFile {
  const score = songToScore(song, settings);
  const mf = new at.midi.MidiFile();
  mf.format = at.midi.MidiFileFormat.MultiTrack;
  new at.midi.MidiFileGenerator(score, settings, new at.midi.AlphaSynthMidiFileHandler(mf, true)).generate();
  return mf;
}

/** Song -> SMF (format 1, one MIDI track per song track, 960 PPQ). */
export function exportMidi(song: Song, settings = new at.Settings()): Uint8Array {
  return addTrackNames(generateMidi(song, settings).toBinary(), song.tracks.map((t) => t.name));
}

/** Prepend a SequenceOrTrackName meta event (FF 03) to each MTrk chunk. */
function addTrackNames(smf: Uint8Array, names: string[]): Uint8Array {
  const out: number[] = [];
  const u32 = (i: number) => ((smf[i] << 24) | (smf[i + 1] << 16) | (smf[i + 2] << 8) | smf[i + 3]) >>> 0;
  let pos = 0;
  let track = 0;
  while (pos + 8 <= smf.length) {
    const id = String.fromCharCode(...smf.subarray(pos, pos + 4));
    const len = u32(pos + 4);
    const body = smf.subarray(pos + 8, pos + 8 + len);
    if (id === 'MTrk' && track < names.length) {
      const name = Array.from(new TextEncoder().encode(names[track++])).slice(0, 127);
      const meta = [0x00, 0xff, 0x03, name.length, ...name];
      pushChunk(out, id, [...meta, ...body]);
    } else pushChunk(out, id, Array.from(body));
    pos += 8 + len;
  }
  return new Uint8Array(out);
}

function pushChunk(out: number[], id: string, body: number[]) {
  for (const c of id) out.push(c.charCodeAt(0));
  const n = body.length;
  out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  for (const b of body) out.push(b);
}
