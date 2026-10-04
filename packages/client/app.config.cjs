/**
 * What `app.json` cannot say, because it depends on the build (decision 0017). Expo reads `app.json`
 * first and hands it here as `config`; a prebuild writes the result into the native projects.
 *
 * - The version Apple sees: `JAIRA_IOS_VERSION` (`X.Y.Z`) and `JAIRA_IOS_BUILD` (`YYYYMMDD.N`), which
 *   the release plan works out (`appleVersionOf` in `scripts/release/versions.mjs`). Without them, a
 *   local prebuild keeps `app.json`'s version and build 1.
 * - The Apple team (`APPLE_TEAM_ID`), so Xcode's automatic signing knows whose certificates to use.
 * - No encryption beyond the system's own TLS, so App Store Connect does not stop every upload to ask
 *   about export compliance.
 */
module.exports = ({ config }) => ({
  ...config,
  version: process.env.JAIRA_IOS_VERSION || config.version,
  ios: {
    ...config.ios,
    buildNumber: process.env.JAIRA_IOS_BUILD || config.ios?.buildNumber || "1",
    ...(process.env.APPLE_TEAM_ID ? { appleTeamId: process.env.APPLE_TEAM_ID } : {}),
    infoPlist: { ...config.ios?.infoPlist, ITSAppUsesNonExemptEncryption: false },
  },
});
