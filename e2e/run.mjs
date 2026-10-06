// End-to-end checks against the real Electron app (requires `npm run build` first).
// Usage: node e2e/run.mjs
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parseMidi } from 'midi-file';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'e2e/out');
fs.mkdirSync(out, { recursive: true });
const electronBin = path.join(root, 'node_modules/electron/dist/electron');

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n').join('\n       '));
  }
}

async function launch(file) {
  const app = await electron.launch({ executablePath: electronBin, args: [root, file], cwd: root });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await waitIdle(win);
  return { app, win, errors };
}

/** Wait until the document is loaded and alphaTab has finished rendering. */
async function waitIdle(win, timeout = 30000) {
  await win.waitForFunction(() => window.sixline?.score && !window.sixline.rendering && document.querySelector('#at .at-surface *'), null, { timeout });
  await win.waitForTimeout(150);
  await win.waitForFunction(() => !window.sixline.rendering, null, { timeout });
}

const state = (win) =>
  win.evaluate(() => {
    const t = window.sixline;
    const e = t.editor;
    return { cursor: { ...e.cursor }, beat: structuredClone(e.beat), beats: e.beats.length, bars: e.song.masterBars.length, dirty: e.dirty, title: document.title };
  });

/** Screen coordinates of a tab position (bar, beat, string) of the rendered track. */
const tabPoint = (win, bar, beat, string) =>
  win.evaluate(
    ([bar, beat, string]) => {
      const t = window.sixline;
      const b = t.score.tracks[t.editor.cursor.track].staves[0].bars[bar].voices[0].beats[beat];
      const all = t.api.boundsLookup.findBeats(b);
      const tab = all[all.length - 1].barBounds.visualBounds;
      const n = t.editor.track.tuning.length;
      const r = document.getElementById('at').getBoundingClientRect();
      return { x: r.left + all[0].onNotesX, y: r.top + tab.y + (string * tab.h) / (n - 1) };
    },
    [bar, beat, string],
  );

// ---------------------------------------------------------------------------------------------
console.log('Milestone 0: GP viewer/player');
for (const f of ['fixtures/fixture.gp3', 'fixtures/fixture.gp4']) {
  await step(`opens ${f}`, async () => {
    const { app, win, errors } = await launch(path.join(root, f));
    const tracks = await win.locator('.trk .name').allTextContents();
    assert.deepEqual(tracks, ['Guitar', 'Bass', 'Drums']);
    assert.deepEqual(errors, []);
    await app.close();
  });
}

{
  const { app, win, errors } = await launch(path.join(root, 'fixtures/fixture.gp5'));
  await step('opens a GP5 file and lists its tracks', async () => {
    assert.deepEqual(await win.locator('.trk .name').allTextContents(), ['Guitar', 'Bass', 'Drums']);
    assert.match(await win.title(), /fixture\.tabproj/);
  });
  await step('renders standard notation and tablature', async () => {
    const n = await win.evaluate(() => {
      const t = window.sixline;
      const b = t.score.tracks[0].staves[0].bars[0].voices[0].beats[0];
      return t.api.boundsLookup.findBeats(b).length; // one per staff renderer
    });
    assert.equal(n, 2, 'expected notation + tab renderers');
    await win.screenshot({ path: path.join(out, 'm0-guitar.png') });
  });
  await step('selecting a track renders that track', async () => {
    await win.locator('.trk').nth(1).click();
    await waitIdle(win);
    const r = await win.evaluate(() => ({ track: window.sixline.editor.cursor.track, rendered: window.sixline.api.tracks.map((t) => t.name) }));
    assert.deepEqual(r, { track: 1, rendered: ['Bass'] });
    await win.locator('.trk').nth(2).click();
    await waitIdle(win);
    await win.screenshot({ path: path.join(out, 'm0-drums.png') });
    await win.locator('.trk').nth(0).click();
    await waitIdle(win);
  });
  await step('soundfont loads and player becomes ready', async () => {
    await win.waitForFunction(() => window.sixline.api.isReadyForPlayback, null, { timeout: 20000 });
  });
  let posPlaying = 0;
  await step('Space starts playback; time and beat cursor advance', async () => {
    const cursorBefore = await win.evaluate(() => document.querySelector('.at-cursor-beat').style.transform);
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.sixline.playerState === 1, null, { timeout: 5000 });
    await win.waitForTimeout(1500);
    posPlaying = await win.evaluate(() => window.sixline.playerPos.current);
    assert.ok(posPlaying > 800, `time should advance while playing, got ${posPlaying}ms`);
    const cursorAfter = await win.evaluate(() => document.querySelector('.at-cursor-beat').style.transform);
    assert.notEqual(cursorAfter, cursorBefore, 'beat cursor should move');
    await win.screenshot({ path: path.join(out, 'm0-playing.png') });
  });
  await step('Space pauses; position holds', async () => {
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.sixline.playerState === 0, null, { timeout: 5000 });
    const a = await win.evaluate(() => window.sixline.playerPos.current);
    await win.waitForTimeout(500);
    const b = await win.evaluate(() => window.sixline.playerPos.current);
    assert.ok(a > 0 && Math.abs(b - a) < 50, `paused position should hold (${a} -> ${b})`);
  });
  await step('Stop returns to the start', async () => {
    await win.click('#b-stop');
    await win.waitForFunction(() => window.sixline.playerPos.current === 0, null, { timeout: 3000 });
  });
  await step('seek slider moves the playback position', async () => {
    await win.evaluate(() => {
      const s = document.getElementById('seek');
      s.value = String(Number(s.max) / 2);
      s.dispatchEvent(new Event('input'));
    });
    await win.waitForTimeout(300);
    const r = await win.evaluate(() => ({ pos: window.sixline.playerPos.current, end: window.sixline.playerPos.end }));
    assert.ok(Math.abs(r.pos - r.end / 2) < 300, `expected ~${r.end / 2}, got ${r.pos}`);
  });
  await step('clicking in the score seeks there', async () => {
    const p = await tabPoint(win, 2, 0, 0);
    await win.mouse.click(p.x, p.y);
    await win.waitForTimeout(300);
    const tick = await win.evaluate(() => window.sixline.api.tickPosition);
    assert.ok(Math.abs(tick - 2 * 3840) <= 2, `tick ${tick} should be the start of bar 3`);
  });

  // -------------------------------------------------------------------------------------------
  console.log('Milestone 1: editable tablature');
  await step('clicking a tab position focuses that beat and string', async () => {
    const p = await tabPoint(win, 1, 2, 3);
    await win.mouse.click(p.x, p.y);
    const s = await state(win);
    assert.deepEqual(s.cursor, { track: 0, bar: 1, beat: 2, string: 3 });
    const caret = await win.evaluate(() => getComputedStyle(document.getElementById('caret')).display);
    assert.equal(caret, 'block');
  });
  await step('typing 1 then 2 enters fret 12 and the render updates', async () => {
    await win.keyboard.press('1');
    await win.keyboard.press('2');
    await waitIdle(win);
    const r = await win.evaluate(() => {
      const t = window.sixline;
      const b = t.score.tracks[0].staves[0].bars[1].voices[0].beats[2];
      return { model: t.editor.noteAtCursor()?.fret, rendered: b.notes.map((n) => [n.string, n.fret]) };
    });
    assert.equal(r.model, 12);
    // alphaTab string numbering: 1 = lowest; our string 3 on 6 strings => alphaTab 3
    assert.ok(r.rendered.some(([s, f]) => s === 3 && f === 12), JSON.stringify(r.rendered));
    await win.screenshot({ path: path.join(out, 'm1-fret12.png') });
  });
  await step('arrow keys move between strings and beats', async () => {
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowRight');
    let s = await state(win);
    assert.deepEqual(s.cursor, { track: 0, bar: 1, beat: 3, string: 5 });
    await win.keyboard.press('ArrowLeft');
    await win.keyboard.press('ArrowUp');
    await win.keyboard.press('ArrowUp');
    s = await state(win);
    assert.deepEqual(s.cursor, { track: 0, bar: 1, beat: 2, string: 3 });
  });
  await step('Delete removes the note; Ctrl+Z restores it; Ctrl+Y redoes', async () => {
    await win.keyboard.press('Delete');
    await waitIdle(win);
    assert.equal((await state(win)).beat.notes.find((n) => n.string === 3), undefined);
    await win.keyboard.press('Control+z');
    await waitIdle(win);
    assert.equal((await state(win)).beat.notes.find((n) => n.string === 3)?.fret, 12);
    await win.keyboard.press('Control+y');
    await waitIdle(win);
    assert.equal((await state(win)).beat.notes.find((n) => n.string === 3), undefined);
    await win.keyboard.press('Control+z');
    await waitIdle(win);
  });
  await step('duration shortcuts and toolbar change the beat duration', async () => {
    await win.keyboard.press('Alt+4');
    assert.equal((await state(win)).beat.duration, 8);
    await win.keyboard.press('Alt+5');
    assert.equal((await state(win)).beat.duration, 16);
    await win.click('[data-dur="2"]');
    assert.equal((await state(win)).beat.duration, 2);
    await win.click('[data-dur="1"]');
    assert.equal((await state(win)).beat.duration, 1);
    await win.keyboard.press('Alt+3');
    assert.equal((await state(win)).beat.duration, 4);
    await waitIdle(win);
    const rendered = await win.evaluate(() => window.sixline.score.tracks[0].staves[0].bars[1].voices[0].beats[2].duration);
    assert.equal(rendered, 4);
  });
  await step('Insert adds a beat, Ctrl+Delete removes it', async () => {
    const before = (await state(win)).beats;
    await win.keyboard.press('Insert');
    assert.equal((await state(win)).beats, before + 1);
    assert.equal((await state(win)).beat.notes.length, 0);
    await win.keyboard.press('Control+Delete');
    assert.equal((await state(win)).beats, before);
  });
  await step('typing in a new bar at the end extends the song', async () => {
    await win.keyboard.press('Control+End'); // no-op guard
    await win.evaluate(() => window.sixline.editor.setCursor({ bar: 3, beat: 0, string: 0 }));
    const bars = (await state(win)).bars;
    await win.keyboard.press('ArrowRight'); // bar 4 is a full whole note -> new bar
    const s = await state(win);
    assert.equal(s.bars, bars + 1);
    assert.equal(s.cursor.bar, 4);
    await win.keyboard.press('5');
    await win.keyboard.press('ArrowRight');
    await win.keyboard.press('7');
    await waitIdle(win);
    const r = await win.evaluate(() => window.sixline.score.tracks[0].staves[0].bars[4].voices[0].beats.map((b) => b.notes.map((n) => n.fret)));
    assert.deepEqual(r, [[5], [7]]);
  });
  await step('Space toggles playback while editing', async () => {
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.sixline.playerState === 1, null, { timeout: 5000 });
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.sixline.playerState === 0, null, { timeout: 5000 });
  });
  await step('no page errors', async () => assert.deepEqual(errors, []));
  await app.close();
}

// ---------------------------------------------------------------------------------------------
console.log('Milestone 2: new songs');
{
  const { app, win, errors } = await launch(path.join(root, 'fixtures/fixture.gp3'));
  await step('Ctrl+N opens the new-song dialog and creates an editable bass song', async () => {
    await win.keyboard.press('Control+n');
    await win.waitForSelector('dialog[open]');
    await win.fill('#f-title', 'My Bass Line');
    await win.selectOption('#f-type', 'bass');
    await win.fill('#f-tempo', '90');
    await win.fill('#f-num', '3');
    await win.fill('#f-bars', '6');
    await win.click('dialog button[value=ok]');
    await waitIdle(win);
    const s = await win.evaluate(() => {
      const song = window.sixline.editor.song;
      return { title: song.title, tempo: song.tempo, bars: song.masterBars.length, sig: song.masterBars[0].num + '/' + song.masterBars[0].den, tracks: song.tracks.map((t) => [t.type, t.tuning.length]) };
    });
    assert.deepEqual(s, { title: 'My Bass Line', tempo: 90, bars: 6, sig: '3/4', tracks: [['bass', 4]] });
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('ArrowDown'); // clamps at string 4
    await win.keyboard.press('3');
    await waitIdle(win);
    const n = await win.evaluate(() => window.sixline.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.map((n) => [n.string, n.fret, n.realValue]));
    assert.deepEqual(n, [[1, 3, 31]]); // low E (28) + 3 = G (31)
  });
  await step('Track menu adds drum and keys tracks; Remove track works', async () => {
    const menu = async (title, item) => {
      await win.locator('.menu .title', { hasText: title }).dispatchEvent('mousedown');
      await win.locator('.menu.open .item', { hasText: item }).dispatchEvent('mousedown');
    };
    await menu('Track', 'Add drum track');
    await menu('Track', 'Add keys/synth track');
    await waitIdle(win);
    assert.deepEqual(await win.locator('.trk .name').allTextContents(), ['Bass', 'Drums', 'Keys']);
    await menu('Track', 'Remove track');
    await waitIdle(win);
    assert.deepEqual(await win.locator('.trk .name').allTextContents(), ['Bass', 'Drums']);
    await win.locator('.trk').nth(0).click();
    await waitIdle(win);
  });
  await step('track properties dialog changes tuning (preset) and name', async () => {
    await win.keyboard.press('F6');
    await win.waitForSelector('dialog[open]');
    await win.fill('#f-name', 'Low Bass');
    await win.focus('#f-preset');
    await win.selectOption('#f-preset', 'Bass 5-string');
    assert.equal(await win.inputValue('#f-tuning'), 'G2 D2 A1 E1 B0');
    await win.click('dialog button[value=ok]');
    await waitIdle(win);
    const t = await win.evaluate(() => window.sixline.editor.song.tracks[0]);
    assert.equal(t.name, 'Low Bass');
    assert.deepEqual(t.tuning, [43, 38, 33, 28, 23]);
    const lines = await win.evaluate(() => window.sixline.score.tracks[0].staves[0].tuning.length);
    assert.equal(lines, 5);
  });
  await step('time signature dialog changes the bar and the following bars', async () => {
    await win.evaluate(() => window.sixline.editor.setCursor({ bar: 2 }));
    await win.click('#tsig');
    await win.waitForSelector('dialog[open]');
    await win.fill('#f-num', '5');
    await win.selectOption('#f-den', '8');
    await win.click('dialog button[value=ok]');
    await waitIdle(win);
    const sigs = await win.evaluate(() => window.sixline.editor.song.masterBars.map((m) => m.num + '/' + m.den));
    assert.deepEqual(sigs, ['3/4', '3/4', '5/8', '5/8', '5/8', '5/8']);
    await win.screenshot({ path: path.join(out, 'm2-new-song.png') });
  });
  await step('no page errors', async () => assert.deepEqual(errors, []));
  await app.close();
}

// ---------------------------------------------------------------------------------------------
console.log('Milestone 3: drum and keys entry');
{
  const { app, win, errors } = await launch(path.join(root, 'fixtures/fixture.gp5'));
  const exportParsed = async () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sixline-m3-')), 'out.mid');
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
    }, f);
    await win.keyboard.press('Control+e');
    await win.waitForFunction(() => document.getElementById('msg')?.textContent.includes('Exported MIDI'), null, { timeout: 10000 });
    await win.evaluate(() => (document.getElementById('msg').textContent = ''));
    const midi = parseMidi(fs.readFileSync(f));
    const notes = [];
    midi.tracks.forEach((tr, ti) => {
      let t = 0;
      for (const e of tr) {
        t += e.deltaTime;
        if (e.type === 'noteOn' && e.velocity > 0) notes.push({ track: ti, ch: e.channel, key: e.noteNumber, t });
      }
    });
    return { midi, notes };
  };
  await step('new drum song: letter keys enter kit pieces; grid shows them; render updates', async () => {
    await win.keyboard.press('Control+n');
    await win.waitForSelector('dialog[open]');
    await win.selectOption('#f-type', 'drums');
    await win.fill('#f-bars', '2');
    await win.click('dialog button[value=ok]');
    await waitIdle(win);
    assert.ok(await win.isVisible('#drumgrid table'), 'drum grid visible');
    assert.match(await win.textContent('#status'), /Snare/);
    await win.keyboard.press('Alt+4'); // eighths
    for (const keys of [['k', 'h'], ['h'], ['s', 'h'], ['h'], ['k', 'h'], ['k', 'h'], ['s', 'h'], ['o']]) {
      for (const k of keys) await win.keyboard.press(k);
      await win.keyboard.press('ArrowRight');
    }
    await waitIdle(win);
    const r = await win.evaluate(() => {
      const t = window.sixline;
      return {
        model: t.editor.song.tracks[0].measures[0].voices[0].map((b) => b.notes.map((n) => n.pitch).sort((a, b) => a - b).join('+')),
        rendered: t.score.tracks[0].staves[0].bars[0].voices[0].beats.map((b) => b.notes.map((n) => n.percussionArticulation).sort((a, b) => a - b).join('+')),
        cursor: t.editor.cursor,
        cells: document.querySelectorAll('#drumgrid td.on').length,
      };
    });
    const want = ['36+42', '42', '38+42', '42', '36+42', '36+42', '38+42', '46'];
    assert.deepEqual(r.model, want);
    assert.deepEqual(r.rendered, want);
    assert.equal(r.cursor.bar, 1, 'full bar advanced to bar 2');
  });
  await step('clicking a drum grid cell toggles that piece; Delete removes on the cursor row; undo', async () => {
    await win.keyboard.press('PageUp');
    const cell = win.locator('#drumgrid tr', { hasText: 'Crash' }).first().locator('td').nth(0);
    await cell.dispatchEvent('mousedown');
    let beat0 = await win.evaluate(() => window.sixline.editor.song.tracks[0].measures[0].voices[0][0].notes.map((n) => n.pitch).sort((a, b) => a - b));
    assert.deepEqual(beat0, [36, 42, 49]);
    assert.match(await win.textContent('#status'), /Crash/);
    await win.keyboard.press('Delete');
    beat0 = await win.evaluate(() => window.sixline.editor.song.tracks[0].measures[0].voices[0][0].notes.map((n) => n.pitch).sort((a, b) => a - b));
    assert.deepEqual(beat0, [36, 42]);
    await win.keyboard.press('Control+z');
    await win.keyboard.press('Control+z');
    await waitIdle(win);
    await win.screenshot({ path: path.join(out, 'm3-drums.png') });
  });
  await step('drum edits play back and export on channel 10 (GM)', async () => {
    await win.waitForFunction(() => window.sixline.api.isReadyForPlayback, null, { timeout: 20000 });
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.sixline.playerState === 1, null, { timeout: 5000 });
    await win.waitForTimeout(800);
    await win.keyboard.press('Space');
    assert.ok((await win.evaluate(() => window.sixline.playerPos.current)) > 300, 'playback advanced');
    const { notes } = await exportParsed();
    const bar0 = notes.filter((n) => n.t < 3840).map((n) => `${n.ch}:${n.key}@${n.t}`).sort();
    assert.deepEqual(bar0, ['9:36@0', '9:36@1920', '9:36@2400', '9:38@2880', '9:38@960', '9:42@0', '9:42@1440', '9:42@1920', '9:42@2400', '9:42@2880', '9:42@480', '9:42@960', '9:46@3360'].sort());
  });
  await step('keys track: note names, transpose, duration, delete; render + export', async () => {
    await win.locator('.menu .title', { hasText: 'Track' }).dispatchEvent('mousedown');
    await win.locator('.menu.open .item', { hasText: 'Add keys/synth track' }).dispatchEvent('mousedown');
    await waitIdle(win);
    await win.evaluate(() => window.sixline.editor.setCursor({ bar: 0, beat: 0 }));
    assert.match(await win.textContent('#status'), /Pitch C4/);
    assert.ok(!(await win.isVisible('#drumgrid table')), 'drum grid hidden on keys');
    await win.keyboard.press('Alt+2'); // half notes
    for (const k of ['c', 'e', 'g']) await win.keyboard.press(k);
    await win.keyboard.press('Shift+ArrowDown'); // G4 -> F#4
    await win.keyboard.press('ArrowRight');
    await win.keyboard.press('d');
    await win.keyboard.press('f');
    await win.keyboard.press('a');
    await win.keyboard.press('Delete'); // remove the A under the cursor
    await waitIdle(win);
    const r = await win.evaluate(() => {
      const t = window.sixline;
      const ti = t.editor.cursor.track;
      return {
        model: t.editor.song.tracks[ti].measures[0].voices[0].map((b) => [b.duration, b.notes.map((n) => n.pitch)]),
        rendered: t.score.tracks[ti].staves[0].bars[0].voices[0].beats.map((b) => b.notes.map((n) => n.realValue).sort((a, b) => b - a)),
        tab: t.score.tracks[ti].staves[0].showTablature,
      };
    });
    assert.deepEqual(r.model, [[2, [66, 64, 60]], [2, [65, 62]]]);
    assert.deepEqual(r.rendered, [[66, 64, 60], [65, 62]]);
    assert.equal(r.tab, false, 'keys tracks show notation only');
    await win.screenshot({ path: path.join(out, 'm3-keys.png') });
  });
  await step('keys MIDI program selection (GM list) reaches the export', async () => {
    await win.keyboard.press('F6');
    await win.waitForSelector('dialog[open]');
    await win.selectOption('#f-program', '81');
    await win.click('dialog button[value=ok]');
    await waitIdle(win);
    const { midi, notes } = await exportParsed();
    const pc = midi.tracks[1].find((e) => e.type === 'programChange');
    assert.equal(pc.programNumber, 81);
    assert.deepEqual(notes.filter((n) => n.track === 1).map((n) => `${n.key}@${n.t}`).sort(), ['60@0', '62@1920', '64@0', '65@1920', '66@0'].sort());
  });
  await step('no page errors', async () => assert.deepEqual(errors, []));
  await app.close();
}

// ---------------------------------------------------------------------------------------------
console.log('Milestone 4: MIDI export');
{
  const priv = path.join(root, 'gp5-examples/Tower10.gp5');
  const src = fs.existsSync(priv) ? priv : path.join(root, 'fixtures/fixture.gp5');
  if (src !== priv) console.log('       (private gp5-examples/Tower10.gp5 absent; using fixtures/fixture.gp5)');
  const { app, win, errors } = await launch(src);
  await step(`edit ${path.basename(src)} tab, File > Export MIDI, parse result independently`, async () => {
    const bar = await win.evaluate((from) => {
      const ms = window.sixline.editor.song.tracks[0].measures;
      for (let i = from; i < ms.length; i++) if (ms[i].voices[0].length >= 2) return i;
      return -1;
    }, src === priv ? 100 : 0);
    assert.ok(bar >= 0, 'no bar with two beats');
    await win.evaluate((bar) => window.sixline.editor.setCursor({ track: 0, bar, beat: 0, string: 0 }), bar);
    await waitIdle(win);
    const p = await tabPoint(win, bar, 1, 0); // click 2nd beat, top string
    await win.mouse.click(p.x, p.y);
    await win.keyboard.press('1');
    await win.keyboard.press('9');
    await waitIdle(win);
    const exp = await win.evaluate(() => {
      const t = window.sixline;
      const c = t.editor.cursor;
      const beat = t.score.tracks[0].staves[0].bars[c.bar].voices[0].beats[c.beat];
      return { cursor: c, key: t.editor.track.tuning[0] + 19, tick: t.score.masterBars[c.bar].start + beat.playbackStart, dur: beat.playbackDuration };
    });
    assert.equal(exp.cursor.beat, 1, `click at ${JSON.stringify(p)} bar ${bar} gave ${JSON.stringify(exp.cursor)}, viewport ${JSON.stringify(win.viewportSize())}`);
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sixline-mid-')), 'export.mid');
    await app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
    }, outFile);
    await win.locator('.menu .title', { hasText: 'File' }).dispatchEvent('mousedown');
    await win.locator('.menu.open .item', { hasText: 'Export MIDI' }).dispatchEvent('mousedown');
    await win.waitForFunction(() => document.getElementById('msg')?.textContent.includes('Exported MIDI'), null, { timeout: 10000 });
    const midi = parseMidi(fs.readFileSync(outFile));
    assert.equal(midi.header.format, 1);
    assert.equal(midi.tracks.length, await win.evaluate(() => window.sixline.editor.song.tracks.length));
    // find the edited note in track 0
    let t = 0;
    const ons = [];
    const offs = new Map();
    for (const e of midi.tracks[0]) {
      t += e.deltaTime;
      if (e.type === 'noteOn' && e.velocity > 0) ons.push({ t, key: e.noteNumber, ch: e.channel });
      else if ((e.type === 'noteOff' || e.type === 'noteOn') && e.noteNumber === exp.key && !offs.has(t)) offs.set(e.noteNumber + ':' + ons.filter((o) => o.key === e.noteNumber).at(-1)?.t, t);
    }
    const hit = ons.find((o) => o.key === exp.key && o.t === exp.tick);
    assert.ok(hit, `edited note key ${exp.key} at tick ${exp.tick} not found in exported MIDI`);
    const end = offs.get(exp.key + ':' + exp.tick);
    assert.ok(end !== undefined && Math.abs(end - exp.tick - exp.dur) <= 1, `duration ${end - exp.tick} != ${exp.dur}`);
    console.log(`       edited note: key ${exp.key} tick ${exp.tick} dur ${exp.dur} ch ${hit.ch}; ${ons.length} notes in track 0`);
  });
  await step('no page errors', async () => assert.deepEqual(errors, []));
  await app.close();
}

// ---------------------------------------------------------------------------------------------
console.log('Milestone 5: MIDI import');
{
  const midiDir = path.join(root, 'fixtures/midi');
  const { app, win, errors } = await launch(path.join(root, 'fixtures/fixture.gp5'));
  const stubOpen = (f) => app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, f);
  const stubSave = (f) => app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
  }, f);
  const menu = async (title, item) => {
    await win.locator('.menu .title', { hasText: title }).dispatchEvent('mousedown');
    await win.locator('.menu.open .item', { hasText: item }).dispatchEvent('mousedown');
  };
  /** File > Import MIDI, accept (optionally adjust) the mapping, return the report lines. */
  const importVia = async (file, adjust) => {
    await stubOpen(file);
    await menu('File', 'Import MIDI');
    await win.waitForSelector('dialog.import[open]');
    if (adjust) await adjust();
    await win.click('dialog.import button[value=ok]');
    await win.waitForSelector('dialog.report[open]');
    const lines = await win.locator('dialog.report li').allTextContents();
    await win.click('dialog.report button');
    await waitIdle(win);
    return lines;
  };

  for (const f of fs.readdirSync(midiDir).filter((f) => f.endsWith('.mid')).sort()) {
    await step(`imports ${f} through File > Import MIDI`, async () => {
      const lines = await importVia(path.join(midiDir, f));
      const s = await win.evaluate(() => {
        const song = window.sixline.editor.song;
        return { tracks: song.tracks.map((t) => `${t.name}:${t.type}`), notes: window.sixline.score.tracks.reduce((n, t) => n + t.staves[0].bars.reduce((m, b) => m + b.voices[0].beats.reduce((k, be) => k + be.notes.length, 0), 0), 0) };
      });
      assert.ok(s.tracks.length > 0 && s.notes > 0, JSON.stringify(s));
      console.log(`       ${s.tracks.join(', ')} | ${lines.join(' ')}`);
      if (f === 'humanized.mid') assert.ok(lines.some((l) => /snapped/.test(l)), 'quantisation reported');
      else if (f !== 'drums.mid' && f !== 'multitrack.mid' && f !== 'piano.mid') assert.ok(lines.every((l) => !/snapped|shortened/.test(l)), lines.join());
    });
  }

  await step('mapping dialog shows proposals and accepts changes (exclude a track, change a type)', async () => {
    const lines = await importVia(path.join(midiDir, 'multitrack.mid'), async () => {
      const rows = await win.locator('dialog.import tr[data-i]').evaluateAll((trs) =>
        trs.map((tr) => [tr.querySelector('.name').value, tr.querySelector('.type').value, tr.querySelector('.tuning').disabled ? '' : tr.querySelector('.tuning').value]),
      );
      assert.deepEqual(rows, [['Guitar', 'guitar', 'Guitar standard'], ['Bass', 'bass', 'Bass 4-string'], ['Strings', 'keys', ''], ['Kit', 'drums', '']]);
      await win.locator('dialog.import tr[data-i="2"] .inc').uncheck();
    });
    assert.ok(lines.some((l) => /1 track\(s\) were not imported/.test(l)), lines.join());
    assert.deepEqual(await win.locator('.trk .name').allTextContents(), ['Guitar', 'Bass', 'Kit']);
  });

  await step('imported multitrack plays, edits (tab, drums, track type), saves and exports; edits survive', async () => {
    await importVia(path.join(midiDir, 'multitrack.mid'));
    assert.deepEqual(await win.locator('.trk .name').allTextContents(), ['Guitar', 'Bass', 'Strings', 'Kit']);
    // play
    await win.waitForFunction(() => window.sixline.api.isReadyForPlayback, null, { timeout: 20000 });
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.sixline.playerState === 1, null, { timeout: 5000 });
    await win.waitForTimeout(600);
    await win.keyboard.press('Space');
    await win.click('#b-stop');
    // tab edit: guitar bar 1 beat 1, top string, fret 12 (E4 + 12 = 76)
    await win.locator('.trk').nth(0).click();
    await waitIdle(win);
    const p = await tabPoint(win, 0, 0, 0);
    await win.mouse.click(p.x, p.y);
    await win.keyboard.press('1');
    await win.keyboard.press('2');
    // drum edit: crash on the first beat of the kit
    await win.locator('.trk').nth(3).click();
    await waitIdle(win);
    await win.evaluate(() => window.sixline.editor.setCursor({ bar: 0, beat: 0 }));
    await win.keyboard.press('c');
    // track type: strings (keys) -> guitar
    await win.locator('.trk').nth(2).click();
    await waitIdle(win);
    await win.keyboard.press('F6');
    await win.waitForSelector('dialog[open]');
    await win.selectOption('#f-type', 'guitar');
    await win.click('dialog button[value=ok]');
    await waitIdle(win);
    const strings = await win.evaluate(() => {
      const t = window.sixline.editor.song.tracks[2];
      return { type: t.type, first: t.measures[0].voices[0][0].notes.map((n) => t.tuning[n.string] + n.fret).sort() };
    });
    assert.deepEqual(strings, { type: 'guitar', first: [52, 59, 64] });
    await win.screenshot({ path: path.join(out, 'm5-imported.png') });
    // save as native project
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sixline-m5-'));
    await stubSave(path.join(tmp, 'imported.tabproj'));
    await win.keyboard.press('Control+Shift+s');
    await win.waitForFunction(() => !document.title.includes('*'), null, { timeout: 5000 });
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'imported.tabproj'), 'utf8'));
    assert.equal(saved.song.tracks[2].type, 'guitar');
    // export and parse independently
    await stubSave(path.join(tmp, 'roundtrip.mid'));
    await win.keyboard.press('Control+e');
    await win.waitForFunction(() => document.getElementById('msg')?.textContent.includes('Exported MIDI'), null, { timeout: 10000 });
    const midi = parseMidi(fs.readFileSync(path.join(tmp, 'roundtrip.mid')));
    const notes = [];
    const meta = [];
    midi.tracks.forEach((tr, ti) => {
      let t = 0;
      for (const e of tr) {
        t += e.deltaTime;
        if (e.type === 'noteOn' && e.velocity > 0) notes.push(`${ti}:${e.channel}:${e.noteNumber}@${t}`);
        if (e.type === 'setTempo') meta.push(`tempo ${Math.round(60e6 / e.microsecondsPerBeat)}@${t}`);
        if (e.type === 'timeSignature') meta.push(`sig ${e.numerator}/${e.denominator}@${t}`);
      }
    });
    assert.ok(notes.includes('0:0:76@0'), 'guitar edit (fret 12 on top string) exported');
    assert.ok(notes.includes('3:9:49@0'), 'crash added on the kit exported on channel 10');
    for (const k of [52, 59, 64]) assert.ok(notes.some((n) => n.startsWith('2:') && n.endsWith(`:${k}@0`)), `converted strings note ${k}`);
    assert.deepEqual(meta.sort(), ['sig 3/4@11520', 'sig 4/4@0', 'sig 6/8@17280', 'tempo 100@0', 'tempo 140@7680'].sort());
  });
  await step('no page errors', async () => assert.deepEqual(errors, []));
  await app.close();
}

// ---------------------------------------------------------------------------------------------
console.log('Persistence + large file');
await step('edit a .tabproj and Ctrl+S saves it in place', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sixline-'));
  const proj = path.join(tmp, 'song.tabproj');
  const track = { name: 'Gtr', type: 'guitar', program: 29, tuning: [64, 59, 55, 50, 45, 40], capo: 0, volume: 13, pan: 8, mute: false, solo: false,
    measures: [{ voices: [[{ duration: 4, dots: 0, notes: [] }]] }] };
  const song = { title: 'Saved', artist: '', tempo: 120, masterBars: [{ num: 4, den: 4 }], tracks: [track] };
  fs.writeFileSync(proj, JSON.stringify({ format: 'tabproj', version: 1, song }));
  const { app, win } = await launch(proj);
  await win.keyboard.press('7');
  assert.match(await win.title(), /\*/);
  await win.keyboard.press('Control+s');
  await win.waitForFunction(() => !document.title.includes('*'), null, { timeout: 5000 });
  const saved = JSON.parse(fs.readFileSync(proj, 'utf8'));
  assert.equal(saved.format, 'tabproj');
  assert.deepEqual(saved.song.tracks[0].measures[0].voices[0][0].notes, [{ string: 0, fret: 7, velocity: 95 }]);
  await app.close();
});

const big = path.join(root, 'gp5-examples/Tower10.gp5');
if (fs.existsSync(big)) {
  await step('large GP5 (201 bars, 4 tracks): open and edit latency', async () => {
    const t0 = Date.now();
    const { app, win, errors } = await launch(big);
    const openMs = Date.now() - t0;
    await win.evaluate(() => window.sixline.editor.setCursor({ bar: 100, beat: 0, string: 2 }));
    await waitIdle(win);
    const ms = await win.evaluate(async () => {
      const t = window.sixline;
      const times = [];
      for (const d of [3, 5, 7]) {
        const s = performance.now();
        t.editor.typeDigit(d, -1e9);
        await new Promise((r) => {
          const off = t.api.renderFinished.on(() => {
            off?.();
            r();
          });
        });
        times.push(performance.now() - s);
      }
      return times;
    });
    console.log(`       open+first render ${openMs}ms; edit->rendered ${ms.map((x) => x.toFixed(0)).join(', ')}ms`);
    await win.screenshot({ path: path.join(out, 'large.png') });
    assert.deepEqual(errors, []);
    await app.close();
  });
}

console.log(failures ? `\n${failures} FAILED` : '\nall e2e checks passed');
process.exit(failures ? 1 : 0);
