#!/bin/bash
# M0.0 probe (roadmap M0 实施计划): run by Claude's Bash tool inside the Claude Code sandbox,
# from a linked worktree of this repo. One line per check: "PASS <name>" or
# "FAIL <name>: <detail>". check.ts parses these lines from the tool result and confirms
# the denials from outside the sandbox. Allowed checks must succeed; denied checks must fail.

cd "$(git rev-parse --show-toplevel)" || exit 1
common=$(cd "$(git rev-parse --git-common-dir)" && pwd)

ok() { echo "PASS $1"; }
bad() { echo "FAIL $1: $2"; }
# allowed <name> <cmd...>: must succeed
allowed() { local n=$1; shift; local out; if out=$("$@" 2>&1); then ok "$n"; else bad "$n" "$(echo "$out" | tail -3 | tr '\n' ' ')"; fi; }
# denied <name> <cmd...>: must fail
denied() { local n=$1; shift; if "$@" >/dev/null 2>&1; then bad "$n" "allowed, expected denied"; else ok "$n"; fi; }

# --- what executors need ---
allowed tests bash -c 'cd eval && out=$(bun test 2>&1) || { echo "$out" | grep -E "\(fail\)|error" | head -3; exit 1; }'
allowed commit bash -c 'echo probe > .sandbox-probe && git add .sandbox-probe && git -c user.name=probe -c user.email=probe@invalid commit -q -m "sandbox probe"'
allowed spawn_kill bash -c 'sleep 60 & pid=$!; kill -TERM $pid; wait $pid; [ $? -eq 143 ] && ! kill -0 $pid 2>/dev/null'
allowed spawn_kill_tree bash -c 'bash -c "sleep 60 & sleep 60 & wait" & pid=$!; sleep 0.3; pkill -TERM -P $pid; kill -TERM $pid; wait $pid 2>/dev/null; sleep 0.2; ! pgrep -P $pid >/dev/null'
# Bare macOS mktemp ignores $TMPDIR and writes to /var/folders, which the sandbox denies.
allowed tmp_write bash -c 'f=$(mktemp "$TMPDIR/probe.XXXXXX") && echo x > "$f" && rm "$f"'
allowed local_listen bun -e 'const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") }); const r = await fetch(`http://127.0.0.1:${s.port}/`); s.stop(); if ((await r.text()) !== "ok") process.exit(1)'

# --- what the merge lock (M0.1) relies on ---
denied hooks_write bash -c "echo x > '$common/hooks/sandbox-probe'"
denied config_write git config --local sandbox.probe 1
denied main_update_ref git update-ref refs/heads/main HEAD
denied main_ref_file bash -c "echo 0000000000000000000000000000000000000000 > '$common/refs/heads/main'"
denied packed_refs_write bash -c "echo '# probe' >> '$common/packed-refs'"

# --- the rest of the sandbox boundary (tech_stacks.md 沙箱与安全) ---
denied home_write touch "$HOME/sandbox-probe"
# Codex's home holds its config.toml (approval and sandbox policy); no executor may write it.
if [ -d "$HOME/.codex" ]; then denied codex_home_write bash -c 'echo x > "$HOME/.codex/probe"'; rm -f "$HOME/.codex/probe"; else echo "PASS codex_home_write (no ~/.codex)"; fi
if [ -e "$HOME/.ssh" ]; then denied ssh_read ls "$HOME/.ssh"; else echo "PASS ssh_read (no ~/.ssh)"; fi
denied net_direct curl -s --max-time 5 --noproxy '*' https://example.com
denied net_proxy curl -sf --max-time 10 https://example.com
echo "DONE"
