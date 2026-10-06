// Compact drum-entry grid for the current bar: rows = kit pieces, columns = beats.
// Purely a view over normal beats/notes; clicks go through the editor commands.
import type { Editor } from '../editor/editor';
import { DRUM_KIT, drumName } from '../model/drums';

export function renderDrumGrid(el: HTMLElement, editor: Editor) {
  const t = editor.track;
  if (t.type !== 'drums') {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const beats = editor.beats;
  const c = editor.cursor;
  const used = new Set(beats.flatMap((b) => b.notes.map((n) => n.pitch!)));
  // shortcut rows, rows used in this bar and the cursor row; plus pitches outside the kit list
  const rows = DRUM_KIT.map((d, i) => ({ ...d, row: i as number | null })).filter((d) => d.shortcut || used.has(d.key) || d.row === c.string);
  for (const p of used) if (!DRUM_KIT.some((d) => d.key === p)) rows.push({ key: p, name: drumName(p), row: null });
  const dur = (b: (typeof beats)[number]) => `1/${b.duration}${'.'.repeat(b.dots)}${b.tuplet ? '³' : ''}`;
  let html = `<table><tr><th>Bar ${c.bar + 1}</th>${beats.map((b, i) => `<th class="${i === c.beat ? 'cur' : ''}">${dur(b)}</th>`).join('')}</tr>`;
  for (const r of rows) {
    const curRow = r.row === c.string;
    html += `<tr class="${curRow ? 'cur' : ''}"><th title="GM ${r.key}">${r.name}${r.shortcut ? ` <kbd>${r.shortcut.toUpperCase()}</kbd>` : ''}</th>`;
    beats.forEach((b, i) => {
      const on = b.notes.some((n) => n.pitch === r.key);
      html += `<td data-beat="${i}" data-key="${r.key}" class="${on ? 'on' : ''}${curRow && i === c.beat ? ' caret' : ''}${i === c.beat ? ' col' : ''}"></td>`;
    });
    html += '</tr>';
  }
  el.innerHTML = html + '</table>';
}

/** `getEditor` returns the active document's editor (it changes when switching tabs). */
export function bindDrumGrid(el: HTMLElement, getEditor: () => Editor) {
  el.addEventListener('mousedown', (e) => {
    const editor = getEditor();
    const td = (e.target as HTMLElement).closest('td');
    if (!td) return;
    e.preventDefault();
    editor.setCursor({ beat: Number(td.dataset.beat) });
    editor.togglePitch(Number(td.dataset.key));
  });
}
