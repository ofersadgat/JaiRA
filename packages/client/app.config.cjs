/**
 * What `app.json` cannot say, because it depends on the build (decision 0017). Expo reads `app.json`
 * first and hands it here as `config`; a prebuild writes the result into the native projects.
 *
 * - The version Apple sees: `JAIRA_IOS_VERSION` (`X.Y.Z`) and `JAIRA_IOS_BUILD` (`YYYYMMDD.N`), which
 *   the release plan works out (`appleVersionOf` in `scripts/release/versions.mjs`). Without them, a
 *   local prebuild keeps `app.json`'s version and build 1.
 * - The Apple team (`APPLE_TEAM_ID`), so Xcode's automatic signing knows whose certificates to use.
 * - Export compliance answered in the build, so App Store Connect does not stop every upload to ask. The
 *   app's encryption is standard algorithms only, none of its own: the system's TLS, WireGuard through
 *   Tailscale built in, and the pairing code exchange (CPace, ChaCha20-Poly1305; decision 0013, amended
 *   2026-10-04), declared exempt as mass-market standard cryptography. That is the publisher's call to
 *   confirm (TODO.md, "Export compliance").
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
