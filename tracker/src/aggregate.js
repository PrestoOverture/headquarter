// Per-combination summary of tasks. Plain JavaScript on purpose: the CLI imports it and the HTML
// report embeds the same source, so the terminal and the page cannot disagree.

/**
 * @param {any[]} tasks
 * @param {(t: any) => string} keyOf
 */
export function aggregate(tasks, keyOf) {
  const groups = new Map();
  for (const t of tasks) {
    const k = keyOf(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const rows = [];
  for (const [key, ts] of groups) {
    const withCommits = ts.filter((t) => t.commits.length > 0);
    const landed = ts.filter((t) => t.landed);
    const mature = landed.filter((t) => t.mature);
    const ci = ts.filter((t) => t.ci);
    const sum = (list, f) => list.reduce((n, t) => n + f(t), 0);
    const cost = sum(ts, (t) => t.costUSD);
    rows.push({
      key,
      tasks: ts.length,
      withCommits: withCommits.length,
      landed: landed.length,
      landedRate: withCommits.length ? landed.length / withCommits.length : null,
      mature: mature.length,
      reworkRate: mature.length ? mature.filter((t) => t.reworked).length / mature.length : null,
      revertRate: mature.length ? mature.filter((t) => t.reverted).length / mature.length : null,
      ci: ci.length,
      ciPassRate: ci.length ? ci.filter((t) => t.ci === "pass").length / ci.length : null,
      costPerTask: cost / ts.length,
      costPerLanded: landed.length ? cost / landed.length : null,
      codexMTokPerTask: sum(ts, (t) => t.codexTokens) / ts.length / 1e6,
      promptsPerTask: sum(ts, (t) => t.humanPrompts) / ts.length,
      interruptsPerTask: sum(ts, (t) => t.interrupts) / ts.length,
      waitMinPerTask: sum(ts, (t) => t.waitMs) / ts.length / 60000,
      linesLandedPerTask: landed.length
        ? sum(landed, (t) => t.commits.filter((c) => c.mainline).reduce((n, c) => n + c.added + c.deleted, 0)) / landed.length
        : null,
      exactShare: (() => {
        const all = ts.flatMap((t) => t.commits);
        return all.length ? all.filter((c) => c.how === "exact").length / all.length : null;
      })(),
    });
  }
  return rows.sort((a, b) => b.tasks - a.tasks);
}
