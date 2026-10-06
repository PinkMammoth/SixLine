import { it, expect } from 'vitest';
import { GM_PROGRAMS } from '../src/model/gm';
it('gm', () => { expect(GM_PROGRAMS).toHaveLength(128); expect(GM_PROGRAMS[29]).toBe('Overdriven Guitar'); expect(GM_PROGRAMS[33]).toBe('Fingered Bass'); expect(GM_PROGRAMS[127]).toBe('Gunshot'); });
