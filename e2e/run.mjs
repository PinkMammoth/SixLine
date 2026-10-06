// End-to-end checks against the real Electron app (requires `npm run build` first).
// Usage: node e2e/run.mjs
import { _electron as electron } from 'playwright-core';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

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
  await win.waitForFunction(() => window.tabedit?.score && !window.tabedit.rendering && document.querySelector('#at .at-surface *'), null, { timeout });
  await win.waitForTimeout(150);
  await win.waitForFunction(() => !window.tabedit.rendering, null, { timeout });
}

const state = (win) =>
  win.evaluate(() => {
    const t = window.tabedit;
    const e = t.editor;
    return { cursor: { ...e.cursor }, beat: structuredClone(e.beat), beats: e.beats.length, bars: e.song.masterBars.length, dirty: e.dirty, title: document.title };
  });

/** Screen coordinates of a tab position (bar, beat, string) of the rendered track. */
const tabPoint = (win, bar, beat, string) =>
  win.evaluate(
    ([bar, beat, string]) => {
      const t = window.tabedit;
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
      const t = window.tabedit;
      const b = t.score.tracks[0].staves[0].bars[0].voices[0].beats[0];
      return t.api.boundsLookup.findBeats(b).length; // one per staff renderer
    });
    assert.equal(n, 2, 'expected notation + tab renderers');
    await win.screenshot({ path: path.join(out, 'm0-guitar.png') });
  });
  await step('selecting a track renders that track', async () => {
    await win.locator('.trk').nth(1).click();
    await waitIdle(win);
    const r = await win.evaluate(() => ({ track: window.tabedit.editor.cursor.track, rendered: window.tabedit.api.tracks.map((t) => t.name) }));
    assert.deepEqual(r, { track: 1, rendered: ['Bass'] });
    await win.locator('.trk').nth(2).click();
    await waitIdle(win);
    await win.screenshot({ path: path.join(out, 'm0-drums.png') });
    await win.locator('.trk').nth(0).click();
    await waitIdle(win);
  });
  await step('soundfont loads and player becomes ready', async () => {
    await win.waitForFunction(() => window.tabedit.api.isReadyForPlayback, null, { timeout: 20000 });
  });
  let posPlaying = 0;
  await step('Space starts playback; time and beat cursor advance', async () => {
    const cursorBefore = await win.evaluate(() => document.querySelector('.at-cursor-beat').style.transform);
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.tabedit.playerState === 1, null, { timeout: 5000 });
    await win.waitForTimeout(1500);
    posPlaying = await win.evaluate(() => window.tabedit.playerPos.current);
    assert.ok(posPlaying > 800, `time should advance while playing, got ${posPlaying}ms`);
    const cursorAfter = await win.evaluate(() => document.querySelector('.at-cursor-beat').style.transform);
    assert.notEqual(cursorAfter, cursorBefore, 'beat cursor should move');
    await win.screenshot({ path: path.join(out, 'm0-playing.png') });
  });
  await step('Space pauses; position holds', async () => {
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.tabedit.playerState === 0, null, { timeout: 5000 });
    const a = await win.evaluate(() => window.tabedit.playerPos.current);
    await win.waitForTimeout(500);
    const b = await win.evaluate(() => window.tabedit.playerPos.current);
    assert.ok(a > 0 && Math.abs(b - a) < 50, `paused position should hold (${a} -> ${b})`);
  });
  await step('Stop returns to the start', async () => {
    await win.click('#b-stop');
    await win.waitForFunction(() => window.tabedit.playerPos.current === 0, null, { timeout: 3000 });
  });
  await step('seek slider moves the playback position', async () => {
    await win.evaluate(() => {
      const s = document.getElementById('seek');
      s.value = String(Number(s.max) / 2);
      s.dispatchEvent(new Event('input'));
    });
    await win.waitForTimeout(300);
    const r = await win.evaluate(() => ({ pos: window.tabedit.playerPos.current, end: window.tabedit.playerPos.end }));
    assert.ok(Math.abs(r.pos - r.end / 2) < 300, `expected ~${r.end / 2}, got ${r.pos}`);
  });
  await step('clicking in the score seeks there', async () => {
    const p = await tabPoint(win, 2, 0, 0);
    await win.mouse.click(p.x, p.y);
    await win.waitForTimeout(300);
    const tick = await win.evaluate(() => window.tabedit.api.tickPosition);
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
      const t = window.tabedit;
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
    const rendered = await win.evaluate(() => window.tabedit.score.tracks[0].staves[0].bars[1].voices[0].beats[2].duration);
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
    await win.evaluate(() => window.tabedit.editor.setCursor({ bar: 3, beat: 0, string: 0 }));
    const bars = (await state(win)).bars;
    await win.keyboard.press('ArrowRight'); // bar 4 is a full whole note -> new bar
    const s = await state(win);
    assert.equal(s.bars, bars + 1);
    assert.equal(s.cursor.bar, 4);
    await win.keyboard.press('5');
    await win.keyboard.press('ArrowRight');
    await win.keyboard.press('7');
    await waitIdle(win);
    const r = await win.evaluate(() => window.tabedit.score.tracks[0].staves[0].bars[4].voices[0].beats.map((b) => b.notes.map((n) => n.fret)));
    assert.deepEqual(r, [[5], [7]]);
  });
  await step('Space toggles playback while editing', async () => {
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.tabedit.playerState === 1, null, { timeout: 5000 });
    await win.keyboard.press('Space');
    await win.waitForFunction(() => window.tabedit.playerState === 0, null, { timeout: 5000 });
  });
  await step('no page errors', async () => assert.deepEqual(errors, []));
  await app.close();
}

// ---------------------------------------------------------------------------------------------
console.log('Persistence + large file');
await step('edit a .tabproj and Ctrl+S saves it in place', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabedit-'));
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
    await win.evaluate(() => window.tabedit.editor.setCursor({ bar: 100, beat: 0, string: 2 }));
    await waitIdle(win);
    const ms = await win.evaluate(async () => {
      const t = window.tabedit;
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
