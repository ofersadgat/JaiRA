/**
 * The two bundled faces, embedded in the app (decision 0015): every static instance
 * `packages/universal/scripts/fonts.py` cut, handed to `expo-font`'s config plugin, which copies them
 * into the Android assets (`assets/fonts/<family>.ttf`, found by family name) and the iOS bundle.
 * Embedded at build time rather than loaded at start, so the first frame already has them.
 */
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const withFonts = require("expo-font/app.plugin.js").default ?? require("expo-font/app.plugin.js");

const DIR = join(__dirname, "..", "..", "universal", "fonts");

module.exports = (config) =>
  withFonts(config, {
    fonts: readdirSync(DIR)
      .filter((f) => f.endsWith(".ttf"))
      .map((f) => join(DIR, f)),
  });
