import { expect, test } from "bun:test";
import { failureKind, feedback } from "./common";

// A real-shaped failing `bun test` run: a source excerpt, a stack frame with the exam path.
const ASSERTION_RUN = `bun test v1.4.0 (34cbb9a40)

hq/test/m1-t02.test.ts:
40 |   const out = run(["status"]);
41 |   expect(out).toContain("goal/x  ");
                   ^
error: expect(received).toContain(expected)

Expected to contain: "goal/x  "
Received: "no goals"

      at <anonymous> (/Users/k/.hq/exams/headquarter-1/m1-t02/files/hq/test/m1-t02.test.ts:41:15)
(fail) hq status > lists every goal branch [12.3ms]

 0 pass
 1 fail`;

test("an assertion failure is told apart from a missing export or a compile error", () => {
  expect(failureKind(ASSERTION_RUN)).toBe("assertion");
  expect(failureKind(`SyntaxError: Export named 'statusOf' not found in module 'hq/src/status.ts'.`)).toBe("other");
  expect(failureKind("error: Cannot find module './status'")).toBe("other");
  expect(failureKind("TypeError: statusOf is not a function")).toBe("other");
  expect(failureKind("ReferenceError: x is not defined\nerror: expect(received).toBe(expected)")).toBe("other"); // any crash makes it not purely assertions
  expect(failureKind("exit 2, nothing printed")).toBe("other");
});

test("feedback keeps test names and assertion messages, never test code or exam paths", () => {
  const f = feedback(ASSERTION_RUN);
  expect(f).toContain("(fail) hq status > lists every goal branch");
  expect(f).toContain("error: expect(received).toContain(expected)");
  expect(f).toContain('Expected to contain: "goal/x  "');
  expect(f).toContain('Received: "no goals"');
  expect(f).not.toContain('run(["status"])'); // source excerpt
  expect(f).not.toContain("toContain(\"goal/x");
  expect(f).not.toContain(".hq/exams");
  expect(f).not.toContain("m1-t02.test.ts");
});

test("feedback strips color codes and caps its length", () => {
  expect(feedback("\x1b[31m(fail)\x1b[0m colored [1ms]")).toBe("(fail) colored [1ms]");
  expect(feedback(Array.from({ length: 500 }, (_, i) => `(fail) t${i}`).join("\n")).split("\n")).toHaveLength(200);
});
