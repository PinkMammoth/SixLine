// Alternative score presentation only. The canonical notes, alphaTab score, MIDI and player
// remain shared with notation; no fret/string conversion is involved.
import type { Editor } from '../editor/editor';
import type { Beat, MasterBar, Measure } from '../model/song';
import { barTicks, beatTicks, voiceTicks } from '../model/rhythm';
import { drumName } from '../model/drums';
import { selectionRange } from '../editor/selection';
import type { CaretBox } from './caret';

export function drumBarLayout(measure: Measure, meter: MasterBar) {
  const length = Math.max(barTicks(meter), ...measure.voices.map(voiceTicks));
  return measure.voices.map(voice => {
    let tick = 0;
    return voice.map(beat => {
      const slot = { start: tick, width: beatTicks(beat), length };
      tick += slot.width;
      return slot;
    });
  });
}

export function drumDuration(beat: Beat) {
  return `1/${beat.duration}${'.'.repeat(beat.dots)}${beat.tuplet ? ` ×${beat.tuplet[1]}/${beat.tuplet[0]}` : ''}${beat.grace ? ' grace' : ''}`;
}

export function renderDrumScore(el: HTMLElement, editor: Editor) {
  el.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = editor.song.title || editor.track.name;
  const help = document.createElement('p');
  help.className = 'drum-score-help';
  help.textContent = 'MIDI drums · 36 kick · 38 snare · 42 closed hat · 46 open hat · 49 crash · 51 ride · 56 cowbell';
  el.append(heading, help);
  const bars = document.createElement('div');
  bars.className = 'drum-bars';
  editor.track.measures.forEach((measure, bar) => {
    const meter = editor.song.masterBars[bar];
    const layout = drumBarLayout(measure, meter);
    const frame = document.createElement('section');
    frame.className = 'drum-bar';
    frame.dataset.bar = String(bar);
    // Leave each shortest beat enough room for a two-digit number and its duration.
    const shortest = Math.min(...layout.flat().map(s => s.width));
    frame.style.flexBasis = Math.max(220, layout[0][0].length / shortest * 34 + 16) + 'px';
    const label = document.createElement('div');
    label.className = 'drum-bar-label';
    label.textContent = `${bar + 1}   ${meter.num}/${meter.den}${meter.tempo ? ` · ♩ ${meter.tempo}` : ''}${meter.repeatStart ? ' · repeat start' : ''}${meter.repeatCount ? ` · repeat ×${meter.repeatCount}` : ''}${meter.altEndings ? ' · alternate ending' : ''}`;
    frame.appendChild(label);
    if (meter.marker) {
      const marker = document.createElement('strong');
      marker.className = 'drum-marker';
      marker.textContent = meter.marker;
      frame.appendChild(marker);
    }
    measure.voices.forEach((voice, vi) => {
      const lane = document.createElement('div');
      lane.className = 'drum-voice' + (vi ? ' secondary' : '');
      lane.dataset.voice = String(vi);
      if (vi) lane.title = `Voice ${vi + 1} (read only)`;
      const rows = Math.max(3, ...voice.map(b => b.notes.length));
      lane.style.setProperty('--drum-rows', String(rows));
      voice.forEach((beat, bi) => {
        const slot = layout[vi][bi];
        const cell = document.createElement('div');
        cell.className = 'drum-beat';
        cell.dataset.beat = String(bi);
        cell.dataset.bar = String(bar);
        cell.dataset.voice = String(vi);
        cell.style.width = `${100 * slot.width / slot.length}%`;
        cell.setAttribute('aria-label', `Measure ${bar + 1}, beat ${bi + 1}, ${drumDuration(beat)}`);
        const chord = document.createElement('div');
        chord.className = 'drum-chord';
        for (const note of [...beat.notes].sort((a, b) => b.pitch! - a.pitch!)) {
          const n = document.createElement('span');
          n.className = 'drum-number' + (note.fx?.ghost ? ' ghost' : '') + (note.fx?.accent ? ' accent' : '');
          n.dataset.pitch = String(note.pitch);
          n.textContent = `${note.tie ? '⌒' : ''}${note.pitch}`;
          n.title = `${note.pitch}: ${drumName(note.pitch!)} · velocity ${note.velocity}${note.fx ? ' · ' + Object.keys(note.fx).join(', ') : ''}${note.tie ? ' · tied' : ''}`;
          chord.appendChild(n);
        }
        if (!beat.notes.length) {
          const rest = document.createElement('span');
          rest.className = 'drum-rest';
          rest.textContent = '—';
          rest.title = 'Rest';
          chord.appendChild(rest);
        }
        const duration = document.createElement('small');
        duration.className = 'drum-duration';
        duration.textContent = drumDuration(beat);
        cell.append(chord, duration);
        lane.appendChild(cell);
      });
      frame.appendChild(lane);
    });
    bars.appendChild(frame);
  });
  el.appendChild(bars);
}

export function updateDrumSelection(el: HTMLElement, editor: Editor) {
  const s = editor.selection?.track === editor.cursor.track ? editor.selection : null;
  const range = s ? selectionRange(editor.song, s) : null;
  el.querySelectorAll<HTMLElement>('.drum-beat').forEach(cell => {
    const bar = Number(cell.dataset.bar), beat = Number(cell.dataset.beat);
    const selected = !!range && (s!.kind === 'measures' || cell.dataset.voice === '0') && bar >= range.start.bar && bar <= range.end.bar &&
      (s!.kind === 'measures' || (bar !== range.start.bar || beat >= range.start.beat) && (bar !== range.end.bar || beat <= range.end.beat));
    cell.classList.toggle('selected', selected && !s!.rows);
    cell.querySelectorAll<HTMLElement>('.drum-number').forEach(n => n.classList.toggle('selected', selected && !!s!.rows?.includes(Number(n.dataset.pitch))));
  });
}

export function drumCaret(el: HTMLElement, editor: Editor): CaretBox | null {
  const c = editor.cursor;
  const cell = el.querySelector<HTMLElement>(`.drum-beat[data-bar="${c.bar}"][data-beat="${c.beat}"][data-voice="0"]`);
  if (!cell) return null;
  const target = cell.querySelector<HTMLElement>(`.drum-number[data-pitch="${editor.rowPitch()}"]`) ?? cell;
  const r = target.getBoundingClientRect(), origin = el.parentElement!.getBoundingClientRect();
  return { x: r.left - origin.left - 2, y: r.top - origin.top - 2, w: r.width + 4, h: r.height + 4, row: target !== cell };
}

export function hitDrumScore(el: HTMLElement, editor: Editor, x: number, y: number, nearest: boolean) {
  const target = document.elementFromPoint(x,y) as HTMLElement | null;
  const cell = target?.closest<HTMLElement>('.drum-beat');
  if (cell && el.contains(cell) && cell.dataset.voice !== '0' && !nearest) return null;
  let chosen = cell?.dataset.voice === '0' && el.contains(cell) ? cell : null;
  if (!chosen) {
    const frame = target?.closest<HTMLElement>('.drum-bar');
    if (!nearest && (!frame || !el.contains(frame))) return null;
    let distance = Infinity;
    for (const beat of (frame && !nearest ? frame : el).querySelectorAll<HTMLElement>('.drum-beat[data-voice="0"]')) {
      const r = beat.getBoundingClientRect();
      const d = Math.hypot(Math.max(r.left-x,0,x-r.right),Math.max(r.top-y,0,y-r.bottom));
      if (d < distance) { chosen = beat; distance = d; }
    }
  }
  if (!chosen) return null;
  const note = target?.closest<HTMLElement>('[data-pitch]');
  return {track:editor.cursor.track,bar:Number(chosen.dataset.bar),beat:Number(chosen.dataset.beat),string:note && chosen.contains(note) ? editor.rowForPitch(Number(note.dataset.pitch)) : editor.cursor.string};
}
