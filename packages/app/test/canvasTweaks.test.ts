import { describe, expect, it } from "vitest";
import { tweakGroups, tweaksOf } from "../src/renderer/canvasTweaks";

describe("tweakGroups", () => {
  it("keeps only the props that ask for an editor, never $preview", () => {
    const groups = tweakGroups({
      $preview: { width: 400, height: 300 },
      onPick: { editor: null },
      dark: { editor: "boolean", default: false },
    });
    expect(groups).toEqual([{ section: undefined, levers: [{ name: "dark", editor: "boolean", value: false }] }]);
  });

  it("groups by section in the order the file first names each, the unsectioned first", () => {
    const groups = tweakGroups({
      accent: { editor: "color", default: "#c2410c", section: "4. Colour" },
      density: { editor: "enum", options: ["cozy", "compact"], default: "cozy", section: "1. Layout" },
      dark: { editor: "boolean", default: false },
      ink: { editor: "color", default: "#111111", section: "4. Colour" },
    });
    expect(groups.map((g) => [g.section, g.levers.map((l) => l.name)])).toEqual([
      [undefined, ["dark"]],
      ["4. Colour", ["accent", "ink"]],
      ["1. Layout", ["density"]],
    ]);
  });

  it("reads a colour's options as its swatches, leaving out what is not a colour", () => {
    const [group] = tweakGroups({ accent: { editor: "color", default: "#c2410c", options: ["#C2410C", " #0f766e ", "oklch(60% 0.1 250)", "teal", 7] } });
    expect(group!.levers[0]!.swatches).toEqual(["#C2410C", "#0f766e", "oklch(60% 0.1 250)"]);
  });

  it("gives no swatches to a colour without options, nor to an enum", () => {
    const [group] = tweakGroups({ a: { editor: "color", default: "#fff" }, b: { editor: "enum", options: ["#fff", "#000"] } });
    expect(group!.levers.map((l) => l.swatches)).toEqual([undefined, undefined]);
  });

  it("carries a number's unit and bounds", () => {
    const [group] = tweakGroups({ gap: { editor: "range", default: 16, min: 0, max: 48, step: 4, unit: "px" } });
    expect(group!.levers[0]).toEqual({ name: "gap", editor: "range", value: 16, min: 0, max: 48, step: 4, unit: "px" });
  });
});

describe("tweaksOf", () => {
  it("reads the levers from an artboard's data-props", () => {
    const source = `<x-dc><div style="color: {{accent}}">Hi</div></x-dc>
<script type="text/x-dc" data-dc-script data-props='{"accent":{"editor":"color","default":"#c2410c","options":["#c2410c","#0f766e"],"section":"Colour"}}'>
class Component extends DCLogic { renderVals() { return { accent: this.props.accent ?? "#c2410c" }; } }
</script>`;
    const groups = tweaksOf(source);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.section).toBe("Colour");
    expect(groups[0]!.levers[0]!.swatches).toEqual(["#c2410c", "#0f766e"]);
  });

  it("finds none in a file that declares none", () => {
    expect(tweaksOf("<x-dc><p>Hi</p></x-dc>")).toEqual([]);
  });
});
