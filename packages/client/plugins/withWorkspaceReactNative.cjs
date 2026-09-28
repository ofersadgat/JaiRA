/**
 * Find React Native where an npm workspace puts it (decision 0015).
 *
 * One's prebuild template leaves `app/build.gradle`'s `react { … }` block on its defaults, which are
 * `../../node_modules/react-native` and friends: right for a single-package app, wrong in this
 * repository, where npm hoists React Native to the root's `node_modules`. Gradle then fails with
 * "…/packages/client/node_modules/react-native/ReactAndroid/gradle.properties (cannot find the path)".
 * `settings.gradle` already asks `node` where the React Native Gradle plugin is; this asks it the same
 * way for the three paths the `react` block needs.
 *
 * FIRST in app.json's plugins, so that its mod runs LAST: Expo runs `app/build.gradle` mods in reverse, and
 * `one/expo-plugin` (vxrn) replaces the whole `react` block with its own template, dropping anything added before it.
 */
const { withAppBuildGradle } = require("expo/config-plugins");

const MARK = "plugins/withWorkspaceReactNative.cjs";
const resolve = (spec) => `new File(["node", "--print", "${spec}"].execute(null, rootDir).text.trim())`;
const LINES = [
  `    // Where npm put them (${MARK}): hoisted to the workspace root.`,
  `    reactNativeDir = ${resolve("require.resolve('react-native/package.json')")}.getParentFile().getAbsoluteFile()`,
  `    codegenDir = ${resolve("require.resolve('@react-native/codegen/package.json', { paths: [require.resolve('react-native/package.json')] })")}.getParentFile().getAbsoluteFile()`,
  `    cliFile = new File(${resolve("require.resolve('react-native/package.json')")}.getParentFile(), "cli.js")`,
];
/** The opening of the block, whatever line ending the template was written with. */
const OPENING = /^react \{(\r?\n)/m;

module.exports = (config) =>
  withAppBuildGradle(config, (c) => {
    const gradle = c.modResults.contents;
    if (process.env.JAIRA_PLUGIN_TRACE) console.log(`[withWorkspaceReactNative] ran; react block ${OPENING.test(gradle) ? "found" : "NOT found"}`);
    if (gradle.includes(MARK)) return c;
    const next = gradle.replace(OPENING, (_m, eol) => `react {${eol}${LINES.join(eol)}${eol}`);
    if (next === gradle) throw new Error("withWorkspaceReactNative: no `react {` block in app/build.gradle");
    c.modResults.contents = next;
    return c;
  });
