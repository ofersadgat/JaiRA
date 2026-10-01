import type { PanelStack } from "@jaira/ui/panelStack";

/**
 * The side panel's motion on web, as `styles.css` moves the desktop's (decision 0015):
 *
 *   .sp-motion-push      the body comes in from the right: 18px and from nothing, 200ms
 *   .sp-motion-pop       …from the left
 *   .sp-motion-replace   fades in, 160ms; .sp-motion-tab 120ms
 *   .view.pane-tween     the column's width eases to its new kind's, 220ms (`usePanelTween` says when)
 *   prefers-reduced-motion: reduce   none of it
 *
 * CSS animations, not `Animated`: they are the desktop's own curves, a still picture holds them (the
 * shots stop `animation` and `transition`), and the reader's reduced-motion setting is a media query. A
 * keyframe and a media query have no inline style, so the rules are written once into a `<style>` of
 * their own and a box is pointed at them by a `data-` attribute, as a scroller is at its scrollbar.
 */
const SHEET = "jaira-panel-motion";
const EASE = "cubic-bezier(0.2,0.7,0.2,1)";

function rules(): void {
  if (typeof document === "undefined" || document.getElementById(SHEET) !== null) return;
  const sheet = document.createElement("style");
  sheet.id = SHEET;
  sheet.textContent =
    `@keyframes jaira-sp-in-right{from{opacity:0;transform:translateX(18px)}}` +
    `@keyframes jaira-sp-in-left{from{opacity:0;transform:translateX(-18px)}}` +
    `@keyframes jaira-sp-fade{from{opacity:0}}` +
    `[data-spmotion="push"]{animation:jaira-sp-in-right 200ms ${EASE}}` +
    `[data-spmotion="pop"]{animation:jaira-sp-in-left 200ms ${EASE}}` +
    `[data-spmotion="replace"]{animation:jaira-sp-fade 160ms ease-out}` +
    `[data-spmotion="tab"]{animation:jaira-sp-fade 120ms ease-out}` +
    `[data-panetween]{transition:width 220ms ${EASE}}` +
    `@media (prefers-reduced-motion:reduce){[data-spmotion],[data-panetween]{animation:none;transition:none}}`;
  document.head.appendChild(sheet);
}

/** `sp-motion-${motion}` for the panel's body: the value of its `data-spmotion`. */
export function bodyMotion(motion: PanelStack["motion"]): string {
  rules();
  return motion;
}

/** `.pane-tween` for the panel's column, as props of the Tamagui `View` whose width it is. */
export function paneTween(on: boolean): Record<string, unknown> {
  rules();
  return on ? { "data-panetween": "" } : {};
}
