import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export async function workflows({ launch, closeApp, step, waitIdle, root, out, tabPoint }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sixline-v02-'));
  const menu = async (win, title, item) => {
    await win.locator('.menu .title', { hasText: title }).dispatchEvent('mousedown');
    await win.locator('.menu.open .item', { hasText: item }).dispatchEvent('mousedown');
  };
  const open = async (app, win, file) => {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, file);
    await win.keyboard.press('Control+o');
    await win.waitForFunction(file => window.sixline.active.filePath === file, file);
    await waitIdle(win);
  };
  console.log('v0.2: composition and practice workflows');
  {
    const { app, win, errors } = await launch(path.join(root, 'fixtures/fixture.gp5'));
    try {
      await step('Workflow A: four-bar riff, keyboard selection, duplication, edit, undo/redo, save/reopen', async () => {
        await win.keyboard.press('Control+n'); await win.waitForSelector('dialog[open]');
        await win.fill('#f-title', 'Workflow riff'); await win.fill('#f-bars', '4'); await win.click('dialog button[value=ok]'); await waitIdle(win);
        for (let i = 0; i < 16; i++) {
          await win.keyboard.press(String([0,3,5,7][i % 4]));
          if (i !== 15) await win.keyboard.press('ArrowRight');
        }
        await waitIdle(win);
        const first = await win.evaluate(() => structuredClone(window.sixline.editor.song.tracks[0].measures));
        await win.keyboard.press('Control+Home');
        for (let i = 0; i < 3; i++) await win.keyboard.press('Control+Shift+ArrowRight');
        assert.equal(await win.locator('.selected-beat').count(), 4);
        await win.keyboard.press('Control+d'); await waitIdle(win);
        assert.equal(await win.evaluate(() => window.sixline.editor.song.masterBars.length), 8);
        assert.deepEqual(await win.evaluate(() => window.sixline.editor.song.tracks[0].measures.slice(4)), first);
        const point = await tabPoint(win, 4, 1, 0);
        await win.mouse.click(point.x, point.y); await win.keyboard.press('9'); await waitIdle(win);
        assert.equal(await win.evaluate(() => window.sixline.editor.noteAtCursor().fret), 9);
        await win.keyboard.press('Control+z'); await waitIdle(win);
        assert.equal(await win.evaluate(() => window.sixline.editor.noteAtCursor().fret), 3);
        await win.keyboard.press('Control+y'); await waitIdle(win);
        const expected = await win.evaluate(() => structuredClone(window.sixline.editor.song));
        const file = path.join(tmp, 'riff.tabproj');
        await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, file);
        await win.keyboard.press('Control+s'); await win.waitForFunction(() => !window.sixline.editor.dirty);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).song, expected);
        await win.keyboard.press('Control+w'); await waitIdle(win); await open(app, win, file);
        assert.deepEqual(await win.evaluate(() => window.sixline.editor.song), expected);
        await win.screenshot({path:path.join(out,'v02-riff.png')});
      });
      await step('copy, cut, paste use keyboard commands and one-action undo', async () => {
        await win.keyboard.press('Control+Home'); await menu(win,'Edit','Select measure');
        const before = await win.evaluate(() => structuredClone(window.sixline.editor.song));
        await win.keyboard.press('Control+x'); await waitIdle(win);
        assert.ok(await win.evaluate(() => window.sixline.editor.beats.every(b => !b.notes.length)));
        await win.keyboard.press('Control+z'); await waitIdle(win);
        assert.deepEqual(await win.evaluate(() => window.sixline.editor.song), before);
        await win.keyboard.press('Control+c'); await win.keyboard.press('Escape'); await win.keyboard.press('Control+ArrowRight');
        await win.keyboard.press('Control+v'); await waitIdle(win);
        assert.deepEqual(await win.evaluate(() => window.sixline.editor.song.tracks[0].measures[1]), before.tracks[0].measures[0]);
        await win.keyboard.press('Control+z'); await waitIdle(win);
        assert.deepEqual(await win.evaluate(() => window.sixline.editor.song), before);
      });
      await step('Workflow D: add/rename/delete markers, save/reopen, jump and Go to Measure', async () => {
        for (const [bar, label] of [[1,'Intro'],[3,'Verse'],[5,'Chorus']]) {
          await win.keyboard.press('Control+g'); await win.fill('#f-measure', String(bar)); await win.click('dialog button[value=ok]');
          await win.click('#b-marker'); await win.fill('#f-marker',label); await win.click('dialog button[value=ok]'); await waitIdle(win);
        }
        await win.click('#b-marker'); await win.fill('#f-marker','Chorus 2'); await win.click('dialog button[value=ok]'); await waitIdle(win);
        await menu(win,'Navigate','Delete marker'); await waitIdle(win);
        await win.keyboard.press('Control+z'); await waitIdle(win);
        await win.keyboard.press('Control+s'); await win.waitForFunction(() => !window.sixline.editor.dirty);
        const file = path.join(tmp, 'riff.tabproj'); await win.keyboard.press('Control+w'); await waitIdle(win); await open(app,win,file);
        for (const bar of [4,0,2]) {
          await win.selectOption('#markers', String(bar));
          assert.equal(await win.evaluate(() => window.sixline.editor.cursor.bar),bar);
        }
        await menu(win,'Navigate','Next marker'); assert.equal(await win.evaluate(() => window.sixline.editor.cursor.bar),4);
        await menu(win,'Navigate','Previous marker'); assert.equal(await win.evaluate(() => window.sixline.editor.cursor.bar),2);
        assert.deepEqual(await win.evaluate(() => window.sixline.editor.song.masterBars.map(b => b.marker)), ['Intro',undefined,'Verse',undefined,'Chorus 2',undefined,undefined,undefined]);
        assert.ok(await win.evaluate(() => window.sixline.score.masterBars[4].section.text === 'Chorus 2'));
        await win.screenshot({path:path.join(out,'v02-markers.png')});
      });
      await step('composition workflow has no page errors', async () => assert.deepEqual(errors, []));
    } finally { await closeApp(app,win); }
  }
  {
    const { app, win, errors } = await launch(path.join(root,'fixtures/fixture.gp5'));
    try {
      await step('Workflow B: GP5 exact measure loop at 70%, metronome and one-bar count-in', async () => {
        await win.waitForFunction(() => window.sixline.api.isReadyForPlayback);
        await win.keyboard.press('Control+Home'); await win.keyboard.press('Control+Shift+ArrowRight');
        await win.click('#b-loop-selection');
        const range = await win.evaluate(() => ({...window.sixline.practice.loop}));
        const expected = await win.evaluate(() => ({startTick:window.sixline.api.tickCache.getMasterBar(window.sixline.score.masterBars[0]).start,endTick:window.sixline.api.tickCache.getMasterBar(window.sixline.score.masterBars[1]).end}));
        assert.deepEqual(range,expected);
        await win.fill('#speed','70'); await win.locator('#speed').blur();
        await win.evaluate(() => {
          window.__clicks = [];
          const create = AudioContext.prototype.createOscillator;
          AudioContext.prototype.createOscillator = function() {
            const node = create.call(this), start = node.start.bind(node);
            node.start = when => { window.__clicks.push({frequency:node.frequency.value,countIn:window.sixline.countingIn}); start(when); };
            return node;
          };
        });
        await win.check('#metronome'); await win.selectOption('#count-in','1');
        await win.evaluate(() => {
          window.__samples = []; window.__states = []; window.__playedNotes = []; window.__tickZeroTime = performance.now();
          window.sixline.api.midiEventsPlayedFilter = [window.sixline.midiNoteOnType];
          window.sixline.api.midiEventsPlayed.on(e => window.__playedNotes.push(...e.events.map(e => e.tick)));
          window.sixline.api.playerPositionChanged.on(e => window.__samples.push({ tick:e.currentTick,time:performance.now(),seek:e.isSeek }));
          window.sixline.api.playerStateChanged.on(e => window.__states.push({state:e.state,time:performance.now()}));
        });
        const begin = await win.evaluate(() => performance.now()); await win.click('#b-caret');
        await win.waitForFunction(() => window.sixline.countingIn);
        assert.equal(await win.evaluate(() => window.sixline.playerState),0);
        await win.waitForFunction(() => window.sixline.playerState === 1, null, {timeout:10000});
        const started = await win.evaluate(() => window.__states.find(s => s.state === 1).time);
        assert.ok(started-begin > 2800 && started-begin < 4000, `count-in at 110 BPM, 70%: ${started-begin}ms`);
        await win.waitForFunction(() => {
          const s = window.__samples.filter(s => !s.seek);
          return s.filter((e,i) => i && e.tick < s[i-1].tick - 100).length >= 2;
        }, null, {timeout:30000});
        const samples = await win.evaluate(() => window.__samples.filter(s => !s.seek));
        assert.ok(samples.length > 50);
        assert.ok(samples.every(s => s.tick >= range.startTick && s.tick <= range.endTick),JSON.stringify(samples.filter(s => s.tick < range.startTick || s.tick > range.endTick)));
        const notes = await win.evaluate(() => window.__playedNotes);
        assert.ok(notes.length > 10);
        assert.ok(notes.every(tick => tick >= range.startTick && tick < range.endTick),`actual MIDI note events escaped the loop: ${notes}`);
        const clicks = await win.evaluate(() => window.__clicks.filter(c => !c.countIn));
        assert.ok(clicks.length >= 15, 'metronome starts real WebAudio clicks across loop iterations');
        assert.ok(clicks.filter(c => c.frequency === 1500).length >= 4, 'first beat accents are audible oscillator events');
        assert.ok(clicks.some(c => c.frequency === 1000), 'other beats use the ordinary click');
        assert.equal(await win.evaluate(() => window.sixline.api.playbackSpeed),0.7);
        assert.ok(await win.locator('#b-loop').evaluate(el => el.classList.contains('on')));
        const old = await win.evaluate(() => window.sixline.api.tickPosition);
        await win.fill('#speed','90'); await win.locator('#speed').blur();
        await win.waitForFunction(() => window.sixline.api.playbackSpeed === 0.9);
        assert.equal(await win.inputValue('#speed'),'90');
        assert.equal(await win.evaluate(() => window.sixline.playerState),1);
        const now = await win.evaluate(() => window.sixline.api.tickPosition);
        assert.ok(now >= old || now < range.startTick + 600,`speed preserves tick or naturally loops: ${old} -> ${now}`);
        await win.screenshot({path:path.join(out,'v02-practice.png')}); await win.click('#b-stop');
      });
      await step('A-B boundaries share looping and remain independent of selection', async () => {
        await win.click('#b-clear-loop'); await win.selectOption('#count-in','0');
        await win.keyboard.press('Control+Home'); await win.keyboard.press('Control+ArrowRight'); await win.click('#b-a');
        await win.keyboard.press('Control+ArrowRight'); await win.click('#b-b'); await win.click('#b-ab');
        const before = await win.evaluate(() => ({...window.sixline.practice.loop}));
        await win.keyboard.press('Shift+ArrowRight'); await win.keyboard.press('Escape');
        assert.deepEqual(await win.evaluate(() => ({...window.sixline.practice.loop})),before);
        assert.equal(await win.evaluate(() => window.sixline.practice.loopSource),'ab');
        await win.click('#b-loop'); assert.equal(await win.evaluate(() => window.sixline.api.isLooping),false);
        await win.click('#b-clear-loop');
      });
      await step('two-bar count-in can be cancelled and does not later start playback', async () => {
        await win.selectOption('#count-in','2'); await win.click('#b-caret'); await win.waitForFunction(() => window.sixline.countingIn);
        await win.waitForTimeout(250); await win.click('#b-stop');
        assert.equal(await win.evaluate(() => window.sixline.countingIn),false);
        await win.waitForTimeout(350); assert.equal(await win.evaluate(() => window.sixline.playerState),0);
        await win.selectOption('#count-in','0');
      });
      await step('Workflow C: track/caret/selection/scroll/panel changes preserve score, synth, state and monotonic ticks', async () => {
        await menu(win,'Track','Add keys/synth track'); await waitIdle(win);
        await win.click('#b-clear-loop'); await win.fill('#speed','50'); await win.locator('#speed').blur();
        await win.keyboard.press('Control+Home'); await win.click('#b-caret'); await win.waitForFunction(() => window.sixline.playerState === 1);
        await win.waitForFunction(() => window.sixline.api.tickPosition > 50);
        await win.evaluate(() => {
          window.__score = window.sixline.score; window.__player = window.sixline.api.player; window.__continuity = [];
          window.__stateContinuity = [];
          window.sixline.api.playerPositionChanged.on(e => window.__continuity.push({tick:e.currentTick,seek:e.isSeek}));
          window.sixline.api.playerStateChanged.on(e => window.__stateContinuity.push(e.state));
        });
        for (const track of [1,2,3,0,2,0]) {
          await win.locator('.trk').nth(track).click(); await waitIdle(win);
          await win.keyboard.press('Control+ArrowRight'); await win.keyboard.press('Shift+ArrowRight');
          await win.keyboard.press('ArrowDown'); // changes the chosen string/drum row/keys pitch only
          const p = await tabPoint(win, Math.min(track, 3), 0, 0);
          if (track !== 2) await win.mouse.click(p.x,p.y,{modifiers:['Shift']});
          await win.locator('#score').evaluate(el => el.scrollTop += 30);
        }
        await win.keyboard.press('F6'); await win.waitForSelector('dialog[open]'); await win.waitForTimeout(200); await win.click('dialog button[value=cancel]');
        await win.click('#b-marker'); await win.fill('#f-marker','Live marker'); await win.click('dialog button[value=ok]'); await waitIdle(win);
        const r = await win.evaluate(() => ({samples:window.__continuity,states:window.__stateContinuity,sameScore:window.__score === window.sixline.score,samePlayer:window.__player === window.sixline.api.player,playing:window.sixline.playerState}));
        assert.equal(r.sameScore,true); assert.equal(r.samePlayer,true); assert.equal(r.playing,1);
        assert.ok(r.states.every(s => s === 1)); assert.ok(r.samples.length > 20);
        const discontinuities = r.samples.filter((s,i) => s.seek || i && s.tick < r.samples[i-1].tick);
        assert.equal(discontinuities.length,0,JSON.stringify(discontinuities.slice(0,10)));
        await win.click('#b-stop');
      });
      await step('play from an arbitrary caret aligns every track at the same tick without losing selection', async () => {
        await win.evaluate(() => window.sixline.editor.setCursor({track:1,bar:2,beat:1})); await waitIdle(win);
        const expected = await win.evaluate(() => window.sixline.api.tickCache.getBeatStart(window.sixline.score.tracks[1].staves[0].bars[2].voices[0].beats[1]));
        await win.click('#b-caret'); await win.waitForFunction(() => window.sixline.playerState === 1);
        const tick = await win.evaluate(() => window.sixline.api.tickPosition); assert.ok(tick >= expected && tick < expected+300);
        assert.deepEqual(await win.evaluate(() => [window.sixline.editor.cursor.track,window.sixline.editor.cursor.bar,window.sixline.editor.cursor.beat]),[1,2,1]);
        await win.click('#b-stop');
      });
      await step('document edit regeneration preserves playback position and playing state', async () => {
        await win.evaluate(() => window.sixline.editor.setCursor({track:0,bar:1,beat:0})); await waitIdle(win);
        await win.click('#b-caret'); await win.waitForFunction(() => window.sixline.playerState === 1); await win.waitForTimeout(500);
        const before = await win.evaluate(() => window.sixline.api.tickPosition);
        await win.keyboard.press('7'); await waitIdle(win);
        await win.waitForFunction(() => window.sixline.playerState === 1, null, {timeout:5000});
        const after = await win.evaluate(() => window.sixline.api.tickPosition);
        assert.ok(after >= before && after < before+2000,`regeneration: ${before} -> ${after}`); await win.click('#b-stop');
      });
      await step('practice and continuity workflows have no page errors', async () => assert.deepEqual(errors,[]));
    } finally { await closeApp(app,win); }
  }
}
