/**
 * The font size of a large figure in a field: the display size while the figure fits, then
 * smaller as it grows, down to a floor (after which an input scrolls and a readout truncates).
 * `100cqi` is the width of the box the figure sits in, so that box must be a container
 * (`@container`); the 1.75rem is the figure's side padding, and a mono digit is 0.6em wide.
 */
export function fitFigure(chars: number): string {
  return `clamp(1.125rem, calc((100cqi - 1.75rem) / ${(Math.max(chars, 4) * 0.6).toFixed(1)}), 2rem)`
}
