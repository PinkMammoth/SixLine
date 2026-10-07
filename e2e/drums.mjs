import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseMidi } from 'midi-file';

export async function drumWorkflows({ launch, closeApp, step, waitIdle, out, root }) {
  console.log('Drums: numeric score and entry');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sixline-drums-'));
  const file = path.join(tmp, 'drums.tabproj');
  const beats = () => Array.from({ length: 4 }, () => ({ duration: 4, dots: 0, notes: [] }));
  const song = {
    title: 'Numbered drums', artist: '', tempo: 120,
    masterBars: Array.from({ length: 8 }, (_, i) => ({ num: 4, den: 4, ...(i === 0 ? { marker: 'Intro' } : {}) })),
    tracks: [
      { name: 'Drums', type: 'drums', program: 0, tuning: [], capo: 0, volume: 13, pan: 8, mute: false, solo: false, measures: Array.from({ length: 8 }, () => ({ voices: [beats()] })) },
      { name: 'Guitar', type: 'guitar', program: 29, tuning: [64,59,55,50,45,40], capo: 0, volume: 13, pan: 8, mute: false, solo: false, measures: Array.from({ length: 8 }, () => ({ voices: [beats()] })) },
    ],
  };
  for (const measure of song.tracks[0].measures) measure.voices.push([{ duration: 1, dots: 0, notes: [] }]);
  song.tracks[0].measures[2].voices[1][0].notes.push({ pitch: 56, velocity: 70, fx: { ghost: true } });
  fs.writeFileSync(file, JSON.stringify({ format: 'tabproj', version: 1, song }));
  const { app, win, errors } = await launch(file);
  const pitches = () => win.evaluate(() => window.sixline.editor.beat.notes.map(n => n.pitch));
  try {
    await step('drum input/view switches preserve music and player; letters remain available', async () => {
      await win.selectOption('#drum-input', 'letters'); await win.selectOption('#drum-view', 'notation');
      await win.keyboard.type('hs'); await waitIdle(win);
      assert.deepEqual(await pitches(), [42,38]);
      await win.evaluate(() => { window.__drumScore = window.sixline.score; window.__drumSong = JSON.stringify(window.sixline.editor.song); window.__drumUndo = window.sixline.editor.lastUndoLabel; });
      await win.selectOption('#drum-input', 'numbers');
      assert.ok(await win.isVisible('#drumscore'));
      assert.equal(await win.inputValue('#drum-view'), 'numbers');
      assert.ok(await win.evaluate(() => window.__drumScore === window.sixline.score && window.__drumSong === JSON.stringify(window.sixline.editor.song) && window.__drumUndo === window.sixline.editor.lastUndoLabel));
      assert.equal(await win.locator('.drum-marker').first().textContent(), 'Intro');
      assert.equal(await win.locator('.drum-number[data-pitch="42"]').first().textContent(), '42');
    });
    await step('two-digit chords are atomic; incomplete/invalid entry leaves music intact', async () => {
      await win.keyboard.press('ArrowRight');
      await win.keyboard.press('3');
      assert.deepEqual(await pitches(), []);
      assert.match(await win.textContent('#status'), /Entering 3_/);
      await win.keyboard.press('8'); await waitIdle(win);
      assert.deepEqual(await pitches(), [38]);
      await win.keyboard.press('Control+z'); await waitIdle(win); assert.deepEqual(await pitches(), []);
      await win.keyboard.press('Control+y'); await waitIdle(win); assert.deepEqual(await pitches(), [38]);
      await win.keyboard.type('4236'); await waitIdle(win); assert.deepEqual(await pitches(), [42,38,36]);
      await win.keyboard.type('99'); assert.deepEqual(await pitches(), [42,38,36]);
      assert.match(await win.textContent('#msg'), /35 to 81/);
      await win.keyboard.press('3'); await win.keyboard.press('Escape');
      assert.equal(await win.evaluate(() => window.sixline.editor.drumDigits), '');
      await win.keyboard.type('56'); await waitIdle(win);
      assert.deepEqual(await pitches(), [56,42,38,36]);
      assert.match(await win.textContent('#status'), /56 Cowbell/);
      assert.ok(await win.locator('#drumgrid th', { hasText: 'Cowbell' }).isVisible());
    });
    await step('numbered score clicks select instruments; Delete/undo and Shift-click ranges work', async () => {
      const cell = '.drum-beat[data-bar="0"][data-beat="1"][data-voice="0"]';
      await win.locator(cell + ' [data-pitch="38"]').click();
      assert.equal(await win.evaluate(() => window.sixline.editor.rowPitch()), 38);
      await win.keyboard.press('Delete'); await waitIdle(win);
      assert.deepEqual(await pitches(), [56,42,36]);
      await win.keyboard.press('Control+z'); await waitIdle(win);
      assert.deepEqual(await pitches(), [56,42,38,36]);
      await win.locator('.drum-beat[data-bar="1"][data-beat="3"][data-voice="0"]').click({ modifiers: ['Shift'] });
      assert.equal(await win.locator('.drum-beat.selected').count(), 7);
      await win.keyboard.press('Escape');
      assert.equal(await win.locator('.drum-beat.selected').count(), 0);
      const before = await win.evaluate(() => structuredClone(window.sixline.editor.cursor));
      await win.locator('.drum-beat[data-bar="2"][data-voice="1"] [data-pitch="56"]').click();
      assert.deepEqual(await win.evaluate(() => window.sixline.editor.cursor), before);
      assert.ok(await win.locator('.drum-beat[data-voice="1"] .ghost').isVisible());
    });
    await step('number view works with letter input and numeric entry works with notation', async () => {
      await win.keyboard.press('Control+Home');
      await win.selectOption('#drum-input', 'letters'); assert.ok(await win.isVisible('#drumscore'));
      await win.keyboard.press('k'); await waitIdle(win); assert.deepEqual(await pitches(), [42,38,36]);
      await win.selectOption('#drum-input', 'numbers'); await win.selectOption('#drum-view', 'notation');
      assert.ok(!(await win.isVisible('#drumscore')));
      await win.keyboard.type('49'); await waitIdle(win); assert.deepEqual(await pitches(), [49,42,38,36]);
      await win.selectOption('#drum-view', 'numbers');
      await win.screenshot({ path: path.join(out, 'drums-numbers.png') });
    });
    await step('numbered drum passage duplicates, saves/reopens and exports unchanged GM pitches', async () => {
      await win.keyboard.press('Control+Home'); await win.keyboard.press('Control+d'); await waitIdle(win);
      assert.equal(await win.evaluate(() => window.sixline.editor.song.masterBars.length), 9);
      const result = await win.evaluate(() => structuredClone(window.sixline.editor.song));
      assert.deepEqual(result.tracks[0].measures[0], result.tracks[0].measures[1]);
      await win.keyboard.press('Control+s');
      await win.waitForFunction(() => !window.sixline.editor.dirty);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).song, result);
      const midiFile = path.join(tmp, 'drums.mid');
      await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, midiFile);
      await win.keyboard.press('Control+e'); await win.waitForTimeout(350);
      const parsed = parseMidi(fs.readFileSync(midiFile));
      const hits = parsed.tracks.flat().filter(e => e.type === 'noteOn');
      assert.ok(hits.some(e => e.noteNumber === 56)); assert.ok(hits.some(e => e.noteNumber === 49));
      assert.ok(hits.every(e => e.channel === 9));
      await win.keyboard.press('Control+w');
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
      await win.keyboard.press('Control+o');
      await win.waitForFunction(file => window.sixline.active.filePath === file, file);
      await waitIdle(win);
      assert.deepEqual(await win.evaluate(() => window.sixline.editor.song), result);
      assert.equal(await win.inputValue('#drum-input'), 'numbers');
      assert.ok(await win.isVisible('#drumscore'));
    });
    await step('switching drum views/tracks and moving the caret preserves monotonic playback', async () => {
      await win.waitForFunction(() => window.sixline.api.isReadyForPlayback);
      await win.evaluate(() => {
        window.__drumPlayingScore = window.sixline.score; window.__drumPositions = []; window.__drumReady = 0;
        window.sixline.api.playerPositionChanged.on(e => window.__drumPositions.push({ tick:e.currentTick, seek:e.isSeek }));
        window.sixline.api.playerReady.on(() => window.__drumReady++);
      });
      await win.click('#b-caret'); await win.waitForFunction(() => window.sixline.playerState === 1);
      await win.waitForTimeout(400);
      const before = await win.evaluate(() => window.sixline.api.tickPosition);
      await win.selectOption('#drum-view', 'notation'); await win.waitForTimeout(200);
      await win.selectOption('#drum-view', 'numbers'); await win.waitForTimeout(200);
      assert.ok(await win.locator('.drum-beat.playing').count());
      await win.keyboard.press('Shift+ArrowRight'); await win.keyboard.press('ArrowDown');
      await win.evaluate(() => window.sixline.editor.setCursor({ track: 1 })); await waitIdle(win);
      assert.ok(!(await win.isVisible('#drum-controls')));
      await win.evaluate(() => window.sixline.editor.setCursor({ track: 0 })); await waitIdle(win);
      await win.selectOption('#drum-input', 'letters'); await win.selectOption('#drum-input', 'numbers');
      assert.equal(await win.evaluate(() => window.sixline.playerState), 1);
      assert.ok(await win.evaluate(() => window.sixline.api.tickPosition) > before);
      assert.ok(await win.evaluate(() => window.__drumPlayingScore === window.sixline.score));
      assert.equal(await win.evaluate(() => window.__drumReady), 1, 'only immediate ready notification; no regeneration');
      const samples = await win.evaluate(() => window.__drumPositions.filter(e => !e.seek));
      assert.ok(samples.length > 5);
      assert.ok(samples.every((e, i) => !i || e.tick >= samples[i-1].tick));
      await win.click('#b-stop');
    });
    await step('numbered view follows repeated exact loop boundaries at practice speed', async () => {
      await win.keyboard.press('Control+Home');
      await win.evaluate(() => window.sixline.editor.selectMeasures(0, 0));
      await win.click('#b-loop-selection'); await win.fill('#speed', '70'); await win.locator('#speed').blur();
      await win.evaluate(() => { window.__numberLoops = []; window.sixline.api.playerPositionChanged.on(e => window.__numberLoops.push(e.currentTick)); });
      await win.click('#b-caret'); await win.waitForFunction(() => window.sixline.playerState === 1);
      await win.waitForFunction(() => window.__numberLoops.some((n,i,a) => i && n < a[i-1]-100), null, { timeout: 10000 });
      const loop = await win.evaluate(() => window.sixline.practice.loop);
      assert.ok((await win.evaluate(() => window.__numberLoops)).every(n => n >= loop.startTick && n <= loop.endTick));
      assert.equal(await win.locator('.drum-beat.playing').getAttribute('data-bar'), '0');
      assert.equal(await win.locator('.drum-beat.selected[data-voice="0"]').count(), 4);
      assert.equal(await win.locator('.drum-beat.selected[data-voice="1"]').count(), 1);
      await win.click('#b-stop');
    });
    await step('drum view produces no page errors', async () => assert.deepEqual(errors, []));
  } finally {
    // Keep legacy workflows independent of the preferences chosen by this test.
    await win.selectOption('#drum-input', 'letters').catch(() => {});
    await win.selectOption('#drum-view', 'notation').catch(() => {});
    await closeApp(app, win);
  }
  // Preferences belong to the desktop profile, not the saved song. Check an actual restart.
  const again = await launch(file);
  try {
    await step('drum input/view preferences survive desktop restart', async () => {
      await again.win.selectOption('#drum-input', 'numbers');
      await again.win.selectOption('#drum-view', 'notation');
      await closeApp(again.app, again.win);
      const last = await launch(file);
      try {
        assert.equal(await last.win.inputValue('#drum-input'), 'numbers');
        assert.equal(await last.win.inputValue('#drum-view'), 'notation');
        await last.win.selectOption('#drum-input', 'letters');
        await last.win.selectOption('#drum-view', 'notation');
      } finally { await closeApp(last.app, last.win); }
    });
  } finally { await closeApp(again.app, again.win).catch(() => {}); }
  const imported = await launch(path.join(root, 'fixtures/fixture.gp5'));
  try {
    await step('GP5 imported drums show their exact MIDI numbers and remain editable', async () => {
      const expected = await imported.win.evaluate(() => {
        const e = window.sixline.editor;
        e.setCursor({ track: e.song.tracks.findIndex(t => t.type === 'drums') });
        return e.track.measures.flatMap(m => m.voices.flatMap(v => v.flatMap(b => b.notes.map(n => n.pitch)))).sort((a,b) => a-b);
      });
      await waitIdle(imported.win);
      await imported.win.selectOption('#drum-input', 'numbers');
      const shown = await imported.win.locator('#drumscore .drum-number').evaluateAll(ns => ns.map(n => Number(n.dataset.pitch)).sort((a,b) => a-b));
      assert.deepEqual(shown, expected);
      assert.ok(shown.includes(42));
      const before = await imported.win.evaluate(() => structuredClone(window.sixline.editor.beat));
      await imported.win.keyboard.type('56'); await waitIdle(imported.win);
      assert.ok(await imported.win.locator('.drum-beat[data-bar="0"][data-beat="0"][data-voice="0"] [data-pitch="56"]').count());
      await imported.win.keyboard.press('Control+z'); await waitIdle(imported.win);
      assert.deepEqual(await imported.win.evaluate(() => window.sixline.editor.beat), before);
      assert.deepEqual(imported.errors, []);
    });
  } finally {
    await imported.win.selectOption('#drum-input', 'letters');
    await imported.win.selectOption('#drum-view', 'notation');
    await closeApp(imported.app, imported.win);
  }
}
