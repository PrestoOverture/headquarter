import { claudePlugin } from "./claude";
import { codexPlugin } from "./codex";
import { opencodePlugin } from "./opencode";
import type { Session } from "./types";

export interface SourcePlugin {
  name: string;
  defaultPaths(home: string): string[];
  detect(path: string): boolean;
  read(path: string): Session[];
}

export const plugins: SourcePlugin[] = [claudePlugin, codexPlugin, opencodePlugin];
