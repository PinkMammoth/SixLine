import assert from 'node:assert/strict';
import path from 'node:path';

export async function scoreInteractions({launch,closeApp,step,waitIdle,root,out,tabPoint}) {
  console.log('Score playback and drag selection');
  const {app,win,errors}=await launch(path.join(root,'fixtures/fixture.gp5'));
  const preferences = await win.evaluate(() => ['sixline.drumInput','sixline.drumView'].map(k=>[k,localStorage.getItem(k)]));
  const data=()=>win.evaluate(()=>({cursor:{...window.sixline.editor.cursor},selection:structuredClone(window.sixline.editor.selection),tick:window.sixline.api.tickPosition,state:window.sixline.playerState}));
  const point=(bar,beat=0,string=0)=>tabPoint(win,bar,beat,string);
  const drag=async(from,to,modifiers=[])=>{
    for(const k of modifiers)await win.keyboard.down(k);
    await win.mouse.move(from.x,from.y);await win.mouse.down();
    await win.mouse.move(to.x,to.y,{steps:16});await win.mouse.up();
    for(const k of modifiers)await win.keyboard.up(k);
  };
  try {
    await win.waitForFunction(()=>window.sixline.api.isReadyForPlayback);
    await win.fill('#speed','50');await win.locator('#speed').blur();
    await step('score click + Space starts at the chosen note, with every track aligned',async()=>{
      const p=await point(2,1,5);const before=await data();await win.mouse.click(p.x,p.y);
      assert.equal((await data()).tick,before.tick,'click arms the next start without seeking immediately');
      const expected=await win.evaluate(()=>{
        const t=window.sixline,b=t.score.tracks[0].staves[0].bars[2].voices[0].beats[1];
        window.__starts=[];t.api.playerPositionChanged.on(e=>{if(e.isSeek)window.__starts.push(e.currentTick);});
        return t.api.tickCache.getBeatStart(b);
      });
      await win.keyboard.press('Space');await win.waitForFunction(()=>window.sixline.playerState===1);
      await win.waitForFunction(t=>window.__starts.some(start=>Math.abs(start-t)<=1),expected,{timeout:3000});
      const r=await data();assert.ok(r.tick>=expected&&r.tick<expected+960,`clicked note start ${expected}, got ${JSON.stringify(r)}`);
      const tracks=await win.evaluate(()=>window.sixline.api.tickCache.findBeat(new Set([0,1,2]),window.sixline.api.tickPosition).beat.voice.bar.index);
      assert.equal(tracks,2);
    });
    await step('Space resumes a pause; clicking another stopped position then Play uses that position',async()=>{
      await win.waitForFunction(()=>window.sixline.api.tickPosition>8740);await win.keyboard.press('Space');await win.waitForFunction(()=>window.sixline.playerState===0);await win.waitForTimeout(200);
      const paused=(await data()).tick;await win.keyboard.press('Space');await win.waitForFunction(()=>window.sixline.playerState===1);
      const resumed=(await data()).tick;assert.ok(resumed>=paused-100&&resumed<paused+960,`resume ${paused} -> ${resumed}`);await win.waitForFunction(t=>window.sixline.api.tickPosition>t+100,paused);
      await win.keyboard.press('Space');await win.waitForFunction(()=>window.sixline.playerState===0);
      const p=await point(1,0,4);await win.mouse.click(p.x,p.y);await win.click('#b-play');
      await win.waitForFunction(()=>window.sixline.playerState===1);
      assert.ok((await data()).tick>=3840&&(await data()).tick<4800);
      await win.waitForFunction(()=>window.sixline.api.tickPosition>3940);await win.click('#b-stop');await win.waitForFunction(()=>window.sixline.playerState===0);
    });
    await step('return/back/forward bar controls seek exact bar starts and clamp song ends',async()=>{
      const song=await win.evaluate(()=>structuredClone(window.sixline.editor.song));
      const p=await point(2,0,5);await win.mouse.click(p.x,p.y);await win.click('#b-next');
      assert.deepEqual([(await data()).cursor.bar,(await data()).tick],[3,11520]);assert.ok(await win.locator('#b-next').isDisabled());
      await win.click('#b-previous');assert.deepEqual([(await data()).cursor.bar,(await data()).tick],[2,7680]);
      await win.click('#b-first');assert.deepEqual([(await data()).cursor.bar,(await data()).tick],[0,0]);assert.ok(await win.locator('#b-previous').isDisabled());
      await win.click('#b-next');assert.equal((await data()).tick,3840);
      assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),song);
    });
    await step('bar controls preserve playing state and score/player identity',async()=>{
      await win.click('#b-play');await win.waitForFunction(()=>window.sixline.playerState===1);
      await win.evaluate(()=>window.__transportScore=window.sixline.score);
      await win.click('#b-next');const next=await data();assert.equal(next.state,1);assert.equal(next.cursor.bar,2);assert.ok(next.tick>=7680&&next.tick<8640);
      await win.click('#b-previous');assert.equal((await data()).state,1);assert.equal((await data()).cursor.bar,1);
      await win.click('#b-first');assert.equal((await data()).state,1);assert.equal((await data()).cursor.bar,0);
      assert.ok(await win.evaluate(()=>window.sixline.score===window.__transportScore));await win.waitForTimeout(250);await win.click('#b-stop');await win.waitForFunction(()=>window.sixline.playerState===0);await win.waitForTimeout(150);
    });
    const original=await win.evaluate(()=>structuredClone(window.sixline.editor.song));
    await step('plain drag selects whole bars; keyboard copy/paste extends the song with one-action undo/redo',async()=>{
      await drag(await point(0,2,5),await point(2,2,5));
      const s=(await data()).selection;assert.equal(s.kind,'measures');assert.equal(s.anchor.bar,0);assert.equal(s.focus.bar,2);
      await win.keyboard.press('Control+c');await win.keyboard.press('Escape');
      const p=await point(3,0,5);await win.mouse.click(p.x,p.y);await win.keyboard.press('Control+v');await waitIdle(win);
      const pasted=await win.evaluate(()=>structuredClone(window.sixline.editor.song));
      assert.equal(pasted.masterBars.length,6);assert.deepEqual(pasted.tracks[0].measures.slice(3),original.tracks[0].measures.slice(0,3));
      assert.ok(pasted.tracks.every(t=>t.measures.length===6));
      await win.keyboard.press('Control+z');await waitIdle(win);assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),original);
      await win.keyboard.press('Control+y');await waitIdle(win);assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),pasted);
      await win.keyboard.press('Control+z');await waitIdle(win);await win.keyboard.press('Control+Home');
    });
    await step('reverse dragging keeps the initial bar anchored, and release outside the score completes selection',async()=>{
      await drag(await point(2,1,5),await point(0,1,5));const s=(await data()).selection;
      assert.equal(s.anchor.bar,2);assert.equal(s.focus.bar,0);assert.equal(s.kind,'measures');
      await win.keyboard.press('Escape');const p=await point(1,0,4);await win.mouse.move(p.x,p.y);await win.mouse.down();
      const sc=await win.locator('#score').boundingBox();await win.mouse.move(sc.x+3,4,{steps:12});await win.mouse.up();
      assert.equal((await data()).selection.anchor.bar,1);assert.equal((await data()).selection.focus.bar,0);
      assert.ok(!(await win.locator('#sheet').evaluate(el=>el.classList.contains('selecting'))));
    });
    await step('Shift-click-and-drag selects beats with a stable anchor while reversing direction',async()=>{
      const p=await point(0,1,5);await win.mouse.click(p.x,p.y);await win.keyboard.down('Shift');
      const start=await point(0,2,5);await win.mouse.move(start.x,start.y);await win.mouse.down();
      const back=await point(0,0,5);await win.mouse.move(back.x,back.y,{steps:8});
      const end=await point(1,3,4);await win.mouse.move(end.x,end.y,{steps:16});await win.mouse.up();await win.keyboard.up('Shift');
      const s=(await data()).selection;assert.equal(s.kind,'beats');assert.deepEqual(s.anchor,{bar:0,beat:1});assert.deepEqual(s.focus,{bar:1,beat:3});
      assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),original);
    });
    await step('drag selection during playback does not stop, seek or rebuild playback',async()=>{
      await win.click('#b-first');await win.click('#b-play');await win.waitForFunction(()=>window.sixline.playerState===1);await win.waitForTimeout(300);
      await win.evaluate(()=>{window.__dragScore=window.sixline.score;window.__dragTicks=[];window.sixline.api.playerPositionChanged.on(e=>window.__dragTicks.push({tick:e.currentTick,seek:e.isSeek}));});
      await drag(await point(0,0,5),await point(2,2,5));await win.waitForTimeout(300);
      const r=await win.evaluate(()=>({state:window.sixline.playerState,same:window.__dragScore===window.sixline.score,ticks:window.__dragTicks}));
      assert.equal(r.state,1);assert.ok(r.same);assert.ok(r.ticks.length>1);
      assert.ok(r.ticks.every((e,i)=>!e.seek&&(!i||e.tick>=r.ticks[i-1].tick)));await win.click('#b-stop');
    });
    await step('ordinary Play starts at the first complete bar of a reverse-dragged selection',async()=>{
      await drag(await point(2,2,5),await point(1,2,5));await win.click('#b-play');
      await win.waitForFunction(()=>window.sixline.playerState===1);
      const r=await data();assert.ok(r.tick>=3840&&r.tick<4800);assert.equal(r.selection.anchor.bar,2);assert.equal(r.selection.focus.bar,1);
      await win.waitForFunction(()=>window.sixline.api.tickPosition>3940);await win.click('#b-stop');await win.waitForFunction(()=>window.sixline.playerState===0);
    });
    await step('edge scrolling extends selection across score rows; releasing and Escape stop the gesture',async()=>{
      await win.keyboard.press('Control+n');await win.waitForSelector('dialog[open]');await win.fill('#f-title','Drag selection');await win.fill('#f-bars','40');
      await win.click('dialog button[value=ok]');await waitIdle(win);
      await win.waitForFunction(()=>window.sixline.editor.song.title==='Drag selection');await waitIdle(win);
      await win.evaluate(()=>window.sixline.editor.songEdit('Test passage',s=>s.tracks[0].measures.forEach(m=>{m.voices[0]=[0,2,3,5].map(fret=>({duration:4,dots:0,notes:[{string:0,fret,velocity:95}]}));})));await waitIdle(win);
      const p=await point(0,0,0),sc=await win.locator('#score').boundingBox();
      await win.mouse.move(p.x,p.y);await win.mouse.down();await win.mouse.move(p.x,sc.y+sc.height-6,{steps:14});await win.waitForTimeout(1800);
      assert.ok(await win.locator('#score').evaluate(el=>el.scrollTop)>150);assert.ok((await data()).selection.focus.bar>=8);
      await win.mouse.up();const stopped=await win.locator('#score').evaluate(el=>el.scrollTop);await win.waitForTimeout(200);
      assert.equal(await win.locator('#score').evaluate(el=>el.scrollTop),stopped);
      await win.screenshot({path:path.join(out,'score-drag.png')});
      await win.keyboard.press('Control+Home');const a=await point(0,0,0),b=await point(1,0,0);
      await win.mouse.move(a.x,a.y);await win.mouse.down();await win.mouse.move(b.x,b.y,{steps:8});await win.keyboard.press('Escape');await win.mouse.up();
      assert.equal((await data()).selection,null);
    });
    await step('numbered drum score shares drag selection and ordinary playback starts',async()=>{
      await win.keyboard.press('Control+n');await win.waitForSelector('dialog[open]');await win.selectOption('#f-type','drums');await win.fill('#f-bars','4');
      await win.click('dialog button[value=ok]');await win.waitForFunction(()=>window.sixline.editor.track.type==='drums');await waitIdle(win);await win.selectOption('#drum-input','numbers');
      await win.keyboard.type('3842');await waitIdle(win);
      const first=await win.locator('.drum-beat[data-bar="0"][data-beat="0"][data-voice="0"]').boundingBox();
      const last=await win.locator('.drum-beat[data-bar="2"][data-beat="0"][data-voice="0"]').boundingBox();
      await drag({x:first.x+first.width/2,y:first.y+20},{x:last.x+last.width/2,y:last.y+20});
      assert.equal((await data()).selection.kind,'measures');assert.equal((await data()).selection.focus.bar,2);
      await win.keyboard.press('Escape');await win.locator('.drum-bar[data-bar="2"] .drum-bar-label').click();
      await win.waitForFunction(()=>window.sixline.api.isReadyForPlayback);await win.click('#b-play');await win.waitForFunction(()=>window.sixline.playerState===1);
      await win.waitForFunction(()=>window.sixline.api.tickPosition>7780);assert.ok((await data()).tick>=7680);await win.click('#b-stop');await win.waitForFunction(()=>window.sixline.playerState===0);assert.deepEqual(errors,[]);
    });
  } finally {
    if(errors.length)console.log('       Page errors: '+errors.join(' | '));
    await win.evaluate(prefs=>prefs.forEach(([k,v])=>v===null?localStorage.removeItem(k):localStorage.setItem(k,v)),preferences).catch(()=>{});
    await closeApp(app,win);
  }
}
