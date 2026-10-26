// Checks of the plugin package: the manifests' fields, each skill's frontmatter, and that every hq subcommand the skills mention is in the usage of hq/src/cli.ts.

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN = join(import.meta.dir, "..");
const CLI = join(PLUGIN, "../hq/src/cli.ts");
const json = (path: string) => JSON.parse(readFileSync(join(PLUGIN, path), "utf8"));
const skills = readdirSync(join(PLUGIN, "skills"));

/** The `---` block at the top of a SKILL.md as key/value pairs. */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error("no frontmatter");
  return Object.fromEntries(m[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
}

test("plugin.json names the plugin hq", () => {
  const p = json(".claude-plugin/plugin.json");
  expect(p.name).toBe("hq");
  expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(p.description).toBeTruthy();
});

test("marketplace.json lists plugin hq with source ./ and the marketplace name headquarter", () => {
  const m = json(".claude-plugin/marketplace.json");
  expect(m.name).toBe("headquarter");
  expect(m.owner.name).toBeTruthy();
  expect(m.plugins).toHaveLength(1);
  expect(m.plugins[0].name).toBe(json(".claude-plugin/plugin.json").name);
  expect(m.plugins[0].source).toBe("./");
});

test("the setup and goal skills exist", () => {
  expect(skills.sort()).toEqual(["goal", "setup"]);
});

for (const skill of ["setup", "goal"]) {
  test(`skill ${skill} has frontmatter with its name and a description`, () => {
    const f = frontmatter(readFileSync(join(PLUGIN, "skills", skill, "SKILL.md"), "utf8"));
    expect(f.name).toBe(skill);
    expect(f.description.length).toBeGreaterThan(40);
  });
}

/** The usage lines of cli.ts: the header comment and the usage string of the fallback error. */
function usage(): string {
  const src = readFileSync(CLI, "utf8");
  const header = src.split("\n").filter((l) => l.startsWith("//")).join("\n");
  const last = src.match(/console\.error\("(usage: hq [^"]*)"\)/);
  if (!last) throw new Error("no usage string in cli.ts");
  return `${header}\n${last[1]}`;
}

/** Every `hq <cmd>` (with the second word for task and goal) inside backticks of a skill. */
function mentioned(text: string): Set<string> {
  const out = new Set<string>();
  for (const span of text.matchAll(/`([^`\n]+)`|^```\n([\s\S]*?)^```/gm)) {
    for (const m of (span[1] ?? span[2]!).matchAll(/(?:^|[\s|(])(?:~\/\.hq\/bin\/)?hq ([a-z][\w-]*)(?: ([a-z][\w-]*))?/gm)) {
      out.add(m[1] === "task" || m[1] === "goal" ? `${m[1]} ${m[2]}` : m[1]!);
    }
  }
  return out;
}

for (const skill of ["setup", "goal"]) {
  test(`every hq subcommand skill ${skill} mentions is in the usage of cli.ts`, () => {
    const found = mentioned(readFileSync(join(PLUGIN, "skills", skill, "SKILL.md"), "utf8"));
    expect(found.size).toBeGreaterThan(0);
    const text = usage();
    for (const sub of found) expect(text, `hq ${sub}`).toContain(`hq ${sub}`);
  });
}

test("together the skills mention the whole flow", () => {
  const all = new Set(skills.flatMap((s) => [...mentioned(readFileSync(join(PLUGIN, "skills", s, "SKILL.md"), "utf8"))]));
  for (const sub of ["install-hook", "goal new", "work", "review", "report", "task gate", "approve", "merge"]) expect(all.has(sub), sub).toBe(true);
});

test("the goal skill leaves approve and merge to the user", () => {
  const text = readFileSync(join(PLUGIN, "skills/goal/SKILL.md"), "utf8");
  expect(text).toContain("never approve");
  expect(text).toContain("yourself");
});

test("README exists", () => {
  expect(existsSync(join(PLUGIN, "README.md"))).toBe(true);
});
