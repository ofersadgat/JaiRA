/**
 * One press of a size stepper (`SizeStep`, `packages/universal/src/components/settings/fields.tsx`):
 * rounded to the step, so a value typed into the box, or arrived at from an older default, joins the
 * grid on the first press instead of carrying its offset forever — and kept inside the limits.
 */
export function steppedSize(value: number, direction: number, by: number, limits: { min: number; max: number }): number {
  const next = Math.round((value + direction * by) / by) * by;
  return Math.min(limits.max, Math.max(limits.min, Number(next.toFixed(2))));
}
