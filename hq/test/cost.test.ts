// `hq task cost <task> --from <file>`: the cost of a session, read from Claude Code's own record.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "../src/cli";
import { git } from "../src/git";
import { readEvents } from "../src/ledger";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

const init = { type: "system", subtype: "init", model: "claude-sonnet-5-5" };
const assistant = { type: "assistant", message: { content: [{ type: "text", text: "done" }] } };
const result = (usd: number, models: string[] = ["claude-sonnet-5-5"], uuid = `u${usd}`, session_id = "s") => ({
  type: "result", subtype: "success", is_error: false, uuid, session_id, total_cost_usd: usd,
  modelUsage: Object.fromEntries(models.map((m) => [m, { costUSD: usd }])),
});
const lines = (...ms: object[]) => ms.map((m) => JSON.stringify(m)).join("\n") + "\n";

describe("hq task cost --from", () => {
  let repo: string;
  let dir: string;
  const file = (name: string, text: string) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };
  const costs = () => readEvents(repo).filter((e) => e.type === "task.cost");

  beforeEach(() => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "hq-cost-")));
    process.env.HQ_HOME = join(root, "hq-home");
    dir = join(root, "logs");
    mkdirSync(dir);
    repo = join(root, "repo");
    mkdirSync(repo);
    git(["init", "-q", "-b", "main"], repo);
    git(["commit", "-q", "--allow-empty", "-m", "base"], repo);
    git(["branch", "goal/x"], repo);
    record(repo, ["task", "start", "t1", "--goal", "x", "--title", "y", "--model", "m"]);
  });

  test("a stream-json log: the result line's cost and model, with the file's path and hash", () => {
    const p = file("a.jsonl", lines(init, assistant, result(0.42)) + "not json\n");
    expect(record(repo, ["task", "cost", "t1", "--from", p])).toContain("$0.4200");
    expect(costs()).toEqual([
      expect.objectContaining({ task: "t1", usd: 0.42, model: "claude-sonnet-5-5", source: { path: p, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } }),
    ]);
  });

  test("a json result, pretty-printed or in an array; --model overrides; a relative path is kept absolute", () => {
    file("b.json", JSON.stringify(result(1.25, ["claude-opus-5-5"]), null, 2));
    record(repo, ["task", "cost", "t1", "--from", "../logs/b.json"]);
    expect(costs().at(-1)).toMatchObject({ usd: 1.25, model: "claude-opus-5-5", source: { path: join(dir, "b.json") } });
    const arr = file("c.json", JSON.stringify([init, assistant, result(0.5)]));
    record(repo, ["task", "cost", "t1", "--from", arr, "--model", "forced"]);
    expect(costs().at(-1)).toMatchObject({ usd: 0.5, model: "forced" });
  });

  test("several runs' result lines are summed; the model falls back to the init message", () => {
    const noUsage = { type: "result", subtype: "success", session_id: "n", uuid: "u-n", total_cost_usd: 0.25 };
    const p = file("d.jsonl", lines(init, result(0.5, ["a", "b"], "u1"), { ...init, model: "c" }, noUsage, result(1, ["a"], "u2")));
    record(repo, ["task", "cost", "t1", "--from", p]);
    const [e] = costs();
    expect(e).toMatchObject({ model: "a, b, c", runs: ["u1", "u-n", "u2"] });
    expect((e as { usd: number }).usd).toBeCloseTo(1.75);
  });

  test("no result line: refused, nothing recorded", () => {
    const p = file("e.jsonl", lines(init, assistant, { type: "result", subtype: "error_max_turns" }));
    expect(() => record(repo, ["task", "cost", "t1", "--from", p])).toThrow("no result line");
    expect(() => record(repo, ["task", "cost", "t1", "--from", file("empty.jsonl", "")])).toThrow("no result line");
    expect(() => record(repo, ["task", "cost", "t1", "--from", join(dir, "missing.jsonl")])).toThrow();
    expect(() => record(repo, ["task", "cost", "t1", "0.5", "--from", p])).toThrow("not both");
    expect(costs()).toHaveLength(0);
  });

  test("the same file twice is refused, for the same task, another task, or under another path", () => {
    const text = lines(init, result(0.3));
    const p = file("f.jsonl", text);
    record(repo, ["task", "cost", "t1", "--from", p]);
    expect(() => record(repo, ["task", "cost", "t1", "--from", p])).toThrow("already recorded");
    expect(() => record(repo, ["task", "cost", "t1", "--from", file("copy.jsonl", text)])).toThrow("already recorded");
    record(repo, ["task", "start", "t2", "--goal", "x", "--title", "z", "--model", "m"]);
    expect(() => record(repo, ["task", "cost", "t2", "--from", p])).toThrow("already recorded");
    expect(costs()).toHaveLength(1);
    record(repo, ["task", "cost", "t1", "--from", file("g.jsonl", lines(init, result(0.3, ["other"], "other-run")))]);
    expect(costs()).toHaveLength(2);
  });

  test("a log recorded, then appended with a resumed run of the same session and recorded again: only the new run counts", () => {
    const p = file("grow.jsonl", lines(init, result(0.3, ["m"], "a", "sess")));
    record(repo, ["task", "cost", "t1", "--from", p]);
    writeFileSync(p, lines(init, result(0.3, ["m"], "a", "sess"), init, result(0.7, ["m"], "b", "sess")));
    const out = record(repo, ["task", "cost", "t1", "--from", p]);
    expect(out).toContain("$0.7000");
    expect(out).toContain("skipped, already recorded: a");
    expect(costs().map((e) => (e as { usd: number }).usd)).toEqual([0.3, 0.7]);
    expect(costs().map((e) => (e as { runs?: string[] }).runs)).toEqual([["a"], ["b"]]);
    expect(costs().map((e) => (e as { sessions?: string[] }).sessions)).toEqual([["sess"], ["sess"]]);
    expect(() => record(repo, ["task", "cost", "t1", "--from", p])).toThrow("already recorded: a, b");
  });

  test("two runs of one session in one file both count", () => {
    const p = file("resumed.jsonl", lines(init, result(0.4, ["m"], "r1", "sess"), init, result(0.9, ["m"], "r2", "sess"), result(0.2, ["m"], "q", "other")));
    record(repo, ["task", "cost", "t1", "--from", p]);
    const [e] = costs();
    expect(e).toMatchObject({ runs: ["r1", "r2", "q"], sessions: ["sess", "other"] });
    expect((e as { usd: number }).usd).toBeCloseTo(1.5);
  });

  test("the same run in two files counts once, across tasks too", () => {
    const first = file("one.jsonl", lines(init, result(0.5, ["m"], "shared")));
    const second = file("two.jsonl", lines(init, result(0.5, ["m"], "shared"), result(0.25, ["m"], "own")));
    record(repo, ["task", "cost", "t1", "--from", first]);
    record(repo, ["task", "start", "t2", "--goal", "x", "--title", "z", "--model", "m"]);
    expect(record(repo, ["task", "cost", "t2", "--from", second])).toContain("skipped, already recorded: shared");
    expect(costs().at(-1)).toMatchObject({ task: "t2", usd: 0.25, runs: ["own"] });
  });

  test("a result without uuid is refused, nothing recorded", () => {
    const bare = { ...result(0.5), uuid: undefined };
    expect(() => record(repo, ["task", "cost", "t1", "--from", file("bare.jsonl", lines(init, result(0.1), bare))])).toThrow("no uuid");
    expect(costs()).toHaveLength(0);
  });
});
