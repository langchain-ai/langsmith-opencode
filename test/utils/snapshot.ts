import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export async function loadJSONL(fileName: string) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const data = await fs.readFile(path.join(__dirname, "..", "snapshot", fileName), "utf8");
  const lines = data
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return lines;
}
