You are working in a checkout of the {repo} repository at {workdir}. A user reported the issue below. Do not fix it. Your job is to write tests that expose it.

The repository's build environment exists only inside a Docker container, where this checkout is mounted at /testbed. To run anything that needs that environment (compilers, the test suite), use:

    {envrun} '<shell command>'

It runs the command from /testbed inside the container. The container has no network access. Read and edit files directly in {workdir}.

Requirements:

1. Your tests must fail on the current code, and they must fail because an assertion about the behavior the issue describes does not hold. A build error, a missing symbol or an unrelated failure does not count.
2. The same tests must pass once the issue is correctly fixed, by any reasonable fix. Test the behavior the issue describes, not one particular implementation.
3. Put the tests where this project keeps its tests and follow its conventions. You may add test files or add cases to existing test files. Do not change any non-test source code: a submission that changes the code under test is invalid.
4. Write `.step0/run_tests.sh` at the repository root: a bash script that, run from /testbed inside the container, runs only your new tests and exits 0 if and only if all of them pass. It must finish within 20 minutes. Before running it, the grader runs the project's build commands in a fresh container:

{rebuild_cmds}

5. Before you finish, run `{envrun} 'bash .step0/run_tests.sh'` and confirm it fails on the current code for the reason in requirement 1.

How to keep the tests tied to the issue:

- Assert only the behavior the issue describes. Do not assert representation details it does not state: for example `1` versus `1.0`, exact whitespace, quoting or message wording. Compare values in a form that holds for any reasonable fix.
- Reproduce the issue as it is written. Do not extend its reproduction with inputs or cases it does not mention: the fix is only required to cover what the issue describes.
- Use the code's public interfaces, the ones the issue and the existing tests use. Never guess an internal function, method or class name; if you cannot find it in the source, do not call it.
- Before you use a test library or helper, check that it is already available offline in the container (installed packages, the local dependency cache). The container has no network, so a missing dependency breaks the build on both the buggy and the fixed code.

Your submission is the final state of the working tree when you stop.

<issue>
{problem_statement}
</issue>
