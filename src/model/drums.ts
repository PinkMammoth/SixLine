// General MIDI percussion kit pieces used for drum entry. Order = top to bottom in the drum grid.

export interface DrumPiece {
  key: number;
  name: string;
  /** Single-letter entry shortcut (drum tracks only). */
  shortcut?: string;
}

export const DRUM_KIT: DrumPiece[] = [
  { key: 49, name: 'Crash', shortcut: 'c' },
  { key: 57, name: 'Crash 2' },
  { key: 55, name: 'Splash' },
  { key: 52, name: 'China' },
  { key: 51, name: 'Ride', shortcut: 'r' },
  { key: 53, name: 'Ride bell', shortcut: 'b' },
  { key: 46, name: 'Open hi-hat', shortcut: 'o' },
  { key: 42, name: 'Closed hi-hat', shortcut: 'h' },
  { key: 44, name: 'Pedal hi-hat', shortcut: 'p' },
  { key: 50, name: 'High tom', shortcut: 't' },
  { key: 48, name: 'Hi-mid tom' },
  { key: 47, name: 'Low-mid tom', shortcut: 'm' },
  { key: 45, name: 'Low tom', shortcut: 'l' },
  { key: 43, name: 'High floor tom' },
  { key: 41, name: 'Floor tom', shortcut: 'f' },
  { key: 38, name: 'Snare', shortcut: 's' },
  { key: 37, name: 'Side stick', shortcut: 'x' },
  { key: 40, name: 'Electric snare' },
  { key: 39, name: 'Hand clap' },
  { key: 36, name: 'Kick', shortcut: 'k' },
  { key: 35, name: 'Acoustic kick' },
];

export const DRUM_BY_SHORTCUT = new Map(DRUM_KIT.filter((d) => d.shortcut).map((d) => [d.shortcut!, d]));

const GM_NAMES: Record<number, string> = {
  54: 'Tambourine', 56: 'Cowbell', 58: 'Vibraslap', 59: 'Ride 2', 60: 'Hi bongo', 61: 'Low bongo', 62: 'Mute hi conga',
  63: 'Open hi conga', 64: 'Low conga', 69: 'Cabasa', 70: 'Maracas', 75: 'Claves', 76: 'Hi wood block', 77: 'Low wood block',
  65: 'High timbale', 66: 'Low timbale', 67: 'High agogo', 68: 'Low agogo', 71: 'Short whistle', 72: 'Long whistle',
  73: 'Short guiro', 74: 'Long guiro', 78: 'Mute cuica', 79: 'Open cuica', 80: 'Mute triangle', 81: 'Open triangle',
};

// Keep existing row indices stable and make every standard GM drum addressable by the caret.
for (const [key, name] of Object.entries(GM_NAMES)) DRUM_KIT.push({ key: Number(key), name });

export function drumName(key: number): string {
  return DRUM_KIT.find((d) => d.key === key)?.name ?? GM_NAMES[key] ?? `Perc ${key}`;
}

export const SNARE_ROW = DRUM_KIT.findIndex((d) => d.key === 38);
