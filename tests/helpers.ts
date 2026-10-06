import fs from 'node:fs';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import { songToScore } from '../src/io/alphatab';
import type { Song } from '../src/model/song';

export const root = path.resolve(__dirname, '..');
export const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(root, name)));

/** Render a Song through alphaTab's MIDI generator; return sorted note events per channel. */
export function playedNotes(score: at.model.Score) {
  const mf = new at.midi.MidiFile();
  new at.midi.MidiFileGenerator(score, new at.Settings(), new at.midi.AlphaSynthMidiFileHandler(mf, true)).generate();
  const notes: string[] = [];
  for (const ev of mf.events as any[]) {
    if (ev.type === at.midi.MidiEventType.NoteOn && ev.noteVelocity > 0) notes.push(`${ev.tick}:${ev.noteKey}:${ev.channel}`);
  }
  return notes.sort();
}

export const songNotes = (song: Song) => playedNotes(songToScore(song, new at.Settings()));
