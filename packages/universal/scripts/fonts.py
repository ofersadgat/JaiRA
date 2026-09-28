"""
The two bundled faces, cut for native (decision 0015).

    pip install fonttools brotli
    python packages/universal/scripts/fonts.py

The desktop ships DM Sans and JetBrains Mono as variable woff2 files, and Chromium picks a weight — and,
for DM Sans, an optical size equal to the font size — out of each. React Native on Android can do
neither with one file, so the phone gets static instances: JetBrains Mono at every weight the
stylesheet uses, and DM Sans at every weight on a grid of optical sizes. `primitives.tsx` names the
nearest (`DMSans_600_12`); each file's family name inside is its file name, which is what both Android
(assets/fonts) and iOS look a family up by. `expo-font`'s config plugin embeds them at build time.
"""
import os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "app", "src", "renderer", "fonts")
OUT = os.path.join(HERE, "..", "fonts")

WEIGHTS = (400, 450, 500, 550, 600, 650, 700, 800)
# Optical sizes: every size the UI draws text at is within half a pixel of one of these (DM Sans'
# axis runs 9–40; smaller text uses 9, as the browser clamps it).
OPSZ = (9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 32)


def cut(src: str, name: str, location: dict) -> None:
    font = TTFont(os.path.join(SRC, src))
    for axis in font["fvar"].axes:
        location.setdefault(axis.axisTag, axis.defaultValue)
    inst = instancer.instantiateVariableFont(font, location)
    inst.flavor = None
    names = inst["name"]
    for rec in list(names.names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17):
            names.removeNames(nameID=rec.nameID)
    names.setName(name, 1, 3, 1, 0x409)
    names.setName("Regular", 2, 3, 1, 0x409)
    names.setName(name, 3, 3, 1, 0x409)
    names.setName(name, 4, 3, 1, 0x409)
    names.setName(name, 6, 3, 1, 0x409)
    # Every instance is the "regular" of its own family: the weight is in the name, not asked for.
    inst["OS/2"].usWeightClass = 400
    inst["OS/2"].fsSelection = (inst["OS/2"].fsSelection & ~0b1100001) | 0b1000000
    inst["head"].macStyle = 0
    inst.save(os.path.join(OUT, f"{name}.ttf"))


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".ttf"):
            os.remove(os.path.join(OUT, f))
    for w in WEIGHTS:
        cut("jetbrains-mono-variable.woff2", f"JetBrainsMono_{w}", {"wght": w})
        for size in OPSZ:
            cut("dm-sans-variable.woff2", f"DMSans_{w}_{size}", {"wght": w, "opsz": size})


if __name__ == "__main__":
    main()
