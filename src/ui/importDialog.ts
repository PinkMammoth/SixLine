// MIDI import: one compact table to confirm track mapping, then a short report of adjustments.
import type { RawMidi, TrackPlan } from '../io/midiImport';
import type { TrackType } from '../model/song';
import { GM_PROGRAMS } from '../model/gm';
import { formatTuning, TUNING_PRESETS } from './dialogs';

const TYPES: [TrackType, string][] = [
  ['guitar', 'Guitar (tab)'],
  ['bass', 'Bass (tab)'],
  ['keys', 'Keys / notation'],
  ['drums', 'Drums'],
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function importDialog(fileName: string, raw: RawMidi, plans: TrackPlan[]): Promise<TrackPlan[] | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'import';
    const presetFor = (t: number[]) => Object.entries(TUNING_PRESETS).find(([, v]) => v.join() === t.join())?.[0] ?? '';
    const rows = raw.tracks
      .map((t, i) => {
        const p = plans[i];
        const range = t.notes.length ? `${Math.min(...t.notes.map((n) => n.pitch))}–${Math.max(...t.notes.map((n) => n.pitch))}` : '';
        return `<tr data-i="${i}">
          <td><input type="checkbox" class="inc" ${p.include ? 'checked' : ''}></td>
          <td><input type="text" class="name" value="${esc(p.name)}"></td>
          <td>${t.channel + 1}</td>
          <td>${t.channel === 9 ? 'Percussion' : `${t.program} ${GM_PROGRAMS[t.program] ?? ''}`}</td>
          <td>${t.notes.length}</td>
          <td title="lowest–highest MIDI pitch">${range}</td>
          <td><select class="type">${TYPES.map(([v, l]) => `<option value="${v}" ${v === p.type ? 'selected' : ''}>${l}</option>`).join('')}</select></td>
          <td><select class="tuning">${Object.keys(TUNING_PRESETS).map((k) => `<option ${k === presetFor(p.tuning) ? 'selected' : ''}>${k}</option>`).join('')}</select></td>
        </tr>`;
      })
      .join('');
    dlg.innerHTML = `<form method="dialog"><h3></h3>
      <table class="map"><tr><th></th><th>Track</th><th>Ch</th><th>MIDI program</th><th>Notes</th><th>Range</th><th>Import as</th><th>Tuning</th></tr>${rows}</table>
      <div class="buttons"><button value="ok" type="submit">Import</button><button value="cancel" type="button">Cancel</button></div></form>`;
    dlg.querySelector('h3')!.textContent = `Import MIDI: ${fileName}`;
    const sync = (tr: HTMLTableRowElement) => {
      const type = tr.querySelector<HTMLSelectElement>('.type')!.value;
      const tun = tr.querySelector<HTMLSelectElement>('.tuning')!;
      tun.disabled = type !== 'guitar' && type !== 'bass';
      if (!tun.disabled && !TUNING_PRESETS[tun.value]?.length) tun.value = type === 'bass' ? 'Bass 4-string' : 'Guitar standard';
      if (type === 'bass' && !tun.value.startsWith('Bass')) tun.value = 'Bass 4-string';
      if (type === 'guitar' && tun.value.startsWith('Bass')) tun.value = 'Guitar standard';
    };
    dlg.querySelectorAll<HTMLTableRowElement>('tr[data-i]').forEach((tr) => {
      sync(tr);
      tr.querySelector('.type')!.addEventListener('change', () => sync(tr));
    });
    dlg.querySelector<HTMLButtonElement>('button[value=cancel]')!.onclick = () => dlg.close('cancel');
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      const out = ok
        ? plans.map((p, i) => {
            const tr = dlg.querySelector<HTMLTableRowElement>(`tr[data-i="${i}"]`)!;
            const type = tr.querySelector<HTMLSelectElement>('.type')!.value as TrackType;
            const tuning = type === 'guitar' || type === 'bass' ? [...TUNING_PRESETS[tr.querySelector<HTMLSelectElement>('.tuning')!.value]] : [];
            return { include: tr.querySelector<HTMLInputElement>('.inc')!.checked, type, name: tr.querySelector<HTMLInputElement>('.name')!.value || p.name, tuning };
          })
        : null;
      dlg.remove();
      resolve(out && out.some((p) => p.include) ? out : null);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector<HTMLButtonElement>('button[value=ok]')!.focus();
  });
}

export function reportDialog(title: string, lines: string[]): Promise<void> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'report';
    dlg.innerHTML = `<form method="dialog"><h3></h3><ul></ul><div class="buttons"><button value="ok" type="submit">OK</button></div></form>`;
    dlg.querySelector('h3')!.textContent = title;
    const ul = dlg.querySelector('ul')!;
    for (const l of lines.length ? lines : ['Imported exactly: no timing, length or pitch adjustments were needed.']) {
      const li = document.createElement('li');
      li.textContent = l;
      ul.appendChild(li);
    }
    dlg.addEventListener('close', () => {
      dlg.remove();
      resolve();
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector('button')!.focus();
  });
}

export { formatTuning };
