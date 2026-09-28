/**
 * What the studio's window is showing right now (`studio.mts`): its address, whether it drew, the first
 * of its text, and anything given as an argument evaluated in the page.
 *
 *   npx tsx packages/app/shots/peek.mts ['<expression>']
 */
import { App } from "./driver.mjs";
import { STUDIO_PORT } from "./parityWorld.mjs";

const app = await App.connect(STUDIO_PORT, { out: import.meta.dirname });
try {
  console.log(await app.evaluate<string>(`location.href + " | " + document.readyState + " | #root children " + document.getElementById('root')?.children.length + " || " + document.body.innerText.slice(0, 600)`));
  if (process.argv[2] !== undefined) console.log(JSON.stringify(await app.evaluate(process.argv[2]), null, 2));
} finally {
  await app.close();
}
