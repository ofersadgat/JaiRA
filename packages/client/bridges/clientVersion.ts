import manifest from "../package.json";

/**
 * The JaiRA version this client was built at, said in `hello`: every workspace's version moves together
 * at a release (`scripts/release/bump.mjs`), so the client's is the app's.
 */
export const CLIENT_VERSION: string = manifest.version;
