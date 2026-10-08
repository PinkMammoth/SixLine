import assert from 'node:assert/strict';
import path from 'node:path';

export async function multiTrackWorkflows({ launch, closeApp, step, waitIdle, root, out }) {
  console.log('Single-track and multi-track views');
  const file = path.join(root, 'fixtures/fixture.gp5');
  let { app, win, errors } = await launch(file);
  const preferences = await win.evaluate(() => ['sixline.trackView', 'sixline.drumView'].map(k => [k, localStorage.getItem(k)]));
  const rendered = () => win.evaluate(() => window.sixline.api.tracks.map(t => t.index));
  const toggle = async () => { await win.click('#b-track-view'); await waitIdle(win); };
  // Scroll each target into the viewport before clicking its actual rendered staff.
  const point = (track, bar = 0, beat = 0, row = 0, note = false, scroll = true) => win.evaluate(args => {
    const [track, bar, beat, row, note, scroll] = args, t = window.sixline;
    const b = t.score.tracks[track].staves[0].bars[bar].voices[0].beats[beat];
    const all = t.api.boundsLookup.findBeats(b), tr = t.editor.song.tracks[track];
    const last = all.at(-1).barBounds.visualBounds;
    const head = note ? all.flatMap(b => b.notes ?? [])[0]?.noteHeadBounds : null;
    const x = head ? head.x + head.w / 2 : all[0].onNotesX;
    const y = head ? head.y + head.h / 2 : tr.tuning.length > 1 ? last.y + row * last.h / (tr.tuning.length - 1) : last.y + last.h / 2;
    const at = document.getElementById('at'), sc = document.getElementById('score');
    const scRect = sc.getBoundingClientRect(), before = at.getBoundingClientRect();
    if (scroll) sc.scrollTop += before.top + y - (scRect.top + scRect.height / 2);
    const r = at.getBoundingClientRect();
    return { x: r.left + x, y: r.top + y };
  }, [track, bar, beat, row, note, scroll]);
  const click = async (...args) => { const p = await point(...args); await win.mouse.click(p.x, p.y); await waitIdle(win); };
  try {
    await step('one click shows aligned guitar, bass and drums without changing the document or selection', async () => {
      if (await win.getAttribute('#b-track-view', 'aria-pressed') === 'true') await toggle();
      await win.evaluate(() => {
        const t = window.sixline;
        t.editor.setCursor({ track: 1, bar: 1, beat: 0, string: 2 });
        t.editor.selectMeasures(1, 2);
      });
      await waitIdle(win);
      const before = await win.evaluate(() => ({ song: structuredClone(window.sixline.editor.song), cursor: { ...window.sixline.editor.cursor }, selection: structuredClone(window.sixline.editor.selection), dirty: window.sixline.editor.dirty, undo: window.sixline.editor.canUndo }));
      await toggle();
      assert.deepEqual(await rendered(), [0, 1, 2]);
      assert.equal(await win.getAttribute('#b-track-view', 'aria-pressed'), 'true');
      const after = await win.evaluate(() => ({ song: window.sixline.editor.song, cursor: window.sixline.editor.cursor, selection: window.sixline.editor.selection, dirty: window.sixline.editor.dirty, undo: window.sixline.editor.canUndo, counts: window.sixline.score.tracks.map(t => window.sixline.api.boundsLookup.findBeats(t.staves[0].bars[0].voices[0].beats[0]).length) }));
      const { counts, ...state } = after;
      assert.deepEqual(state, before);
      assert.deepEqual(counts, [2, 2, 1]);
      assert.ok(await win.locator('#selection .selected-beat').count());
      await win.screenshot({ path: path.join(out, 'multi-track.png') });
      await toggle();
      assert.deepEqual(await rendered(), [1]);
      assert.ok(await win.locator('#selection .selected-beat').count());
      await toggle();
    });
    await step('clicking another staff selects and edits that instrument; sidebar selection retains every staff', async () => {
      await click(0, 0, 0, 4);
      assert.deepEqual(await win.evaluate(() => window.sixline.editor.cursor), { track: 0, bar: 0, beat: 0, string: 4 });
      await win.evaluate(() => { window.__viewScore = window.sixline.score; window.__viewSong = structuredClone(window.sixline.editor.song); });
      await click(1, 1, 0, 2);
      assert.equal(await win.locator('.trk.sel').getAttribute('data-index'), '1');
      assert.ok(await win.evaluate(() => window.sixline.score === window.__viewScore));
      await win.keyboard.press('7'); await waitIdle(win);
      const r = await win.evaluate(() => ({ cursor: window.sixline.editor.cursor, note: window.sixline.editor.noteAtCursor(), song: window.sixline.editor.song, before: window.__viewSong }));
      assert.deepEqual(r.cursor, { track: 1, bar: 1, beat: 0, string: 2 });
      assert.equal(r.note.fret, 7);
      assert.deepEqual(r.song.tracks[0], r.before.tracks[0]);
      assert.deepEqual(r.song.tracks[2], r.before.tracks[2]);
      assert.deepEqual(await rendered(), [0, 1, 2]);
      await win.keyboard.press('Control+z'); await waitIdle(win);
      assert.ok(await win.evaluate(() => JSON.stringify(window.sixline.editor.song) === JSON.stringify(window.__viewSong)));
      await win.locator('.trk').nth(0).click(); await waitIdle(win);
      assert.deepEqual(await rendered(), [0, 1, 2]);
    });
    await step('dragging across instruments stays on the initial track, with track-specific highlights', async () => {
      const start = await point(0, 0, 0, 5), to = await point(1, 2, 1, 3, false, false);
      await win.mouse.move(start.x, start.y); await win.mouse.down();
      await win.mouse.move(to.x, to.y, { steps: 12 }); await win.mouse.up();
      const r = await win.evaluate(() => ({ cursor: window.sixline.editor.cursor, selection: window.sixline.editor.selection }));
      assert.equal(r.cursor.track, 0); assert.equal(r.selection.track, 0);
      assert.equal(r.selection.anchor.bar, 0); assert.equal(r.selection.focus.bar, 2);
      assert.ok(await win.locator('#selection .selected-beat').count());
      await win.keyboard.down('Shift'); await click(1, 1, 0, 1); await win.keyboard.up('Shift');
      assert.equal(await win.evaluate(() => window.sixline.editor.cursor.track), 1);
      assert.equal(await win.evaluate(() => window.sixline.editor.selection), null);
    });
    await step('clicking a staff uses that instrument’s beat spacing when rhythms differ', async () => {
      await win.evaluate(() => window.sixline.editor.songEdit('Test bass rhythm', s => {
        s.tracks[1].measures[1].voices[0] = [3, 5].map(fret => ({ duration: 2, dots: 0, notes: [{ string: 1, fret, velocity: 95 }] }));
      }));
      await waitIdle(win);
      await click(0, 1, 0, 5);
      await click(1, 1, 1, 1);
      assert.deepEqual(await win.evaluate(() => window.sixline.editor.cursor), { track: 1, bar: 1, beat: 1, string: 1 });
      assert.equal(await win.evaluate(() => window.sixline.editor.noteAtCursor().fret), 5);
      await win.keyboard.press('Control+z'); await waitIdle(win);
    });
    await step('view toggles and active-track changes preserve running playback and score identity', async () => {
      await win.waitForFunction(() => window.sixline.api.isReadyForPlayback);
      await win.fill('#speed', '50'); await win.locator('#speed').blur();
      await win.click('#b-first'); await win.click('#b-play');
      await win.waitForFunction(() => window.sixline.playerState === 1);
      // Wait for the explicit Play seek to reach the synth before observing view changes.
      await win.waitForFunction(() => window.sixline.api.tickPosition > 50);
      await win.evaluate(() => {
        window.__viewScore = window.sixline.score; window.__viewTicks = [];
        window.sixline.api.playerPositionChanged.on(e => window.__viewTicks.push({ tick: e.currentTick, seek: e.isSeek }));
      });
      await toggle(); assert.deepEqual(await rendered(), [1]);
      await toggle(); assert.deepEqual(await rendered(), [0, 1, 2]);
      await win.locator('.trk').nth(2).click(); await waitIdle(win);
      const r = await win.evaluate(() => ({ state: window.sixline.playerState, same: window.sixline.score === window.__viewScore, ticks: window.__viewTicks }));
      assert.equal(r.state, 1); assert.ok(r.same, 'view changes retain the same score'); assert.ok(r.ticks.length > 1, `expected playback updates, got ${JSON.stringify(r.ticks)}`);
      const discontinuities = r.ticks.filter((e, i) => e.seek || i && e.tick < r.ticks[i - 1].tick);
      assert.deepEqual(discontinuities, [], `unexpected playback discontinuity: ${JSON.stringify(discontinuities.slice(0, 10))}`);
      await win.click('#b-stop'); await win.waitForFunction(() => window.sixline.playerState === 0);
    });
    await step('numbered drum preference is restored in single view; drum note clicks address the correct pitch', async () => {
      await click(2, 0, 0, 0, true);
      assert.equal(await win.evaluate(() => window.sixline.editor.track.type), 'drums');
      const pitch = await win.evaluate(() => window.sixline.score.tracks[2].staves[0].bars[0].voices[0].beats[0].notes[0].percussionArticulation);
      assert.equal(await win.evaluate(() => window.sixline.editor.rowPitch()), pitch);
      await toggle(); await win.selectOption('#drum-view', 'numbers');
      assert.ok(await win.locator('#drumscore').isVisible());
      await toggle(); assert.deepEqual(await rendered(), [0, 1, 2]);
      assert.ok(await win.locator('#drumscore').isHidden());
      assert.ok(await win.locator('#drum-view').isDisabled());
      assert.equal(await win.inputValue('#drum-view'), 'notation');
      await toggle(); assert.ok(await win.locator('#drumscore').isVisible());
      assert.equal(await win.inputValue('#drum-view'), 'numbers');
      await toggle();
    });
    await step('adding, editing and removing a keys track updates the combined score; undo restores it', async () => {
      await win.evaluate(() => window.sixline.editor.addTrack('keys')); await waitIdle(win);
      assert.deepEqual(await rendered(), [0, 1, 2, 3]);
      await click(3);
      assert.equal(await win.evaluate(() => window.sixline.editor.cursor.track), 3);
      await win.keyboard.press('Enter'); await waitIdle(win);
      assert.equal(await win.evaluate(() => window.sixline.editor.beat.notes[0].pitch), 60);
      await win.evaluate(() => window.sixline.editor.removeTrack()); await waitIdle(win);
      assert.deepEqual(await rendered(), [0, 1, 2]);
      await win.keyboard.press('Control+z'); await waitIdle(win);
      assert.deepEqual(await rendered(), [0, 1, 2, 3]);
      assert.equal(await win.evaluate(() => window.sixline.editor.song.tracks[3].measures[0].voices[0][0].notes[0].pitch), 60);
    });
    await step('multi-track preference survives restart and switching documents; one-track songs also toggle', async () => {
      assert.deepEqual(errors, []);
      await closeApp(app, win);
      ({ app, win, errors } = await launch(file));
      assert.equal(await win.getAttribute('#b-track-view', 'aria-pressed'), 'true');
      assert.deepEqual(await rendered(), [0, 1, 2]);
      await win.keyboard.press('Control+n'); await win.waitForSelector('dialog[open]');
      await win.click('dialog button[value=ok]'); await waitIdle(win);
      assert.deepEqual(await rendered(), [0]);
      await toggle(); assert.equal(await win.getAttribute('#b-track-view', 'aria-pressed'), 'false');
      assert.deepEqual(await rendered(), [0]);
      await toggle();
      await win.locator('#doctabs .dtab').first().click(); await waitIdle(win);
      assert.deepEqual(await rendered(), [0, 1, 2]);
      await toggle(); assert.deepEqual(await rendered(), [0]);
      assert.deepEqual(errors, []);
    });
    await step('rapid toggle clicks settle on the final requested view', async () => {
      await win.evaluate(() => {
        const b = document.getElementById('b-track-view');
        b.click(); b.click(); b.click();
      });
      await waitIdle(win);
      assert.equal(await win.getAttribute('#b-track-view', 'aria-pressed'), 'true');
      assert.deepEqual(await rendered(), [0, 1, 2]);
      await toggle(); assert.deepEqual(await rendered(), [0]);
      assert.deepEqual(errors, []);
    });
  } finally {
    await win.evaluate(prefs => prefs.forEach(([k, v]) => v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v)), preferences).catch(() => {});
    await closeApp(app, win);
  }
}
