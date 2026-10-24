// Runs `merge` as its own process for the merge queue test: bun merge-child.ts <repo> <goal> <log>.
// The tests are a slow plain shell command (no sandbox), and its start and end times go to <log>.

import { appendFileSync } from "node:fs";
import { run } from "../../src/git";
import { merge } from "../../src/merge";

const [repo, goal, log] = process.argv.slice(2) as [string, string, string];
const r = merge(repo, goal, {
  wait: 60,
  runTests: (cmd, cwd) => {
    appendFileSync(log, `${goal} start ${Date.now()}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    const t = run(["bash", "-c", cmd], cwd);
    appendFileSync(log, `${goal} end ${Date.now()}\n`);
    return t;
  },
});
console.log(JSON.stringify(r.ok ? { ok: true, mergeCommit: r.mergeCommit } : r));
