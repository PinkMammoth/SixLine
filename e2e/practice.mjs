import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function practiceWorkflows({ launch, closeApp, step, waitIdle, out }) {
  console.log('Progressive loop practice');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sixline-practice-'));
  const file = path.join(dir, 'practice.tabproj');
  const song = {
    title: 'Practice', artist: '', tempo: 240,
    masterBars: [{ num: 2, den: 4 }, { num: 2, den: 4, tempo: 300 }, { num: 2, den: 4, tempo: 240 }, { num: 2, den: 4 }],
    tracks: [{ name: 'Guitar', type: 'guitar', program: 29, tuning: [64, 59, 55, 50, 45, 40], capo: 0, volume: 13, pan: 8, mute: false, solo: false,
      measures: Array.from({ length: 4 }, (_, bar) => ({ voices: [Array.from({ length: 2 }, (_, beat) => ({ duration: 4, dots: 0, notes: [{ string: 0, fret: bar * 2 + beat, velocity: 95 }] }))] })) }],
  };
  fs.writeFileSync(file, JSON.stringify({ format: 'tabproj', version: 1, song }));
  const { app, win, errors } = await launch(file);
  const open = async () => { await win.click('#b-practice'); await win.waitForSelector('dialog[open]'); };
  const start = async ({ countIn = '1', metronome = '1', increment = '5', target = '65' } = {}) => {
    if (await win.locator('#b-end-practice').isVisible()) await win.click('#b-end-practice');
    await open();
    await win.fill('#f-firstBar', '2'); await win.fill('#f-lastBar', '3');
    await win.fill('#f-startSpeed', '50'); await win.fill('#f-increment', increment); await win.fill('#f-targetSpeed', target);
    await win.selectOption('#f-countIn', countIn); await win.selectOption('#f-metronome', metronome);
    await win.evaluate(() => { window.__practiceClicks = []; window.__practicePlays = []; window.__practiceNotes = []; });
    await win.click('dialog button[value=ok]');
  };
  try {
    await win.waitForFunction(() => window.sixline.api.isReadyForPlayback);
    await win.evaluate(() => {
      window.__practiceClicks = []; window.__practicePlays = []; window.__practiceNotes = [];
      const create = AudioContext.prototype.createOscillator;
      AudioContext.prototype.createOscillator = function () {
        const node = create.call(this), start = node.start.bind(node), ctx = this;
        node.start = when => {
          const t = window.sixline;
          window.__practiceClicks.push({ time: performance.now() + Math.max(0, (when ?? ctx.currentTime) - ctx.currentTime) * 1000, frequency: node.frequency.value, countIn: t.countingIn, speed: t.practice.speed, pass: t.practice.completedPasses });
          start(when);
        };
        return node;
      };
      window.sixline.api.playerStateChanged.on(e => {
        if (e.state === 1) window.__practicePlays.push({ time: performance.now(), speed: window.sixline.practice.speed, multiplier: window.sixline.api.playbackSpeed, pass: window.sixline.practice.completedPasses });
      });
      window.sixline.api.midiEventsPlayedFilter = [window.sixline.midiNoteOnType];
      window.sixline.api.midiEventsPlayed.on(e => window.__practiceNotes.push(...e.events.map(note => note.tick)));
    });
    await step('practice prefills backwards bar selections, defaults to +5%, and validates without editing', async () => {
      await win.evaluate(() => window.sixline.editor.selectMeasures(2, 1)); await open();
      assert.equal(await win.inputValue('#f-firstBar'), '2'); assert.equal(await win.inputValue('#f-lastBar'), '3');
      assert.equal(await win.inputValue('#f-startSpeed'), '50'); assert.equal(await win.inputValue('#f-increment'), '5'); assert.equal(await win.inputValue('#f-targetSpeed'), '100');
      await win.screenshot({ path: path.join(out, 'progressive-practice-dialog.png') });
      for (const [field, value] of [['lastBar', '1'], ['lastBar', '5'], ['startSpeed', '24'], ['increment', '0'], ['targetSpeed', '49']]) {
        await win.fill(`#f-${field}`, value); await win.click('dialog button[value=ok]');
        assert.ok(await win.locator('dialog[open]').count());
        await win.fill('#f-lastBar', '3'); await win.fill('#f-startSpeed', '50'); await win.fill('#f-increment', '5'); await win.fill('#f-targetSpeed', '100');
      }
      await win.click('dialog button[value=cancel]');
      assert.equal(await win.evaluate(() => window.sixline.practice.progressive), null);
      assert.equal(await win.evaluate(() => window.sixline.editor.dirty), false);
      assert.deepEqual(await win.evaluate(() => window.sixline.editor.song), song);
    });
    await step('each full pass increases speed; count-in and click track follow it, with exact MIDI boundaries', async () => {
      await start();
      await win.waitForFunction(() => window.__practicePlays.length >= 5, null, { timeout: 25000 });
      const data = await win.evaluate(() => ({ plays: window.__practicePlays.slice(0, 5), clicks: window.__practiceClicks, notes: window.__practiceNotes, range: window.sixline.practice.loop }));
      assert.deepEqual(data.plays.map(p => p.speed), [50, 55, 60, 65, 65]);
      assert.deepEqual(data.plays.map(p => p.multiplier), [.5, .55, .6, .65, .65]);
      assert.deepEqual(data.range, { startTick: 1920, endTick: 5760 });
      assert.ok(data.notes.length >= 16); assert.ok(data.notes.every(tick => tick >= 1920 && tick < 5760), JSON.stringify(data.notes));
      for (const play of data.plays) {
        const clicks = data.clicks.filter(c => c.countIn && c.pass === play.pass);
        assert.deepEqual(clicks.map(c => c.frequency), [1500, 1000]);
        assert.ok(clicks.every(c => c.speed === play.speed));
        const beatMs = 60000 / 300 * 100 / play.speed;
        assert.ok(Math.abs(clicks[1].time - clicks[0].time - beatMs) < 80, `count-in beat spacing at ${play.speed}%`);
        assert.ok(Math.abs(play.time - clicks[0].time - 2 * beatMs) < 160, `count-in duration at ${play.speed}%`);
      }
      for (const play of data.plays.slice(0, 4)) {
        const clicks = data.clicks.filter(c => !c.countIn && c.pass === play.pass);
        assert.deepEqual(clicks.map(c => c.frequency), [1500, 1000, 1500, 1000]);
        assert.ok(clicks.every(c => c.speed === play.speed));
        assert.ok(Math.abs(clicks[1].time - clicks[0].time - 60000 / 300 * 100 / play.speed) < 100);
        assert.ok(Math.abs(clicks[3].time - clicks[2].time - 60000 / 240 * 100 / play.speed) < 100);
      }
      assert.match(await win.textContent('#practice-progress'), /Bars 2–3.*65%.*target/);
      assert.ok(await win.isDisabled('#speed'));
      assert.equal(await win.evaluate(() => window.sixline.editor.dirty), false);
      assert.deepEqual(await win.evaluate(() => window.sixline.editor.song), song);
      await win.screenshot({ path: path.join(out, 'progressive-practice.png') });
      await win.click('#b-stop');
    });
    await step('Pause retains progress and Stop cancels count-in, resets speed and prevents queued restarts', async () => {
      await start();
      await win.waitForFunction(() => window.sixline.practice.completedPasses >= 1 && window.sixline.playerState === 1 && window.sixline.api.tickPosition > 2300, null, { timeout: 12000 });
      await win.click('#b-play'); await win.waitForFunction(() => window.sixline.playerState === 0);
      const paused = await win.evaluate(() => ({ passes: window.sixline.practice.completedPasses, speed: window.sixline.practice.speed, tick: window.sixline.api.tickPosition }));
      await win.waitForTimeout(1100);
      assert.deepEqual(await win.evaluate(() => ({ passes: window.sixline.practice.completedPasses, speed: window.sixline.practice.speed, tick: window.sixline.api.tickPosition })), paused);
      assert.equal(await win.evaluate(() => window.sixline.countingIn), false);
      await win.click('#b-play'); await win.waitForFunction(() => window.sixline.countingIn);
      assert.equal(await win.evaluate(() => window.sixline.practice.speed), paused.speed);
      await win.click('#b-stop'); await win.waitForTimeout(1300);
      assert.equal(await win.evaluate(() => window.sixline.playerState), 0); assert.equal(await win.evaluate(() => window.sixline.countingIn), false);
      assert.equal(await win.evaluate(() => window.sixline.practice.speed), 50); assert.equal(await win.evaluate(() => window.sixline.practice.completedPasses), 0);
      await win.click('#b-play'); await win.waitForFunction(() => window.sixline.countingIn);
      await win.click('#b-play'); await win.waitForTimeout(1000);
      assert.equal(await win.evaluate(() => window.sixline.playerState), 0); assert.equal(await win.evaluate(() => window.sixline.countingIn), false);
    });
    await step('practice supports a click track without count-in and caps fractional increases', async () => {
      await start({ countIn: '0', increment: '2.5', target: '54' });
      await win.waitForFunction(() => window.__practicePlays.length >= 4, null, { timeout: 16000 });
      assert.deepEqual(await win.evaluate(() => window.__practicePlays.slice(0, 4).map(p => p.speed)), [50, 52.5, 54, 54]);
      assert.equal(await win.evaluate(() => window.__practiceClicks.some(c => c.countIn)), false);
      assert.ok(await win.evaluate(() => window.__practiceClicks.length >= 12));
      await win.click('#b-end-practice'); await win.waitForTimeout(2200);
      assert.equal(await win.evaluate(() => window.sixline.playerState), 0);
      assert.equal(await win.evaluate(() => window.sixline.practice.loop), null);
      assert.ok(await win.isEnabled('#speed'));
    });
    await step('two-bar countdown repeats without a click track, and seeking exits practice', async () => {
      await start({ countIn: '2', metronome: '0', increment: '10', target: '60' });
      await win.waitForFunction(() => window.__practicePlays.length >= 2, null, { timeout: 14000 });
      const clicks = await win.evaluate(() => window.__practiceClicks);
      assert.ok(clicks.every(c => c.countIn));
      for (const pass of [0, 1]) assert.deepEqual(clicks.filter(c => c.pass === pass).map(c => c.frequency), [1500, 1000, 1500, 1000]);
      await win.click('#b-first'); await win.waitForTimeout(1600);
      assert.equal(await win.evaluate(() => window.sixline.practice.progressive), null);
      assert.equal(await win.evaluate(() => window.sixline.playerState), 0);
    });
    await step('music edits cancel practice and cannot resume a stale range after regeneration', async () => {
      await start(); await win.waitForFunction(() => window.sixline.playerState === 1, null, { timeout: 5000 });
      await win.evaluate(() => window.sixline.editor.setTimeSignature(3, 4, 0)); await waitIdle(win);
      await win.waitForTimeout(1800);
      assert.equal(await win.evaluate(() => window.sixline.practice.progressive), null);
      assert.equal(await win.evaluate(() => window.sixline.playerState), 0);
      assert.equal(await win.evaluate(() => window.sixline.countingIn), false);
      await win.keyboard.press('Control+z'); await waitIdle(win);
    });
    await step('switching documents during count-in cancels it and resets practice progress', async () => {
      await start(); await win.waitForFunction(() => window.sixline.countingIn);
      await win.keyboard.press('Control+n'); await win.waitForSelector('dialog[open]');
      await win.click('dialog button[value=ok]'); await waitIdle(win); await win.waitForTimeout(1200);
      assert.equal(await win.evaluate(() => window.sixline.playerState), 0); assert.equal(await win.evaluate(() => window.sixline.countingIn), false);
      await win.locator('#doctabs .dtab').first().click(); await waitIdle(win);
      assert.equal(await win.evaluate(() => window.sixline.practice.speed), 50); assert.equal(await win.evaluate(() => window.sixline.practice.completedPasses), 0);
      assert.deepEqual(errors, []);
    });
  } finally {
    await closeApp(app, win); fs.rmSync(dir, { recursive: true, force: true });
  }
}
