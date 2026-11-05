# hq plugin

A Claude Code plugin that drives the hq goal flow (goal, work in a separate sandboxed session, gates, report, your approval, merge). The directory is a local marketplace and a plugin in one.

## Install

hq itself must be installed first, from the headquarter repository: `bun hq/src/cli.ts install` (puts the launcher at `~/.hq/bin/hq`).

Then, in Claude Code or a terminal:

```
claude plugin marketplace add <path to headquarter>/plugin
claude plugin install hq@headquarter
```

To check the package without installing it: `claude plugin validate plugin`.

## Skills

| Skill | What it does |
| --- | --- |
| `setup` | Prepares the current repository: checks `~/.hq/bin/hq` exists (otherwise tells you how to install it), runs `hq install-hook`, and writes `.hq.json` with the full-test command you agree on. An existing `.hq.json` is never overwritten. |
| `goal` | Walks one goal through the flow: writes the acceptance criteria in `goals/<goal>.json` with you (several tasks go under `tasks`), `hq goal new`, `hq work` per task, then the gates: the task's check (`self_test`), `hq review` (Codex), a review of the diff by a fresh Claude session that is not the author, and `hq report` (full tests). Each gate is recorded with `hq task gate`. |

In Claude Code they are `/hq:setup` and `/hq:goal`.

## What stays manual

Approval and merge are yours. The `goal` skill ends by asking you to run these in a terminal:

```
hq approve <goal>
hq merge <goal>
```

`hq approve` reads the goal name you type from the terminal, so a Claude session cannot run it. The skills never approve, never merge, and never edit main; the main-ref guard hook (`hq install-hook`) refuses it anyway. Committing `.hq.json` to main after `setup` is also yours.
