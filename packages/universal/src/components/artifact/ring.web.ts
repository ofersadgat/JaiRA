/**
 * How wide Chromium lays a 1px border out here — whole device pixels, so 0.667 at 1.5× — read off a
 * probe once, since `devicePixelRatio` does not always say the scale the page is drawn at (the studio's
 * window reports 2 and draws at 1.5). A size a box takes from its content plus its ring (an
 * `img` at its natural size) is the content plus two of these. A phone's is `ring.ts`.
 */
let measured: number | undefined;

export function ringWidth(): number {
  if (measured !== undefined) return measured;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;border:1px solid transparent";
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).borderTopWidth);
  probe.remove();
  measured = Number.isFinite(px) && px > 0 ? px : 1;
  return measured;
}
