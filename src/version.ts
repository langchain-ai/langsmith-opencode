import { readFileSync } from "node:fs";

// Read at runtime from package.json via import.meta.url; a JSON import won't
// work (package.json sits outside tsconfig rootDir).
const readIntegrationVersion = (): string => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
};

export const INTEGRATION_VERSION: string = readIntegrationVersion();
