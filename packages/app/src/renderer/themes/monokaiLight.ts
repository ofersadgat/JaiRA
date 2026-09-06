/**
 * Monokai Light, as the TextMate theme it is published as — the file's contents, not a reading of them.
 *
 * Generated from `themes/Monokai%20Light.tmTheme` in `github.com/anoff/vscode-monokai-light`, which
 * is a plist: this is that file's `settings` array converted to JSON and otherwise untouched. Every
 * scope its author wrote is here, including the thirty this app's own palette has no field for
 * (`markup.heading`, `invalid.deprecated`, `meta.attribute`) — because what consumes this is a real
 * TextMate engine, and those scopes are exactly what it will ask about.
 *
 * The other three themes are Shiki's bundled copies of their VSCode themes and need no module like
 * this one. Monokai Light has no bundled copy, which is why it is embedded — and why it is embedded
 * RAW rather than mapped down to a dozen colours the way `editorThemes.ts` has to do for the DOM
 * editors, which have no TextMate engine to hand it to.
 *
 * Regenerate by re-fetching that file and converting the plist. Nothing here is hand-edited, and a
 * hand edit would be a lie about where the colours came from.
 */
import type { ThemeRegistrationRaw } from "shiki/core";

/**
 * `as ThemeRegistrationRaw` rather than a declared type, and the cast is about the FILE rather than
 * about this app.
 *
 * A `.tmTheme`'s global block states `caret`, `selection`, `invisibles`, `lineHighlight` and half a
 * dozen more; Shiki's type for a settings entry names only the three that colour a token. Both are
 * right — a TextMate engine reads the token three, and an editor reads the rest — and a theme
 * trimmed to what the type admits would be a theme with its caret and selection thrown away. So the
 * file goes in whole and the type is asserted over it.
 */
export const MONOKAI_LIGHT_TM = {
  // The id this app knows it by (`editorThemes.ts`), so the Monaco theme Shiki registers under this
  // name is the one the stored preference asks for.
  name: "monokai-light",
  type: "light",
  settings: [
    {
      "settings": {
        "background": "#FFFFFF",
        "caret": "#000000",
        "foreground": "#000000",
        "invisibles": "#E0E0E0",
        "lineHighlight": "#A5A5A526",
        "selection": "#C2E8FF",
        "selectionBorder": "#AACBDF",
        "inactiveSelection": "#EDEDED",
        "findHighlight": "#FFE792",
        "findHighlightForeground": "#000000"
      }
    },
    {
      "scope": "comment",
      "settings": {
        "foreground": "#9F9F8F"
      }
    },
    {
      "scope": "string",
      "settings": {
        "foreground": "#F25A00"
      }
    },
    {
      "scope": "constant.numeric",
      "settings": {
        "foreground": "#AE81FF"
      }
    },
    {
      "scope": "constant.language",
      "settings": {
        "foreground": "#AE81FF"
      }
    },
    {
      "scope": "constant.character, constant.other",
      "settings": {
        "foreground": "#AE81FF"
      }
    },
    {
      "scope": "variable",
      "settings": {
        "fontStyle": ""
      }
    },
    {
      "scope": "keyword",
      "settings": {
        "foreground": "#F92672"
      }
    },
    {
      "scope": "storage",
      "settings": {
        "fontStyle": "",
        "foreground": "#F92672"
      }
    },
    {
      "scope": "storage.type",
      "settings": {
        "fontStyle": "italic",
        "foreground": "#28C6E4"
      }
    },
    {
      "scope": "entity.name.class",
      "settings": {
        "fontStyle": "underline",
        "foreground": "#6AAF19"
      }
    },
    {
      "scope": "entity.other.inherited-class",
      "settings": {
        "fontStyle": "italic underline",
        "foreground": "#6AAF19"
      }
    },
    {
      "scope": "entity.name.function",
      "settings": {
        "fontStyle": "",
        "foreground": "#6AAF19"
      }
    },
    {
      "scope": "variable.language",
      "settings": {
        "fontStyle": "italic",
        "foreground": "#FD971F"
      }
    },
    {
      "scope": "variable.parameter",
      "settings": {
        "fontStyle": "italic",
        "foreground": "#FD971F"
      }
    },
    {
      "scope": "entity.name.tag",
      "settings": {
        "fontStyle": "",
        "foreground": "#F92672"
      }
    },
    {
      "scope": "entity.other.attribute-name",
      "settings": {
        "fontStyle": "",
        "foreground": "#6AAF19"
      }
    },
    {
      "scope": "support.function",
      "settings": {
        "fontStyle": "",
        "foreground": "#28C6E4"
      }
    },
    {
      "scope": "support.constant",
      "settings": {
        "fontStyle": "",
        "foreground": "#28C6E4"
      }
    },
    {
      "scope": "support.type, support.class",
      "settings": {
        "fontStyle": "italic",
        "foreground": "#28C6E4"
      }
    },
    {
      "scope": "meta.attribute",
      "settings": {
        "fontStyle": "italic",
        "foreground": "#cd3704"
      }
    },
    {
      "scope": "support.other.variable",
      "settings": {
        "fontStyle": ""
      }
    },
    {
      "scope": "invalid",
      "settings": {
        "background": "#F92672",
        "fontStyle": "",
        "foreground": "#000000"
      }
    },
    {
      "scope": "invalid.deprecated",
      "settings": {
        "background": "#AE81FF",
        "foreground": "#000000"
      }
    },
    {
      "scope": "markup.underline",
      "settings": {
        "fontStyle": "underline"
      }
    },
    {
      "scope": "markup.bold",
      "settings": {
        "fontStyle": "bold",
        "foreground": "#28C6E4"
      }
    },
    {
      "scope": "markup.heading",
      "settings": {
        "fontStyle": "bold",
        "foreground": "#28C6E4"
      }
    },
    {
      "scope": "markup.italic",
      "settings": {
        "fontStyle": "italic",
        "foreground": "#28C6E4"
      }
    },
    {
      "scope": "markup.inserted",
      "settings": {
        "foreground": "#6AAF19"
      }
    },
    {
      "scope": "markup.deleted",
      "settings": {
        "foreground": "#F92672"
      }
    },
    {
      "scope": "markup.changed",
      "settings": {
        "foreground": "#F25A00"
      }
    },
    {
      "scope": "markup.quote",
      "settings": {
        "foreground": "#F92672"
      }
    },
    {
      "scope": "markup.list",
      "settings": {
        "foreground": "#F25A00"
      }
    },
    {
      "scope": "markup.inline.raw",
      "settings": {
        "foreground": "#FD971F"
      }
    },
    {
      "scope": "meta.embedded",
      "settings": {
        "foreground": "#000000FF"
      }
    }
  ],
} as ThemeRegistrationRaw;
