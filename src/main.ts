import './ui/style.css';
import * as at from '@coderline/alphatab';
import { Editor } from './editor/editor';
import { createSong, isStringed, type Duration, type Song } from './model/song';
import { loadGpBytes, songToScore } from './io/alphatab';
import { parseProject, serializeProject } from './io/project';
import { exportMidi } from './io/midiExport';
import { buildSong, parseMidiBytes, proposeMapping } from './io/midiImport';
import { importDialog, reportDialog } from './ui/importDialog';
import { initialFile, onOpenFile, openFile, saveFile, type OpenedFile } from './platform/host';
import { buildMenus, type MenuDef } from './ui/menu';
import { locateCaret } from './ui/caret';
import { newSongDialog, pitchName, timeSignatureDialog, trackDialog, unsavedDialog, measureDialog, markerDialog } from './ui/dialogs';
import { selectionRange } from './editor/selection';
import type { Passage } from './editor/clipboard';
import { PracticeState, CountIn, tempoAtBar, clampLoopTick } from './playback/practice';
import { Metronome, elapsedMs, type ClickBar } from './playback/metronome';
import { bindDrumGrid, renderDrumGrid } from './ui/drumgrid';
import { DRUM_BY_SHORTCUT, drumName } from './model/drums';
import { bindDrumScore, renderDrumScore, updateDrumSelection, drumCaret } from './ui/drumscore';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ state

/** An open document (one tab). */
interface Doc {
  editor: Editor;
  filePath: string | null;
  fileName: string;
  scrollTop: number;
  practice: PracticeState;
}
const docs: Doc[] = [];
let active: Doc = newDoc(createSong({ tracks: ['guitar'] }), null, 'Untitled.tabproj');
docs.push(active);
/** The active document's editor. Every command acts on it. */
let editor = active.editor;
/** Scroll position to restore after the next render (when switching tabs). */
let restoreScroll: number | null = null;
let score: at.model.Score | null = null;
let renderedTrack = -1;
let pendingFirstBar: number | null = null;
let pendingStructural = false;
let pendingReset = false;
/** Track count and bar count of the last rendered score; alphaTab can only redraw in place if unchanged. */
let renderedShape = '';
let renderQueued = false;
let rendering = false;
let renderStart = 0;
let lastRenderMs = 0;
let playerState = 0; // 0 paused/stopped, 1 playing
let playerPos = { current: 0, end: 0 };
let message = '';
let messageTimer = 0;
let clipboard: Passage | null = null;
const countIn = new CountIn();
const metronome = new Metronome();
let clickBars: ClickBar[] = [];
let pendingAudio = false;
let resumePlayback: { tick: number; playing: boolean } | null = null;
type DrumMode = 'letters' | 'numbers';
type DrumView = 'notation' | 'numbers';
function preference(key: string, fallback: string) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
let drumInput: DrumMode = preference('sixline.drumInput', 'letters') === 'numbers' ? 'numbers' : 'letters';
let drumView: DrumView = preference('sixline.drumView', 'notation') === 'numbers' ? 'numbers' : 'notation';
let drumEntryTimer = 0;
const numberScoreVisible = () => editor.track.type === 'drums' && drumView === 'numbers';

// ------------------------------------------------------------------ alphaTab

buildToolbar(); // before the API: alphaTab's .on() fires immediately with current state

const api = new at.AlphaTabApi($('at'), {
  core: { fontDirectory: './font/', includeNoteBounds: true, useWorkers: false },
  display: { scale: 1.0, layoutMode: at.LayoutMode.Page, staveProfile: at.StaveProfile.Default },
  notation: { rhythmMode: at.TabRhythmMode.ShowWithBars },
  player: {
    playerMode: at.PlayerMode.EnabledSynthesizer,
    soundFont: './soundfont/sonivox.sf2',
    scrollElement: $('score'),
    enableCursor: true,
    enableUserInteraction: false,
    // auto-scroll follows playback only while playing; otherwise the view follows the edit caret
    scrollMode: at.ScrollMode.Off,
  },
} as any);

api.renderStarted.on(() => {
  rendering = true;
});
api.renderFinished.on(() => {
  rendering = false;
  lastRenderMs = performance.now() - renderStart;
  if (restoreScroll !== null) {
    $('score').scrollTop = restoreScroll;
    restoreScroll = null;
  }
  updateDrumView(true);
  updateCaret();
  updateStatus();
  if (renderQueued) flushRender();
});
api.playerStateChanged.on((e) => {
  playerState = e.state;
  if (e.state !== 1) metronome.cancel();
  else if (active.practice.metronome) metronome.update(clickBars, api.tickPosition, active.practice.speed, active.practice.looping ? active.practice.loop : null);
  const mode = e.state === 1 && !numberScoreVisible() ? at.ScrollMode.Continuous : at.ScrollMode.Off;
  if (api.settings.player.scrollMode !== mode) {
    api.settings.player.scrollMode = mode;
    api.updateSettings();
  }
  updateToolbar();
});
api.playerPositionChanged.on((e) => {
  const loop = active.practice.looping ? active.practice.loop : null;
  const tick = clampLoopTick(e.currentTick, loop);
  if (tick !== e.currentTick) {
    // AlphaTab gates MIDI at the exact end, but reports elapsed audio-buffer time past it.
    // Normalize the public musical position before the cursor and other listeners consume it.
    Object.assign(e, { currentTick: tick, currentTime: elapsedMs(clickBars, 0, tick, active.practice.speed) });
  }
  playerPos = { current: e.currentTime, end: e.endTime };
  updateDrumPlayhead(tick);
  const seek = $<HTMLInputElement>('seek');
  if (seek && document.activeElement !== seek) {
    seek.max = String(e.endTime);
    seek.value = String(e.currentTime);
  }
  $('time').textContent = `${fmtTime(e.currentTime)} / ${fmtTime(e.endTime)}`;
  if (playerState === 1 && active.practice.metronome) metronome.update(clickBars, e.currentTick, active.practice.speed, active.practice.looping ? active.practice.loop : null, e.isSeek);
});
// PlayerReady covers MIDI regeneration without AlphaTab 1.8's recursive loadedMidiInfo getter.
api.playerReady.on(() => {
  clickBars = api.tickCache?.masterBars.map(b => ({ start: b.start, end: b.end, num: b.masterBar.timeSignatureNumerator, den: b.masterBar.timeSignatureDenominator, tempos: b.tempoChanges.map(t => ({ tick: t.tick, tempo: t.tempo })) })) ?? [];
  applyPractice();
  if (resumePlayback) {
    const saved = resumePlayback;
    resumePlayback = null;
    api.tickPosition = Math.min(saved.tick, Math.max(0, (api.tickCache?.masterBars.at(-1)?.end ?? saved.tick + 1) - 1));
    if (saved.playing) api.play();
  }
});
api.soundFontLoaded.on(() => updateStatus());
api.error.on((e) => {
  console.error('alphaTab error', e);
  setMessage('Error: ' + (e as Error).message);
});

// ------------------------------------------------------------------ rendering

function newDoc(song: Song, filePath: string | null, fileName: string): Doc {
  const ed = new Editor(song);
  // listeners are per editor; only the active document drives the view
  ed.onChange((c) => {
    renderTabs();
    if (ed !== editor) return;
    pendingFirstBar = pendingFirstBar === null ? c.firstBar : Math.min(pendingFirstBar, c.firstBar);
    pendingStructural ||= c.structural;
    pendingReset ||= !!c.reset;
    pendingAudio ||= c.audio !== false;
    if (c.audio !== false && countIn.active) { countIn.cancel(); updateToolbar(); }
    scheduleRender();
  });
  ed.onCursor(() => {
    if (ed !== editor) return;
    if (editor.cursor.track !== renderedTrack) scheduleRender();
    updateCaret();
    updateStatus();
  });
  return { editor: ed, filePath, fileName, scrollTop: 0, practice: new PracticeState() };
}

/** Show a document: everything (render, tracks, status, playback) switches to it. */
function activate(doc: Doc) {
  if (doc === active && editor === doc.editor && score) return;
  active.scrollTop = $('score').scrollTop;
  api.stop();
  countIn.cancel();
  metronome.cancel();
  resumePlayback = null;
  active = doc;
  editor = doc.editor;
  editor.clearDrumDigits();
  applyPractice();
  score = null;
  renderedTrack = -1;
  pendingReset = true;
  restoreScroll = doc.scrollTop;
  scheduleRender();
  renderTabs();
  renderTracks();
  updateStatus();
}

/** A tab nobody has touched yet (the startup "Untitled") is replaced instead of kept. */
const isPristine = (d: Doc) => !d.filePath && !d.editor.dirty && !d.editor.canUndo && d.fileName === 'Untitled.tabproj';

/** Open a song in a new tab (or reuse a pristine untitled one / the tab already showing that file). */
function openDocument(song: Song, filePath: string | null, fileName: string) {
  const existing = filePath ? docs.find((d) => d.filePath === filePath) : undefined;
  if (existing) {
    activate(existing);
    setMessage(`${fileName} is already open`);
    return;
  }
  const doc = newDoc(song, filePath, fileName);
  const i = docs.indexOf(active);
  if (isPristine(active)) docs[i] = doc;
  else docs.splice(i + 1, 0, doc);
  score = null; // force activate() to switch even when replacing in place
  activate(doc);
}

async function closeDoc(doc = active) {
  if (doc.editor.dirty) {
    if (doc !== active) activate(doc);
    const choice = await unsavedDialog(doc.fileName);
    if (choice === 'cancel') return false;
    if (choice === 'save' && !(await doSave())) return false;
  }
  const i = docs.indexOf(doc);
  docs.splice(i, 1);
  if (!docs.length) docs.push(newDoc(createSong({ tracks: ['guitar'] }), null, 'Untitled.tabproj'));
  if (doc === active) {
    score = null;
    activate(docs[Math.min(i, docs.length - 1)]);
  } else renderTabs();
  return true;
}

function cycleDoc(delta: number) {
  const i = docs.indexOf(active);
  activate(docs[(i + delta + docs.length) % docs.length]);
}

function renderTabs() {
  const el = $('doctabs');
  el.innerHTML = '';
  for (const d of docs) {
    const t = document.createElement('div');
    t.className = 'dtab' + (d === active ? ' sel' : '');
    t.title = d.filePath ?? d.fileName;
    t.innerHTML = '<span class="dname"></span><span class="dclose" title="Close (Ctrl+W)">×</span>';
    t.querySelector('.dname')!.textContent = d.fileName.replace(/\.tabproj$/, '') + (d.editor.dirty ? ' *' : '');
    t.onmousedown = (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeDoc(d);
      } else if (!(e.target as HTMLElement).classList.contains('dclose')) activate(d);
    };
    t.querySelector<HTMLElement>('.dclose')!.onclick = () => closeDoc(d);
    el.appendChild(t);
  }
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  if (!rendering) requestAnimationFrame(flushRender);
}

function flushRender() {
  if (!renderQueued) return;
  renderQueued = false;
  renderStart = performance.now();
  const track = editor.cursor.track;
  const docChanged = !score || pendingAudio;
  const incremental = track === renderedTrack && !pendingStructural && pendingFirstBar !== null;
  // Same document, track and shape (e.g. tempo, time signature, mixer changes): keep the current drawing on
  // screen while re-rendering instead of blanking it (flicker). alphaTab cannot do this across layout changes.
  const shape = `${editor.song.tracks.length}:${editor.song.masterBars.length}`;
  const sameLayout = track === renderedTrack && !pendingReset && shape === renderedShape;
  const hints = incremental
    ? { reuseViewport: true, firstChangedMasterBar: pendingFirstBar! }
    : sameLayout
      ? { reuseViewport: true, firstChangedMasterBar: 0 }
      : undefined;
  renderedShape = shape;
  const reset = pendingReset;
  pendingReset = false;
  pendingFirstBar = null;
  pendingStructural = false;
  // Only a document change needs a new alphaTab Score. Showing another track re-renders the same Score,
  // which alphaTab treats as a view change and leaves the player (and playback position) alone.
  if (docChanged) {
    if (score && !reset) resumePlayback = { tick: api.tickPosition, playing: playerState === 1 };
    score = songToScore(editor.song, api.settings);
  } else if (score) {
    // Rehearsal labels affect engraving only; retain the score identity and its player.
    score.masterBars.forEach((b, i) => {
      const label = editor.song.masterBars[i].marker;
      b.section = label ? new at.model.Section() : null;
      if (b.section) b.section.text = label!;
    });
    score.tracks.forEach((t, i) => { t.name = editor.song.tracks[i].name; });
  }
  pendingAudio = false;
  if (track !== renderedTrack && !reset) restoreScroll = $('score').scrollTop;
  renderedTrack = track;
  updateDrumView(true);
  rendering = true;
  api.renderScore(score!, [track], hints);
  renderTracks();
  updateToolbar();
}

/** The alphaTab beat at the editor cursor in the current rendered score. */
function cursorBeat() {
  const c = editor.cursor;
  return score?.tracks[c.track]?.staves[0].bars[c.bar]?.voices[0]?.beats[c.beat] ?? null;
}

function updateCaret() {
  updateSelection();
  const el = $('caret');
  const beat = cursorBeat();
  const box = numberScoreVisible() ? drumCaret($('drumscore'), editor) : beat && api.boundsLookup ? locateCaret(api.boundsLookup, beat, editor.track, editor.cursor.string) : null;
  if (!box) {
    el.style.display = 'none';
    return;
  }
  Object.assign(el.style, { display: 'block', left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
  el.classList.toggle('beatonly', !box.row);
  if (playerState !== 1) scrollIntoView(box);
}

function updateSelection() {
  const el = $('selection');
  el.replaceChildren();
  if (numberScoreVisible()) { updateDrumSelection($('drumscore'), editor); return; }
  const s = editor.selection;
  if (!s || s.track !== renderedTrack || !score || !api.boundsLookup) return;
  const { start, end } = selectionRange(editor.song, s);
  for (let bar = start.bar; bar <= end.bar; bar++) {
    const beats = score.tracks[s.track].staves[0].bars[bar].voices[0].beats;
    const selected = s.kind === 'measures' ? beats : beats.slice(bar === start.bar ? start.beat : 0, bar === end.bar ? end.beat + 1 : undefined);
    for (const beat of selected) {
      const bounds = api.boundsLookup.findBeats(beat);
      if (!bounds?.length) continue;
      if (s.rows) {
        for (const bound of bounds) for (const n of bound.notes ?? []) {
          const row = isStringed(editor.track) ? editor.track.tuning.length - n.note.string : editor.track.type === 'drums' ? n.note.percussionArticulation : n.note.realValue;
          if (!s.rows.includes(row)) continue;
          const rect = n.noteHeadBounds, box = document.createElement('div');
          box.className = 'selected-beat';
          Object.assign(box.style, { left: rect.x - 3 + 'px', top: rect.y - 3 + 'px', width: rect.w + 6 + 'px', height: rect.h + 6 + 'px' });
          el.appendChild(box);
        }
        continue;
      }
      const first = bounds[0], last = bounds[bounds.length - 1];
      const box = document.createElement('div');
      box.className = 'selected-beat';
      const x = s.kind === 'measures' ? first.barBounds.visualBounds.x : first.realBounds.x;
      const w = s.kind === 'measures' ? first.barBounds.visualBounds.w : first.realBounds.w;
      Object.assign(box.style, { left: x + 'px', top: first.barBounds.visualBounds.y - 8 + 'px', width: Math.max(16, w) + 'px', height: last.barBounds.visualBounds.y + last.barBounds.visualBounds.h - first.barBounds.visualBounds.y + 16 + 'px' });
      el.appendChild(box);
      if (s.kind === 'measures') break;
    }
  }
}

function setDrumInput(mode: DrumMode) {
  drumInput = mode;
  docs.forEach(d => d.editor.clearDrumDigits());
  try { localStorage.setItem('sixline.drumInput', mode); } catch { /* preferences are optional */ }
  // Number entry immediately gives the readable score the user asked for; view remains independently selectable.
  if (mode === 'numbers') setDrumView('numbers');
  updateStatus();
}
function setDrumView(view: DrumView) {
  drumView = view;
  try { localStorage.setItem('sixline.drumView', view); } catch { /* preferences are optional */ }
  updateDrumView(true);
  updateCaret();
  updateStatus();
}
function updateDrumView(redraw = false) {
  const visible = numberScoreVisible();
  $('sheet').classList.toggle('drum-numbers', visible);
  $('drumscore').hidden = !visible;
  $('at').setAttribute('aria-hidden', String(visible));
  if (visible && redraw) renderDrumScore($('drumscore'), editor);
  const mode = playerState === 1 && !visible ? at.ScrollMode.Continuous : at.ScrollMode.Off;
  if (api.settings.player.scrollMode !== mode) { api.settings.player.scrollMode = mode; api.updateSettings(); }
  updateDrumPlayhead(api.tickPosition);
}
function updateDrumPlayhead(tick: number) {
  if (!numberScoreVisible()) return;
  const el = $('drumscore');
  const beat = api.tickCache?.findBeat(new Set([editor.cursor.track]), tick)?.beat;
  const next = beat ? el.querySelector<HTMLElement>(`.drum-beat[data-bar="${beat.voice.bar.index}"][data-beat="${beat.index}"][data-voice="${beat.voice.index}"]`) : null;
  el.querySelectorAll('.playing').forEach(n => { if (n !== next) n.classList.remove('playing'); });
  if (next) {
    const changed = !next.classList.contains('playing');
    next.classList.add('playing');
    if (playerState === 1 && changed) {
      const r = next.getBoundingClientRect(), origin = $('sheet').getBoundingClientRect();
      scrollIntoView({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
    }
  }
}

function scrollIntoView(b: { x: number; y: number; w: number; h: number }) {
  const sc = $('score');
  const pad = 40;
  if (b.y < sc.scrollTop + pad) sc.scrollTop = b.y - pad;
  else if (b.y + b.h > sc.scrollTop + sc.clientHeight - pad) sc.scrollTop = b.y + b.h - sc.clientHeight + pad;
}

// Edit interaction is independent of alphaTab's seeking and playback-range interaction.
$('at').addEventListener('mousedown', (ev) => {
  if (!api.boundsLookup || !score) return;
  const r = $('at').getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  const beat = api.boundsLookup.getBeatAtPos(x, y);
  if (!beat || beat.voice.index !== 0) return;
  let string = editor.cursor.string;
  const tr = editor.track;
  const clickedNote = api.boundsLookup.getNoteAtPos(beat, x, y);
  if (!isStringed(tr) && clickedNote) string = editor.rowForPitch(tr.type === 'drums' ? clickedNote.percussionArticulation : clickedNote.realValue);
  if (isStringed(tr)) {
    // choose the nearest tab line
    let best = Infinity;
    for (let s = 0; s < tr.tuning.length; s++) {
      const box = locateCaret(api.boundsLookup, beat, tr, s);
      if (!box?.row) continue;
      const d = Math.abs(box.y + box.h / 2 - y);
      if (d < best) {
        best = d;
        string = s;
      }
    }
  }
  const previousSelection = editor.selection;
  editor.setCursor({ bar: beat.voice.bar.index, beat: Math.min(beat.index, editor.track.measures[beat.voice.bar.index].voices[0].length - 1), string }, ev.shiftKey);
  if (ev.ctrlKey || ev.metaKey) editor.toggleSelectionRow(isStringed(tr) ? string : editor.rowPitch(), previousSelection);
});

// ------------------------------------------------------------------ files

const GP_FILTER = { name: 'Guitar Pro 3-5', extensions: ['gp3', 'gp4', 'gp5'] };
const PROJ_FILTER = { name: 'SixLine project', extensions: ['tabproj'] };

const MIDI_FILTER = { name: 'Standard MIDI File', extensions: ['mid', 'midi'] };

async function doOpen() {
  const f = await openFile([{ name: 'Supported files', extensions: ['tabproj', 'gp3', 'gp4', 'gp5', 'mid', 'midi'] }, GP_FILTER, PROJ_FILTER, MIDI_FILTER]);
  if (f) loadFile(f);
}

async function doImportMidi() {
  const f = await openFile([MIDI_FILTER]);
  if (f) await importMidiFile(f);
}

/** MIDI -> mapping dialog -> ordinary song (+ report of every adjustment). */
async function importMidiFile(f: OpenedFile) {
  try {
    const raw = parseMidiBytes(f.bytes);
    if (!raw.tracks.length) throw new Error('no notes found');
    const plans = await importDialog(f.name, raw, proposeMapping(raw));
    if (!plans) return;
    const base = f.name.replace(/\.[^.]+$/, '');
    const { song, report } = buildSong(raw, plans, base);
    openDocument(song, null, base + '.tabproj');
    setMessage(`Imported ${f.name}: ${song.tracks.length} tracks, ${song.masterBars.length} bars, ${report.notes} notes`);
    updateStatus();
    await reportDialog(`Imported ${f.name}`, report.lines);
  } catch (e) {
    console.error(e);
    setMessage(`Could not import ${f.name}: ${(e as Error).message}`);
  }
}

function loadFile(f: OpenedFile) {
  try {
    const ext = f.name.split('.').pop()!.toLowerCase();
    if (ext === 'mid' || ext === 'midi') {
      importMidiFile(f);
      return;
    }
    if (ext === 'tabproj') openDocument(parseProject(new TextDecoder().decode(f.bytes)), f.path, f.name);
    // imported files are saved as a new project
    else openDocument(loadGpBytes(f.bytes), null, f.name.replace(/\.[^.]+$/, '') + '.tabproj');
    const song = editor.song;
    setMessage(`Opened ${f.name}: ${song.tracks.length} tracks, ${song.masterBars.length} bars`);
  } catch (e) {
    console.error(e);
    setMessage(`Could not open ${f.name}: ${(e as Error).message}`);
  }
}

async function doExportMidi() {
  try {
    const data = exportMidi(editor.song, api.settings);
    const p = await saveFile(null, data, active.fileName.replace(/\.tabproj$/, '') + '.mid', [{ name: 'Standard MIDI File', extensions: ['mid', 'midi'] }]);
    if (p) setMessage('Exported MIDI ' + p.split(/[\\/]/).pop());
  } catch (e) {
    console.error(e);
    setMessage('MIDI export failed: ' + (e as Error).message);
  }
}

/** Save the active document; resolves true when it was written. */
async function doSave(as = false): Promise<boolean> {
  const doc = active;
  const data = new TextEncoder().encode(serializeProject(doc.editor.song));
  const p = await saveFile(as ? null : doc.filePath, data, doc.fileName, [PROJ_FILTER]);
  if (!p) return false;
  doc.filePath = p;
  doc.fileName = p.split(/[\\/]/).pop()!;
  doc.editor.dirty = false;
  setMessage('Saved ' + doc.fileName);
  renderTabs();
  updateStatus();
  return true;
}

async function doNew() {
  const o = await newSongDialog();
  if (!o) return;
  const song = createSong({ title: o.title, tempo: o.tempo, num: o.num, den: o.den, bars: o.bars, tracks: [o.type] });
  openDocument(song, null, o.title.replace(/[\\/:*?"<>|]/g, '_') + '.tabproj');
}

async function editTrack(i = editor.cursor.track) {
  const old = editor.song.tracks[i];
  const r = await trackDialog(old);
  if (!r) return;
  if (r.type !== old.type) {
    // the dialog's tuning/capo/program fields belong to the old type
    const dropped = editor.setTrackType(i, r.type);
    const { tuning: _t, capo: _c, program, ...rest } = r.props;
    editor.setTrackProps(i, old.type !== 'drums' && r.type !== 'drums' && program !== undefined ? { ...rest, program } : rest);
    setMessage(`Converted "${old.name}" to ${r.type}` + (dropped ? `; ${dropped} note(s) could not be placed on the tuning and were removed (Ctrl+Z restores)` : ''));
  } else editor.setTrackProps(i, r.props);
}

async function editTimeSignature() {
  const mb = editor.song.masterBars[editor.cursor.bar];
  const r = await timeSignatureDialog(mb.num, mb.den);
  if (r) editor.setTimeSignature(r.num, r.den);
}

// ------------------------------------------------------------------ playback

function playPause() {
  if (countIn.active) { countIn.cancel(); updateToolbar(); return; }
  if (playerState === 1) api.pause();
  else startPlayback(false);
}
function stop() {
  countIn.cancel();
  resumePlayback = null;
  api.stop();
  updateToolbar();
}

function command(fn: () => void) {
  try { fn(); } catch (e) { setMessage((e as Error).message); }
}
function copy(cut = false) {
  command(() => { clipboard = cut ? editor.cut() : editor.copy(); setMessage(cut ? 'Cut passage (rhythm retained as rests)' : 'Copied passage'); });
}
function paste() { command(() => { if (!clipboard) throw new Error('Copy a passage in SixLine first.'); editor.paste(clipboard); }); }
function duplicate() { command(() => editor.duplicate()); }

function caretTick() {
  const b = cursorBeat();
  if (!b || !api.tickCache) throw new Error('Wait for the score to finish loading.');
  return api.tickCache.getBeatStart(b);
}
function loopSelection() {
  command(() => {
    if (!editor.selection || !score || !api.tickCache) throw new Error('Select a beat or measure range first.');
    const s = editor.selection, { start, end } = selectionRange(editor.song, s);
    const bars = score.tracks[s.track].staves[0].bars;
    const first = bars[start.bar].voices[0].beats[start.beat];
    const last = bars[end.bar].voices[0].beats[end.beat];
    const startTick = s.kind === 'measures' ? api.tickCache.getMasterBar(score.masterBars[start.bar]).start : api.tickCache.getBeatStart(first);
    const endTick = s.kind === 'measures' ? api.tickCache.getMasterBar(score.masterBars[end.bar]).end : api.tickCache.getBeatStart(last) + last.playbackDuration;
    const outside = api.tickCache.masterBars.some(b => b.start >= startTick && b.start < endTick && (b.masterBar.index < start.bar || b.masterBar.index > end.bar));
    if (outside) throw new Error('This range crosses a repeat into unselected measures. Select one continuous playback passage.');
    active.practice.setLoop({ startTick, endTick }, 'selection');
    applyPractice(); updateToolbar();
  });
}
function toggleLoop() {
  command(() => {
    const p = active.practice;
    if (!p.loop) throw new Error('Use Loop Selection or set A and B first.');
    p.looping = !p.looping; applyPractice(); updateToolbar();
  });
}
function setLoopPoint(which: 'a' | 'b') {
  command(() => { active.practice[which] = caretTick(); updateToolbar(); });
}
function enableAB() { command(() => { active.practice.enableAB(); applyPractice(); updateToolbar(); }); }
function clearLoop() { active.practice.clearLoop(); applyPractice(); updateToolbar(); }
function applyPractice() {
  const p = active.practice;
  api.playbackSpeed = p.speed / 100;
  api.metronomeVolume = 0;
  api.countInVolume = 0;
  api.playbackRange = p.looping && p.loop ? Object.assign(new at.synth.PlaybackRange(), p.loop) : null;
  api.isLooping = p.looping;
}
function startPlayback(fromCaret: boolean) {
  command(() => {
    if (!api.isReadyForPlayback || renderQueued || rendering) throw new Error('Playback is still loading.');
    countIn.cancel();
    if (fromCaret) {
      if (playerState === 1) api.pause();
      let tick = caretTick();
      if (editor.selection && score && api.tickCache) {
        const { start } = selectionRange(editor.song, editor.selection);
        const b = score.tracks[editor.selection.track].staves[0].bars[start.bar].voices[0].beats[start.beat];
        tick = api.tickCache.getBeatStart(b);
      }
      api.tickPosition = tick;
    }
    const p = active.practice;
    if (p.metronome) metronome.ready().catch(e => setMessage('Metronome failed: ' + e.message));
    if (p.looping && p.loop && (api.tickPosition < p.loop.startTick || api.tickPosition >= p.loop.endTick)) api.tickPosition = p.loop.startTick;
    const startTick = api.tickPosition;
    const lookup = api.tickCache?.masterBars.find(b => b.start <= startTick && startTick < b.end);
    const bar = lookup?.masterBar.index ?? editor.cursor.bar;
    const mb = editor.song.masterBars[bar];
    const tempo = lookup?.tempoChanges.filter(t => t.tick <= startTick).at(-1)?.tempo ?? tempoAtBar(editor.song, bar);
    if (p.countIn) {
      setMessage(`Count-in: ${p.countIn} bar${p.countIn === 1 ? '' : 's'}`);
      countIn.start(mb.num, mb.den, tempo, p.countIn, () => p.speed, () => { api.tickPosition = startTick; api.play(); updateToolbar(); }).catch(e => { countIn.cancel(); setMessage('Count-in failed: ' + e.message); updateToolbar(); });
      updateToolbar();
    } else api.play();
  });
}
async function goToMeasure() {
  const n = await measureDialog(editor.cursor.bar + 1, editor.song.masterBars.length);
  if (n !== null) command(() => editor.goToMeasure(n));
}
async function editMarker() {
  const ed = editor, bar = ed.cursor.bar;
  const label = await markerDialog(ed.song.masterBars[bar].marker ?? '');
  if (label !== null) ed.setMarker(label, bar);
}

// ------------------------------------------------------------------ keyboard

const DUR_KEYS: Record<string, Duration> = { '1': 1, '2': 2, '3': 4, '4': 8, '5': 16, '6': 32 };

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || (t as any).isContentEditable) return;
  if (document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  let handled = true;
  if (mod) {
    const lk = k.toLowerCase();
    if (lk === 'z' && !e.shiftKey) editor.undo();
    else if ((lk === 'z' && e.shiftKey) || lk === 'y') editor.redo();
    else if (lk === 's') doSave(e.shiftKey);
    else if (lk === 'e') doExportMidi();
    else if (lk === 'i') doImportMidi();
    else if (lk === 'o') doOpen();
    else if (lk === 'n') doNew();
    else if (lk === 'w') closeDoc();
    else if (lk === 'c') copy();
    else if (lk === 'x') copy(true);
    else if (lk === 'v') paste();
    else if (lk === 'd') duplicate();
    else if (lk === 'a') editor.selectMeasures(0, editor.song.masterBars.length - 1);
    else if (lk === 'g') goToMeasure();
    else if (lk === 'l') loopSelection();
    else if (k === ' ') startPlayback(true);
    else if (k === 'Home') editor.setCursor({ bar: 0, beat: 0 });
    else if (k === 'End') editor.setCursor({ bar: editor.song.masterBars.length - 1, beat: editor.track.measures.at(-1)!.voices[0].length - 1 });
    else if (k === 'ArrowRight' && e.shiftKey) editor.extendSelection(1, true);
    else if (k === 'ArrowLeft' && e.shiftKey) editor.extendSelection(-1, true);
    else if (k === 'Tab') cycleDoc(e.shiftKey ? -1 : 1);
    else if (k === 'PageDown') cycleDoc(1);
    else if (k === 'PageUp') cycleDoc(-1);
    else if (k === 'ArrowRight') editor.moveBar(1);
    else if (k === 'ArrowLeft') editor.moveBar(-1);
    else if (k === 'Delete' || k === 'Backspace') editor.deleteBeat();
    else if (k === 'Insert') editor.insertBars(editor.cursor.bar, 1);
    else if (k === 'ArrowUp' && e.shiftKey) editor.transposeNote(12);
    else if (k === 'ArrowDown' && e.shiftKey) editor.transposeNote(-12);
    else if (k === 'ArrowUp') editor.moveString(-12);
    else if (k === 'ArrowDown') editor.moveString(12);
    else handled = false;
  } else if (e.altKey && DUR_KEYS[k]) {
    editor.setDuration(DUR_KEYS[k]);
  } else if (k === ' ') playPause();
  else if (editor.track.type === 'drums' && drumInput === 'letters' && k.length === 1 && DRUM_BY_SHORTCUT.has(k.toLowerCase()) && !e.altKey) editor.togglePitch(DRUM_BY_SHORTCUT.get(k.toLowerCase())!.key);
  else if (editor.track.type === 'keys' && /^[a-gA-G]$/.test(k) && !e.altKey) editor.typeNoteName(k);
  else if (k === 'Enter') editor.toggleAtCursor();
  else if (k === 'ArrowUp' && e.shiftKey) editor.transposeNote(1);
  else if (k === 'ArrowDown' && e.shiftKey) editor.transposeNote(-1);
  else if (k === 'ArrowRight' && e.shiftKey) editor.extendSelection(1);
  else if (k === 'ArrowLeft' && e.shiftKey) editor.extendSelection(-1);
  else if (k === 'ArrowRight') editor.moveRight();
  else if (k === 'ArrowLeft') editor.moveLeft();
  else if (k === 'ArrowUp') editor.moveString(-1);
  else if (k === 'ArrowDown') editor.moveString(1);
  else if (k === 'Home') editor.setCursor({ beat: 0 });
  else if (k === 'End') editor.setCursor({ beat: editor.beats.length - 1 });
  else if (k === 'PageDown') editor.moveBar(1);
  else if (k === 'PageUp') editor.moveBar(-1);
  else if (/^[0-9]$/.test(k)) {
    if (editor.track.type === 'drums' && drumInput === 'numbers') {
      clearTimeout(drumEntryTimer);
      command(() => editor.typeDrumDigit(Number(k)));
      if (editor.drumDigits) {
        const ed = editor;
        drumEntryTimer = window.setTimeout(() => { ed.clearDrumDigits(); ed.emitCursor(); }, 2000);
      }
    }
    else editor.typeDigit(Number(k));
  }
  else if ((k === 'Delete' || k === 'Backspace') && editor.drumDigits) { editor.clearDrumDigits(); updateStatus(); }
  else if (k === 'Delete' || k === 'Backspace') editor.deleteNote();
  else if (k === 'Insert') editor.insertBeat();
  else if (k === '+' || k === '=') editor.stepDuration(1);
  else if (k === '-' || k === '_') editor.stepDuration(-1);
  else if (k === '.') editor.toggleDot();
  else if (k === 'T' || (k === 't' && isStringed(editor.track))) editor.toggleTriplet();
  else if (k === 'Escape') { editor.clearDrumDigits(); editor.clearSelection(); closeMenus(); }
  else if (k === 'F6') editTrack();
  else handled = false;
  if (handled) e.preventDefault();
});

// ------------------------------------------------------------------ menus / toolbar / panels

const menus: MenuDef[] = [
  {
    title: 'File',
    items: [
      { label: 'New', key: 'Ctrl+N', run: doNew },
      { label: 'Open…', key: 'Ctrl+O', run: doOpen },
      { label: 'Save', key: 'Ctrl+S', run: () => doSave() },
      { label: 'Save As…', key: 'Ctrl+Shift+S', run: () => doSave(true) },
      { label: 'Close', key: 'Ctrl+W', run: () => closeDoc() },
      null,
      { label: 'Import MIDI…', key: 'Ctrl+I', run: doImportMidi },
      { label: 'Export MIDI…', key: 'Ctrl+E', run: doExportMidi },
    ],
  },
  {
    title: 'Edit',
    items: [
      { label: 'Undo', key: 'Ctrl+Z', run: () => editor.undo(), enabled: () => editor.canUndo },
      { label: 'Redo', key: 'Ctrl+Y', run: () => editor.redo(), enabled: () => editor.canRedo },
      null,
      { label: 'Copy', key: 'Ctrl+C', run: () => copy() },
      { label: 'Cut', key: 'Ctrl+X', run: () => copy(true) },
      { label: 'Paste', key: 'Ctrl+V', run: paste, enabled: () => !!clipboard },
      { label: 'Duplicate selection / measure', key: 'Ctrl+D', run: duplicate },
      { label: 'Select beat / chord', run: () => editor.select() },
      { label: 'Select note on current row', run: () => editor.select('beats', [isStringed(editor.track) ? editor.cursor.string : editor.rowPitch()]) },
      { label: 'Select measure', run: () => editor.selectMeasures(editor.cursor.bar) },
      { label: 'Select all measures', key: 'Ctrl+A', run: () => editor.selectMeasures(0, editor.song.masterBars.length - 1) },
      { label: 'Clear selection', key: 'Esc', run: () => editor.clearSelection() },
      null,
      { label: 'Insert beat', key: 'Ins', run: () => editor.insertBeat() },
      { label: 'Delete beat', key: 'Ctrl+Del', run: () => editor.deleteBeat() },
      { label: 'Clear beat', run: () => editor.clearBeat() },
      null,
      { label: 'Insert bar', key: 'Ctrl+Ins', run: () => editor.insertBars(editor.cursor.bar, 1) },
      { label: 'Append bar', run: () => editor.insertBars(editor.song.masterBars.length, 1) },
      { label: 'Delete bar', run: () => editor.deleteBar() },
    ],
  },
  {
    title: 'Track',
    items: [
      { label: 'Add guitar track', run: () => editor.addTrack('guitar') },
      { label: 'Add bass track', run: () => editor.addTrack('bass') },
      { label: 'Add keys/synth track', run: () => editor.addTrack('keys') },
      { label: 'Add drum track', run: () => editor.addTrack('drums') },
      null,
      { label: 'Track properties…', key: 'F6', run: () => editTrack() },
      { label: 'Remove track', run: () => editor.removeTrack(), enabled: () => editor.song.tracks.length > 1 },
      null,
      { label: 'Time signature…', run: editTimeSignature },
    ],
  },
  {
    title: 'Playback',
    items: [
      { label: 'Play / Pause', key: 'Space', run: playPause },
      { label: 'Play from caret / selection', key: 'Ctrl+Space', run: () => startPlayback(true) },
      { label: 'Stop', run: stop },
      null,
      { label: 'Loop Selection', key: 'Ctrl+L', run: loopSelection },
      { label: 'Enable / Disable loop', run: toggleLoop },
      { label: 'Set A at caret', run: () => setLoopPoint('a') },
      { label: 'Set B at caret (exclusive end)', run: () => setLoopPoint('b') },
      { label: 'Enable A-B loop', run: enableAB },
      { label: 'Clear loop markers', run: clearLoop },
    ],
  },
  {
    title: 'Navigate',
    items: [
      { label: 'Go to measure…', key: 'Ctrl+G', run: goToMeasure },
      { label: 'Next measure', key: 'Ctrl+Right', run: () => editor.moveBar(1) },
      { label: 'Previous measure', key: 'Ctrl+Left', run: () => editor.moveBar(-1) },
      { label: 'Beginning of song', key: 'Ctrl+Home', run: () => editor.setCursor({ bar: 0, beat: 0 }) },
      { label: 'End of song', key: 'Ctrl+End', run: () => editor.setCursor({ bar: editor.song.masterBars.length - 1, beat: editor.track.measures.at(-1)!.voices[0].length - 1 }) },
      null,
      { label: 'Add / Rename marker…', run: editMarker },
      { label: 'Delete marker', run: () => editor.setMarker('') },
      { label: 'Next marker', run: () => editor.jumpMarker(1) },
      { label: 'Previous marker', run: () => editor.jumpMarker(-1) },
    ],
  },
];
const { closeMenus } = buildMenus($('menubar'), menus);

function buildToolbar() {
  const tb = $('toolbar');
  tb.innerHTML = `
    <button id="b-play" title="Play/Pause (Space)">▶</button>
    <button id="b-stop" title="Stop">■</button>
    <input id="seek" type="range" min="0" max="1" value="0" title="Seek">
    <span id="time" class="lbl">0:00 / 0:00</span>
    <span class="sep"></span>
    <span class="lbl">Tempo</span><input id="tempo" type="number" min="20" max="400">
    <span id="tsig" class="lbl"></span>
    <span class="sep"></span>
    ${([1, 2, 4, 8, 16] as Duration[])
      .map((d, i) => `<button data-dur="${d}" title="1/${d} (Alt+${i + 1})">${['𝅝', '𝅗𝅥', '♩', '♪', '𝅘𝅥𝅯'][i]}</button>`)
      .join('')}
    <button id="b-dot" title="Dotted (.)">•</button>
    <button id="b-trip" title="Triplet (T)">3</button>
    <span class="sep"></span>
    <button id="b-undo" title="Undo (Ctrl+Z)">↶</button>
    <button id="b-redo" title="Redo (Ctrl+Y)">↷</button>
    <span class="sep"></span>
    <span id="trackname" class="lbl"></span>
    <span id="drum-controls" hidden>
      <label>Drum input <select id="drum-input" aria-label="Drum input"><option value="letters">Letters (H, S, K…)</option><option value="numbers">MIDI numbers</option></select></label>
      <label>View <select id="drum-view" aria-label="Drum score view"><option value="notation">Notation</option><option value="numbers">MIDI numbers</option></select></label>
    </span>`;
  $<HTMLSelectElement>('drum-input').onchange = () => { setDrumInput($<HTMLSelectElement>('drum-input').value as DrumMode); $('drum-input').blur(); };
  $<HTMLSelectElement>('drum-view').onchange = () => { setDrumView($<HTMLSelectElement>('drum-view').value as DrumView); $('drum-view').blur(); };
  const practice = document.createElement('div');
  practice.id = 'practicebar';
  practice.innerHTML = `<button id="b-caret" title="Play from caret / selection (Ctrl+Space)">Play here</button>
    <label>Speed <input id="speed" type="number" min="25" max="200" step="10" value="100" list="speeds">%</label>
    <datalist id="speeds">${[50,60,70,80,90,100,110,120].map(n => `<option value="${n}"></option>`).join('')}</datalist>
    <button id="b-loop-selection" title="Loop Selection (Ctrl+L)">Loop selection</button>
    <button id="b-loop" title="Enable / Disable saved loop">Loop off</button>
    <button id="b-a" title="Set A at caret">A</button><button id="b-b" title="Set B at caret (exclusive end)">B</button>
    <button id="b-ab" title="Enable A-B loop">A-B</button><button id="b-clear-loop" title="Clear loop markers">Clear loop</button>
    <label><input id="metronome" type="checkbox">Metronome</label>
    <label>Count-in <select id="count-in"><option value="0">Off</option><option value="1">1 bar</option><option value="2">2 bars</option></select></label>
    <select id="markers" aria-label="Jump to section marker"><option value="">Markers…</option></select>
    <button id="b-marker" title="Add / Rename section marker">Marker…</button>`;
  tb.after(practice);
  $('b-caret').onclick = () => startPlayback(true);
  $('b-loop-selection').onclick = loopSelection;
  $('b-loop').onclick = toggleLoop;
  $('b-a').onclick = () => setLoopPoint('a'); $('b-b').onclick = () => setLoopPoint('b');
  $('b-ab').onclick = enableAB; $('b-clear-loop').onclick = clearLoop;
  $<HTMLInputElement>('speed').onchange = () => command(() => { active.practice.setSpeed(Number($<HTMLInputElement>('speed').value)); api.playbackSpeed = active.practice.speed / 100; updateToolbar(); });
  $<HTMLInputElement>('metronome').onchange = () => {
    active.practice.metronome = $<HTMLInputElement>('metronome').checked;
    if (active.practice.metronome) metronome.ready().catch(e => setMessage('Metronome failed: ' + e.message));
    else metronome.cancel();
  };
  $<HTMLSelectElement>('count-in').onchange = () => { active.practice.countIn = Number($<HTMLSelectElement>('count-in').value) as 0 | 1 | 2; };
  $<HTMLSelectElement>('markers').onchange = () => { const el = $<HTMLSelectElement>('markers'); if (el.value !== '') editor.goToMeasure(Number(el.value) + 1); el.value = ''; el.blur(); };
  $('b-marker').onclick = editMarker;
  practice.querySelectorAll('button').forEach(b => b.addEventListener('mouseup', () => b.blur()));
  $('b-play').onclick = playPause;
  $('b-stop').onclick = stop;
  $('b-dot').onclick = () => editor.toggleDot();
  $('b-trip').onclick = () => editor.toggleTriplet();
  $('b-undo').onclick = () => editor.undo();
  $('b-redo').onclick = () => editor.redo();
  tb.querySelectorAll<HTMLButtonElement>('[data-dur]').forEach((b) => (b.onclick = () => editor.setDuration(Number(b.dataset.dur) as Duration)));
  const seek = $<HTMLInputElement>('seek');
  seek.oninput = () => (api.timePosition = Number(seek.value));
  $('tsig').onclick = editTimeSignature;
  $('tsig').title = 'Time signature (click to change)';
  const tempo = $<HTMLInputElement>('tempo');
  tempo.onchange = () => {
    const v = Math.max(20, Math.min(400, Number(tempo.value) || 120));
    if (v === editor.song.tempo) return;
    // consecutive tempo steps (spinner clicks) are one undo step
    editor.songEdit('Tempo', (s) => (s.tempo = v), { merge: editor.lastUndoLabel === 'Tempo' });
  };
  tempo.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') {
      if (e.key === 'Escape') tempo.value = String(editor.song.tempo);
      else tempo.dispatchEvent(new Event('change'));
      tempo.blur();
    }
  };
  // buttons must not keep keyboard focus (Space would re-click them)
  tb.querySelectorAll('button').forEach((b) => b.addEventListener('mouseup', () => b.blur()));
}

function updateToolbar() {
  $('b-play').textContent = playerState === 1 ? '❚❚' : '▶';
  $('b-play').classList.toggle('on', playerState === 1);
  const tempo = $<HTMLInputElement>('tempo');
  if (document.activeElement !== tempo) tempo.value = String(editor.song.tempo);
  const mb = editor.song.masterBars[editor.cursor.bar];
  $('tsig').textContent = `${mb.num}/${mb.den}`;
  $('trackname').textContent = editor.track.name;
  $('drum-controls').hidden = editor.track.type !== 'drums';
  $<HTMLSelectElement>('drum-input').value = drumInput;
  $<HTMLSelectElement>('drum-view').value = drumView;
  const beat = editor.beat;
  document.querySelectorAll<HTMLButtonElement>('[data-dur]').forEach((b) => b.classList.toggle('on', Number(b.dataset.dur) === beat.duration));
  $('b-dot').classList.toggle('on', beat.dots > 0);
  $('b-trip').classList.toggle('on', !!beat.tuplet);
  $<HTMLButtonElement>('b-undo').disabled = !editor.canUndo;
  $<HTMLButtonElement>('b-redo').disabled = !editor.canRedo;
  const p = active.practice;
  if (document.activeElement !== $('speed')) $<HTMLInputElement>('speed').value = String(p.speed);
  $<HTMLInputElement>('metronome').checked = p.metronome;
  $<HTMLSelectElement>('count-in').value = String(p.countIn);
  $('b-loop').textContent = p.looping ? `Loop ${p.loopSource === 'ab' ? 'A-B' : 'selection'}` : 'Loop off';
  $('b-loop').classList.toggle('on', p.looping);
  $('b-a').classList.toggle('on', p.a !== null); $('b-b').classList.toggle('on', p.b !== null);
  $('b-a').title = `Set A at caret${p.a === null ? '' : ` (tick ${p.a})`}`;
  $('b-b').title = `Set B at caret (exclusive end)${p.b === null ? '' : ` (tick ${p.b})`}`;
  if (countIn.active) $('b-play').textContent = '…';
  const markers = $<HTMLSelectElement>('markers');
  const options = [new Option('Markers…', '')];
  editor.song.masterBars.forEach((b, i) => { if (b.marker) options.push(new Option(`${i + 1}: ${b.marker}`, String(i))); });
  markers.replaceChildren(...options);
}

function renderTracks() {
  const el = $('tracks');
  el.innerHTML = '';
  editor.song.tracks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'trk' + (i === editor.cursor.track ? ' sel' : '');
    row.dataset.index = String(i);
    const kind = { guitar: 'G', bass: 'B', keys: 'K', drums: 'D' }[t.type];
    row.innerHTML = `<span class="kind">${kind}</span><span class="name"></span><span class="ms m ${t.mute ? 'on' : ''}" title="Mute">M</span><span class="ms s ${t.solo ? 'on' : ''}" title="Solo">S</span>`;
    row.querySelector('.name')!.textContent = t.name;
    row.ondblclick = (ev) => {
      if (!(ev.target as HTMLElement).classList.contains('ms')) editTrack(i);
    };
    row.onclick = (ev) => {
      const target = ev.target as HTMLElement;
      if (target.classList.contains('m')) return toggleMix(i, 'mute');
      if (target.classList.contains('s')) return toggleMix(i, 'solo');
      if (i !== editor.cursor.track) editor.setCursor({ track: i, beat: 0 });
      renderTracks();
    };
    el.appendChild(row);
  });
}

function toggleMix(i: number, what: 'mute' | 'solo') {
  editor.songEdit(what === 'mute' ? 'Mute' : 'Solo', (s) => (s.tracks[i][what] = !s.tracks[i][what]));
}

function setMessage(m: string) {
  message = m;
  clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => {
    message = '';
    updateStatus();
  }, 6000);
  updateStatus();
}

function updateStatus() {
  const c = editor.cursor;
  const tr = editor.track;
  const beat = editor.beat;
  const note = editor.noteAtCursor();
  const row = isStringed(tr)
    ? `String ${c.string + 1}${note ? ` fret ${note.fret}` : ''}`
    : tr.type === 'drums'
      ? `${editor.rowPitch()} ${drumName(editor.rowPitch())}${note ? ' ●' : ''}${editor.drumDigits ? ` · Entering ${editor.drumDigits}_` : ''}`
      : `Pitch ${pitchName(editor.rowPitch())}${note ? ' ●' : ''}`;
  renderDrumGrid($('drumgrid'), editor, drumInput === 'numbers');
  const over = editor.barOverfull() ? '<span class="warn">bar too long</span>' : '';
  $('status').innerHTML = `
    <span>Bar ${c.bar + 1}/${editor.song.masterBars.length}</span>
    <span>Beat ${c.beat + 1}/${editor.beats.length}${editor.selection ? ' · selection' : ''}</span>
    <span>${row}</span>
    <span>1/${beat.duration}${'.'.repeat(beat.dots)}${beat.tuplet ? ' (3)' : ''}</span>
    ${over}
    <span style="flex:1"></span>
    <span id="msg"></span>
    <span>${active.fileName}${editor.dirty ? ' *' : ''}</span>
    <span title="last render">${lastRenderMs.toFixed(0)}ms</span>`;
  $('msg').textContent = message;
  updateToolbar();
  document.title = `${active.fileName}${editor.dirty ? ' *' : ''} - SixLine`;
}

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ boot

// Quitting with unsaved tabs: block the unload; the desktop shell then asks whether to discard.
window.addEventListener('beforeunload', (e) => {
  if (docs.some((d) => d.editor.dirty)) {
    e.preventDefault();
    e.returnValue = '';
  }
});
renderTabs();

bindDrumGrid($('drumgrid'), () => editor);
bindDrumScore($('drumscore'), () => editor);

renderTracks();
updateStatus();
scheduleRender();
initialFile().then((f) => f && loadFile(f));
onOpenFile(loadFile);

// Test/automation hook (no network, local only).
(window as any).sixline = { get editor() { return editor; }, get docs() { return docs; }, get active() { return active; }, api, loadFile, closeDoc, get score() { return score; }, get rendering() { return rendering || renderQueued; }, get playerState() { return playerState; }, get playerPos() { return playerPos; }, get practice() { return active.practice; }, get countingIn() { return countIn.active; }, midiNoteOnType: at.midi.MidiEventType.NoteOn };
