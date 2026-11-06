import { opendirSync } from "node:fs";

// Preserve the filesystem order used by the original reader in both runtimes.
// readdirSync sorts names in Node, which changes ties in commit attribution.
export function directoryNames(path: string): string[] {
  const dir = opendirSync(path);
  try {
    const names: string[] = [];
    for (let entry; (entry = dir.readSync()) !== null;) names.push(entry.name);
    return names;
  } finally { dir.closeSync(); }
}
