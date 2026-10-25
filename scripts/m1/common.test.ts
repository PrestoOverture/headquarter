import { expect, test } from "bun:test";
import { failureKind, feedback, summary } from "./common";

// A real-shaped failing `bun test` run: a source excerpt, a stack frame with the exam path.
const ASSERTION_RUN = `bun test v1.4.0 (34cbb9a40)

hq/test/m1-t02.test.ts:
40 |   const out = run(["status"]);
41 |   expect(out).toContain("goal/x  ");
                   ^
error: expect(received).toContain(expected)

Expected to contain: "goal/x  "
Received: "no goals in /Users/k/.hq/x"

      at <anonymous> (/Users/k/.hq-m1/exams/m1-t02/files/hq/test/m1-t02.test.ts:41:15)
(fail) hq status > lists every goal branch [12.3ms]

 0 pass
 1 fail`;

test("assertion only when every failing test failed on an expect", () => {
  expect(failureKind(ASSERTION_RUN)).toBe("assertion");
  // one assertion, one plain throw from a stub: not all assertions
  const mixed = `error: expect(received).toBe(expected)\n(fail) a [1ms]\nerror: not implemented\n(fail) b [1ms]\n 0 pass\n 2 fail`;
  expect(failureKind(mixed)).toBe("other");
  expect(failureKind(`error: Test "slow" timed out after 30000ms\n(fail) slow\n 0 pass\n 1 fail`)).toBe("other");
  expect(failureKind(`SyntaxError: Export named 'statusOf' not found in module 'hq/src/status.ts'.`)).toBe("other");
  expect(failureKind("error: Cannot find module './status'\n(fail) x")).toBe("other");
  expect(failureKind("exit 2, nothing printed")).toBe("other");
  // two failing tests but one assertion line: the other one failed some other way
  expect(failureKind(`error: expect(received).toBe(expected)\n(fail) a\n(fail) b\n 0 pass\n 2 fail`)).toBe("other");
});

test("feedback keeps test names and assertion messages, never test code, the exam path or the hidden file names", () => {
  const f = feedback(ASSERTION_RUN, ["hq/test/m1-t02.test.ts"]);
  expect(f).toContain("(fail) hq status > lists every goal branch");
  expect(f).toContain("error: expect(received).toContain(expected)");
  expect(f).toContain('Expected to contain: "goal/x  "');
  expect(f).toContain('Received: "no goals in /Users/k/.hq/x"'); // hq's own paths are fine
  expect(f).not.toContain('run(["status"])');
  expect(f).not.toContain(".hq-m1");
  expect(f).not.toContain("m1-t02.test.ts");
});

test("feedback drops lines carrying the hidden test code, whatever the code under test returned", () => {
  const line = `expect(statusOf(ledger)).toContain("goal/x  ");`;
  // as Bun prints a string value: one line, newlines and quotes escaped
  const run = `error: expect(received).toBe(expected)\nExpected: "ok"\nReceived: ${JSON.stringify(`test(() => {\n  ${line}`)}\n(fail) lists [1ms]`;
  const f = feedback(run, [], [`test("lists", () => {\n  ${line}\n});\n`]);
  expect(f).toContain("(fail) lists");
  expect(f).toContain('Expected: "ok"');
  expect(f).not.toContain("statusOf");
});

test("feedback trusts only known failing tests and gives the rest one small budget", () => {
  const long = "Q".repeat(1000);
  const run = [
    "error: expect(received).toBe(expected)", 'Expected: "ok"', `Received: "${long}"`, ...Array.from({ length: 10 }, (_, i) => `+ chunk${i}`), "(fail) a [1ms]",
    "error: expect(received).toBe(expected)", 'Received: "second"', "(fail) b [1ms]",
    ...Array.from({ length: 50 }, (_, i) => `(fail) Zm9yZ2Vk${i}`), // printed by the code under test
  ].join("\n");
  const f = feedback(run, [], [], ["a", "b", "c"]).split("\n");
  expect(f.filter((l) => l.startsWith("(fail)"))).toEqual(["(fail) a [1ms]", "(fail) b [1ms]"]);
  expect(f.filter((l) => !l.startsWith("(fail)"))).toHaveLength(8); // 4 per known failing test
  expect(f.find((l) => l.startsWith('Received: "Q'))!.length).toBe(160);
  expect(feedback(run).split("\n").length).toBeLessThanOrEqual(52 + 4 * 52); // without names: still bounded per failing line
});

test("feedback strips color codes and caps its length", () => {
  expect(feedback("\x1b[31m(fail)\x1b[0m colored [1ms]")).toBe("(fail) colored [1ms]");
  expect(feedback(Array.from({ length: 500 }, (_, i) => `(fail) t${i}`).join("\n"), [], [], ["t1", "t2"]).split("\n")).toHaveLength(2);
  expect(feedback(`Received: "${"x".repeat(1000)}"\n(fail) t`).split("\n")[0]!.length).toBe(160);
});

test("a usage limit is read from the session's final error only, whatever the period", async () => {
  const { usageLimited } = await import("./common");
  expect(usageLimited({ is_error: true, result: "You've hit your weekly limit · resets 9am (Asia/Shanghai)" })).toBe(true);
  expect(usageLimited({ is_error: true, result: "You've hit your session limit" })).toBe(true);
  expect(usageLimited({ is_error: true, result: "You've hit your limit" })).toBe(true);
  expect(usageLimited({ is_error: false, result: "the eval files say: hit your limit" })).toBe(false);
  expect(usageLimited(null)).toBe(false);
});

test("summary adds up every bun test summary in the output", () => {
  expect(summary(ASSERTION_RUN)).toEqual({ pass: 0, fail: 1, skip: 0 });
  expect(summary(" 3 pass\n 0 fail\n...\n 2 pass\n 1 skip\n 1 todo\n 1 fail")).toEqual({ pass: 5, fail: 1, skip: 2 });
  expect(summary("exit 0, no tests ran")).toEqual({ pass: 0, fail: 0, skip: 0 });
});

test("the grader's preload goes first into any bunfig.toml, the rest kept", async () => {
  const { withPreload } = await import("./grade");
  expect(withPreload("", "/c/seal.ts")).toBe('[test]\npreload = ["/c/seal.ts"]\n');
  expect(withPreload("[test]\n# slow\ntimeout = 30000\n", "/c/seal.ts")).toBe('[test]\npreload = ["/c/seal.ts"]\n# slow\ntimeout = 30000\n');
  expect(withPreload('[test]\npreload = ["./a.ts"]\n', "/c/seal.ts")).toBe('[test]\npreload = ["/c/seal.ts", "./a.ts"]\n');
  expect(withPreload('[test]\npreload = "./a.ts"\n', "/c/seal.ts")).toBe('[test]\npreload = ["/c/seal.ts", "./a.ts"]\n');
  expect(withPreload('[install]\nexact = true', "/c/seal.ts")).toBe('[install]\nexact = true\n[test]\npreload = ["/c/seal.ts"]\n');
});
