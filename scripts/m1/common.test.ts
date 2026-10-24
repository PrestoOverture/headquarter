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

test("feedback strips color codes and caps its length", () => {
  expect(feedback("\x1b[31m(fail)\x1b[0m colored [1ms]")).toBe("(fail) colored [1ms]");
  expect(feedback(Array.from({ length: 500 }, (_, i) => `(fail) t${i}`).join("\n")).split("\n")).toHaveLength(200);
  expect(feedback(`Received: "${"x".repeat(1000)}"`).length).toBeLessThanOrEqual(400);
});

test("summary adds up every bun test summary in the output", () => {
  expect(summary(ASSERTION_RUN)).toEqual({ pass: 0, fail: 1 });
  expect(summary(" 3 pass\n 0 fail\n...\n 2 pass\n 1 fail")).toEqual({ pass: 5, fail: 1 });
  expect(summary("exit 0, no tests ran")).toEqual({ pass: 0, fail: 0 });
});
