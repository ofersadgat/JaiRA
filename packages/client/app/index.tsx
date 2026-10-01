/**
 * `/`. The platforms split one level down, in `src/routes/index(.web).tsx`, not here: One 1.27 names a
 * `.web.tsx` page as a route of its own (`/index.web`), and Metro bundles every file in `app/` for
 * native — so the web page here would drag what only a browser can run into the phone's bundle.
 */
export { default } from "../src/routes/index";
