// Editor state + command execution with snapshot-based undo/redo.
// All document mutation goes through Editor.edit(); UI code never mutates the Song directly.
import { createTrack, emptyMeasure, isStringed, type Beat, type Duration, type Measure, type Song, type Track, type TrackType } from '../model/song';
import { barTicks, beatTicks, voiceTicks } from '../model/rhythm';
import { DRUM_KIT, SNARE_ROW } from '../model/drums';
import { convertTrack } from '../model/convert';

export interface Cursor {
  track: number;
  bar: number;
  beat: number;
  /** Vertical row: string index (0 = highest) on tab tracks, DRUM_KIT index on drums, 127 - pitch on keys. */
  string: number;
}

export interface Change {
  /** First master bar index affected (for incremental re-rendering). */
  firstBar: number;
  /** Bar count / track list / track properties changed. */
  structural: boolean;
}

type Scope = { kind: 'measure'; track: number; bar: number } | { kind: 'song' };

interface Entry {
  label: string;
  scope: Scope;
  before: Measure | Song;
  after: Measure | Song;
  cursorBefore: Cursor;
  cursorAfter: Cursor;
  firstBar: number;
}

const clone = <T>(v: T): T => structuredClone(v);

export class Editor {
  cursor: Cursor = { track: 0, bar: 0, beat: 0, string: 0 };
  /** Duration used for newly created beats. */
  duration: Duration = 4;
  dirty = false;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners: ((c: Change) => void)[] = [];
  private cursorListeners: (() => void)[] = [];
  /** Last typed digit, for multi-digit fret entry. */
  private pendingDigit: { at: string; value: number; time: number } | null = null;

  constructor(public song: Song) {}

  onChange(fn: (c: Change) => void) {
    this.listeners.push(fn);
  }
  onCursor(fn: () => void) {
    this.cursorListeners.push(fn);
  }

  load(song: Song) {
    this.song = song;
    this.undoStack = [];
    this.redoStack = [];
    this.cursor = { track: 0, bar: 0, beat: 0, string: song.tracks[0] ? this.defaultRow(song.tracks[0]) : 0 };
    this.dirty = false;
    this.emit({ firstBar: 0, structural: true });
    this.emitCursor();
  }

  get track() {
    return this.song.tracks[this.cursor.track];
  }
  get measure() {
    return this.track.measures[this.cursor.bar];
  }
  get beats(): Beat[] {
    return this.measure.voices[0];
  }
  get beat(): Beat {
    return this.beats[this.cursor.beat];
  }
  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }
  /** Number of rows the cursor moves over vertically. */
  get rowCount() {
    const t = this.track;
    return isStringed(t) ? t.tuning.length : t.type === 'drums' ? DRUM_KIT.length : 128;
  }

  /** MIDI/GM key addressed by a row on drum and keys tracks. */
  rowPitch(row = this.cursor.string, track: Track = this.track): number {
    return track.type === 'drums' ? DRUM_KIT[row]?.key ?? 38 : 127 - row;
  }

  rowForPitch(pitch: number, track: Track = this.track): number {
    if (track.type === 'drums') {
      const i = DRUM_KIT.findIndex((d) => d.key === pitch);
      return i >= 0 ? i : this.cursor.string;
    }
    return 127 - pitch;
  }

  private defaultRow(t: Track) {
    if (t.type === 'drums') return SNARE_ROW;
    if (t.type === 'keys') return 127 - 60;
    return 0;
  }

  // ------------------------------------------------------------ core edit machinery

  /**
   * Apply a mutation. scope 'measure' snapshots only the cursor's measure; 'song' snapshots everything.
   * merge=true folds this edit into the previous undo entry (used for multi-digit fret entry).
   */
  edit(label: string, scope: 'measure' | 'song', fn: (song: Song) => void, opts: { merge?: boolean; firstBar?: number } = {}) {
    const sc: Scope = scope === 'song' ? { kind: 'song' } : { kind: 'measure', track: this.cursor.track, bar: this.cursor.bar };
    const cursorBefore = { ...this.cursor };
    const before = this.snapshot(sc);
    fn(this.song);
    this.normalize();
    const firstBar = opts.firstBar ?? (sc.kind === 'measure' ? sc.bar : 0);
    const entry: Entry = { label, scope: sc, before, after: this.snapshot(sc), cursorBefore, cursorAfter: { ...this.cursor }, firstBar };
    const last = this.undoStack[this.undoStack.length - 1];
    if (opts.merge && last && sameScope(last.scope, sc)) {
      last.after = entry.after;
      last.cursorAfter = entry.cursorAfter;
    } else this.undoStack.push(entry);
    this.redoStack = [];
    this.dirty = true;
    this.emit({ firstBar, structural: sc.kind === 'song' });
    this.emitCursor();
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.restore(e.scope, e.before);
    this.cursor = { ...e.cursorBefore };
    this.redoStack.push(e);
    this.afterHistory(e);
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.restore(e.scope, e.after);
    this.cursor = { ...e.cursorAfter };
    this.undoStack.push(e);
    this.afterHistory(e);
  }

  private afterHistory(e: Entry) {
    this.dirty = true;
    this.pendingDigit = null;
    this.clampCursor();
    this.emit({ firstBar: e.firstBar, structural: e.scope.kind === 'song' });
    this.emitCursor();
  }

  private snapshot(sc: Scope) {
    return sc.kind === 'song' ? clone(this.song) : clone(this.song.tracks[sc.track].measures[sc.bar]);
  }
  private restore(sc: Scope, data: Measure | Song) {
    if (sc.kind === 'song') Object.assign(this.song, clone(data as Song));
    else this.song.tracks[sc.track].measures[sc.bar] = clone(data as Measure);
  }

  /** Invariants: every measure has a primary voice with at least one beat. */
  private normalize() {
    for (const t of this.song.tracks)
      for (let i = 0; i < t.measures.length; i++) {
        const m = t.measures[i];
        if (!m.voices.length) m.voices.push([]);
        if (!m.voices[0].length) m.voices[0].push({ duration: this.duration, dots: 0, notes: [] });
      }
    this.clampCursor();
  }

  clampCursor() {
    const c = this.cursor;
    c.track = Math.max(0, Math.min(c.track, this.song.tracks.length - 1));
    c.bar = Math.max(0, Math.min(c.bar, this.song.masterBars.length - 1));
    c.beat = Math.max(0, Math.min(c.beat, this.beats.length - 1));
    c.string = Math.max(0, Math.min(c.string, this.rowCount - 1));
  }

  private emit(c: Change) {
    for (const l of this.listeners) l(c);
  }
  emitCursor() {
    for (const l of this.cursorListeners) l();
  }

  setCursor(c: Partial<Cursor>) {
    const from = this.track;
    Object.assign(this.cursor, c);
    const to = this.song.tracks[this.cursor.track];
    if (c.string === undefined && to && to !== from && to.type !== from?.type) this.cursor.string = this.defaultRow(to);
    this.pendingDigit = null;
    this.clampCursor();
    this.emitCursor();
  }

  // ------------------------------------------------------------ queries

  barFull(bar = this.cursor.bar) {
    return voiceTicks(this.track.measures[bar].voices[0]) >= barTicks(this.song.masterBars[bar]);
  }

  barOverfull(bar = this.cursor.bar) {
    return voiceTicks(this.track.measures[bar].voices[0]) > barTicks(this.song.masterBars[bar]);
  }

  noteAtCursor() {
    if (isStringed(this.track)) return this.beat.notes.find((n) => n.string === this.cursor.string);
    const p = this.rowPitch();
    return this.beat.notes.find((n) => n.pitch === p);
  }

  // ------------------------------------------------------------ navigation

  moveString(delta: number) {
    this.setCursor({ string: this.cursor.string + delta });
  }

  /** Right: next beat; past the end of an unfilled bar appends a rest; past a full bar goes to next bar (adding one at the end). */
  moveRight() {
    const c = this.cursor;
    if (c.beat < this.beats.length - 1) return this.setCursor({ beat: c.beat + 1 });
    if (!this.barFull()) {
      const remaining = barTicks(this.song.masterBars[c.bar]) - voiceTicks(this.beats);
      const dur = fitDuration(this.duration, remaining);
      this.edit('Add beat', 'measure', () => {
        this.beats.push({ duration: dur, dots: 0, notes: [] });
        c.beat = this.beats.length - 1;
      });
      return;
    }
    if (c.bar === this.song.masterBars.length - 1) {
      this.insertBars(c.bar + 1, 1);
      this.setCursor({ bar: c.bar + 1, beat: 0 });
      return;
    }
    this.setCursor({ bar: c.bar + 1, beat: 0 });
  }

  moveLeft() {
    const c = this.cursor;
    if (c.beat > 0) return this.setCursor({ beat: c.beat - 1 });
    if (c.bar > 0) {
      const prev = this.track.measures[c.bar - 1].voices[0];
      this.setCursor({ bar: c.bar - 1, beat: prev.length - 1 });
    }
  }

  moveBar(delta: number) {
    this.setCursor({ bar: this.cursor.bar + delta, beat: 0 });
  }

  // ------------------------------------------------------------ note editing

  /** Type a digit: enters a fret; a second digit within the window forms a multi-digit fret (e.g. 1,2 -> 12). */
  typeDigit(d: number, now = performance.now()) {
    if (!isStringed(this.track)) return;
    const at = posKey(this.cursor);
    const p = this.pendingDigit;
    let fret = d;
    let merge = false;
    if (p && p.at === at && now - p.time < 1000 && p.value * 10 + d <= 30) {
      fret = p.value * 10 + d;
      merge = true;
    }
    this.setFret(fret, merge);
    this.pendingDigit = merge ? null : { at, value: d, time: now };
  }

  setFret(fret: number, merge = false) {
    const s = this.cursor.string;
    this.edit(
      `Fret ${fret}`,
      'measure',
      () => {
        const b = this.beat;
        const existing = b.notes.find((n) => n.string === s);
        if (existing) {
          existing.fret = fret;
          delete existing.tie;
        } else {
          b.notes.push({ string: s, fret, velocity: 95 });
          b.notes.sort((x, y) => x.string! - y.string!);
        }
      },
      { merge },
    );
  }

  /** Toggle a drum/keys pitch at the cursor beat and move the row cursor to it. */
  togglePitch(pitch: number) {
    if (isStringed(this.track)) return;
    this.edit(`Note ${pitch}`, 'measure', () => {
      const b = this.beat;
      const i = b.notes.findIndex((n) => n.pitch === pitch);
      if (i >= 0) b.notes.splice(i, 1);
      else {
        b.notes.push({ pitch, velocity: 95 });
        b.notes.sort((x, y) => y.pitch! - x.pitch!);
      }
      this.cursor.string = this.rowForPitch(pitch);
    });
  }

  /** Drums/keys: toggle the note on the cursor row. */
  toggleAtCursor() {
    if (!isStringed(this.track)) this.togglePitch(this.rowPitch());
  }

  /** Keys: enter note name (a-g) in the octave nearest the cursor pitch. */
  typeNoteName(letter: string) {
    if (this.track.type !== 'keys') return;
    const pc = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[letter.toLowerCase()];
    if (pc === undefined) return;
    const ref = this.rowPitch();
    let best = pc;
    for (let p = pc; p <= 127; p += 12) if (Math.abs(p - ref) < Math.abs(best - ref)) best = p;
    this.togglePitch(best);
  }

  /** Keys: move the note under the cursor by `delta` semitones (cursor follows). */
  transposeNote(delta: number) {
    if (this.track.type !== 'keys') return;
    const n = this.noteAtCursor();
    const to = (n?.pitch ?? 0) + delta;
    if (!n || to < 0 || to > 127 || this.beat.notes.some((x) => x.pitch === to)) return;
    this.edit('Transpose note', 'measure', () => {
      this.noteAtCursor()!.pitch = to;
      this.beat.notes.sort((x, y) => y.pitch! - x.pitch!);
      this.cursor.string = this.rowForPitch(to);
    });
  }

  deleteNote() {
    const n = this.noteAtCursor();
    if (!n) {
      // nothing on this row: if the whole beat is a rest, remove the beat instead (GP-like)
      if (!this.beat.notes.length && this.beats.length > 1) this.deleteBeat();
      return;
    }
    this.edit('Delete note', 'measure', () => {
      this.beat.notes.splice(this.beat.notes.indexOf(n), 1);
    });
  }

  clearBeat() {
    this.edit('Clear beat', 'measure', () => {
      this.beat.notes = [];
    });
  }

  // ------------------------------------------------------------ rhythm editing

  setDuration(d: Duration) {
    this.duration = d;
    if (this.beat.duration === d) return this.emitCursor();
    this.edit(`Duration 1/${d}`, 'measure', () => {
      this.beat.duration = d;
    });
  }

  /** Shorter (+1) or longer (-1) note value. */
  stepDuration(dir: 1 | -1) {
    const order: Duration[] = [1, 2, 4, 8, 16, 32, 64];
    const i = order.indexOf(this.beat.duration) + dir;
    if (i >= 0 && i < order.length) this.setDuration(order[i]);
  }

  toggleDot() {
    this.edit('Dot', 'measure', () => {
      this.beat.dots = this.beat.dots ? 0 : 1;
    });
  }

  toggleTriplet() {
    this.edit('Triplet', 'measure', () => {
      if (this.beat.tuplet) delete this.beat.tuplet;
      else this.beat.tuplet = [3, 2];
    });
  }

  insertBeat() {
    this.edit('Insert beat', 'measure', () => {
      this.beats.splice(this.cursor.beat, 0, { duration: this.duration, dots: 0, notes: [] });
    });
  }

  deleteBeat() {
    this.edit('Delete beat', 'measure', () => {
      this.beats.splice(this.cursor.beat, 1);
      if (this.cursor.beat >= this.beats.length) this.cursor.beat = Math.max(0, this.beats.length - 1);
    });
  }

  // ------------------------------------------------------------ bar editing (song scope)

  insertBars(at: number, count: number) {
    this.edit(
      'Insert bar',
      'song',
      (s) => {
        const ref = s.masterBars[Math.min(at, s.masterBars.length - 1)] ?? { num: 4, den: 4 };
        s.masterBars.splice(at, 0, ...Array.from({ length: count }, () => ({ num: ref.num, den: ref.den })));
        for (const t of s.tracks) t.measures.splice(at, 0, ...Array.from({ length: count }, () => emptyMeasure()));
      },
      { firstBar: at },
    );
  }

  deleteBar(at = this.cursor.bar) {
    if (this.song.masterBars.length <= 1) return;
    this.edit(
      'Delete bar',
      'song',
      (s) => {
        // keep the tempo change of a deleted bar on the following bar
        const removed = s.masterBars[at];
        s.masterBars.splice(at, 1);
        if (removed.tempo !== undefined && s.masterBars[at] && s.masterBars[at].tempo === undefined) s.masterBars[at].tempo = removed.tempo;
        for (const t of s.tracks) t.measures.splice(at, 1);
        this.cursor.beat = 0;
      },
      { firstBar: at },
    );
  }

  // ------------------------------------------------------------ tracks

  addTrack(type: TrackType) {
    this.edit('Add track', 'song', (s) => {
      const n = s.tracks.filter((t) => t.type === type).length;
      const t = createTrack(type, s.masterBars.length);
      if (n) t.name += ' ' + (n + 1);
      s.tracks.push(t);
      this.cursor = { track: s.tracks.length - 1, bar: this.cursor.bar, beat: 0, string: this.defaultRow(t) };
    });
  }

  removeTrack(index = this.cursor.track) {
    if (this.song.tracks.length <= 1) return;
    this.edit('Remove track', 'song', (s) => {
      s.tracks.splice(index, 1);
      this.cursor.beat = 0;
    });
  }

  /** Update track properties. Changing the string count drops notes on removed strings. */
  setTrackProps(index: number, props: Partial<Pick<Track, 'name' | 'program' | 'tuning' | 'capo' | 'volume' | 'pan'>>) {
    this.edit('Track properties', 'song', (s) => {
      const t = s.tracks[index];
      Object.assign(t, props);
      if (props.tuning)
        for (const m of t.measures) for (const v of m.voices) for (const b of v) b.notes = b.notes.filter((n) => n.string === undefined || n.string < t.tuning.length);
    });
  }

  /** Change a track's type (pitches kept; guitar/bass get automatic fingering). Returns notes that could not be placed. */
  setTrackType(index: number, type: TrackType, tuning?: number[]): number {
    const src = this.song.tracks[index];
    if (src.type === type && !tuning) return 0;
    const { track, dropped } = convertTrack(src, type, tuning);
    this.edit('Change track type', 'song', (s) => {
      s.tracks[index] = track;
      if (index === this.cursor.track) this.cursor.string = this.defaultRow(track);
    });
    return dropped;
  }

  /** Set the time signature from `bar` onwards, up to the next bar that had a different signature. */
  setTimeSignature(num: number, den: number, bar = this.cursor.bar) {
    this.edit(
      `Time signature ${num}/${den}`,
      'song',
      (s) => {
        const old = s.masterBars[bar];
        const [on, od] = [old.num, old.den];
        for (let i = bar; i < s.masterBars.length && s.masterBars[i].num === on && s.masterBars[i].den === od; i++) {
          s.masterBars[i].num = num;
          s.masterBars[i].den = den;
        }
      },
      { firstBar: bar },
    );
  }

  /** Generic song-level mutation (track settings, tempo, time signature...). */
  songEdit(label: string, fn: (s: Song) => void) {
    this.edit(label, 'song', fn);
  }
}

function sameScope(a: Scope, b: Scope) {
  return a.kind === b.kind && (a.kind === 'song' || (b.kind === 'measure' && a.track === b.track && a.bar === b.bar));
}

const posKey = (c: Cursor) => `${c.track}:${c.bar}:${c.beat}:${c.string}`;

/** Largest plain duration <= preferred that fits in the remaining ticks. */
export function fitDuration(preferred: Duration, remaining: number): Duration {
  const order: Duration[] = [1, 2, 4, 8, 16, 32, 64];
  for (const d of order.slice(order.indexOf(preferred))) if (beatTicks({ duration: d, dots: 0 }) <= remaining) return d;
  return 64;
}
