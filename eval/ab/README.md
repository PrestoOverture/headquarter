# Writer prompt A/B

Does `writer_prompt_v2.md` fix step 0's misses without breaking what v1 caught?

- `missed.txt`: the 9 tasks v1 missed in the full run (all `fails_on_fixed`).
- `controls.txt`: 9 tasks v1 caught, to see whether v2 breaks any.

## Run it

1. Dispatch the `step0` workflow with `prompt=v2` and `ids` set to the JSON array of both lists, 18 ids. `model` should be the one the v1 run used (the default, Sonnet):

   ```sh
   ids=$(cat eval/ab/missed.txt eval/ab/controls.txt | jq -R . | jq -sc .)
   gh workflow run step0.yml -f prompt=v2 -f ids="$ids"
   ```

2. Download the run's `step0-results` artifact. If a task was regraded or rerun, merge all the v2 runs; the latest grade of each id wins:

   ```sh
   cd eval
   bun src/merge-runs.ts v2-merged <run dir>...
   ```

3. Compare against the v1 merge (the merge of the full v1 runs), restricted to the 18 ids:

   ```sh
   cat ab/missed.txt ab/controls.txt > ab/ids.txt
   bun src/ab.ts v1-merged v2-merged --ids ab/ids.txt
   ```

   Drop `--ids` to compare every id found in either directory.

## Reading the output

- fixed: a miss in A, caught in B. broken: caught in A, a miss in B. unchanged: the rest.
- Catch rates are over the ids graded on both sides. An id with no grade on a side (no report, or `grade_error`) is listed under "Not counted" and is in no count or rate.
- With the lists above, fixed should come from `missed.txt` and broken from `controls.txt`. The controls are all caught in v1, so their A rate is 100%.
- One run per task, and the writer is not deterministic: a few fixed or broken tasks can be noise. Rerun v2 and merge to see which changes hold.
