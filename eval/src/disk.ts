// Disk preflight for the write and grade jobs: a task image that cannot fit on the runner
// is excluded (verdict excluded_disk) instead of failing the job with "no space left on
// device". The estimate is the registry manifest's compressed layers summed, times
// EXTRACT_FACTOR for unpacking, against the free space on Docker's data root.

import { run } from "./sh";

export const EXTRACT_FACTOR = 2.5;

type Descriptor = { digest?: string; size?: number; platform?: { os?: string; architecture?: string; variant?: string } };
export type Manifest = { layers?: Descriptor[]; manifests?: Descriptor[] };

export type DiskCheck = {
  compressed_bytes: number;
  needed_bytes: number; // compressed_bytes × factor
  free_bytes: number;
  factor: number;
  runner?: string;
};

/** Sum of the compressed layer sizes of a single-image manifest; null for a manifest list. */
export function compressedBytes(manifest: Manifest): number | null {
  if (!manifest.layers) return null;
  return manifest.layers.reduce((n, l) => n + (l.size ?? 0), 0);
}

/** The digest of the entry for `platform` ("linux/amd64", "linux/arm64/v8") in a manifest list. */
export function platformDigest(list: Manifest, platform: string): string | null {
  const [os, arch, variant] = platform.split("/");
  const m = list.manifests?.find((e) => e.platform?.os === os && e.platform?.architecture === arch && (!variant || !e.platform?.variant || e.platform.variant === variant));
  return m?.digest ?? null;
}

export function check(compressed: number, free: number, runner?: string): { fits: boolean; check: DiskCheck } {
  const needed = Math.ceil(compressed * EXTRACT_FACTOR);
  return { fits: needed <= free, check: { compressed_bytes: compressed, needed_bytes: needed, free_bytes: free, factor: EXTRACT_FACTOR, ...(runner ? { runner } : {}) } };
}

/** `repo` of `repo:tag` or `repo@sha256:…`, for addressing one manifest of the same repository by digest. */
export function repository(image: string): string {
  const noDigest = image.split("@")[0]!;
  const colon = noDigest.lastIndexOf(":");
  return colon > noDigest.lastIndexOf("/") ? noDigest.slice(0, colon) : noDigest;
}

function manifestOf(ref: string): Manifest | null {
  const r = run(["docker", "manifest", "inspect", ref]);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

/** Compressed size of the image for `platform`, from the registry; null when the registry does not say. */
export function registrySize(image: string, platform: string): number | null {
  let manifest = manifestOf(image);
  if (manifest?.manifests) {
    const digest = platformDigest(manifest, platform);
    manifest = digest ? manifestOf(`${repository(image)}@${digest}`) : null;
  }
  return manifest ? compressedBytes(manifest) : null;
}

/** Free bytes on the filesystem holding Docker's data root; null when it cannot be read. */
export function freeBytes(): number | null {
  const root = run(["docker", "info", "--format", "{{.DockerRootDir}}"]);
  if (root.code !== 0 || !root.out.trim()) return null;
  const df = run(["df", "-Pk", root.out.trim()]);
  const avail = Number(df.out.trim().split("\n").at(-1)?.trim().split(/\s+/)[3]);
  return df.code === 0 && Number.isFinite(avail) ? avail * 1024 : null;
}

/**
 * Whether the image for `platform` is already in Docker's local store, so a pull adds
 * nothing. A partly present image (some layers) counts as absent: the full estimate stays,
 * which is conservative. An older Docker that rejects `--platform` here also reads as absent.
 */
export function cachedLocally(image: string, platform: string, exec: (cmd: string[]) => { code: number } = run): boolean {
  return exec(["docker", "image", "inspect", "--platform", platform, image]).code === 0;
}

type Probes = { cached: typeof cachedLocally; size: typeof registrySize; free: typeof freeBytes };

/**
 * Whether the image fits on this runner. Returns the numbers when it does not. An image
 * already present locally is never excluded. When the size or the free space cannot be
 * read, the pull goes ahead: a broken preflight must not exclude a task.
 */
export function excludedForDisk(
  image: string,
  platform: string,
  runner = process.env.STEP0_RUNNER,
  probes: Probes = { cached: cachedLocally, size: registrySize, free: freeBytes },
): DiskCheck | null {
  if (probes.cached(image, platform)) {
    console.log("disk preflight skipped: image already present locally");
    return null;
  }
  const compressed = probes.size(image, platform);
  const free = probes.free();
  if (compressed === null || free === null) {
    console.log(`disk preflight skipped: ${compressed === null ? "image size" : "free space"} unknown`);
    return null;
  }
  const { fits, check: c } = check(compressed, free, runner);
  console.log(`disk preflight: needs ${gb(c.needed_bytes)} GB (${gb(compressed)} GB compressed × ${EXTRACT_FACTOR}), ${gb(free)} GB free${fits ? "" : ": excluded_disk"}`);
  return fits ? null : c;
}

export const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

/** The report.json of a task whose image did not fit. */
export function excludedReport(task: { instance_id: string; language: string }, disk: DiskCheck) {
  return { instance_id: task.instance_id, language: task.language, verdict: "excluded_disk" as const, graded_at: new Date().toISOString(), disk };
}
