import { readFileSync } from "node:fs";

/** A fixture's text, as the runtime would be given it. */
export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

/** A minimal artboard around a template and an optional logic script. */
export function artboard(template: string, script?: string, dataProps?: string): string {
  const scriptTag =
    script === undefined
      ? ""
      : `<script type="text/x-dc" data-dc-script${dataProps === undefined ? "" : ` data-props='${dataProps}'`}>\n${script}\n</script>\n`;
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>T</title>\n<script src="./support.js"></script>\n</head>\n<body>\n<x-dc>${template}</x-dc>\n${scriptTag}</body>\n</html>\n`;
}

/** A logic class whose `renderVals()` returns the given object literal source. */
export function returning(vals: string): string {
  return `class Component extends DCLogic {\n  renderVals() {\n    return ${vals};\n  }\n}`;
}
