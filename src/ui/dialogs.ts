// Small modal forms built on <dialog>. Enter = OK, Esc = cancel.
import { createTrack, DEFAULT_PROGRAMS, type Track, type TrackType, type NoteEffects } from '../model/song';
import { GM_PROGRAMS } from '../model/gm';
import { TUNING_PRESETS, presetsFor, resizeTuning, stringCounts } from '../model/tunings';
import type { ProgressiveSettings } from '../playback/practice';
export { TUNING_PRESETS };

type Field =
  | { name: string; label: string; type: 'text'; value: string }
  | { name: string; label: string; type: 'number'; value: number; min?: number; max?: number; step?: number | 'any' }
  | { name: string; label: string; type: 'select'; value: string; options: [string, string][] };

function form(title: string, fields: Field[], onInput?: (f: HTMLFormElement, target?: HTMLElement) => void): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    const rows = fields
      .map((f) => {
        const id = 'f-' + f.name;
        if (f.type === 'select')
          return `<label>${f.label}<select id="${id}" name="${f.name}">${f.options.map(([v, l]) => `<option value="${v}"${v === f.value ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
        const extra = f.type === 'number' ? ` min="${f.min ?? ''}" max="${f.max ?? ''}" step="${f.step ?? 1}" style="width:70px"` : ' style="width:200px"';
        return `<label>${f.label}<input id="${id}" name="${f.name}" type="${f.type}" value="${String(f.value).replace(/"/g, '&quot;')}"${extra}></label>`;
      })
      .join('');
    dlg.innerHTML = `<form method="dialog"><h3></h3>${rows}<div class="buttons"><button value="ok" type="submit">OK</button><button value="cancel" type="button">Cancel</button></div></form>`;
    dlg.querySelector('h3')!.textContent = title;
    const f = dlg.querySelector('form')!;
    f.querySelector<HTMLButtonElement>('button[value=cancel]')!.onclick = () => dlg.close('cancel');
    if (onInput) {
      onInput(f);
      f.addEventListener('input', e => onInput(f, e.target as HTMLElement));
    }
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

export async function bendDialog(fx?: NoteEffects) {
  const existing = fx?.bend;
  const r = await form('Bend', [
    { name: 'amount', label: 'Amount', type: 'select', value: existing ? 'keep' : '4', options: [
      ...(existing ? [['keep', 'Keep current curve'] as [string,string]] : []),
      ['0','Remove bend'], ['1','Quarter step'], ['2','Half step'], ['4','Whole step'], ['6','1½ steps'],
    ] },
    { name: 'shape', label: 'Shape', type: 'select', value: existing?.at(-1)?.value === 0 ? 'release' : 'bend', options: [['bend','Bend and hold'],['release','Bend and release']] },
  ]);
  return r && r.amount !== 'keep' ? { amount: Number(r.amount), release: r.shape === 'release' } : null;
}
export async function slideDialog(fx?: NoteEffects) {
  const options: [string,string][] = [['0','None'],['1','Shift to next note'],['2','Legato to next note'],['3','Slide out up'],['4','Slide out down']];
  if (fx?.slide === 5 || fx?.slide === 6) options.push([String(fx.slide), 'Keep imported pick slide']);
  const r = await form('Slide', [
    { name: 'slide', label: 'Slide out', type: 'select', value: String(fx?.slide ?? 0), options },
    { name: 'slideIn', label: 'Slide in', type: 'select', value: String(fx?.slideIn ?? 0), options: [['0','None'],['1','From below'],['2','From above']] },
  ]);
  return r ? { out: Number(r.slide), into: Number(r.slideIn) } : null;
}
export async function harmonicDialog(fx?: NoteEffects) {
  const options: [string,string][] = [['0','None'],['1','Natural (touch fret on tab)'],['2','Artificial'],['3','Pinch']];
  if (fx?.harmonic && fx.harmonic.type > 3) options.push([String(fx.harmonic.type), 'Keep imported harmonic type']);
  const r = await form('Harmonic', [
    { name: 'harmonic', label: 'Type', type: 'select', value: String(fx?.harmonic?.type ?? 1), options },
    { name: 'node', label: 'Touch node above fretted note (non-natural)', type: 'number', value: fx?.harmonic?.value ?? 12, min: 0.1, max: 24, step:'any' },
  ]);
  return r ? { type: Number(r.harmonic), value: Number(r.node) } : null;
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

export async function practiceDialog(settings: ProgressiveSettings, max: number, metronome: boolean, countIn: 0 | 1 | 2) {
  const r = await form('Practice bars', [
    { name: 'firstBar', label: 'First bar', type: 'number', value: settings.firstBar, min: 1, max },
    { name: 'lastBar', label: 'Last bar (included)', type: 'number', value: settings.lastBar, min: 1, max },
    { name: 'startSpeed', label: 'Starting speed (%)', type: 'number', value: settings.startSpeed, min: 25, max: 200, step: 0.01 },
    { name: 'increment', label: 'Increase per pass (percentage points)', type: 'number', value: settings.increment, min: 0.01, max: 175, step: 0.01 },
    { name: 'targetSpeed', label: 'Target speed (%)', type: 'number', value: settings.targetSpeed, min: 25, max: 200, step: 0.01 },
    { name: 'metronome', label: 'Click track', type: 'select', value: metronome ? '1' : '0', options: [['0', 'Off'], ['1', 'On']] },
    { name: 'countIn', label: 'Count-in before every pass', type: 'select', value: String(countIn), options: [['0', 'Off'], ['1', '1 bar'], ['2', '2 bars']] },
  ], f => {
    const input = (name: string) => f.elements.namedItem(name) as HTMLInputElement;
    f.querySelectorAll('input').forEach(el => el.required = true);
    input('lastBar').setCustomValidity(Number(input('lastBar').value) < Number(input('firstBar').value) ? 'Last bar must be at or after the first bar.' : '');
    input('targetSpeed').setCustomValidity(Number(input('targetSpeed').value) < Number(input('startSpeed').value) ? 'Target speed must be at or above the starting speed.' : '');
    if (!f.querySelector('.practice-help')) {
      const help = document.createElement('p'); help.className = 'practice-help';
      help.textContent = 'For example: 50% → 55% → 60%. Looping continues at the target speed. Stop resets the speed; Pause keeps your progress.';
      f.querySelector('.buttons')!.before(help);
      f.querySelector('button[value=ok]')!.textContent = 'Start practice';
    }
  });
  return r ? { settings: { firstBar: Number(r.firstBar), lastBar: Number(r.lastBar), startSpeed: Number(r.startSpeed), increment: Number(r.increment), targetSpeed: Number(r.targetSpeed) }, metronome: r.metronome === '1', countIn: Number(r.countIn) as 0 | 1 | 2 } : null;
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
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(s.trim());
  if (!m) return null;
  let pc = NAMES.indexOf(m[1].toUpperCase());
  if (m[2] === '#') pc++;
  if (m[2] === 'b') pc--;
  const pitch = (Number(m[3]) + 1) * 12 + pc;
  return Number.isInteger(pitch) && pitch >= 0 && pitch <= 127 ? pitch : null;
}
export const formatTuning = (t: number[]) => t.map(pitchName).join(' ');
export function parseTuning(s: string): number[] | null {
  const parts = s.trim().split(/[\s,]+/).filter(Boolean);
  const out = parts.map(parsePitch);
  return out.length >= 1 && out.length <= 8 && out.every((p) => p !== null) ? (out as number[]) : null;
}


export async function trackDialog(t: Track) {
  const fields: Field[] = [
    { name: 'name', label: 'Name', type: 'text', value: t.name },
    { name: 'type', label: 'Track type', type: 'select', value: t.type, options: TYPES },
  ];
  fields.push({ name: 'program', label: 'Instrument (GM)', type: 'select', value: String(t.program), options: GM_PROGRAMS.map((n, i) => [String(i), `${i} ${n}`]) });
  fields.push({ name: 'strings', label: 'Strings', type: 'select', value: String(t.tuning.length), options: [] });
  fields.push({ name: 'preset', label: 'Tuning preset', type: 'select', value: '', options: [] });
  fields.push({ name: 'tuning', label: 'Open notes (top → bottom)', type: 'text', value: formatTuning(t.tuning) });
  fields.push({ name: 'capo', label: 'Capo', type: 'number', value: t.capo, min: 0, max: 24 });
  fields.push({ name: 'volume', label: 'Volume (0-16)', type: 'number', value: t.volume, min: 0, max: 16 });
  fields.push({ name: 'pan', label: 'Pan (0-16, 8 = centre)', type: 'number', value: t.pan, min: 0, max: 16 });
  let type = t.type, tuning = [...t.tuning];
  const drafts = new Map<TrackType, number[]>([[t.type, tuning]]);
  let rows: HTMLElement;
  let notice: HTMLElement;
  const r = await form('Track properties', fields, (f, target) => {
    const count = f.elements.namedItem('strings') as HTMLSelectElement;
    const preset = f.elements.namedItem('preset') as HTMLSelectElement;
    const text = f.elements.namedItem('tuning') as HTMLInputElement;
    const show = (name: string, visible: boolean) => {
      const el = f.elements.namedItem(name) as HTMLInputElement;
      el.disabled = !visible;
      el.closest('label')!.hidden = !visible;
    };
    if (!rows) {
      rows = document.createElement('div'); rows.className = 'tuning-strings';
      notice = document.createElement('p'); notice.className = 'tuning-help';
      text.closest('label')!.after(rows, notice);
    }
    if (target?.id === 'f-type') {
      drafts.set(type, [...tuning]);
      const next = (target as HTMLSelectElement).value as TrackType;
      if (type === 'drums' && next !== 'drums') (f.elements.namedItem('program') as HTMLSelectElement).value = String(DEFAULT_PROGRAMS[next]);
      type = next;
      tuning = [...(drafts.get(type) ?? createTrack(type, 0).tuning)];
    } else if (target?.id === 'f-strings') {
      if (tuning.length) drafts.set(type, [...tuning]);
      tuning = resizeTuning(type, tuning.length ? tuning : drafts.get(type) ?? [], Number(count.value));
    } else if (target?.id === 'f-preset' && preset.value) {
      tuning = [...TUNING_PRESETS[preset.value]];
    } else if (target?.dataset.string !== undefined) {
      tuning[Number(target.dataset.string)] = Number((target as HTMLSelectElement).value);
    } else if (target?.id === 'f-tuning') {
      const parsed = parseTuning(text.value);
      const allowed = parsed && (stringCounts(type).includes(parsed.length) || type === t.type && parsed.length === t.tuning.length);
      text.setCustomValidity(allowed ? '' : `Choose ${stringCounts(type).filter(n => n > 0).join(', ')} open notes from C-1 to G9 (for example E4 or Bb2).`);
      if (!allowed) return;
      tuning = parsed;
    } else if (target) return;
    const counts = stringCounts(type);
    if (tuning.length && !counts.includes(tuning.length)) counts.push(tuning.length); // retain unusual imported instruments
    count.replaceChildren(...counts.map(n => new Option(n ? `${n} strings` : 'Standard notation (no strings)', String(n))));
    count.value = String(tuning.length);
    preset.replaceChildren(new Option('Custom', ''), ...presetsFor(type).map(n => new Option(n, n)));
    preset.value = presetsFor(type).find(n => TUNING_PRESETS[n].join() === tuning.join()) ?? '';
    text.value = formatTuning(tuning); text.setCustomValidity('');
    show('program', type !== 'drums'); show('strings', type !== 'drums');
    show('preset', tuning.length > 0); show('tuning', tuning.length > 0); show('capo', tuning.length > 0);
    rows.hidden = tuning.length === 0;
    // Preserve focus while editing a single string; other changes rebuild the string list.
    if (target?.dataset.string === undefined) rows.replaceChildren(...tuning.map((pitch, string) => {
      const label = document.createElement('label'); label.textContent = `String ${string + 1}${string === 0 ? ' (top)' : ''}`;
      const select = document.createElement('select'); select.id = `f-string-${string}`; select.dataset.string = String(string);
      select.setAttribute('aria-label', `String ${string + 1} open note`);
      select.replaceChildren(...Array.from({ length: 128 }, (_, p) => new Option(pitchName(p), String(p))));
      select.value = String(pitch); label.appendChild(select); return label;
    }));
    const removed = type === t.type && tuning.length && t.tuning.length > tuning.length ? t.measures.flatMap(m => m.voices.flatMap(v => v.flatMap(b => b.notes))).filter(n => n.string !== undefined && n.string >= tuning.length).length : 0;
    notice.textContent = removed ? `${removed} note${removed === 1 ? '' : 's'} on removed strings will be removed. Undo restores them.` : tuning.length ? 'Each open note includes its octave. Strings may repeat notes or use any pitch order.' : '';
    notice.hidden = !notice.textContent;
  });
  if (!r) return null;
  const out: Partial<Track> = { name: r.name || t.name, volume: clamp(Number(r.volume), 0, 16, t.volume), pan: clamp(Number(r.pan), 0, 16, t.pan) };
  if (r.program !== undefined) out.program = clamp(Number(r.program), 0, 127, t.program);
  out.tuning = [...tuning];
  out.capo = tuning.length ? clamp(Number(r.capo), 0, 24, t.capo) : 0;
  return { type: r.type as TrackType, props: out };
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
