import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { listConnectorManifests } from "../src/connectors/registry.js";

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else files.push(path);
  }
  return files;
}

const root = new URL("..", import.meta.url).pathname;
const sourceFiles = (await filesUnder(join(root, "src"))).filter((path) => path.endsWith(".js"));
const transpiler = new Bun.Transpiler({ loader: "js" });
for (const path of sourceFiles) {
  const source = await Bun.file(path).text();
  transpiler.scan(source);
}

const publicFiles = ["index.html", "app.css", "app.js"];
for (const file of publicFiles) {
  if (!(await Bun.file(join(root, "public", file)).exists())) throw new Error(`Missing public/${file}`);
}

const connectorIds = listConnectorManifests().map((manifest) => manifest.id);
if (new Set(connectorIds).size !== connectorIds.length) throw new Error("Connector ids must be unique");

console.log(`Checked ${sourceFiles.length} JavaScript modules and ${connectorIds.length} connector manifest`);
