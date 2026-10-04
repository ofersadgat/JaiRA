/**
 * The React Native CLI's commands, as One wants them (decision 0015, 0017). A release build bundles its
 * JavaScript in Xcode's "Bundle React Native code and images" phase, which One's prebuild points at
 * `react-native bundle` (not Expo's `export:embed`); this replaces that command with One's, so the
 * bundle gets One's router and transforms. Without it the phase fails: the stock command needs this
 * file's CLI (`@react-native-community/cli`) and knows nothing of `one/metro-entry`.
 */
module.exports = { commands: require("one/react-native-commands") };
