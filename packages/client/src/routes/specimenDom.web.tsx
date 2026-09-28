import { useLayoutEffect } from "react";
import "@jaira/ui/styles.css";
import { specimenOf, lookOf } from "../specimens/registry";

/**
 * `/specimen-dom?name=…&look=…`: one DOM component from the renderer, drawn from a fixture with the
 * desktop's stylesheet, in a box of the specimen's width (`#specimen`). `pair.mts --specimen` photographs
 * it against `/specimen-rn`, the universal copy drawn from the same fixture on the native path — the
 * fidelity gate for a leaf, without a world to seed or a scene to reach (decision 0015).
 */
export default function SpecimenDom() {
  const q = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
  const specimen = specimenOf(q.get("name"));
  const look = lookOf(q.get("look"));
  // After the commit, not during render: the layout's <html> is React's, and its commit would undo it.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset["theme"] = look.scheme;
    if (look.palette === "classic") delete root.dataset["palette"];
    else root.dataset["palette"] = look.palette;
    if (look.wash) root.dataset["wash"] = "on";
    else delete root.dataset["wash"];
  }, [look.scheme, look.palette, look.wash]);
  if (specimen === undefined) return <p>No specimen by that name.</p>;
  const Dom = specimen.dom;
  return (
    <div id="root">
      <div id="specimen" style={{ width: specimen.width, padding: 12, background: "var(--bg)", color: "var(--text)" }}>
        <Dom />
      </div>
    </div>
  );
}
