// Small modal forms built on <dialog>. Enter = OK, Esc = cancel.
import { type Track, type TrackType } from '../model/song';
import { GM_PROGRAMS } from '../model/gm';
import { TUNING_PRESETS } from '../model/tunings';
export { TUNING_PRESETS };

type Field =
  | { name: string; label: string; type: 'text'; value: string }
  | { name: string; label: string; type: 'number'; value: number; min?: number; max?: number }
  | { name: string; label: string; type: 'select'; value: string; options: [string, string][] };

function form(title: string, fields: Field[], onInput?: (f: HTMLFormElement) => void): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    const rows = fields
      .map((f) => {
        const id = 'f-' + f.name;
        if (f.type === 'select')
          return `<label>${f.label}<select id="${id}" name="${f.name}">${f.options.map(([v, l]) => `<option value="${v}"${v === f.value ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
        const extra = f.type === 'number' ? ` min="${f.min ?? ''}" max="${f.max ?? ''}" style="width:70px"` : ' style="width:200px"';
        return `<label>${f.label}<input id="${id}" name="${f.name}" type="${f.type}" value="${String(f.value).replace(/"/g, '&quot;')}"${extra}></label>`;
      })
      .join('');
    dlg.innerHTML = `<form method="dialog"><h3></h3>${rows}<div class="buttons"><button value="ok" type="submit">OK</button><button value="cancel" type="button">Cancel</button></div></form>`;
    dlg.querySelector('h3')!.textContent = title;
    const f = dlg.querySelector('form')!;
    f.querySelector<HTMLButtonElement>('button[value=cancel]')!.onclick = () => dlg.close('cancel');
    if (onInput) f.addEventListener('input', () => onInput(f));
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'ok';
      const data = ok ? Object.fromEntries(new FormData(f).entries()) as Record<string, string> : null;
      dlg.remove();
      resolve(data);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    (f.querySelector('input,select') as HTMLElement | null)?.focus();
  });
}

const TYPES: [TrackType, string][] = [
  ['guitar', 'Guitar'],
  ['bass', 'Bass'],
  ['keys', 'Keys / Synth'],
  ['drums', 'Drums'],
];

export async function measureDialog(current: number, max: number) {
  const r = await form('Go to measure', [{ name: 'measure', label: 'Measure', type: 'number', value: current, min: 1, max }]);
  return r ? Number(r.measure) : null;
}

export async function markerDialog(current: string) {
  const r = await form(current ? 'Rename section marker' : 'Add section marker', [{ name: 'marker', label: 'Label', type: 'text', value: current }]);
  return r ? r.marker : null;
}

export async function newSongDialog() {
  const r = await form('New song', [
    { name: 'title', label: 'Title', type: 'text', value: 'Untitled' },
    { name: 'type', label: 'Instrument', type: 'select', value: 'guitar', options: TYPES },
    { name: 'tempo', label: 'Tempo (BPM)', type: 'number', value: 120, min: 20, max: 400 },
    { name: 'num', label: 'Beats per bar', type: 'number', value: 4, min: 1, max: 32 },
    { name: 'den', label: 'Beat unit', type: 'select', value: '4', options: [['2', '2'], ['4', '4'], ['8', '8'], ['16', '16']] },
    { name: 'bars', label: 'Bars', type: 'number', value: 8, min: 1, max: 999 },
  ]);
  if (!r) return null;
  return {
    title: r.title || 'Untitled',
    type: r.type as TrackType,
    tempo: clamp(Number(r.tempo), 20, 400, 120),
    num: clamp(Number(r.num), 1, 32, 4),
    den: Number(r.den),
    bars: clamp(Number(r.bars), 1, 999, 8),
  };
}

export async function timeSignatureDialog(num: number, den: number) {
  const r = await form('Time signature', [
    { name: 'num', label: 'Beats per bar', type: 'number', value: num, min: 1, max: 32 },
    { name: 'den', label: 'Beat unit', type: 'select', value: String(den), options: [['2', '2'], ['4', '4'], ['8', '8'], ['16', '16']] },
  ]);
  return r ? { num: clamp(Number(r.num), 1, 32, num), den: Number(r.den) } : null;
}

// ---------------------------------------------------------------- tuning helpers

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const pitchName = (p: number) => NAMES[p % 12] + (Math.floor(p / 12) - 1);
export function parsePitch(s: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(s.trim());
  if (!m) return null;
  let pc = NAMES.indexOf(m[1].toUpperCase());
  if (m[2] === '#') pc++;
  if (m[2] === 'b') pc--;
  return (Number(m[3]) + 1) * 12 + pc;
}
export const formatTuning = (t: number[]) => t.map(pitchName).join(' ');
export function parseTuning(s: string): number[] | null {
  const parts = s.trim().split(/[\s,]+/).filter(Boolean);
  const out = parts.map(parsePitch);
  return out.length >= 1 && out.length <= 10 && out.every((p) => p !== null) ? (out as number[]) : null;
}


export async function trackDialog(t: Track) {
  const stringed = t.type === 'guitar' || t.type === 'bass';
  const fields: Field[] = [
    { name: 'name', label: 'Name', type: 'text', value: t.name },
    { name: 'type', label: 'Track type', type: 'select', value: t.type, options: TYPES },
  ];
  if (t.type !== 'drums')
    fields.push({ name: 'program', label: 'Instrument (GM)', type: 'select', value: String(t.program), options: GM_PROGRAMS.map((n, i) => [String(i), `${i} ${n}`]) });
  if (stringed) {
    fields.push({ name: 'preset', label: 'Tuning preset', type: 'select', value: '', options: [['', '(custom)'], ...Object.keys(TUNING_PRESETS).map((k) => [k, k] as [string, string])] });
    fields.push({ name: 'tuning', label: 'Tuning (high → low)', type: 'text', value: formatTuning(t.tuning) });
    fields.push({ name: 'capo', label: 'Capo', type: 'number', value: t.capo, min: 0, max: 24 });
  }
  fields.push({ name: 'volume', label: 'Volume (0-16)', type: 'number', value: t.volume, min: 0, max: 16 });
  fields.push({ name: 'pan', label: 'Pan (0-16, 8 = centre)', type: 'number', value: t.pan, min: 0, max: 16 });
  const r = await form('Track properties', fields, (f) => {
    const preset = (f.elements.namedItem('preset') as HTMLSelectElement | null)?.value;
    if (preset && document.activeElement?.id === 'f-preset') (f.elements.namedItem('tuning') as HTMLInputElement).value = formatTuning(TUNING_PRESETS[preset]);
  });
  if (!r) return null;
  const type = r.type as TrackType;
  const out: Partial<Track> = { name: r.name || t.name, volume: clamp(Number(r.volume), 0, 16, t.volume), pan: clamp(Number(r.pan), 0, 16, t.pan) };
  if (r.program !== undefined) out.program = clamp(Number(r.program), 0, 127, t.program);
  if (stringed) {
    const tuning = parseTuning(r.tuning);
    if (tuning) out.tuning = tuning;
    out.capo = clamp(Number(r.capo), 0, 24, t.capo);
  }
  return { type, props: out };
}

function clamp(v: number, lo: number, hi: number, dflt: number) {
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : dflt;
}

/** Unsaved changes in a document that is about to close. */
export function unsavedDialog(name: string): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'unsaved';
    dlg.innerHTML = `<form method="dialog"><h3></h3><p>Save changes before closing?</p><div class="buttons">
      <button value="save" type="submit">Save</button><button value="discard" type="submit">Don't save</button><button value="cancel" type="submit">Cancel</button></div></form>`;
    dlg.querySelector('h3')!.textContent = name;
    dlg.addEventListener('close', () => {
      const v = dlg.returnValue;
      dlg.remove();
      resolve(v === 'save' || v === 'discard' ? v : 'cancel');
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.querySelector<HTMLButtonElement>('button[value=save]')!.focus();
  });
}
