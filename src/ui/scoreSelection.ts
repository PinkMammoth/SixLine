import type { Cursor, Editor } from '../editor/editor';
import type { Position, Selection } from '../editor/selection';

/** Anchor and granularity stay fixed throughout a drag, including reversing across score rows. */
export class ScoreDrag {
  private moved = false;
  get active() { return this.moved; }
  constructor(public anchor: Position, public kind: Selection['kind'], public rows: number[] | undefined, private x: number, private y: number) {}
  update(x: number, y: number, position: Position) {
    this.moved ||= Math.hypot(x - this.x, y - this.y) >= 4;
    return this.moved ? { anchor: { ...this.anchor }, focus: { bar: position.bar, beat: position.beat }, kind: this.kind, rows: this.rows?.slice() } : null;
  }
}

/** Speed is pixels/second, independent of animation frame rate. */
export function edgeScroll(client: number, start: number, end: number) {
  const edge = 36;
  if (client < start + edge) return -Math.min(700, Math.max(0, start + edge - client) / edge * 700);
  if (client > end - edge) return Math.min(700, Math.max(0, client - end + edge) / edge * 700);
  return 0;
}

interface Options {
  surface: HTMLElement;
  scroller: HTMLElement;
  getEditor: () => Editor;
  hitTest: (x: number, y: number, nearest: boolean, lockedTrack?: number) => Cursor | null;
  choosePlayback: () => void;
  finished: () => void;
}

/** Shared pointer capture/selection for notation/tab and the numbered drum score. */
export function bindScoreSelection({surface,scroller,getEditor,hitTest,choosePlayback,finished}: Options) {
  let gesture: { pointer: number; editor: Editor; track: number; drag: ScoreDrag; x: number; y: number } | null = null;
  let frame = 0, lastTime = 0;
  function update() {
    const g = gesture;
    if (!g) return;
    if (getEditor() !== g.editor || g.editor.cursor.track !== g.track) { cancel(); return; }
    const hit = hitTest(g.x,g.y,true,g.track);
    if (!hit) return;
    const range = g.drag.update(g.x,g.y,hit);
    if (!range) return;
    const previous = g.editor.selection;
    if (previous?.kind === range.kind && previous.focus.bar === range.focus.bar && previous.focus.beat === range.focus.beat &&
      previous.anchor.bar === range.anchor.bar && previous.anchor.beat === range.anchor.beat) return;
    g.editor.selection = {track:g.track,...range};
    choosePlayback();
    g.editor.setCursor(hit,true,range.kind);
  }
  function scroll(time: number) {
    if (!gesture) return;
    const r = scroller.getBoundingClientRect();
    const dt = Math.min(40, time - lastTime) / 1000; lastTime = time;
    const y = edgeScroll(gesture.y,r.top,r.bottom), x = edgeScroll(gesture.x,r.left,r.right);
    if (gesture.drag.active && (y || x)) {
      const beforeY = scroller.scrollTop, beforeX = scroller.scrollLeft;
      scroller.scrollTop += y * dt; scroller.scrollLeft += x * dt;
      if (scroller.scrollTop !== beforeY || scroller.scrollLeft !== beforeX) update();
    }
    frame = requestAnimationFrame(scroll);
  }
  function cancel() {
    const g = gesture;
    gesture = null;
    cancelAnimationFrame(frame);
    surface.classList.remove('selecting');
    if (g && surface.hasPointerCapture(g.pointer)) surface.releasePointerCapture(g.pointer);
    if (g) finished();
  }
  surface.addEventListener('pointerdown', ev => {
    if (ev.button !== 0 || !ev.isPrimary) return;
    const hit = hitTest(ev.clientX,ev.clientY,false);
    if (!hit) return;
    cancel(); ev.preventDefault();
    // Drop input focus (tempo/speed/etc.) so shortcuts immediately address the score.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const editor = getEditor(), previous = editor.selection;
    const modifier = ev.ctrlKey || ev.metaKey;
    const extend = ev.shiftKey && hit.track === editor.cursor.track;
    const anchor = extend ? previous?.anchor ?? {bar:editor.cursor.bar,beat:editor.cursor.beat} : hit;
    const kind = extend ? previous?.kind ?? 'beats' : ev.shiftKey || modifier ? 'beats' : 'measures';
    gesture = {pointer:ev.pointerId,editor,track:hit.track,drag:new ScoreDrag(anchor,kind,extend ? previous?.rows : undefined,ev.clientX,ev.clientY),x:ev.clientX,y:ev.clientY};
    surface.setPointerCapture(ev.pointerId);
    choosePlayback();
    editor.setCursor(hit,extend,extend ? previous?.kind ?? 'beats' : 'beats');
    if (modifier) {
      editor.toggleSelectionRow(editor.track.type === 'guitar' || editor.track.type === 'bass' ? hit.string : editor.rowPitch(),previous);
      gesture.drag.rows = editor.selection?.rows;
      gesture.drag.anchor = editor.selection?.anchor ?? anchor;
    }
    lastTime = performance.now(); frame = requestAnimationFrame(scroll);
  });
  surface.addEventListener('pointermove', ev => {
    if (!gesture || ev.pointerId !== gesture.pointer) return;
    gesture.x = ev.clientX; gesture.y = ev.clientY;
    update();
    if (gesture?.editor.selection) surface.classList.add('selecting');
  });
  surface.addEventListener('pointerup', ev => {
    if (!gesture || ev.pointerId !== gesture.pointer) return;
    gesture.x = ev.clientX; gesture.y = ev.clientY; update(); cancel();
  });
  surface.addEventListener('pointercancel', cancel);
  surface.addEventListener('lostpointercapture', cancel);
  window.addEventListener('blur', cancel);
  window.addEventListener('keydown', ev => { if (ev.key === 'Escape') cancel(); });
  return { get active() { return gesture !== null; }, cancel };
}
