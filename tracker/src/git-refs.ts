// Exclude metadata refs from --all walks while retaining Git's object replacement behavior.
export const WORK_REF_EXCLUDES = [
  "--exclude=refs/stash",
  "--exclude=refs/notes/*",
  "--exclude=refs/original/*",
  "--exclude=refs/replace/*",
];
