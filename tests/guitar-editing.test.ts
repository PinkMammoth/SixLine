import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as at from '@coderline/alphatab';
import { parseMidi } from 'midi-file';
import { Editor } from '../src/editor/editor';
import { createSong, HarmonicType, notePitch, type NoteEffects, type Song } from '../src/model/song';
import { bendCurve } from '../src/editor/techniques';
import { loadGpBytes, scoreToSong, songToScore } from '../src/io/alphatab';
import { serializeProject, parseProject } from '../src/io/project';
import { exportMidi } from '../src/io/midiExport';
import { fixture, root } from './helpers';

const riff = (type: 'guitar' | 'bass' = 'guitar') => {
  const song = createSong({ tracks: [type], bars: 2 });
  song.tracks[0].measures[0].voices[0] = [3,5,2,7].map(fret => ({ duration:4, dots:0, notes:[{string:0,fret,velocity:95}] }));
  return new Editor(song);
};
const bridge = (e: Editor) => songToScore(e.song, new at.Settings()).tracks[0].staves[0].bars[0].voices[0].beats;

describe('editable guitar and bass techniques', () => {
  it.each(['guitar','bass'] as const)('validates and renders hammer-on and pull-off on %s', type => {
    const e = riff(type); e.setTechnique('hammer'); e.moveRight(); e.setTechnique('hammer');
    const beats = bridge(e);
    expect(beats[0].notes[0].hammerPullDestination?.fret).toBe(5);
    expect(beats[1].notes[0].hammerPullDestination?.fret).toBe(2);
    e.setTechnique('hammer'); expect(e.noteAtCursor()?.fx).toBeUndefined();
    e.undo(); expect(e.noteAtCursor()?.fx?.hammer).toBe(true);
    e.redo(); expect(e.noteAtCursor()?.fx).toBeUndefined();
  });
  it.each(['palmMute','letRing','vibrato'] as const)('toggles %s without losing other effects', key => {
    const e = riff(); e.setBend(2); const bend = structuredClone(e.noteAtCursor()!.fx!.bend);
    e.setTechnique(key); expect(e.noteAtCursor()?.fx?.[key]).toBe(true);
    e.setTechnique(key); expect(e.noteAtCursor()?.fx?.[key]).toBeUndefined();
    expect(e.noteAtCursor()?.fx?.bend).toEqual(bend);
    e.undo(); expect(e.noteAtCursor()?.fx?.[key]).toBe(true);
    e.redo(); expect(e.noteAtCursor()?.fx?.[key]).toBeUndefined();
  });
  it('retains normal and wide vibrato across alphaTab conversion and native storage', () => {
    const e = riff(); e.setTechnique('vibrato','wide');
    expect(bridge(e)[0].notes[0].vibrato).toBe(at.model.VibratoType.Wide);
    expect(scoreToSong(songToScore(e.song, new at.Settings())).tracks[0].measures[0].voices[0][0].notes[0].fx?.vibrato).toBe('wide');
    expect(parseProject(serializeProject(e.song))).toEqual(e.song);
    e.setTechnique('vibrato'); expect(e.noteAtCursor()?.fx).toBeUndefined();
  });
  it.each([1,2,4,6])('stores and renders a bend of %s quarter tones', amount => {
    const e = riff(); e.setBend(amount);
    expect(e.noteAtCursor()?.fx?.bend).toEqual(bendCurve(amount));
    expect(bridge(e)[0].notes[0].maxBendPoint?.value).toBe(amount);
    e.setBend(amount,true); expect(bridge(e)[0].notes[0].bendType).toBe(at.model.BendType.BendRelease);
    expect(e.noteAtCursor()?.fx?.bend?.at(-1)?.value).toBe(0);
    e.setBend(0); expect(e.noteAtCursor()?.fx).toBeUndefined();
    e.undo(); expect(e.noteAtCursor()?.fx?.bend).toEqual(bendCurve(amount,true));
  });
  it('rejects unsupported bend amounts atomically', () => {
    const e=riff(), before=structuredClone(e.song);
    expect(()=>e.setBend(3)).toThrow(/Bend amount/); expect(e.song).toEqual(before); expect(e.canUndo).toBe(false);
  });
  it.each([1,2,3,4])('edits slide out type %s and slide-in together', out => {
    const e=riff(); e.setSlide(out,2); const n=bridge(e)[0].notes[0];
    expect(n.slideOutType).toBe(out); expect(n.slideInType).toBe(2);
    if(out<3) expect(n.slideTarget?.fret).toBe(5);
    e.setSlide(0,0); expect(e.noteAtCursor()?.fx).toBeUndefined(); e.undo(); expect(e.noteAtCursor()?.fx).toEqual({slide:out,slideIn:2});
  });
  it.each(['hammer','shift','legato'])('rejects invalid %s transitions without changing history', kind => {
    for(const fault of ['missing','different-string','same-fret','rest','tied']) {
      const e=riff();
      if(fault==='missing') e.setCursor({beat:3});
      if(fault==='different-string') e.beats[1].notes[0].string=1;
      if(fault==='same-fret') e.beats[1].notes[0].fret=3;
      if(fault==='rest') e.beats[1].notes=[];
      if(fault==='tied') e.beats[1].notes[0].tie=true;
      const before=structuredClone(e.song);
      expect(()=>kind==='hammer'?e.setTechnique('hammer'):e.setSlide(kind==='shift'?1:2)).toThrow();
      expect(e.song).toEqual(before); expect(e.canUndo).toBe(false);
    }
  });
  it('validates every selected transition before editing any note', () => {
    const e=riff(); e.selectMeasures(0); const before=structuredClone(e.song);
    expect(()=>e.setTechnique('hammer')).toThrow(/target first/); expect(e.song).toEqual(before); expect(e.canUndo).toBe(false);
  });
  it.each(['hammer','slide'])('rejects %s across an implicit end-of-bar rest', kind => {
    const e=riff(); e.track.measures[0].voices[0]=[e.beat];
    e.track.measures[1].voices[0]=[{duration:4,dots:0,notes:[{string:0,fret:7,velocity:95}]}];
    const before=structuredClone(e.song);
    expect(()=>kind==='hammer'?e.setTechnique('hammer'):e.setSlide(1)).toThrow(/Fill the measure/);
    expect(e.song).toEqual(before); expect(e.canUndo).toBe(false);
  });
  it('applies/removes range effects to selected rows, including measure secondary voices', () => {
    const e=riff(); e.beats[0].notes.push({string:1,fret:7,velocity:95});
    e.track.measures[0].voices.push([{duration:1,dots:0,notes:[{string:0,fret:12,velocity:95}]}]);
    e.select('beats',[0]); e.extendSelection(2); e.setTechnique('palmMute',true);
    expect(e.beats.slice(0,3).every(b=>b.notes[0].fx?.palmMute)).toBe(true);
    expect(e.beats[0].notes[1].fx).toBeUndefined(); expect(e.track.measures[0].voices[1][0].notes[0].fx).toBeUndefined();
    e.selectMeasures(0); e.setTechnique('letRing',true);
    expect(e.track.measures[0].voices.flatMap(v=>v.flatMap(b=>b.notes)).every(n=>n.fx?.letRing)).toBe(true);
    expect(bridge(e)[0].notes[0].letRingDestination).not.toBeNull();
    e.setTechnique('letRing',false); e.undo(); expect(e.beats[3].notes[0].fx?.letRing).toBe(true);
  });
  it.each([HarmonicType.Natural,HarmonicType.Artificial,HarmonicType.Pinch])('stores and plays harmonic type %s', type => {
    const e=riff(); e.setFret(12); e.setHarmonic(type,12);
    const n=bridge(e)[0].notes[0]; expect(n.harmonicType).toBe(type); expect(n.harmonicValue).toBe(12);
    expect(n.realValue).toBe(type===HarmonicType.Natural?76:88);
    expect(scoreToSong(songToScore(e.song,new at.Settings())).tracks[0].measures[0].voices[0][0].notes[0].fx?.harmonic).toEqual({type,value:12});
    e.setHarmonic(0); expect(e.noteAtCursor()?.fx).toBeUndefined(); e.undo(); expect(e.noteAtCursor()?.fx?.harmonic?.type).toBe(type);
  });
  it('rejects an unplayable natural harmonic rather than silently choosing a node', () => {
    const e=riff(); e.setFret(6); expect(()=>e.setHarmonic(HarmonicType.Natural)).toThrow(/touch fret/);
    expect(e.noteAtCursor()?.fx).toBeUndefined();
  });
  it('keeps imported harmonic variants and custom bend points through unrelated edits', () => {
    const e=riff(); const fx:NoteEffects={harmonic:{type:HarmonicType.Tap,value:2.7},bend:[{offset:0,value:2},{offset:17,value:6},{offset:60,value:1}],vibrato:'wide'};
    e.beats[0].notes[0].fx=structuredClone(fx); e.setTechnique('palmMute');
    expect(e.noteAtCursor()?.fx).toEqual({...fx,palmMute:true}); e.undo(); expect(e.noteAtCursor()?.fx).toEqual(fx);
    expect(parseProject(serializeProject(e.song))).toEqual(e.song);
  });
  it('does not normalize an imported custom harmonic node when its fret is unchanged', () => {
    const e=riff();e.beats[0].notes[0].fret=6;e.beats[0].notes[0].fx={harmonic:{type:HarmonicType.Natural,value:5.4}};
    e.setFret(6);expect(e.noteAtCursor()?.fx?.harmonic).toEqual({type:1,value:5.4});
    expect(parseProject(serializeProject(e.song))).toEqual(e.song);
    e.setFret(7);expect(e.noteAtCursor()?.fx?.harmonic).toEqual({type:1,value:7});
  });
});

describe('technique preservation and linked-note edits', () => {
  const articulated = () => { const e=riff(); e.setTechnique('hammer'); e.setSlide(2); e.setBend(4,true); e.setTechnique('vibrato','wide'); e.setTechnique('palmMute'); e.setTechnique('letRing'); e.setHarmonic(HarmonicType.Pinch); return e; };
  it('preserves all technique data through copy/paste, cut/undo, duplication and native reload', () => {
    const e=articulated(), original=structuredClone(e.track.measures[0]);
    e.selectMeasures(0); const p=e.copy(); e.setCursor({bar:1}); e.paste(p);
    expect(e.track.measures[1]).toEqual(original); e.undo(); e.redo(); expect(e.track.measures[1]).toEqual(original);
    e.selectMeasures(0); e.cut(); expect(e.beats.every(b=>!b.notes.length)).toBe(true); e.undo(); expect(e.track.measures[0]).toEqual(original);
    e.selectMeasures(0); e.duplicate(); expect(e.track.measures[1]).toEqual(original);
    expect(parseProject(serializeProject(e.song))).toEqual(e.song);
    e.undo(); expect(e.song.masterBars).toHaveLength(2); e.redo(); expect(e.track.measures[1]).toEqual(original);
  });
  it('preserves techniques in beat duplication without inventing links at the boundary', () => {
    const e=articulated(); e.track.measures[1].voices[0]=[3,5,2,7].map(fret=>({duration:4,dots:0,notes:[{string:0,fret,velocity:95}]})); e.select(); e.extendSelection(1); const p=e.copy();
    e.duplicate(); expect(e.beats[2].notes[0].fx).toEqual(p.measures[0].voices[0][0].notes[0].fx);
    expect(bridge(e)[2].notes[0].hammerPullDestination?.fret).toBe(5);
  });
  it('clearly rejects copying/duplicating only the origin of a linked effect', () => {
    const e=articulated(); expect(()=>e.copy()).toThrow(/both ends/); e.select(); expect(()=>e.duplicate()).toThrow(/both ends/);
  });
  it('detaches deleted/cut targets and restores cross-bar transitions with a single undo', () => {
    const e=riff(); e.track.measures[0].voices[0]=[{duration:1,dots:0,notes:[{string:0,fret:3,velocity:95}]}];
    e.track.measures[1].voices[0]=[{duration:1,dots:0,notes:[{string:0,fret:5,velocity:95}]}];
    e.setTechnique('hammer'); e.setSlide(1); e.setCursor({bar:1}); e.deleteNote();
    expect(e.track.measures[0].voices[0][0].notes[0].fx).toBeUndefined(); e.undo();
    expect(e.track.measures[0].voices[0][0].notes[0].fx).toEqual({hammer:true,slide:1});
    expect(e.noteAtCursor()?.fret).toBe(5); e.cut(); expect(e.track.measures[0].voices[0][0].notes[0].fx).toBeUndefined();
    e.undo(); expect(e.track.measures[0].voices[0][0].notes[0].fx?.hammer).toBe(true);
  });
  it('pasting over a target does not attach an old slide to a replacement note', () => {
    const e=riff(); e.setSlide(1); e.setCursor({beat:2}); const p=e.copy(); e.setCursor({beat:1}); e.paste(p);
    expect(e.beats[0].notes[0].fx).toBeUndefined(); e.undo(); expect(e.beats[0].notes[0].fx?.slide).toBe(1);
  });
  it('version 1 projects with legacy boolean vibrato still load without migrating or dropping fields', () => {
    const e=riff(); e.beats[0].notes[0].fx={vibrato:true,hammer:true};
    const old=JSON.stringify({format:'tabproj',version:1,song:e.song}); expect(parseProject(old)).toEqual(e.song);
    expect(bridge(e)[0].notes[0].vibrato).toBe(at.model.VibratoType.Slight);
  });
  it('exports sounding bends, slides, vibrato and harmonic pitches as ordinary MIDI events', () => {
    const e=articulated(), file=parseMidi(exportMidi(e.song)), events=file.tracks.flat();
    expect(events.some((e:any)=>e.type==='pitchBend')).toBe(true);
    expect(events.some((e:any)=>e.type==='noteOn'&&e.noteNumber===79)).toBe(true);
    expect(events.some((e:any)=>e.type==='sequencerSpecific'||e.type==='text')).toBe(false);
  });
});

describe('chord entry and transforms', () => {
  it('enters a five-string chord vertically as one undo action and keeps its duration', () => {
    const e=new Editor(createSong()); e.setDuration(8); e.toggleChordEntry();
    for(const fret of [0,1,0,2,3]) {e.typeDigit(fret,0);e.advanceChordString();}
    expect(e.cursor).toMatchObject({bar:0,beat:0,string:5}); expect(e.beat.duration).toBe(8);
    expect(e.beat.notes.map(n=>[n.string,n.fret])).toEqual([[0,0],[1,1],[2,0],[3,2],[4,3]]);
    e.undo(); expect(e.beat.notes).toEqual([]); expect(e.beat.duration).toBe(8);
    e.redo(); expect(e.beat.notes).toHaveLength(5); expect(bridge(e)[0].notes).toHaveLength(5);
  });
  it('combines multi-digit chord frets, prevents duplicate strings and honours reverse navigation', () => {
    const e=new Editor(createSong()); e.toggleChordEntry(); e.typeDigit(1,0); e.typeDigit(2,10); e.advanceChordString();
    e.typeDigit(2,20); e.typeDigit(4,30); e.advanceChordString(-1); e.typeDigit(7,40);
    expect(e.beat.notes.map(n=>n.fret)).toEqual([7,24]); e.undo(); expect(e.beat.notes).toEqual([]);
  });
  it('mute/skip advances a string without adding a fake note and groups existing chord deletion', () => {
    const e=riff(); e.toggleChordEntry(); e.muteChordString(); expect(e.cursor.string).toBe(1); expect(e.beat.notes).toEqual([]);
    e.typeDigit(4,0); e.undo(); expect(e.beat.notes[0].fret).toBe(3);
  });
  it('new beats and explicit caret navigation start separate chord undo groups', () => {
    const e=riff(); e.toggleChordEntry(); e.typeDigit(7,0); e.advanceChordString(); e.typeDigit(2,10); e.moveRight(); e.setCursor({string:0}); e.typeDigit(8,20);
    e.undo(); expect(e.beat.notes[0].fret).toBe(5); e.undo(); expect(e.track.measures[0].voices[0][0].notes).toEqual([{string:0,fret:3,velocity:95}]);
  });
  it('transposes an entire chord or selected rows atomically and preserves techniques', () => {
    const e=riff(); e.beats[0].notes.push({string:1,fret:7,velocity:95,fx:{palmMute:true}}); e.transformFrets(12);
    expect(e.beat.notes.map(n=>n.fret)).toEqual([15,19]); expect(e.beat.notes[1].fx?.palmMute).toBe(true);
    e.undo(); e.select('beats',[1]); e.transformFrets(-1); expect(e.beat.notes.map(n=>n.fret)).toEqual([3,6]);
  });
  it('moves chords across strings with unchanged sounding pitches', () => {
    const e=riff(); e.beats[0].notes=[{string:0,fret:3,velocity:95},{string:1,fret:7,velocity:95}];
    const pitches=e.beat.notes.map(n=>notePitch(e.track,n)); e.transformFrets(1,true);
    expect(e.beat.notes.map(n=>n.string)).toEqual([1,2]); expect(e.beat.notes.map(n=>notePitch(e.track,n))).toEqual(pitches);
    e.undo(); expect(e.beat.notes.map(n=>n.string)).toEqual([0,1]);
  });
  it.each(['negative','over-max','beyond-string','duplicate-string','pitch','relationship'])('rejects %s transforms without partial edits', fault => {
    const e=riff();
    let run=()=>e.transformFrets(-12);
    if(fault==='over-max') run=()=>e.transformFrets(28);
    if(fault==='beyond-string') run=()=>e.transformFrets(-1,true);
    if(fault==='duplicate-string') {e.beats[0].notes.push({string:1,fret:7,velocity:95}); e.select('beats',[0]); run=()=>e.transformFrets(1,true);}
    if(fault==='pitch') {e.setCursor({string:5});e.beat.notes=[{string:5,fret:0,velocity:95}];run=()=>e.transformFrets(-1,true);}
    if(fault==='relationship') {e.setTechnique('hammer');run=()=>e.transformFrets(1,true);}
    const before=structuredClone(e.song), undo=e.lastUndoLabel; expect(run).toThrow(); expect(e.song).toEqual(before);expect(e.lastUndoLabel).toBe(undo);
  });
  it('rejects direct invalid fret entry, unsupported track types and invalid multi-digit chord frets', () => {
    const e=riff(); for(const n of [-1,31,1.5]) expect(()=>e.setFret(n)).toThrow(/Fret/);
    e.toggleChordEntry(); e.typeDigit(3,0); expect(()=>e.typeDigit(1,20)).toThrow(/31/);
    for(const type of ['keys','drums'] as const) {const x=new Editor(createSong({tracks:[type]}));expect(()=>x.toggleChordEntry()).toThrow();expect(()=>x.setTechnique('palmMute')).toThrow();}
  });
  it('buffers a multi-digit harmonic fret without changing the imported effect or undo history', () => {
    const e=riff(); e.setFret(12);e.setHarmonic(HarmonicType.Natural);const before=structuredClone(e.song),label=e.lastUndoLabel;
    e.typeDigit(1,0);expect(e.fretDigits).toBe('1');expect(e.song).toEqual(before);expect(e.lastUndoLabel).toBe(label);
    e.typeDigit(9,20);expect(e.noteAtCursor()?.fret).toBe(19);expect(e.noteAtCursor()?.fx?.harmonic).toEqual({type:1,value:19});
    e.undo();expect(e.song).toEqual(before);e.redo();expect(e.noteAtCursor()?.fret).toBe(19);
  });
  it('allows multi-digit frets whose first digit would temporarily break a hammer-on', () => {
    const e=riff();e.beats[1].notes[0].fret=1;e.setTechnique('hammer');const before=structuredClone(e.song);
    expect(()=>e.setFret(1)).toThrow(/equal to its origin/);
    e.typeDigit(1,0);expect(e.song).toEqual(before);e.typeDigit(2,20);
    expect(e.noteAtCursor()?.fret).toBe(12);expect(e.noteAtCursor()?.fx?.hammer).toBe(true);expect(bridge(e)[0].notes[0].hammerPullDestination?.fret).toBe(1);
    e.undo();expect(e.song).toEqual(before);
  });
  it('cancels an incomplete fret without editing, and resets input on load', () => {
    const e=riff();e.setFret(12);e.setHarmonic(HarmonicType.Natural);const before=structuredClone(e.song);
    e.typeDigit(1,0);e.cancelFretEntry();expect(e.fretDigits).toBe('');expect(e.song).toEqual(before);
    e.toggleChordEntry();e.typeDigit(1,0);e.load(before);expect(e.fretDigits).toBe('');
    e.typeDigit(9,20);expect(e.noteAtCursor()?.fret).toBe(9);
  });
  it('enters and moves four-string bass chords without assuming a six-string guitar', () => {
    const e=riff('bass');e.beat.notes=[];e.toggleChordEntry();
    for(const fret of [12,10,7,5]) {for(const digit of String(fret))e.typeDigit(Number(digit),0);e.advanceChordString();}
    expect(e.cursor.string).toBe(3);expect(e.beat.notes.map(n=>n.fret)).toEqual([12,10,7,5]);
    e.undo();expect(e.beat.notes).toEqual([]);e.redo();e.transformFrets(1);
    expect(e.beat.notes.map(n=>n.fret)).toEqual([13,11,8,6]);
  });
  it('clears the entire chord with effects in one reversible edit', () => {
    const e=riff(); e.setTechnique('palmMute'); e.beat.notes.push({string:1,fret:12,velocity:95}); const b=structuredClone(e.beat);
    e.clearBeat(); expect(e.beat.notes).toEqual([]);e.undo();expect(e.beat).toEqual(b);
  });
});

const privateFiles=fs.readdirSync(path.join(root,'gp5-examples')).filter(n=>/\.gp[345]$/i.test(n)).map(n=>'gp5-examples/'+n);
describe('GP technique preservation', () => {
  it.each(['fixtures/fixture.gp3','fixtures/fixture.gp4','fixtures/fixture.gp5',...privateFiles])('preserves imported effects through the model and native reload: %s', file => {
    const raw=at.importer.ScoreLoader.loadScoreFromBytes(fixture(file),new at.Settings()); const song=loadGpBytes(fixture(file));
    const saved:Song=parseProject(serializeProject(song)); expect(saved).toEqual(song);
    raw.tracks.forEach((t,ti)=>t.staves[0].bars.forEach((b,bi)=>b.voices.forEach((v,vi)=>v.beats.forEach((bt,bti)=>bt.notes.forEach((n,ni)=>{
      const note=saved.tracks[ti].measures[bi].voices[vi]?.[bti]?.notes[ni]; expect(note).toBeDefined();
      if(n.isHammerPullOrigin)expect(note.fx?.hammer).toBe(true); if(n.isPalmMute)expect(note.fx?.palmMute).toBe(true); if(n.isLetRing)expect(note.fx?.letRing).toBe(true);
      if(n.harmonicType)expect(note.fx?.harmonic).toEqual({type:n.harmonicType,value:n.harmonicValue});
      if(n.slideOutType)expect(note.fx?.slide).toBe(n.slideOutType); if(n.slideInType)expect(note.fx?.slideIn).toBe(n.slideInType);
      if(n.vibrato)expect(note.fx?.vibrato).toBe(n.vibrato===at.model.VibratoType.Wide?'wide':true);
      if(n.hasBend)expect(note.fx?.bend).toEqual(n.bendPoints!.map(p=>({offset:p.offset,value:p.value})));
    })))));
  });
});
