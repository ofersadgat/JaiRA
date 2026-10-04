import { Slot } from "one";

/**
 * The page, from `<html>` down.
 *
 * `data-palette` is the default palette, stamped for the first paint, and `applyAppearance` rewrites it
 * once settings arrive. There is no CSP `<meta>` here: Electron sends the
 * same policy as a header from its `app://` protocol, which a page cannot override. The viewport is the
 * device's width: a phone's browser (the `/native` preview, a paired browser) lays the page out at its
 * own width rather than a desktop's 980; a desktop's ignores it.
 */
export default function Layout() {
  return (
    <html lang="en" data-palette="ink">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>JaiRA</title>
      </head>
      <body>
        <Slot />
      </body>
    </html>
  );
}
