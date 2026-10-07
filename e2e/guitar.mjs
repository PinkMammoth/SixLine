import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseMidi } from 'midi-file';

export async function guitarWorkflows({ launch, closeApp, step, waitIdle, root, out }) {
  console.log('Guitar / bass composition');
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'sixline-guitar-'));
  const newSong=async(win,title,type='guitar')=>{
    await win.keyboard.press('Control+n');await win.waitForSelector('dialog[open]');
    await win.fill('#f-title',title);await win.fill('#f-bars','4');await win.fill('#f-tempo','180');
    await win.selectOption('#f-type',type);
    await win.click('dialog button[value=ok]');await waitIdle(win);
  };
  const position=async(win,bar,beat,string=0)=>{
    await win.evaluate(({bar,beat,string})=>window.sixline.editor.setCursor({bar,beat,string}),{bar,beat,string});await waitIdle(win);
  };
  const saveAs=async(app,win,file)=>{
    await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);
    await win.keyboard.press('Control+Shift+s');await win.waitForFunction(()=>!window.sixline.editor.dirty);
  };
  const reopen=async(app,win,file)=>{
    await win.keyboard.press('Control+w');
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
    await win.keyboard.press('Control+o');await win.waitForFunction(file=>window.sixline.active.filePath===file,file);await waitIdle(win);
  };
  const okDialog=async(win)=>{await win.click('dialog button[value=ok]');await waitIdle(win);};
  const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  {
    const {app,win,errors}=await launch(path.join(root,'fixtures/fixture.gp5'));
    try {
      await step('Guitar A: keyboard riff with hammer-on, pull-off, slide, bend and vibrato',async()=>{
        await newSong(win,'Articulated riff');
        for(let i=0;i<8;i++){await win.keyboard.type(['5','7','3','9','12','7','5','7'][i]);if(i<7)await win.keyboard.press('ArrowRight');}
        await position(win,0,0);await win.keyboard.press('h');await waitIdle(win);
        await position(win,0,1);await win.keyboard.press('h');await waitIdle(win);
        await position(win,0,2);await win.keyboard.press('s');await win.waitForSelector('dialog[open]');
        await win.selectOption('#f-slide','2');await okDialog(win);
        await position(win,0,3);await win.keyboard.press('b');await win.waitForSelector('dialog[open]');
        await win.selectOption('#f-amount','4');await win.selectOption('#f-shape','release');await okDialog(win);
        await win.keyboard.press('v');await waitIdle(win);
        const notes=await win.evaluate(()=>window.sixline.score.tracks[0].staves[0].bars[0].voices[0].beats.map(b=>({fret:b.notes[0].fret,dest:b.notes[0].hammerPullDestination?.fret,slide:b.notes[0].slideOutType,bend:b.notes[0].hasBend,vibrato:b.notes[0].vibrato})));
        assert.equal(notes[0].dest,7);assert.equal(notes[1].dest,3);assert.equal(notes[2].slide,2);assert.equal(notes[3].bend,true);assert.equal(notes[3].vibrato,1);
      });
      await step('Guitar A: range palm mute / let ring and natural / pinch harmonics',async()=>{
        await position(win,0,0);await win.keyboard.press('Shift+ArrowRight');await win.keyboard.press('Shift+ArrowRight');await win.keyboard.press('Shift+ArrowRight');
        await win.keyboard.press('p');await waitIdle(win);await win.keyboard.press('Escape');
        await position(win,1,0);await win.keyboard.press('n');await win.waitForSelector('dialog[open]');await win.selectOption('#f-harmonic','1');await okDialog(win);
        await position(win,1,1);await win.keyboard.press('n');await win.waitForSelector('dialog[open]');await win.selectOption('#f-harmonic','3');await okDialog(win);
        await position(win,1,2);await win.keyboard.press('b');await win.waitForSelector('dialog[open]');await win.selectOption('#f-amount','1');await okDialog(win);
        await position(win,1,0);await win.keyboard.press('Shift+ArrowRight');await win.keyboard.press('Shift+ArrowRight');await win.keyboard.press('Shift+ArrowRight');
        await win.keyboard.press('l');await waitIdle(win);await win.keyboard.press('Escape');await win.keyboard.press('Shift+v');await waitIdle(win);
        const bars=await win.evaluate(()=>window.sixline.editor.track.measures);
        assert.ok(bars[0].voices[0].every(b=>b.notes[0].fx.palmMute));assert.ok(bars[1].voices[0].every(b=>b.notes[0].fx.letRing));
        assert.equal(bars[1].voices[0][0].notes[0].fx.harmonic.type,1);assert.equal(bars[1].voices[0][1].notes[0].fx.harmonic.type,3);
        assert.equal(bars[1].voices[0][3].notes[0].fx.vibrato,'wide');
        await win.screenshot({path:path.join(out,'guitar-articulated.png')});
      });
      await step('Guitar A: bend dialog preserves current curves unless explicitly changed',async()=>{
        await position(win,0,3);const before=await win.evaluate(()=>structuredClone(window.sixline.editor.noteAtCursor().fx.bend));
        await win.keyboard.press('b');await win.waitForSelector('dialog[open]');assert.equal(await win.inputValue('#f-amount'),'keep');await okDialog(win);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.noteAtCursor().fx.bend),before);
        await win.keyboard.press('b');await win.waitForSelector('dialog[open]');await win.selectOption('#f-amount','2');await win.selectOption('#f-shape','bend');await okDialog(win);
        assert.equal(await win.evaluate(()=>Math.max(...window.sixline.editor.noteAtCursor().fx.bend.map(p=>p.value))),2);
        await win.keyboard.press('Control+z');await waitIdle(win);assert.deepEqual(await win.evaluate(()=>window.sixline.editor.noteAtCursor().fx.bend),before);
      });
      await step('Guitar A: save, close, reopen preserves every articulation; playback completes',async()=>{
        const file=path.join(tmp,'articulated.tabproj');const song=await win.evaluate(()=>structuredClone(window.sixline.editor.song));
        await saveAs(app,win,file);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).song,song);await reopen(app,win,file);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),song);
        await win.waitForFunction(()=>window.sixline.api.isReadyForPlayback);
        await win.evaluate(()=>{window.__riffProgress=[];window.sixline.api.playerPositionChanged.on(e=>window.__riffProgress.push(e.currentTime));});
        await win.keyboard.press('Space');await win.waitForFunction(()=>window.sixline.playerState===1);
        await win.waitForFunction(()=>window.sixline.playerState===0,null,{timeout:15000});
        assert.ok(await win.evaluate(()=>Math.max(...window.__riffProgress))>4000);assert.deepEqual(errors,[]);
      });
      await step('Guitar A: unsupported transition reports an error without changing music',async()=>{
        await position(win,1,3);const song=await win.evaluate(()=>structuredClone(window.sixline.editor.song));
        await win.keyboard.press('h');assert.match(await win.textContent('#msg'),/following fret|target first/);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),song);
      });
      await step('Guitar A: multi-digit harmonic editing and Escape retain techniques',async()=>{
        await position(win,1,0);const before=await win.evaluate(()=>structuredClone(window.sixline.editor.song));
        await win.keyboard.press('1');assert.equal(await win.evaluate(()=>window.sixline.editor.fretDigits),'1');
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),before);
        await win.keyboard.press('Escape');assert.equal(await win.evaluate(()=>window.sixline.editor.fretDigits),'');
        await win.keyboard.type('19');await waitIdle(win);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.noteAtCursor().fx.harmonic),{type:1,value:19});
        await win.keyboard.press('Control+z');await waitIdle(win);assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),before);
      });
      await step('Guitar B: fast vertical chord progression, muted strings and chord undo/redo',async()=>{
        await newSong(win,'Chord progression');await win.keyboard.press('q');
        assert.ok(await win.locator('#b-chord').evaluate(b=>b.classList.contains('on')));
        const chords=[[0,1,0,2,3,null],[0,1,2,2,0,null],[3,0,0,0,2,3],[1,1,2,3,3,1]];
        for(let i=0;i<chords.length;i++){
          for(const fret of chords[i]){if(fret===null)await win.keyboard.press('x');else{await win.keyboard.type(String(fret));await win.keyboard.press('Tab');}}
          if(i<3)await win.keyboard.press('ArrowRight');
        }
        await waitIdle(win);const beats=await win.evaluate(()=>structuredClone(window.sixline.editor.beats));
        assert.equal(beats.length,4);assert.deepEqual(beats[0].notes.map(n=>[n.string,n.fret]),[[0,0],[1,1],[2,0],[3,2],[4,3]]);
        assert.equal(beats[3].notes.length,6);await win.keyboard.press('Control+z');await waitIdle(win);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.beat.notes),[]);await win.keyboard.press('Control+y');await waitIdle(win);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.beats),beats);
      });
      await step('Guitar B: multi-digit chord entry retains duration and avoids duplicate string notes',async()=>{
        await win.keyboard.press('ArrowRight');await win.keyboard.press('Alt+1');
        for(const fret of [12,13,12,14,15]){await win.keyboard.type(String(fret));await win.keyboard.press('Tab');}await win.keyboard.press('x');await waitIdle(win);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.cursor),{track:0,bar:1,beat:0,string:5});
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.beat.notes.map(n=>n.fret)),[12,13,12,14,15]);
        assert.equal(await win.evaluate(()=>window.sixline.editor.beat.duration),1);
        assert.equal(await win.evaluate(()=>window.sixline.score.tracks[0].staves[0].bars[1].voices[0].beats[0].notes.length),5);
      });
      await step('Guitar B: duplicate progression, edit duplicate chord, undo/redo and MIDI export',async()=>{
        await win.keyboard.press('Control+Home');await win.keyboard.press('Control+Shift+ArrowRight');await win.keyboard.press('Control+d');await waitIdle(win);
        const duplicated=await win.evaluate(()=>structuredClone(window.sixline.editor.song));assert.equal(duplicated.masterBars.length,6);
        assert.deepEqual(duplicated.tracks[0].measures[2],duplicated.tracks[0].measures[0]);assert.deepEqual(duplicated.tracks[0].measures[3],duplicated.tracks[0].measures[1]);
        await win.keyboard.press('Escape');await win.keyboard.press('Shift+ArrowUp');await waitIdle(win);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.beat.notes.map(n=>n.fret)),[1,2,1,3,4]);
        await win.keyboard.press('Control+z');await waitIdle(win);assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),duplicated);
        await win.keyboard.press('Control+y');await waitIdle(win);
        const file=path.join(tmp,'chords.mid');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);
        await win.keyboard.press('Control+e');await win.waitForTimeout(300);
        const parsed=parseMidi(fs.readFileSync(file));let tick=0;const first=[];
        for(const ev of parsed.tracks[0]){tick+=ev.deltaTime;if(tick===0&&ev.type==='noteOn')first.push(ev.noteNumber);}
        assert.deepEqual(first.sort((a,b)=>a-b),[48,52,55,60,64]);assert.deepEqual(errors,[]);
        await win.screenshot({path:path.join(out,'guitar-chords.png')});
      });
      await step('Guitar B: clear chord shortcut removes all notes as one undoable action',async()=>{
        const notes=await win.evaluate(()=>structuredClone(window.sixline.editor.beat.notes));await win.keyboard.press('Control+Shift+k');await waitIdle(win);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.beat.notes),[]);await win.keyboard.press('Control+z');await waitIdle(win);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.beat.notes),notes);
      });
      await step('Bass: vertical chord entry, transpose, pitch-preserving string move and invalid-move feedback',async()=>{
        await newSong(win,'Bass chords','bass');await win.keyboard.press('q');
        for(const fret of [12,10,7]){await win.keyboard.type(String(fret));await win.keyboard.press('Tab');}await win.keyboard.press('x');await waitIdle(win);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.beat.notes.map(n=>n.fret)),[12,10,7]);
        const before=await win.evaluate(()=>structuredClone(window.sixline.editor.song));
        await win.keyboard.press('Shift+ArrowUp');await waitIdle(win);assert.deepEqual(await win.evaluate(()=>window.sixline.editor.beat.notes.map(n=>n.fret)),[13,11,8]);
        await win.keyboard.press('Control+z');await waitIdle(win);assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),before);
        const pitches=await win.evaluate(()=>window.sixline.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.map(n=>n.realValue));
        await win.keyboard.press('Alt+ArrowDown');await waitIdle(win);assert.deepEqual(await win.evaluate(()=>window.sixline.editor.beat.notes.map(n=>n.string)),[1,2,3]);
        assert.deepEqual(await win.evaluate(()=>window.sixline.score.tracks[0].staves[0].bars[0].voices[0].beats[0].notes.map(n=>n.realValue)),pitches);
        const moved=await win.evaluate(()=>structuredClone(window.sixline.editor.song));
        await win.keyboard.press('Alt+ArrowDown');assert.match(await win.textContent('#msg'),/beyond the available strings/);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),moved);assert.deepEqual(errors,[]);
      });
    } finally {await closeApp(app,win);}
  }
  {
    const privateDir=path.join(root,'gp5-examples');
    const files=fs.existsSync(privateDir)?fs.readdirSync(privateDir).filter(f=>/\.gp5$/i.test(f)):[];
    const {app,win,errors}=await launch(path.join(root,'fixtures/fixture.gp5'));
    try {
      await step('Guitar C: edit two imported GP techniques, save/reopen; original fixture stays intact',async()=>{
        let chosen=null, effects=[];
        for(const name of files){
          const file=path.join(privateDir,name);await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);
          await win.keyboard.press('Control+o');await win.waitForFunction(name=>window.sixline.active.fileName===name,name.replace(/\.[^.]+$/,'.tabproj'));await waitIdle(win);
          effects=await win.evaluate(()=>window.sixline.editor.song.tracks.flatMap((t,track)=>['guitar','bass'].includes(t.type)?t.measures.flatMap((m,bar)=>m.voices[0].flatMap((b,beat)=>b.notes.flatMap(n=>Object.entries(n.fx??{}).filter(([k,v])=>v&&['hammer','bend','slide','slideIn','vibrato','palmMute','letRing','harmonic'].includes(k)).map(([key])=>({track,bar,beat,string:n.string,key}))))):[]));
          if(effects.length>=2){chosen=file;break;}
        }
        if(!chosen){console.log('       No private articulated GP5 fixture available; preservation covered by unit fixtures.');return;}
        const originalHash=hash(chosen);const before=await win.evaluate(()=>structuredClone(window.sixline.editor.song));
        for(const effect of effects.slice(0,2)){
          await win.evaluate(p=>window.sixline.editor.setCursor(p),effect);await waitIdle(win);
          if(['hammer','vibrato','palmMute','letRing'].includes(effect.key))await win.keyboard.press({hammer:'h',vibrato:'v',palmMute:'p',letRing:'l'}[effect.key]);
          else if(effect.key==='bend'){await win.keyboard.press('b');await win.waitForSelector('dialog[open]');await win.selectOption('#f-amount','0');await okDialog(win);}
          else if(effect.key==='harmonic'){await win.keyboard.press('n');await win.waitForSelector('dialog[open]');await win.selectOption('#f-harmonic','0');await okDialog(win);}
          else {await win.keyboard.press('s');await win.waitForSelector('dialog[open]');await win.selectOption('#f-slide','0');await win.selectOption('#f-slideIn','0');await okDialog(win);}
          await waitIdle(win);
        }
        const edited=await win.evaluate(()=>structuredClone(window.sixline.editor.song));assert.notDeepEqual(edited,before);
        for(const effect of effects.slice(0,2)) {
          const notes=edited.tracks[effect.track].measures[effect.bar].voices[0][effect.beat].notes;
          const old=before.tracks[effect.track].measures[effect.bar].voices[0][effect.beat].notes.find(n=>n.string===effect.string);
          assert.notDeepEqual(notes.find(n=>n.string===effect.string).fx?.[effect.key],old.fx[effect.key]);
        }
        const file=path.join(tmp,'imported-techniques.tabproj');await saveAs(app,win,file);await reopen(app,win,file);
        assert.deepEqual(await win.evaluate(()=>window.sixline.editor.song),edited);assert.equal(hash(chosen),originalHash);assert.deepEqual(errors,[]);
      });
    } finally {await closeApp(app,win);}
  }
}
