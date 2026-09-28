/**
 * What the studio's window is showing right now (`studio.mts`): its address, whether it drew, the first
 * of its text, and anything given as an argument evaluated in the page.
 *
 *   npx tsx packages/app/shots/peek.mts ['<expression>'] [--port 9301]
 */
import { App } from "./driver.mjs";
import { STUDIO_PORT } from "./parityWorld.mjs";

const app = await App.connect(process.argv.includes("--port") ? Number(process.argv[process.argv.indexOf("--port") + 1]) : STUDIO_PORT, { out: import.meta.dirname });
try {
  console.log(await app.evaluate<string>(`location.href + " | " + document.readyState + " | #root children " + document.getElementById('root')?.children.length + " || " + document.body.innerText.slice(0, 600)`));
  // The expression: the first argument that is not `--port` or its value.
  const expression = process.argv.slice(2).find((a, i, all) => a !== "--port" && all[i - 1] !== "--port");
  if (expression !== undefined) console.log(JSON.stringify(await app.evaluate(expression), null, 2));
} finally {
  await app.close();
}
