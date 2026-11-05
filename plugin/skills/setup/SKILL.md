---
name: setup
description: "Prepare the current repository for hq: check the hq launcher is installed, install the main-ref guard hook, and write .hq.json with the full-test command. Use when the user wants to start using hq in a repository."
---

# Set up this repository for hq

Work in the repository the user is in. Do these steps in order and stop at the first one that fails.

1. Check that `~/.hq/bin/hq` exists (`test -x ~/.hq/bin/hq`). If it does not, tell the user to run `bun hq/src/cli.ts install` in the headquarter repository, then to come back and run this skill again. Do not install it yourself.
2. Run `~/.hq/bin/hq install-hook` in the repository. It installs the guard that stops anything but an approved `hq merge` from moving main. Report what it printed.
3. Check whether `.hq.json` exists at the repository root. If it does, show it, say it is kept as it is, and skip to step 6. Never overwrite or edit an existing `.hq.json`.
4. Find the repository's full-test command: look at package.json scripts, a Makefile, CI config and the README. Propose one command that runs every test from the repository root, and ask the user to confirm or change it. Do not write the file before they agree.
5. Write `.hq.json` with the agreed command, as an object with one key, `test`. hq reads it from main, so it takes effect once it is committed to main. Committing to main is the user's to do (it needs `HQ_ALLOW_MAIN=1`, which is theirs to set); do not commit it to main yourself.
6. Say the repository is ready and that the `goal` skill is next.

Use `~/.hq/bin/hq` for every hq command.
