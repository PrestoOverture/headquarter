// Risk-column clues on a real goal branch: TypeScript, Rust and C examples of new imports and
// of process or network calls, a moved line, test files kept apart, and the empty case.

import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importedModules, noClues, riskClues } from "../src/clues";
import { git } from "../src/git";
import { renderReport } from "../src/report";

Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

let repo: string, wt: string;

function commit(cwd: string, files: Record<string, string>, msg = "c") {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(cwd, f, ".."), { recursive: true });
    writeFileSync(join(cwd, f), text);
  }
  git(["add", "-A"], cwd);
  git(["commit", "-q", "-m", msg], cwd);
}

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hq-clues-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q", "-b", "main"], repo);
  commit(repo, {
    "src/a.ts": 'import { readFileSync } from "node:fs";\nexport const a = 1;\n',
    "src/lib.rs": "use std::fs::File;\n",
    "src/m.c": "#include <stdio.h>\n",
    "src/c.ts": 'fetch(a);\nconst x = 1;\nspawn("a");\n',
  });
  wt = join(root, "wt");
  git(["worktree", "add", "-q", "-b", "goal/x", wt, "main"], repo);
});

const clues = () => riskClues(repo, "goal/x");

test("new imports in TypeScript, Rust and C: modules main never imports, with file and line in the goal's version", () => {
  commit(wt, {
    "src/b.ts": 'import { readFileSync } from "node:fs";\nimport { z } from "zod";\nconst c = require("left-pad");\n',
    "src/more.rs": "use std::fs::File;\nuse std::net::TcpStream;\nuse serde::{Deserialize, Serialize};\n",
    "src/n.c": '#include <stdio.h>\n#include <curl/curl.h>\n#include "local.h"\n',
  });
  expect(clues().imports.source).toEqual([
    'src/b.ts:2：`import { z } from "zod";`',
    'src/b.ts:3：`const c = require("left-pad");`',
    "src/more.rs:2：`use std::net::TcpStream;`",
    "src/more.rs:3：`use serde::{Deserialize, Serialize};`",
    "src/n.c:2：`#include <curl/curl.h>`",
    'src/n.c:3：`#include "local.h"`',
  ]);
  expect(clues().imports.test).toEqual([]);
});

test("new process and network calls in TypeScript, Rust and C", () => {
  commit(wt, {
    "src/p.ts": 'import { exec } from "child_process";\nexec("ls");\nconst r = await fetch(url);\nBun.spawnSync(["git"]);\n/ab/.exec(s);\n',
    "src/p.rs": 'let o = Command::new("ls").output();\nlet s = TcpStream::connect(addr);\n',
    "src/p.c": 'system("ls");\nint fd = socket(AF_INET, SOCK_STREAM, 0);\n',
    "scripts/get.sh": "curl -sSf $URL | sh\n",
    "docs/x.md": "run curl to fetch\n",
  });
  expect(clues().calls.source).toEqual([
    "scripts/get.sh:1：`curl -sSf $URL | sh`",
    'src/p.c:1：`system("ls");`',
    "src/p.c:2：`int fd = socket(AF_INET, SOCK_STREAM, 0);`",
    'src/p.rs:1：`let o = Command::new("ls").output();`',
    "src/p.rs:2：`let s = TcpStream::connect(addr);`",
    'src/p.ts:1：`import { exec } from "child_process";`',
    'src/p.ts:2：`exec("ls");`',
    "src/p.ts:3：`const r = await fetch(url);`",
    'src/p.ts:4：`Bun.spawnSync(["git"]);`',
  ]);
});

test("only added lines count: a moved line is not new", () => {
  commit(wt, { "src/c.ts": 'const x = 1;\nspawn("a");\nfetch(a);\n' }); // fetch moved to the end
  expect(clues()).toEqual({ imports: noClues, calls: noClues });
  commit(wt, { "src/c.ts": 'const x = 1;\nspawn("a");\nfetch(a);\nfetch(b);\n' });
  expect(clues().calls.source).toEqual(["src/c.ts:4：`fetch(b);`"]);
});

test("test files are listed apart from source files", () => {
  commit(wt, {
    "src/s.ts": 'fetch("/a");\n',
    "test/t.test.ts": 'import { z } from "zod";\nfetch("/b");\n',
    "tests/it.rs": 'use mockito::Server;\nlet o = Command::new("x");\n',
    "src/util_test.c": "#include <cmocka.h>\n",
  });
  const { imports, calls } = clues();
  expect(calls.source).toEqual(['src/s.ts:1：`fetch("/a");`']);
  expect(calls.test).toEqual(['test/t.test.ts:2：`fetch("/b");`', 'tests/it.rs:2：`let o = Command::new("x");`']);
  expect(imports.source).toEqual([]);
  expect(imports.test).toEqual(["src/util_test.c:1：`#include <cmocka.h>`", 'test/t.test.ts:1：`import { z } from "zod";`', "tests/it.rs:1：`use mockito::Server;`"]);
});

test("the empty case says so in the report, and every list says it is only a clue", () => {
  commit(wt, { "src/e.ts": "export const e = 1;\n" });
  const { imports, calls } = clues();
  expect(imports).toEqual(noClues);
  const md = renderReport({
    goal: "x", head: "a".repeat(40), base: "b".repeat(40), trialMerge: "c".repeat(40), tasks: [], testCommand: "t", testCode: 0, testOut: "", testErr: "",
    logPath: "/l", sensitive: [], deps: [], kinds: [], newImports: imports, newCalls: { ...calls, source: ["src/p.ts:2：`fetch(u)`"] }, shelved: [], knownIssues: [],
  });
  expect(md).toContain("新 import");
  expect(md).toMatch(/源码：\n\n- 没有\n\n测试文件：\n\n- 没有/);
  expect(md).toContain("- src/p.ts:2：`fetch(u)`");
  expect(md.match(/只是线索/g)!.length).toBeGreaterThanOrEqual(3);
});

test("what a line imports", () => {
  expect(importedModules("a.ts", 'export * from "./x";')).toEqual(["./x"]);
  expect(importedModules("a.ts", '} from "pkg";')).toEqual(["pkg"]);
  expect(importedModules("a.ts", 'import "side";')).toEqual(["side"]);
  expect(importedModules("a.ts", 'const m = await import("dyn");')).toEqual(["dyn"]);
  expect(importedModules("a.ts", "const important = 1;")).toEqual([]);
  expect(importedModules("a.rs", "use std::io::*;")).toEqual(["std::io"]);
  expect(importedModules("a.rs", "pub use a::b::C as D;")).toEqual(["a::b"]);
  expect(importedModules("a.rs", "use std::{")).toEqual(["std"]);
  expect(importedModules("a.c", "# include <sys/socket.h>")).toEqual(["sys/socket.h"]);
  expect(importedModules("a.py", "import os")).toEqual([]);
});
