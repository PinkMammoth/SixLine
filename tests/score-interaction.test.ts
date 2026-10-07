import {describe,expect,it} from 'vitest';
import {ScoreDrag,edgeScroll} from '../src/ui/scoreSelection';
import {TransportState,transportDestination} from '../src/playback/transport';
import {Editor} from '../src/editor/editor';
import {createSong} from '../src/model/song';
import {selectionRange} from '../src/editor/selection';

describe('score drag selection', () => {
  it('ignores click jitter, then retains its anchor when the drag reverses', () => {
    const drag=new ScoreDrag({bar:2,beat:1},'measures',undefined,100,100);
    expect(drag.update(102,101,{bar:2,beat:1})).toBeNull();
    expect(drag.update(120,100,{bar:4,beat:2})).toMatchObject({anchor:{bar:2,beat:1},focus:{bar:4,beat:2},kind:'measures'});
    expect(drag.update(80,200,{bar:0,beat:0})?.anchor).toEqual({bar:2,beat:1});
    expect(drag.active).toBe(true);
  });
  it.each(['guitar','bass','drums','keys'] as const)('copies complete bars selected by dragging on %s', type => {
    const e=new Editor(createSong({tracks:[type],bars:5}));
    e.track.measures.forEach((m,bar)=>{m.voices[0][0].notes=[type==='guitar'||type==='bass'?{string:0,fret:bar,velocity:95}:{pitch:type==='drums'?38:60+bar,velocity:95}];});
    const original=structuredClone(e.song);
    const drag=new ScoreDrag({bar:1,beat:0},'measures',undefined,0,0);
    e.selection={track:0,...drag.update(50,150,{bar:3,beat:0})!};e.setCursor({bar:3},true,'measures');
    expect(e.copy().measures).toEqual(e.track.measures.slice(1,4));
    expect(selectionRange(e.song,e.selection!)).toEqual({start:{bar:1,beat:0},end:{bar:3,beat:0}});
    expect(e.song).toEqual(original);expect(e.canUndo).toBe(false);
  });
  it('shift-drag preserves beat granularity and chosen rows without sharing mutable endpoints', () => {
    const anchor={bar:0,beat:2},rows=[0,2],drag=new ScoreDrag(anchor,'beats',rows,0,0);
    const first=drag.update(20,0,{bar:2,beat:1})!; first.anchor.bar=9;first.rows!.push(4);
    expect(drag.update(40,0,{bar:1,beat:2})).toEqual({anchor:{bar:0,beat:2},focus:{bar:1,beat:2},kind:'beats',rows:[0,2]});
  });
  it('scrolls proportionally near edges, clamps speed and leaves the centre still', () => {
    expect(edgeScroll(200,100,500)).toBe(0);
    expect(edgeScroll(100,100,500)).toBe(-700);expect(edgeScroll(500,100,500)).toBe(700);
    expect(edgeScroll(90,100,500)).toBe(-700);expect(edgeScroll(510,100,500)).toBe(700);
    expect(edgeScroll(118,100,500)).toBe(-350);expect(edgeScroll(482,100,500)).toBe(350);
  });
});

describe('playback start and bar navigation intent', () => {
  it('starts from the caret, resumes after pause and follows a subsequent stopped score click', () => {
    const p=new TransportState();expect(p.fromCaret).toBe(true);
    p.usePosition();expect(p.fromCaret).toBe(false);
    p.chooseCaret(true);expect(p.fromCaret).toBe(false);
    p.chooseCaret(false);expect(p.fromCaret).toBe(true);
    p.usePosition();p.stopped();expect(p.fromCaret).toBe(true);
  });
  it('an explicit slider/transport position wins over the editing caret', () => {
    const p=new TransportState();p.chooseCaret(false);p.usePosition();expect(p.fromCaret).toBe(false);
  });
  const bars=[{start:0,end:3840,masterBar:{index:0}},{start:3840,end:6720,masterBar:{index:1}},{start:6720,end:10560,masterBar:{index:2}},{start:10560,end:13440,masterBar:{index:1}}];
  it('moves exactly one playback bar through meter changes and repeat occurrences', () => {
    expect(transportDestination(bars,6000,1)).toEqual({bar:2,tick:6720,index:2});
    expect(transportDestination(bars,11000,-1)).toEqual({bar:2,tick:6720,index:2});
    expect(transportDestination(bars,7000,1)).toEqual({bar:1,tick:10560,index:3});
    expect(transportDestination(bars,11000,'first')).toEqual({bar:0,tick:0,index:0});
  });
  it('clamps both song ends and clearly rejects an unloaded timeline', () => {
    expect(transportDestination(bars,0,-1).tick).toBe(0);
    expect(transportDestination(bars,20000,1).tick).toBe(10560);
    expect(()=>transportDestination([],0,1)).toThrow(/loading/);
  });
});
