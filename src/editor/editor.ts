// Editor state + command execution with snapshot-based undo/redo.
// All document mutation goes through Editor.edit(); UI code never mutates the Song directly.
import { createTrack, emptyMeasure, isStringed, notePitch, MAX_FRET, HarmonicType, type Beat, type Duration, type Measure, type Song, type Track, type TrackType } from '../model/song';
import { barTicks, beatTicks, voiceTicks } from '../model/rhythm';
import { DRUM_KIT, SNARE_ROW } from '../model/drums';
import { convertTrack } from '../model/convert';
import { copyPassage, pastePassage, insertPassage, tieOrigins, type Passage } from './clipboard';
import { selectionRange, type Selection } from './selection';
import { notePositions, nextOnString, requireTransition, relationships, repairRelationships, tidyFx, NATURAL_NODES, bendCurve, type NotePosition } from './techniques';

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
  /** A different document was loaded. */
  reset?: boolean;
  /** Metadata-only changes do not regenerate playback. */
  audio?: boolean;
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
  selectionBefore: Selection | null;
  selectionAfter: Selection | null;
  audio?: boolean;
}

const clone = <T>(v: T): T => structuredClone(v);

export class Editor {
  cursor: Cursor = { track: 0, bar: 0, beat: 0, string: 0 };
  selection: Selection | null = null;
  /** Duration used for newly created beats. */
  duration: Duration = 4;
  /** Editing preference, independent of song and playback. Tab/Enter commits a string in this mode. */
  chordEntry = false;
  private chordSession: { at: string; entry: Entry } | null = null;
  dirty = false;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners: ((c: Change) => void)[] = [];
  private cursorListeners: (() => void)[] = [];
  /** Last typed digit, for multi-digit fret entry. */
  private pendingDigit: { at: string; value: number; time: number; deferred?: boolean } | null = null;
  /** Only exposed for a digit buffered to avoid temporarily breaking a harmonic/transition. */
  get fretDigits() { return this.pendingDigit?.deferred ? String(this.pendingDigit.value) : ''; }
  cancelFretEntry() { this.pendingDigit = null; this.emitCursor(); }
  private pendingDrumDigit: { at: string; value: number; time: number } | null = null;
  get drumDigits() { return this.pendingDrumDigit ? String(this.pendingDrumDigit.value) : ''; }
  clearDrumDigits() { this.pendingDrumDigit = null; }

  constructor(public song: Song) {
    if (song.tracks[0]) this.cursor.string = this.defaultRow(song.tracks[0]);
  }

  onChange(fn: (c: Change) => void) {
    this.listeners.push(fn);
  }
  onCursor(fn: () => void) {
    this.cursorListeners.push(fn);
  }

  load(song: Song) {
    this.clearDrumDigits();
    this.pendingDigit = null;
    this.chordSession = null;
    this.song = song;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = null;
    this.cursor = { track: 0, bar: 0, beat: 0, string: song.tracks[0] ? this.defaultRow(song.tracks[0]) : 0 };
    this.dirty = false;
    this.emit({ firstBar: 0, structural: true, reset: true });
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
  edit(label: string, scope: 'measure' | 'song', fn: (song: Song) => void, opts: { merge?: boolean; firstBar?: number; audio?: boolean } = {}) {
    this.clearDrumDigits();
    this.pendingDigit = null;
    const links = this.song.tracks.map(relationships);
    // A deletion can detach a transition in the previous bar; capture both ends in the same undo action.
    const crossesBar = links[this.cursor.track].some(r => r.from.bar !== r.to.bar && (r.from.bar === this.cursor.bar || r.to.bar === this.cursor.bar));
    const sc: Scope = scope === 'song' || crossesBar ? { kind: 'song' } : { kind: 'measure', track: this.cursor.track, bar: this.cursor.bar };
    const cursorBefore = { ...this.cursor };
    const selectionBefore = clone(this.selection);
    const before = this.snapshot(sc);
    fn(this.song);
    let repaired: number | null = null;
    this.song.tracks.forEach((t, i) => { const first = repairRelationships(t, links[i] ?? []); if (first !== null) repaired = Math.min(repaired ?? first, first); });
    this.normalize();
    const firstBar = Math.min(opts.firstBar ?? (scope === 'song' ? 0 : this.cursor.bar), repaired ?? Infinity);
    const entry: Entry = { label, scope: sc, before, after: this.snapshot(sc), cursorBefore, cursorAfter: { ...this.cursor }, firstBar, selectionBefore, selectionAfter: clone(this.selection), audio: opts.audio };
    const last = this.undoStack[this.undoStack.length - 1];
    if (opts.merge && last && sameScope(last.scope, sc)) {
      last.after = entry.after;
      last.cursorAfter = entry.cursorAfter;
      last.selectionAfter = entry.selectionAfter;
    } else this.undoStack.push(entry);
    this.redoStack = [];
    this.dirty = true;
    this.emit({ firstBar, structural: sc.kind === 'song', audio: opts.audio });
    this.emitCursor();
  }

  undo() {
    const partial = this.drumDigits || this.fretDigits;
    this.clearDrumDigits();
    this.pendingDigit = null;
    const e = this.undoStack.pop();
    if (!e) { if (partial) this.emitCursor(); return; }
    this.restore(e.scope, e.before);
    this.cursor = { ...e.cursorBefore };
    this.selection = clone(e.selectionBefore);
    this.redoStack.push(e);
    this.afterHistory(e);
  }

  redo() {
    const partial = this.drumDigits || this.fretDigits;
    this.clearDrumDigits();
    this.pendingDigit = null;
    const e = this.redoStack.pop();
    if (!e) { if (partial) this.emitCursor(); return; }
    this.restore(e.scope, e.after);
    this.cursor = { ...e.cursorAfter };
    this.selection = clone(e.selectionAfter);
    this.undoStack.push(e);
    this.afterHistory(e);
  }

  private afterHistory(e: Entry) {
    this.chordSession = null;
    this.clearDrumDigits();
    this.dirty = true;
    this.pendingDigit = null;
    this.clampCursor();
    this.emit({ firstBar: e.firstBar, structural: e.scope.kind === 'song', audio: e.audio });
    this.emitCursor();
  }

  private snapshot(sc: Scope) {
    return sc.kind === 'song' ? clone(this.song) : clone(this.song.tracks[sc.track].measures[sc.bar]);
  }
  private restore(sc: Scope, data: Measure | Song) {
    if (sc.kind === 'song') this.song = clone(data as Song);
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
    if (this.selection) {
      const s = this.selection;
      if (!this.song.tracks[s.track]) this.selection = null;
      else for (const p of [s.anchor, s.focus]) {
        p.bar = Math.max(0, Math.min(p.bar, this.song.masterBars.length - 1));
        p.beat = Math.max(0, Math.min(p.beat, this.song.tracks[s.track].measures[p.bar].voices[0].length - 1));
      }
    }
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

  setCursor(c: Partial<Cursor>, extend = false, kind: Selection['kind'] = 'beats') {
    this.chordSession = null;
    this.clearDrumDigits();
    const from = this.track;
    const anchor = this.selection?.anchor ?? { bar: this.cursor.bar, beat: this.cursor.beat };
    const originalTrack = this.cursor.track;
    Object.assign(this.cursor, c);
    const to = this.song.tracks[this.cursor.track];
    if (c.string === undefined && to && to !== from && to.type !== from?.type) this.cursor.string = this.defaultRow(to);
    this.pendingDigit = null;
    this.clampCursor();
    if (extend && originalTrack === this.cursor.track) this.selection = { track: this.cursor.track, anchor, focus: { bar: this.cursor.bar, beat: this.cursor.beat }, kind, rows: this.selection?.rows };
    else this.selection = null;
    this.emitCursor();
  }

  clearSelection() { this.selection = null; this.emitCursor(); }

  select(kind: Selection['kind'] = 'beats', rows?: number[]) {
    this.selection = { track: this.cursor.track, anchor: { bar: this.cursor.bar, beat: this.cursor.beat }, focus: { bar: this.cursor.bar, beat: this.cursor.beat }, kind, rows };
    this.emitCursor();
  }

  toggleSelectionRow(row: number, previous = this.selection) {
    if (!previous?.rows || previous.track !== this.cursor.track) return this.select('beats', [row]);
    const rows = previous.rows.includes(row) ? previous.rows.filter(r => r !== row) : [...previous.rows, row];
    if (!rows.length) return this.clearSelection();
    const { start, end } = selectionRange(this.song, previous), c = this.cursor;
    const outside = c.bar < start.bar || c.bar > end.bar || c.bar === start.bar && c.beat < start.beat || c.bar === end.bar && c.beat > end.beat;
    this.selection = { ...clone(previous), rows, focus: outside ? {bar:c.bar,beat:c.beat} : previous.focus };
    this.emitCursor();
  }

  selectMeasures(first: number, last = first) {
    const max = this.song.masterBars.length - 1;
    first = Math.max(0, Math.min(max, first)); last = Math.max(0, Math.min(max, last));
    this.selection = { track: this.cursor.track, kind: 'measures', anchor: { bar: first, beat: 0 }, focus: { bar: last, beat: 0 } };
    Object.assign(this.cursor, { bar: last, beat: 0 });
    this.emitCursor();
  }

  extendSelection(delta: number, measures = false) {
    const c = this.cursor;
    if (measures) return this.setCursor({ bar: c.bar + delta, beat: 0 }, true, 'measures');
    let bar = c.bar, beat = c.beat + delta;
    if (beat < 0 && bar > 0) { bar--; beat = this.track.measures[bar].voices[0].length - 1; }
    if (beat >= this.track.measures[bar].voices[0].length && bar < this.song.masterBars.length - 1) { bar++; beat = 0; }
    this.setCursor({ bar, beat }, true);
  }

  copy(): Passage {
    return copyPassage(this.song, this.selection ?? { track: this.cursor.track, kind: 'beats', anchor: this.cursor, focus: this.cursor });
  }

  cut(): Passage {
    const p = this.copy();
    const s = this.selection ?? { track: this.cursor.track, kind: 'beats', anchor: this.cursor, focus: this.cursor } as Selection;
    const { start, end } = selectionRange(this.song, s);
    this.edit('Cut', 'song', song => {
      const track = song.tracks[s.track], origins = tieOrigins(track);
      for (let bar = start.bar; bar <= end.bar; bar++) {
        const m = song.tracks[s.track].measures[bar];
        for (let vi = 0; vi < m.voices.length; vi++) {
          if (s.kind === 'beats' && vi > 0) continue;
          m.voices[vi].forEach((b, i) => {
            if (s.kind === 'beats' && (bar === start.bar && i < start.beat || bar === end.bar && i > end.beat)) return;
            b.notes = s.rows ? b.notes.filter(n => !s.rows!.includes(isStringed(song.tracks[s.track]) ? n.string! : n.pitch!)) : [];
          });
        }
      }
      const remaining = new Set(track.measures.flatMap(m => m.voices.flatMap(v => v.flatMap(b => b.notes))));
      for (const [note, origin] of origins) if (remaining.has(note) && !remaining.has(origin)) delete note.tie;
      this.selection = null;
      Object.assign(this.cursor, start);
    }, { firstBar: start.bar });
    return p;
  }

  paste(p: Passage) {
    const result = pastePassage(this.song, this.cursor.track, this.cursor, p);
    this.edit('Paste', 'song', () => { this.song = result; this.selection = null; }, { firstBar: this.cursor.bar });
  }

  duplicate() {
    const s = this.selection ?? { track: this.cursor.track, kind: 'measures', anchor: this.cursor, focus: this.cursor } as Selection;
    const { start, end } = selectionRange(this.song, s);
    const p = copyPassage(this.song, s);
    if (s.kind === 'measures' && !s.rows) {
      const startTempo = this.song.masterBars.slice(0, start.bar + 1).reduce((tempo, b) => b.tempo ?? tempo, this.song.tempo);
      const endTempo = this.song.masterBars.slice(0, end.bar + 1).reduce((tempo, b) => b.tempo ?? tempo, this.song.tempo);
      if (startTempo !== endTempo) p.bars[0].tempo = startTempo;
      const at = end.bar + 1, count = p.measures.length;
      this.edit('Duplicate measures', 'song', song => {
        song.masterBars.splice(at, 0, ...clone(p.bars));
        song.tracks.forEach((t, i) => t.measures.splice(at, 0, ...(i === s.track ? clone(p.measures) : p.measures.map(() => emptyMeasure()))));
        Object.assign(this.cursor, { track: s.track, bar: at, beat: 0 });
        this.selection = { track: s.track, kind: 'measures', anchor: { bar: at, beat: 0 }, focus: { bar: at + count - 1, beat: 0 } };
      }, { firstBar: at });
    } else {
      const at = { bar: end.bar, beat: end.beat + 1 };
      const result = insertPassage(this.song, s.track, at, p);
      const nextBar = voiceTicks(this.song.tracks[s.track].measures[at.bar].voices[0].slice(0, at.beat)) === barTicks(this.song.masterBars[at.bar]);
      this.edit('Duplicate passage', 'song', () => { this.song = result; this.selection = null; Object.assign(this.cursor, nextBar ? { bar: at.bar + 1, beat: 0 } : at); }, { firstBar: start.bar });
    }
  }

  goToMeasure(number: number) {
    if (!Number.isInteger(number) || number < 1 || number > this.song.masterBars.length) throw new Error(`Enter a measure from 1 to ${this.song.masterBars.length}.`);
    this.setCursor({ bar: number - 1, beat: 0 });
  }

  jumpMarker(delta: 1 | -1) {
    for (let i = this.cursor.bar + delta; i >= 0 && i < this.song.masterBars.length; i += delta)
      if (this.song.masterBars[i].marker) { this.setCursor({ bar: i, beat: 0 }); break; }
  }

  setMarker(label: string, bar = this.cursor.bar) {
    this.edit(label.trim() ? 'Section marker' : 'Delete marker', 'song', song => {
      if (label.trim()) song.masterBars[bar].marker = label.trim();
      else delete song.masterBars[bar].marker;
    }, { firstBar: bar, audio: false });
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
    if (this.selection) { const { end } = selectionRange(this.song, this.selection); this.setCursor(end); return; }
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
    if (this.selection) { const { start } = selectionRange(this.song, this.selection); this.setCursor(start); return; }
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

  toggleChordEntry() {
    if (!isStringed(this.track)) throw new Error('Chord entry is available on guitar and bass tracks.');
    this.chordEntry = !this.chordEntry;
    this.pendingDigit = null; this.chordSession = null;
    this.emitCursor();
  }
  advanceChordString(delta = 1) {
    const session = this.chordSession;
    this.setCursor({ string: this.cursor.string + delta });
    this.chordSession = session;
  }
  private chordMerge() {
    return this.chordEntry && this.chordSession?.at === `${this.cursor.track}:${this.cursor.bar}:${this.cursor.beat}` && this.chordSession.entry === this.undoStack.at(-1);
  }
  private rememberChord() {
    if (this.chordEntry) this.chordSession = { at: `${this.cursor.track}:${this.cursor.bar}:${this.cursor.beat}`, entry: this.undoStack.at(-1)! };
  }
  muteChordString() {
    if (this.noteAtCursor()) {
      const merge = this.chordMerge();
      this.edit('Chord entry', 'measure', () => { this.beat.notes = this.beat.notes.filter(n => n.string !== this.cursor.string); }, { merge });
      this.rememberChord();
    }
    this.advanceChordString();
  }

  /** Notes addressed by a technique command. Whole-measure selections include retained secondary voices. */
  techniqueNotes(chord = false): NotePosition[] {
    if (!isStringed(this.track)) throw new Error('This command is available on guitar and bass tracks.');
    const s = this.selection;
    let notes: NotePosition[];
    if (s && s.track === this.cursor.track) {
      const { start, end } = selectionRange(this.song, s);
      notes = notePositions(this.track).filter(p => p.bar >= start.bar && p.bar <= end.bar &&
        (s.kind === 'measures' || p.voice === 0 && (p.bar !== start.bar || p.beat >= start.beat) && (p.bar !== end.bar || p.beat <= end.beat)) && (!s.rows || s.rows.includes(p.note.string!)));
    } else notes = notePositions(this.track).filter(p => p.bar === this.cursor.bar && p.beat === this.cursor.beat && p.voice === 0 && (chord || p.note.string === this.cursor.string));
    if (!notes.length) throw new Error('Select a fretted note first.');
    return notes;
  }
  setTechnique(key: 'hammer' | 'palmMute' | 'letRing' | 'vibrato', value?: boolean | 'wide') {
    const notes = this.techniqueNotes();
    const applied = value ?? !notes.every(p => !!p.note.fx?.[key]);
    if (key !== 'vibrato' && applied === 'wide') throw new Error('Wide applies only to vibrato.');
    if (key === 'hammer' && applied) notes.forEach(p => requireTransition(this.track, p, this.song.masterBars));
    this.edit(key === 'hammer' ? 'Hammer-on / pull-off' : key, 'song', () => {
      for (const {note} of notes) {
        if (applied) { const fx = note.fx ??= {}; if (key === 'vibrato') fx.vibrato = applied; else fx[key] = true; }
        else if (note.fx) { delete note.fx[key]; tidyFx(note); }
      }
    }, { firstBar: Math.min(...notes.map(p => p.bar)) });
  }
  setBend(amount: number, release = false) {
    const notes = this.techniqueNotes(), curve = amount === 0 ? null : bendCurve(amount, release);
    this.edit('Bend', 'song', () => { for (const {note} of notes) {
      if (curve) (note.fx ??= {}).bend = clone(curve);
      else if (note.fx) { delete note.fx.bend; tidyFx(note); }
    } }, { firstBar: Math.min(...notes.map(p => p.bar)) });
  }
  setSlide(out: number, into = 0) {
    if (![0,1,2,3,4,5,6].includes(out) || ![0,1,2].includes(into)) throw new Error('Unsupported slide type.');
    const notes = this.techniqueNotes();
    if (out === 1 || out === 2) notes.forEach(p => { if (p.note.fx?.slide !== out) requireTransition(this.track, p, this.song.masterBars); });
    this.edit('Slide', 'song', () => { for (const {note} of notes) {
      const fx = note.fx ??= {}; if (out) fx.slide = out; else delete fx.slide;
      if (into) fx.slideIn = into; else delete fx.slideIn; tidyFx(note);
    } }, { firstBar: Math.min(...notes.map(p => p.bar)) });
  }
  setHarmonic(type: HarmonicType | 0, value = 12) {
    const notes = this.techniqueNotes();
    if (![0,1,2,3,4,5,6].includes(type)) throw new Error('Unsupported harmonic type.');
    if (type === HarmonicType.Natural && notes.some(p => !NATURAL_NODES[p.note.fret!])) throw new Error('Natural harmonic needs a playable touch fret (for example 5, 7, 12, 19 or 24).');
    if (type && type !== HarmonicType.Natural && (!Number.isFinite(value) || value <= 0 || value > 24)) throw new Error('Harmonic touch node must be above 0 and at most 24.');
    this.edit('Harmonic', 'song', () => { for (const {note} of notes) {
      if (type) (note.fx ??= {}).harmonic = { type, value: type === HarmonicType.Natural ? NATURAL_NODES[note.fret!] : value };
      else if (note.fx) { delete note.fx.harmonic; tidyFx(note); }
    } }, { firstBar: Math.min(...notes.map(p => p.bar)) });
  }
  /** Atomic chord/selection transforms. Restringing preserves sounding fretted pitches. */
  transformFrets(delta: number, strings = false) {
    const targets = this.techniqueNotes(true), song = clone(this.song), track = song.tracks[this.cursor.track];
    const before = relationships(track);
    const copied = targets.map(p => track.measures[p.bar].voices[p.voice][p.beat].notes.find(n => n.string === p.note.string)!);
    for (const [i, p] of targets.entries()) {
      const n = copied[i];
      if (strings) {
        if (n.fx?.harmonic) throw new Error('Remove the harmonic before moving its note to another string.');
        const row = n.string! + delta;
        if (row < 0 || row >= track.tuning.length) throw new Error('The chord would move beyond the available strings.');
        n.fret = notePitch(this.track, p.note) - track.tuning[row] - track.capo;
        n.string = row;
      } else {
        n.fret! += delta;
        if (n.fx?.harmonic?.type === HarmonicType.Natural) {
          if (!NATURAL_NODES[n.fret!]) throw new Error('The result is not a playable natural harmonic node.');
          n.fx.harmonic.value = NATURAL_NODES[n.fret!];
        }
      }
      if (!Number.isInteger(n.fret) || n.fret! < 0 || n.fret! > MAX_FRET) throw new Error(`All resulting frets must be between 0 and ${MAX_FRET}.`);
    }
    for (const m of track.measures) for (const v of m.voices) for (const b of v) {
      if (new Set(b.notes.map(n => n.string)).size !== b.notes.length) throw new Error('Moving those notes would put two notes on the same string.');
      b.notes.sort((a,b) => a.string! - b.string!);
    }
    for (const r of before) {
      if (r.from.note.string !== r.to.note.string || (r.tie ? notePitch(track, r.from.note) !== notePitch(track, r.to.note) : nextOnString(track, r.from)?.note !== r.to.note || r.from.note.fret === r.to.note.fret && r.fromFret !== r.toFret))
        throw new Error('This move would break a tie, hammer-on or slide. Select both ends of the transition.');
    }
    this.edit(strings ? 'Move chord to strings' : 'Transpose frets', 'song', () => { this.song = song; if (strings) { this.cursor.string += delta; if (this.selection?.rows) this.selection.rows = this.selection.rows.map(r => r + delta); } }, { firstBar: Math.min(...targets.map(p => p.bar)) });
  }

  /** Two-digit GM entry is atomic: the first digit never changes the song or undo history. */
  typeDrumDigit(d: number, now = performance.now()) {
    if (this.track.type !== 'drums' || !Number.isInteger(d) || d < 0 || d > 9) return;
    const p = this.pendingDrumDigit;
    if (!p || p.at !== posKey(this.cursor) || now - p.time >= 2000) {
      this.pendingDrumDigit = { at: posKey(this.cursor), value: d, time: now };
      this.emitCursor();
      return;
    }
    this.clearDrumDigits();
    const pitch = p.value * 10 + d;
    if (pitch < 35 || pitch > 81) {
      this.emitCursor();
      throw new Error('Use a General MIDI drum number from 35 to 81 (for example 38 snare, 42 hi-hat, 56 cowbell).');
    }
    this.togglePitch(pitch);
  }

  /** Type a digit: enters a fret; a second digit within the window forms a multi-digit fret (e.g. 1,2 -> 12). */
  typeDigit(d: number, now = performance.now()) {
    if (!isStringed(this.track) || !Number.isInteger(d) || d < 0 || d > 9) return;
    const at = posKey(this.cursor);
    const p = this.pendingDigit;
    if (this.chordEntry && p && p.at === at && now - p.time < 1000 && p.value * 10 + d > MAX_FRET) {
      this.pendingDigit = null; this.emitCursor();
      throw new Error(`Fret ${p.value * 10 + d} is above the maximum ${MAX_FRET}.`);
    }
    let fret = d;
    let merge = false;
    if (p && p.at === at && now - p.time < 1000 && p.value * 10 + d <= 30) {
      fret = p.value * 10 + d;
      merge = !p.deferred;
    }
    // Keep existing techniques intact while entering a multi-digit fret whose prefix is not playable.
    if (fret === d && [1,2,3].includes(d) && this.fretConflict(d)) {
      this.pendingDigit = {at,value:d,time:now,deferred:true};
      this.emitCursor(); return;
    }
    if (p?.deferred && p.at === at && now - p.time < 1000 && p.value * 10 + d > MAX_FRET) {
      this.pendingDigit = null; this.emitCursor(); throw new Error(`Fret must be between 0 and ${MAX_FRET}.`);
    }
    this.setFret(fret, merge);
    this.pendingDigit = merge || p?.deferred && fret !== d ? null : { at, value: d, time: now };
  }

  private fretConflict(fret: number) {
    const note = this.noteAtCursor();
    if (!note || note.fret === fret) return '';
    if (note.fx?.harmonic?.type === HarmonicType.Natural && !NATURAL_NODES[fret]) return 'Remove the natural harmonic before entering a fret without a harmonic touch node.';
    if (relationships(this.track).some(r => !r.tie && (r.from.note === note && r.to.note.fret === fret || r.to.note === note && r.from.note.fret === fret)))
      return 'That fret would make a hammer-on or slide target equal to its origin. Change or remove the transition first.';
    return '';
  }

  setFret(fret: number, merge = false) {
    if (!isStringed(this.track)) throw new Error('Fret entry requires a guitar or bass track.');
    if (!Number.isInteger(fret) || fret < 0 || fret > MAX_FRET) throw new Error(`Fret must be between 0 and ${MAX_FRET}.`);
    const s = this.cursor.string;
    const conflict = this.fretConflict(fret);
    if (conflict) throw new Error(conflict);
    this.edit(
      this.chordEntry ? 'Chord entry' : `Fret ${fret}`,
      'measure',
      () => {
        const b = this.beat;
        const existing = b.notes.find((n) => n.string === s);
        if (existing) {
          if (existing.fret !== fret && existing.fx?.harmonic?.type === HarmonicType.Natural) existing.fx.harmonic.value = NATURAL_NODES[fret];
          existing.fret = fret;
          delete existing.tie;
        } else {
          b.notes.push({ string: s, fret, velocity: 95 });
          b.notes.sort((x, y) => x.string! - y.string!);
        }
      },
      { merge: merge || this.chordMerge() },
    );
    this.rememberChord();
  }

  /** Toggle a drum/keys pitch at the cursor beat and move the row cursor to it. */
  togglePitch(pitch: number) {
    if (isStringed(this.track)) return;
    this.clearDrumDigits();
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
        this.selection = null;
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
        this.selection = null;
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
      this.selection = null;
      this.cursor = { track: s.tracks.length - 1, bar: this.cursor.bar, beat: 0, string: this.defaultRow(t) };
    });
  }

  removeTrack(index = this.cursor.track) {
    if (this.song.tracks.length <= 1) return;
    this.edit('Remove track', 'song', (s) => {
      s.tracks.splice(index, 1);
      this.selection = null;
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
    }, { audio: Object.keys(props).some(k => k !== 'name') });
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
  songEdit(label: string, fn: (s: Song) => void, opts: { merge?: boolean } = {}) {
    this.edit(label, 'song', fn, opts);
  }

  /** Label of the most recent undoable edit (for merging repeated steps such as tempo spinner clicks). */
  get lastUndoLabel(): string | undefined {
    return this.undoStack[this.undoStack.length - 1]?.label;
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
