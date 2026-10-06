// Computes the on-screen edit caret rectangle from alphaTab's layout bounds.
import type * as at from '@coderline/alphatab';
import { isStringed, type Track } from '../model/song';

export interface CaretBox {
  x: number;
  y: number;
  w: number;
  h: number;
  /** true when the box marks a single tab line (string); false = whole beat column. */
  row: boolean;
}

/**
 * alphaTab reports one BeatBounds per staff renderer (standard notation, then tablature).
 * The tab renderer's bar visualBounds spans exactly from the top to the bottom tab line,
 * so string i sits at y + i * h / (strings - 1).
 */
export function locateCaret(lookup: at.rendering.BoundsLookup, beat: at.model.Beat, track: Track, string: number): CaretBox | null {
  const all = lookup.findBeats(beat);
  if (!all || !all.length) return null;
  const x = all[0].onNotesX - 9;
  const w = 18;
  if (isStringed(track) && track.tuning.length > 1) {
    const tab = all[all.length - 1].barBounds.visualBounds;
    const spacing = tab.h / (track.tuning.length - 1);
    const h = Math.max(10, spacing);
    return { x, y: tab.y + string * spacing - h / 2, w, h, row: true };
  }
  const top = all[0].barBounds.visualBounds;
  const bottom = all[all.length - 1].barBounds.visualBounds;
  return { x, y: top.y - 6, w, h: bottom.y + bottom.h - top.y + 12, row: false };
}
