import { Slot } from "one";

/**
 * The page, from `<html>` down.
 *
 * `data-palette` is the default palette, stamped for the first paint, and `applyAppearance` rewrites it
 * once settings arrive. There is no CSP `<meta>` here: Electron sends the
 * same policy as a header from its `app://` protocol, which a page cannot override.
 */
export default function Layout() {
  return (
    <html lang="en" data-palette="ink">
      <head>
        <meta charSet="utf-8" />
        <title>JaiRA</title>
      </head>
      <body>
        <Slot />
      </body>
    </html>
  );
}
