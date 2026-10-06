// Native project format (.tabproj): versioned JSON.
import type { Song } from '../model/song';

export const FORMAT_ID = 'tabproj';
export const FORMAT_VERSION = 1;

interface ProjectFile {
  format: typeof FORMAT_ID;
  version: number;
  song: Song;
}

/** migrations[n] upgrades a version-n document to version n+1. */
const migrations: Record<number, (doc: any) => any> = {};

export function serializeProject(song: Song): string {
  const doc: ProjectFile = { format: FORMAT_ID, version: FORMAT_VERSION, song };
  return JSON.stringify(doc, null, 1);
}

export function parseProject(text: string): Song {
  let doc = JSON.parse(text);
  if (doc?.format !== FORMAT_ID) throw new Error('Not a .tabproj file');
  if (typeof doc.version !== 'number' || doc.version > FORMAT_VERSION)
    throw new Error(`Unsupported project version ${doc.version} (this build reads up to ${FORMAT_VERSION})`);
  while (doc.version < FORMAT_VERSION) {
    const up = migrations[doc.version];
    if (!up) throw new Error(`No migration from version ${doc.version}`);
    doc = { ...up(doc), version: doc.version + 1 };
  }
  validate(doc.song);
  return doc.song;
}

function validate(s: Song) {
  if (!Array.isArray(s?.masterBars) || !Array.isArray(s.tracks)) throw new Error('Corrupt project: missing bars/tracks');
  for (const t of s.tracks)
    if (t.measures.length !== s.masterBars.length) throw new Error(`Corrupt project: track "${t.name}" has wrong bar count`);
}
