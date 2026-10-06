import { describe, expect, it } from 'vitest';
import { parseProject, serializeProject, FORMAT_VERSION } from '../src/io/project';
import { loadGpBytes } from '../src/io/alphatab';
import { createSong } from '../src/model/song';
import { fixture, songNotes } from './helpers';

describe('.tabproj', () => {
  it('round-trips a new song', () => {
    const s = createSong({ tracks: ['guitar', 'bass', 'drums', 'keys'], tempo: 140, num: 3, den: 4 });
    expect(parseProject(serializeProject(s))).toEqual(s);
  });
  it('round-trips an imported GP file exactly, including playback', () => {
    const s = loadGpBytes(fixture('fixtures/fixture.gp5'));
    const back = parseProject(serializeProject(s));
    expect(back).toEqual(JSON.parse(JSON.stringify(s)));
    expect(songNotes(back)).toEqual(songNotes(s));
  });
  it('writes format id and version', () => {
    const doc = JSON.parse(serializeProject(createSong()));
    expect(doc.format).toBe('tabproj');
    expect(doc.version).toBe(FORMAT_VERSION);
  });
  it('rejects foreign, future and corrupt files', () => {
    expect(() => parseProject('{"format":"other"}')).toThrow(/Not a/);
    expect(() => parseProject(JSON.stringify({ format: 'tabproj', version: 999, song: createSong() }))).toThrow(/Unsupported/);
    const bad = createSong();
    bad.tracks[0].measures.pop();
    expect(() => parseProject(JSON.stringify({ format: 'tabproj', version: 1, song: bad }))).toThrow(/bar count/);
  });
});
