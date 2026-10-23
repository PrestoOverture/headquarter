import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { check, compressedBytes, EXTRACT_FACTOR, excludedReport, type Manifest, platformDigest, repository } from "../src/disk";
import { markdown, summarize } from "../src/summarize";

const GB = 1e9;
const image = { layers: [{ size: 1_000_000_000 }, { size: 2_000_000_000 }, { size: 500_000_000 }] };
const list: Manifest = {
  manifests: [
    { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64", variant: "v8" } },
    { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
    { digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" } },
  ],
};

describe("size estimate", () => {
  test("compressed layers are summed", () => {
    expect(compressedBytes(image)).toBe(3.5 * GB);
  });
  test("a manifest list has no layers; the platform's entry is picked by digest", () => {
    expect(compressedBytes(list)).toBeNull();
    expect(platformDigest(list, "linux/amd64")).toBe("sha256:amd");
    expect(platformDigest(list, "linux/arm64")).toBe("sha256:arm");
    expect(platformDigest(list, "linux/s390x")).toBeNull();
  });
  test("the repository is the image name without tag or digest", () => {
    expect(repository("ghcr.io/org/img:tag")).toBe("ghcr.io/org/img");
    expect(repository("localhost:5000/img")).toBe("localhost:5000/img");
    expect(repository("org/img:t@sha256:abc")).toBe("org/img");
  });
  test("a docker v2 manifest file", () => {
    const m: Manifest = JSON.parse(readFileSync(new URL("fixtures/manifest.json", import.meta.url), "utf8"));
    expect(compressedBytes(m)).toBe(1_234_567_890 + 98_765_432 + 3_000);
  });
});

describe("fit decision", () => {
  test("needs the compressed size times 2.5", () => {
    expect(EXTRACT_FACTOR).toBe(2.5);
    expect(check(10 * GB, 25 * GB).check).toMatchObject({ compressed_bytes: 10 * GB, needed_bytes: 25 * GB, free_bytes: 25 * GB, factor: 2.5 });
  });
  test("exactly enough fits, one byte less does not", () => {
    expect(check(10 * GB, 25 * GB).fits).toBe(true);
    expect(check(10 * GB, 25 * GB - 1).fits).toBe(false);
  });
  test("the runner is recorded when known", () => {
    expect(check(1, 1, "ubuntu-latest").check.runner).toBe("ubuntu-latest");
    expect("runner" in check(1, 1).check).toBe(false);
  });
});

describe("excluded_disk in the summary", () => {
  const excluded = excludedReport({ instance_id: "big", language: "c" }, check(30 * GB, 40 * GB, "ubuntu-latest").check);
  const reports = [
    { instance_id: "a", language: "c", verdict: "caught" as const },
    { instance_id: "b", language: "c", verdict: "passes_on_buggy" as const },
    excluded,
  ];
  test("counts in neither the numerator nor the denominator", () => {
    const s = summarize(reports, []);
    expect(s.graded).toBe(2);
    expect(s.caught).toBe(1);
    expect(s.catch_rate).toBe(0.5);
    expect(s.counts.excluded_disk).toBe(1);
  });
  test("is listed with its numbers", () => {
    const s = summarize(reports, []);
    expect(s.excluded_disk).toEqual([{ instance_id: "big", compressed_bytes: 30 * GB, needed_bytes: 75 * GB, free_bytes: 40 * GB, factor: 2.5, runner: "ubuntu-latest" }]);
    expect(markdown(s)).toContain("| big | 75.0 | 40.0 | ubuntu-latest |");
    expect(markdown(s)).toContain("catch rate 50.0% (1/2)");
  });
  test("a report with only excluded tasks has no rate", () => {
    expect(summarize([excluded], []).catch_rate).toBeNull();
  });
});

describe("workflow runner input", () => {
  const wf = readFileSync(new URL("../../.github/workflows/step0.yml", import.meta.url), "utf8");
  const job = (name: string) => wf.split(`\n  ${name}:\n`)[1]!.split(/\n {2}[a-z]+:\n/)[0]!;

  test("is a choice of ubuntu-latest and ubuntu-latest-16-cores, default ubuntu-latest", () => {
    expect(wf).toMatch(/\n {6}runner:\n(?: {8}.*\n)*? {8}type: choice\n(?: {8}.*\n)*? {8}options: \[ubuntu-latest, ubuntu-latest-16-cores\]\n/);
    expect(wf).toMatch(/\n {6}runner:\n(?: {8}.*\n)*? {8}default: ubuntu-latest\n/);
  });
  test("selects the runner of the write and grade jobs only", () => {
    expect(job("write")).toContain("runs-on: ${{ inputs.runner }}");
    expect(job("grade")).toContain("runs-on: ${{ inputs.runner }}");
    for (const j of ["plan", "summarize"]) expect(job(j)).toContain("runs-on: ubuntu-latest\n");
  });
  test("reaches the scripts through STEP0_RUNNER", () => {
    expect(job("write")).toContain("STEP0_RUNNER: ${{ inputs.runner }}");
    expect(job("grade")).toContain("STEP0_RUNNER: ${{ inputs.runner }}");
  });
});
