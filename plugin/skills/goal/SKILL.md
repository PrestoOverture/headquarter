---
name: goal
description: Take a goal through the hq flow: write acceptance criteria with the user, start the goal branch, run each task in a sandboxed session, run the gates, and ask the user to approve and merge in a terminal. Use when the user wants to build a feature or fix with hq.
---

# Take a goal from criteria to merge

Use `~/.hq/bin/hq` for every hq command; if it is missing, send the user to the `setup` skill. Goal names are lowercase letters, digits and dashes. Run hq commands from the main checkout; the goal's files live in its worktree, `<repo>.goals/<goal>`.

You never approve, never merge and never edit main yourself. Those two steps are the user's, in a terminal.

## 1. Acceptance criteria

Agree the goal file with the user before anything is created. Ask until each criterion is something a test or a command can decide. Draft it as JSON and show it:

- a one-task goal: `{"title": "...", "acceptance": ["..."], "scope": "<dir>", "check": "<command>"}`
- a multi-task goal: `{"title": "...", "acceptance": ["goal-level criteria"], "tasks": {"<task>": {"title": "...", "acceptance": ["..."], "scope": "<dir>", "check": "<command>"}}}`

`scope` defaults to the repository root and `check` to the scope's tests plus the type check. Task criteria that serve a goal criterion can be written `{"text": "...", "traces": "g1"}` (the goal's criteria are g1, g2, ...); `hq trace <goal>` checks that every one is traced.

## 2. Start the goal

Run `hq goal new <goal> --title "<title>"`. Then write the agreed JSON to `goals/<goal>.json` in the goal's worktree and commit it there on `goal/<goal>`.

## 3. Work

For a one-task goal run `hq work <goal>`. For a multi-task goal run `hq work <goal> --task <task>` for each task in order, finishing the gates of a task (step 4) before the next. `hq work` starts a separate sandboxed `claude -p` session in the worktree and records the task start and cost. A non-zero exit means the session ended on an error or a usage limit: show the user the message and ask before running again. To send rework, write the failed criteria and findings to a notes file and pass `--notes <file>`.

The task id is the `--task` name, or the goal name for a one-task goal. Commit nothing yourself in the worktree beyond the goal file; the work session's commits are the work.

## 4. Gates

Run these for each task and record each result with `hq task gate <task> <gate> <pass|fail>`. A failing gate goes back to step 3 with notes; do not record a pass you did not see.

1. `self_test`: run the task's `check` command in the worktree. Record `hq task gate <task> self_test <pass|fail>`.
2. `codex_review`: `hq review <goal> --task <task>`. It runs Codex and records the gate itself, so do not record it again.
3. `claude_diff`: a review by a session that is not the author. Do not read the diff and judge it in this session. Start a fresh one, read-only, in the worktree, and have it read the diff against the task's base:

   `git diff <base>..goal/<goal> | claude -p --no-session-persistence --allowedTools Read Grep Glob "Review this diff line by line against these acceptance criteria: <criteria>. Report each real defect with file and line. Finish with exactly PASS or FAIL."`

   Record the verdict with `hq task gate <task> claude_diff <pass|fail> --note "<one-line summary>"`.
4. `full_tests`: once every task is done, run `hq report <goal>`. It makes the five-column report and runs the full tests on a trial merge with the latest main. Record `hq task gate <last-task> full_tests <pass|fail>` from its result.

## 5. Hand over

When the report is green, give the user the goal name and ask them to run these two commands themselves, in a terminal, one after the other:

```
hq approve <goal>
hq merge <goal>
```

`hq approve` reads from the terminal and cannot be run from this session. Do not try to get around that, do not set `HQ_ALLOW_MAIN`, and do not move main by any other route. If the user comes back with a merge refusal, read it with them and fix the cause on the goal branch; then start again from step 4 for the new commit.
