import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseMidi } from 'midi-file';

export async function tuningWorkflows({ launch, closeApp, step, waitIdle, root, out }) {
  console.log('Custom guitar, bass and synth tunings');
  const { app, win, errors } = await launch(path.join(root, 'fixtures/fixture.gp5'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sixline-tunings-'));
  const properties = async () => { await win.keyboard.press('F6'); await win.waitForSelector('dialog[open]'); };
  const accept = async () => { await win.click('dialog button[value=ok]'); await waitIdle(win); };
  const track = () => win.evaluate(() => structuredClone(window.sixline.editor.track));
  const selectTrack = async i => { await win.locator('.trk').nth(i).click(); await waitIdle(win); };
  const point = (row = 0) => win.evaluate(row => {
    const t = window.sixline, c = t.editor.cursor;
    const b = t.score.tracks[c.track].staves[0].bars[c.bar].voices[0].beats[c.beat];
    const all = t.api.boundsLookup.findBeats(b), tab = all.at(-1).barBounds.visualBounds;
    const y = tab.y + (t.editor.track.tuning.length > 1 ? row * tab.h / (t.editor.track.tuning.length - 1) : 0);
    const sc = document.getElementById('score'), at = document.getElementById('at');
    const before = at.getBoundingClientRect(), r = sc.getBoundingClientRect();
    sc.scrollTop += before.top + y - r.top - r.height / 2;
    const origin = at.getBoundingClientRect();
    return { x: origin.left + all[0].onNotesX, y: origin.top + y };
  }, row);
  try {
    await step('guitar offers 6/7/8 strings and independent notes, retaining edits on Cancel', async () => {
      const before = await track(); await properties();
      assert.deepEqual(await win.locator('#f-strings option').evaluateAll(options => options.map(o => o.value)), ['6', '7', '8']);
      await win.selectOption('#f-strings', '8');
      assert.equal(await win.locator('.tuning-strings select').count(), 8);
      await win.selectOption('#f-string-0', '61'); await win.selectOption('#f-string-7', '60');
      assert.match(await win.inputValue('#f-tuning'), /^C#4 .* C4$/);
      await win.screenshot({ path: path.join(out, 'custom-tuning-dialog.png') });
      await win.click('dialog button[value=cancel]'); assert.deepEqual(await track(), before);
    });
    await step('custom guitar tuning supports repeated and non-descending notes, editing and one-action undo', async () => {
      const before = await track(); await properties(); await win.selectOption('#f-strings', '8');
      const tuning = [64, 60, 64, 52, 40, 43, 35, 30];
      for (const [i, p] of tuning.entries()) await win.selectOption(`#f-string-${i}`, String(p));
      await win.fill('#f-name', 'Custom eight'); await accept();
      assert.deepEqual((await track()).tuning, tuning);
      await win.keyboard.press('Control+z'); await waitIdle(win); assert.deepEqual(await track(), before);
      await win.keyboard.press('Control+y'); await waitIdle(win);
      await win.evaluate(() => window.sixline.editor.setCursor({ bar: 3, beat: 0, string: 7 }));
      const p = await point(7); await win.mouse.click(p.x, p.y); await win.keyboard.press('3'); await waitIdle(win);
      assert.deepEqual(await win.evaluate(() => ({ string: window.sixline.editor.cursor.string, fret: window.sixline.editor.noteAtCursor().fret })), { string: 7, fret: 3 });
      await properties(); await win.selectOption('#f-strings', '6');
      assert.match(await win.textContent('.tuning-help'), /1 note on removed strings/); await accept();
      assert.equal((await track()).tuning.length, 6);
      await win.keyboard.press('Control+z'); await waitIdle(win); assert.deepEqual((await track()).tuning, tuning);
      assert.equal(await win.evaluate(() => window.sixline.editor.cursor.string), 7);
    });
    await step('bass offers 4/5/6 strings, its six-string preset and editable open notes', async () => {
      await selectTrack(1); await properties();
      assert.deepEqual(await win.locator('#f-strings option').evaluateAll(options => options.map(o => o.value)), ['4', '5', '6']);
      await win.selectOption('#f-preset', 'Bass 6-string');
      assert.equal(await win.inputValue('#f-strings'), '6');
      assert.equal(await win.inputValue('#f-tuning'), 'C3 G2 D2 A1 E1 B0');
      await win.selectOption('#f-string-5', '22'); await accept();
      assert.deepEqual((await track()).tuning, [48, 43, 38, 33, 28, 22]);
    });
    await step('invalid open notes and wrong counts keep the dialog open without changing the song', async () => {
      const before = await track(); await properties();
      for (const text of ['C10 G2 D2 A1 E1 B0', 'C3 G2 D2', 'C3 G2 D2 A1 E1 B0 C4']) {
        await win.fill('#f-tuning', text); await win.click('dialog button[value=ok]');
        assert.ok(await win.locator('dialog[open]').count());
        assert.equal(await win.locator('#f-tuning').evaluate(el => el.validity.valid), false);
        assert.deepEqual(await track(), before);
      }
      await win.fill('#f-tuning', 'C3 G2 D2 A1 E1 Bb0'); await accept();
      assert.deepEqual((await track()).tuning, [48, 43, 38, 33, 28, 22]);
    });
    await step('synth offers notation or 1–8 strings, with independent sound selection and tab editing', async () => {
      await win.evaluate(() => window.sixline.editor.addTrack('keys')); await waitIdle(win);
      await properties();
      assert.deepEqual(await win.locator('#f-strings option').evaluateAll(options => options.map(o => o.value)), ['0', '1', '2', '3', '4', '5', '6', '7', '8']);
      assert.ok(await win.locator('#f-tuning').isHidden());
      await win.selectOption('#f-strings', '8'); await win.selectOption('#f-program', '81');
      await win.fill('#f-tuning', 'C4 C3 E4 E4 C5 C2 G#5 G2'); await accept();
      assert.deepEqual((await track()).tuning, [60, 48, 64, 64, 72, 36, 80, 43]);
      assert.equal((await track()).type, 'keys'); assert.equal((await track()).program, 81);
      await win.evaluate(() => window.sixline.editor.setCursor({ bar: 0, beat: 0, string: 7 }));
      const p = await point(7); await win.mouse.click(p.x, p.y); await win.keyboard.press('5'); await waitIdle(win);
      assert.deepEqual(await win.evaluate(() => window.sixline.editor.beat.notes), [{ string: 7, fret: 5, velocity: 95 }]);
      const selected = await point(7);
      await win.keyboard.down('Control'); await win.mouse.click(selected.x, selected.y); await win.keyboard.up('Control');
      assert.deepEqual(await win.evaluate(() => window.sixline.editor.selection.rows), [7]);
      await win.keyboard.press('Escape');
      if (await win.getAttribute('#b-track-view', 'aria-pressed') !== 'true') await win.click('#b-track-view');
      await waitIdle(win);
      assert.equal(await win.evaluate(() => window.sixline.api.tracks.length), 4);
      await win.screenshot({ path: path.join(out, 'custom-tunings.png') });
    });
    await step('custom guitar, bass and synth tunings survive save/reopen and export exact synth pitches', async () => {
      const before = await win.evaluate(() => structuredClone(window.sixline.editor.song));
      const project = path.join(dir, 'custom.tabproj'), midi = path.join(dir, 'custom.mid');
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, project);
      await win.keyboard.press('Control+Shift+s'); await win.waitForFunction(() => !window.sixline.editor.dirty);
      assert.deepEqual(JSON.parse(fs.readFileSync(project, 'utf8')).song, before);
      await win.keyboard.press('Control+w'); await waitIdle(win);
      await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, project);
      await win.keyboard.press('Control+o'); await win.waitForFunction(() => window.sixline.editor.song.tracks.length === 4); await waitIdle(win);
      assert.deepEqual(await win.evaluate(() => window.sixline.editor.song), before);
      await selectTrack(3); await properties(); assert.equal(await win.inputValue('#f-string-7'), '43');
      assert.equal(await win.inputValue('#f-program'), '81'); await win.click('dialog button[value=cancel]');
      await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, midi);
      await win.keyboard.press('Control+e'); await win.waitForFunction(() => document.getElementById('msg').textContent.startsWith('Exported MIDI'));
      const notes = parseMidi(fs.readFileSync(midi)).tracks.flat().filter(e => e.type === 'noteOn' && e.channel === 2);
      assert.deepEqual(notes.map(e => e.noteNumber), [48]);
    });
    await step('switching synth tab to notation preserves notes and program, with one-action undo', async () => {
      await properties(); await win.selectOption('#f-strings', '0'); await accept();
      assert.deepEqual((await track()).tuning, []); assert.equal((await track()).program, 81);
      assert.deepEqual((await track()).measures[0].voices[0][0].notes, [{ pitch: 48, velocity: 95 }]);
      await win.keyboard.press('Control+z'); await waitIdle(win);
      assert.equal((await track()).tuning.length, 8); assert.equal((await track()).measures[0].voices[0][0].notes[0].string, 7);
    });
    await step('one-string synth renders a usable caret and allows open-note fret entry', async () => {
      await win.evaluate(() => window.sixline.editor.addTrack('keys')); await waitIdle(win);
      await properties(); await win.selectOption('#f-strings', '1'); await win.selectOption('#f-string-0', '60'); await accept();
      const p = await point(); await win.mouse.click(p.x, p.y); await win.keyboard.press('0'); await waitIdle(win);
      assert.deepEqual(await win.evaluate(() => window.sixline.editor.beat.notes), [{ string: 0, fret: 0, velocity: 95 }]);
      assert.ok(await win.locator('#caret').isVisible());
      assert.equal(await win.locator('#caret').evaluate(el => el.classList.contains('beatonly')), false);
      assert.deepEqual(errors, []);
    });
  } finally {
    if (await win.getAttribute('#b-track-view', 'aria-pressed').catch(() => null) === 'true') { await win.click('#b-track-view').catch(() => {}); await waitIdle(win).catch(() => {}); }
    await closeApp(app, win); fs.rmSync(dir, { recursive: true, force: true });
  }
}
