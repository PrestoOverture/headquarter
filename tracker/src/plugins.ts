import { claudePlugin } from "./claude";
import { codexPlugin } from "./codex";
import { opencodePlugin } from "./opencode";
import type { Session } from "./types";

export type SessionFileReader = (file: string, parse: () => Session[]) => Session[];

export interface SourcePlugin {
  name: string;
  /** Bump whenever this plugin's parsing changes to invalidate its cached sessions. */
  version: string;
  defaultPaths(home: string): string[];
  detect(path: string): boolean;
  read(path: string, readFile?: SessionFileReader): Session[];
}

export const plugins: SourcePlugin[] = [claudePlugin, codexPlugin, opencodePlugin];
