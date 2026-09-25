/**
 * `npm run licenses:sync` — fetch every SPDX license template `licenses/config.json` names and
 * `licenses/spdx/` does not hold yet. Commit what it writes: the build reads only the committed copy
 * and never goes to the network for one (see `thirdPartyLicenses.ts`).
 */
import { syncThirdPartyLicenseNotices } from "./thirdPartyLicenses";

await syncThirdPartyLicenseNotices(new URL("./config.json", import.meta.url));
