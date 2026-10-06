import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import { loadGpBytes } from '../src/io/alphatab';
import { fixture, playedNotes, root, songNotes } from './helpers';

const fixtures = ['fixtures/fixture.gp3', 'fixtures/fixture.gp4', 'fixtures/fixture.gp5'];
const examples = fs.existsSync(path.join(root, 'gp5-examples'))
  ? fs.readdirSync(path.join(root, 'gp5-examples')).filter((f) => f.endsWith('.gp5')).map((f) => 'gp5-examples/' + f)
  : [];

describe('GP import', () => {
  it.each(fixtures)('loads %s into the song model', (f) => {
    const song = loadGpBytes(fixture(f));
    expect(song.title).toBe('Fixture Riff');
    expect(song.tempo).toBe(110);
    expect(song.masterBars).toHaveLength(4);
    expect(song.tracks.map((t) => t.type)).toEqual(['guitar', 'bass', 'drums']);
    expect(song.tracks[0].tuning).toEqual([64, 59, 55, 50, 45, 40]);
    expect(song.tracks[1].tuning).toEqual([43, 38, 33, 28]);
    // first guitar beat: low E open (string index 5 = lowest)
    expect(song.tracks[0].measures[0].voices[0][0].notes[0]).toMatchObject({ string: 5, fret: 0 });
    // multi-digit frets survive
    expect(song.tracks[0].measures[2].voices[0].map((b) => b.notes[0].fret)).toEqual([12, 10, 15, 14]);
    // drums carry GM keys
    expect(song.tracks[2].measures[0].voices[0][0].notes.map((n) => n.pitch).sort()).toEqual([36, 42]);
  });

  it.each([...fixtures, ...examples])('round-trips %s through our model without changing played notes', (f) => {
    const original = at.importer.ScoreLoader.loadScoreFromBytes(fixture(f), new at.Settings());
    const song = loadGpBytes(fixture(f));
    const a = playedNotes(original).map((s) => s.split(':').slice(0, 2).join(':'));
    const b = songNotes(song).map((s) => s.split(':').slice(0, 2).join(':'));
    expect(b.length).toBe(a.length);
    expect(b).toEqual(a);
  });
});
