import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseIds } from "../src/ab";
import { keptTasks } from "../src/tasks";

test("every id in the A/B lists is a task in the task file", () => {
  const known = new Set(keptTasks(new URL("../tasks/tasks.json.gz", import.meta.url).pathname).map((t) => t.instance_id));
  for (const f of ["missed.txt", "controls.txt"])
    for (const id of parseIds(readFileSync(new URL(`../ab/${f}`, import.meta.url), "utf8"))) expect(known.has(id)).toBe(true);
});
