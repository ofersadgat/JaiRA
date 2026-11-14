/**
 * The composer stack panel's motion on web (2026-11-14, round 3: "instead of a UI swap, the UI should
 * transform from one form to the next"). One float, never swapped for another:
 *
 *   the float      its left, top, width and height ease to the new view's, 260ms — a list widening into
 *                  the rows, the contents unfolding beside a list, another segment pressed while open
 *   a column       its width eases with it
 *   what is in it  fades across, 220ms, coming up 3px — a new view in the same float
 *   the contents   unfolding: in from behind the list, 32px to the left and from nothing, 260ms;
 *                  another set's while unfolded: fades across
 *   the chevron    a row's › turns half round into ‹ while its contents are out
 *   opening        from 6px down and a little small, 180ms; nothing eases from where it was not
 *   prefers-reduced-motion: reduce   none of it
 *
 * CSS, not `Animated`, as the side panel's (`panelMotion.web.ts`): a still picture holds it, and the
 * reader's reduced-motion setting is a media query. The rules are written once into a `<style>` of
 * their own; a box is pointed at them by a `data-` attribute.
 */
const SHEET = "jaira-stack-motion";
const EASE = "cubic-bezier(0.2,0.75,0.2,1)";

function rules(): void {
  if (typeof document === "undefined" || document.getElementById(SHEET) !== null) return;
  const sheet = document.createElement("style");
  sheet.id = SHEET;
  sheet.textContent =
    `@keyframes jaira-stack-open{from{opacity:0;transform:translateY(6px) scale(0.98)}}` +
    `@keyframes jaira-stack-fade{from{opacity:0;transform:translateY(3px)}}` +
    `@keyframes jaira-stack-unfold{from{opacity:0;transform:translateX(-32px)}}` +
    `[data-stackmorph="on"]{transition:left 260ms ${EASE},top 260ms ${EASE},width 260ms ${EASE},height 260ms ${EASE}}` +
    `[data-stackmorph="opening"]{animation:jaira-stack-open 180ms ${EASE};transform-origin:bottom left}` +
    `[data-stackcol]{transition:width 260ms ${EASE}}` +
    `[data-stackfade]{animation:jaira-stack-fade 220ms ${EASE}}` +
    `[data-stackunfold]{animation:jaira-stack-unfold 260ms ${EASE}}` +
    `[data-stackturn]{transition:transform 260ms ${EASE}}` +
    `@media (prefers-reduced-motion:reduce){[data-stackmorph],[data-stackcol],[data-stackfade],[data-stackunfold],[data-stackturn]{animation:none;transition:none}}`;
  document.head.appendChild(sheet);
}

/** The float: still while it is first placed (`opening` plays its way in), easing every change after. */
export function morphMotion(phase: "opening" | "on"): Record<string, unknown> {
  rules();
  return { "data-stackmorph": phase };
}

/** A column whose width eases with the float's. */
export function columnMotion(): Record<string, unknown> {
  rules();
  return { "data-stackcol": "" };
}

/** What comes in: a new view fading across, or the contents unfolding from behind the list. */
export function arriveMotion(how: "fade" | "unfold"): Record<string, unknown> {
  rules();
  return how === "fade" ? { "data-stackfade": "" } : { "data-stackunfold": "" };
}

/** The › that turns into ‹. */
export function turnMotion(): Record<string, unknown> {
  rules();
  return { "data-stackturn": "" };
}
