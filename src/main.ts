import './ui/style.css';
import * as at from '@coderline/alphatab';
import { Editor } from './editor/editor';
import { createSong, isStringed, type Duration, type Song } from './model/song';
import { loadGpBytes, songToScore } from './io/alphatab';
import { parseProject, serializeProject } from './io/project';
import { exportMidi } from './io/midiExport';
import { buildSong, parseMidiBytes, proposeMapping } from './io/midiImport';
import { importDialog, reportDialog } from './ui/importDialog';
import { initialFile, openFile, saveFile, type OpenedFile } from './platform/host';
import { buildMenus, type MenuDef } from './ui/menu';
import { locateCaret } from './ui/caret';
import { newSongDialog, pitchName, timeSignatureDialog, trackDialog } from './ui/dialogs';
import { bindDrumGrid, renderDrumGrid } from './ui/drumgrid';
import { DRUM_BY_SHORTCUT, drumName } from './model/drums';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ------------------------------------------------------------------ state

const editor = new Editor(createSong({ tracks: ['guitar'] }));
let filePath: string | null = null;
let fileName = 'Untitled.tabproj';
let score: at.model.Score | null = null;
let renderedTrack = -1;
let pendingFirstBar: number | null = null;
let pendingStructural = false;
let renderQueued = false;
let rendering = false;
let renderStart = 0;
let lastRenderMs = 0;
let playerState = 0; // 0 paused/stopped, 1 playing
let playerPos = { current: 0, end: 0 };
let message = '';
let messageTimer = 0;

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
    enableUserInteraction: true,
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
  updateCaret();
  updateStatus();
  if (renderQueued) flushRender();
});
api.playerStateChanged.on((e) => {
  playerState = e.state;
  const mode = e.state === 1 ? at.ScrollMode.Continuous : at.ScrollMode.Off;
  if (api.settings.player.scrollMode !== mode) {
    api.settings.player.scrollMode = mode;
    api.updateSettings();
  }
  updateToolbar();
});
api.playerPositionChanged.on((e) => {
  playerPos = { current: e.currentTime, end: e.endTime };
  const seek = $<HTMLInputElement>('seek');
  if (seek && document.activeElement !== seek) {
    seek.max = String(e.endTime);
    seek.value = String(e.currentTime);
  }
  $('time').textContent = `${fmtTime(e.currentTime)} / ${fmtTime(e.endTime)}`;
});
api.soundFontLoaded.on(() => updateStatus());
api.error.on((e) => {
  console.error('alphaTab error', e);
  setMessage('Error: ' + (e as Error).message);
});

// ------------------------------------------------------------------ rendering

editor.onChange((c) => {
  pendingFirstBar = pendingFirstBar === null ? c.firstBar : Math.min(pendingFirstBar, c.firstBar);
  pendingStructural ||= c.structural;
  scheduleRender();
});
editor.onCursor(() => {
  if (editor.cursor.track !== renderedTrack) scheduleRender();
  updateCaret();
  updateStatus();
});

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
  const incremental = track === renderedTrack && !pendingStructural && pendingFirstBar !== null;
  const hints = incremental ? { reuseViewport: true, firstChangedMasterBar: pendingFirstBar! } : undefined;
  pendingFirstBar = null;
  pendingStructural = false;
  score = songToScore(editor.song, api.settings);
  renderedTrack = track;
  rendering = true;
  api.renderScore(score, [track], hints);
  renderTracks();
  updateToolbar();
}

/** The alphaTab beat at the editor cursor in the current rendered score. */
function cursorBeat() {
  const c = editor.cursor;
  return score?.tracks[c.track]?.staves[0].bars[c.bar]?.voices[0]?.beats[c.beat] ?? null;
}

function updateCaret() {
  const el = $('caret');
  const beat = cursorBeat();
  const box = beat && api.boundsLookup ? locateCaret(api.boundsLookup, beat, editor.track, editor.cursor.string) : null;
  if (!box) {
    el.style.display = 'none';
    return;
  }
  Object.assign(el.style, { display: 'block', left: box.x + 'px', top: box.y + 'px', width: box.w + 'px', height: box.h + 'px' });
  el.classList.toggle('beatonly', !box.row);
  if (playerState !== 1) scrollIntoView(box);
}

function scrollIntoView(b: { x: number; y: number; w: number; h: number }) {
  const sc = $('score');
  const pad = 40;
  if (b.y < sc.scrollTop + pad) sc.scrollTop = b.y - pad;
  else if (b.y + b.h > sc.scrollTop + sc.clientHeight - pad) sc.scrollTop = b.y + b.h - sc.clientHeight + pad;
}

// Click in the score: focus the beat/string under the mouse (alphaTab also seeks the player there).
$('at').addEventListener('mousedown', (ev) => {
  if (!api.boundsLookup || !score) return;
  const r = $('at').getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  const beat = api.boundsLookup.getBeatAtPos(x, y);
  if (!beat || beat.voice.index !== 0) return;
  let string = editor.cursor.string;
  const tr = editor.track;
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
  editor.setCursor({ bar: beat.voice.bar.index, beat: beat.index, string });
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
    api.stop();
    editor.load(song);
    filePath = null;
    fileName = base + '.tabproj';
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
    let song: Song;
    if (ext === 'tabproj') {
      song = parseProject(new TextDecoder().decode(f.bytes));
      filePath = f.path;
      fileName = f.name;
    } else {
      song = loadGpBytes(f.bytes);
      // imported files are saved as a new project next to the original
      filePath = null;
      fileName = f.name.replace(/\.[^.]+$/, '') + '.tabproj';
    }
    api.stop();
    editor.load(song);
    setMessage(`Opened ${f.name}: ${song.tracks.length} tracks, ${song.masterBars.length} bars`);
  } catch (e) {
    console.error(e);
    setMessage(`Could not open ${f.name}: ${(e as Error).message}`);
  }
}

async function doExportMidi() {
  try {
    const data = exportMidi(editor.song, api.settings);
    const p = await saveFile(null, data, fileName.replace(/\.tabproj$/, '') + '.mid', [{ name: 'Standard MIDI File', extensions: ['mid', 'midi'] }]);
    if (p) setMessage('Exported MIDI ' + p.split(/[\\/]/).pop());
  } catch (e) {
    console.error(e);
    setMessage('MIDI export failed: ' + (e as Error).message);
  }
}

async function doSave(as = false) {
  const data = new TextEncoder().encode(serializeProject(editor.song));
  const p = await saveFile(as ? null : filePath, data, fileName, [PROJ_FILTER]);
  if (!p) return;
  filePath = p;
  fileName = p.split(/[\\/]/).pop()!;
  editor.dirty = false;
  setMessage('Saved ' + fileName);
  updateStatus();
}

async function doNew() {
  const o = await newSongDialog();
  if (!o) return;
  api.stop();
  filePath = null;
  fileName = o.title.replace(/[\\/:*?"<>|]/g, '_') + '.tabproj';
  editor.load(createSong({ title: o.title, tempo: o.tempo, num: o.num, den: o.den, bars: o.bars, tracks: [o.type] }));
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
  api.playPause();
}
function stop() {
  api.stop();
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
  else if (editor.track.type === 'drums' && k.length === 1 && DRUM_BY_SHORTCUT.has(k.toLowerCase()) && !e.altKey) editor.togglePitch(DRUM_BY_SHORTCUT.get(k.toLowerCase())!.key);
  else if (editor.track.type === 'keys' && /^[a-gA-G]$/.test(k) && !e.altKey) editor.typeNoteName(k);
  else if (k === 'Enter') editor.toggleAtCursor();
  else if (k === 'ArrowUp' && e.shiftKey) editor.transposeNote(1);
  else if (k === 'ArrowDown' && e.shiftKey) editor.transposeNote(-1);
  else if (k === 'ArrowRight') editor.moveRight();
  else if (k === 'ArrowLeft') editor.moveLeft();
  else if (k === 'ArrowUp') editor.moveString(-1);
  else if (k === 'ArrowDown') editor.moveString(1);
  else if (k === 'Home') editor.setCursor({ beat: 0 });
  else if (k === 'End') editor.setCursor({ beat: editor.beats.length - 1 });
  else if (k === 'PageDown') editor.moveBar(1);
  else if (k === 'PageUp') editor.moveBar(-1);
  else if (/^[0-9]$/.test(k)) editor.typeDigit(Number(k));
  else if (k === 'Delete' || k === 'Backspace') editor.deleteNote();
  else if (k === 'Insert') editor.insertBeat();
  else if (k === '+' || k === '=') editor.stepDuration(1);
  else if (k === '-' || k === '_') editor.stepDuration(-1);
  else if (k === '.') editor.toggleDot();
  else if (k === 'T' || (k === 't' && isStringed(editor.track))) editor.toggleTriplet();
  else if (k === 'Escape') closeMenus();
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
      { label: 'Stop', run: stop },
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
    <span id="trackname" class="lbl"></span>`;
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
    editor.songEdit('Tempo', (s) => (s.tempo = v));
    tempo.blur();
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
  const beat = editor.beat;
  document.querySelectorAll<HTMLButtonElement>('[data-dur]').forEach((b) => b.classList.toggle('on', Number(b.dataset.dur) === beat.duration));
  $('b-dot').classList.toggle('on', beat.dots > 0);
  $('b-trip').classList.toggle('on', !!beat.tuplet);
  $<HTMLButtonElement>('b-undo').disabled = !editor.canUndo;
  $<HTMLButtonElement>('b-redo').disabled = !editor.canRedo;
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
      ? `${drumName(editor.rowPitch())}${note ? ' ●' : ''}`
      : `Pitch ${pitchName(editor.rowPitch())}${note ? ' ●' : ''}`;
  renderDrumGrid($('drumgrid'), editor);
  const over = editor.barOverfull() ? '<span class="warn">bar too long</span>' : '';
  $('status').innerHTML = `
    <span>Bar ${c.bar + 1}/${editor.song.masterBars.length}</span>
    <span>Beat ${c.beat + 1}/${editor.beats.length}</span>
    <span>${row}</span>
    <span>1/${beat.duration}${'.'.repeat(beat.dots)}${beat.tuplet ? ' (3)' : ''}</span>
    ${over}
    <span style="flex:1"></span>
    <span id="msg"></span>
    <span>${fileName}${editor.dirty ? ' *' : ''}</span>
    <span title="last render">${lastRenderMs.toFixed(0)}ms</span>`;
  $('msg').textContent = message;
  updateToolbar();
  document.title = `${fileName}${editor.dirty ? ' *' : ''} - SixLine`;
}

function fmtTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ boot

bindDrumGrid($('drumgrid'), editor);

renderTracks();
updateStatus();
scheduleRender();
initialFile().then((f) => f && loadFile(f));

// Test/automation hook (no network, local only).
(window as any).sixline = { editor, api, loadFile, get score() { return score; }, get rendering() { return rendering || renderQueued; }, get playerState() { return playerState; }, get playerPos() { return playerPos; } };
