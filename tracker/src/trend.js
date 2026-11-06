// Shared by the offline dashboard and MCP. Keep chart point semantics unchanged.
const DAY = 86400000;
// Fixed UTC Monday anchor keeps bucket boundaries stable when filters change.
const ANCHOR = Date.UTC(1970, 0, 5);
export function bucketAt(at, bucket = "4week") {
  const span = (bucket === "week" ? 7 : 28) * DAY;
  return ANCHOR + Math.floor((at - ANCHOR) / span) * span;
}
export function modelSwitches(tasks, bucket = "4week") {
  const vendors = new Map();
  for (const t of tasks) {
    if (!vendors.has(t.vendor)) vendors.set(t.vendor, new Map());
    const buckets = vendors.get(t.vendor), at = bucketAt(t.start, bucket);
    if (!buckets.has(at)) buckets.set(at, new Map());
    const counts = buckets.get(at), model = t.model || "?";
    counts.set(model, (counts.get(model) || 0) + 1);
  }
  const switches = [];
  for (const [vendor, buckets] of vendors) {
    let previous = null;
    for (const [at, counts] of [...buckets].sort((a,b) => a[0]-b[0])) {
      const ranked = [...counts].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
      const model = counts.get(previous) === ranked[0][1] ? previous : ranked[0][0];
      if (previous !== null && model !== previous) switches.push({vendor, at, old:previous, model});
      previous = model;
    }
  }
  return switches.sort((a,b) => a.at-b.at || a.vendor.localeCompare(b.vendor));
}

export function trend(ts, bucket = "4week", metric = "output") {
  const vendors = [...new Set(ts.map(t => t.vendor))].sort();
  if (!ts.length) return {vendors, buckets:[], series:[], switches:[]};
  const span = (bucket === "week" ? 7 : 28) * DAY;
  const starts = ts.map(t => bucketAt(t.start, bucket));
  const first = Math.min(...starts), last = Math.max(...starts);
  const buckets = [];
  for (let at = first; at <= last; at += span) buckets.push(at);
  const grouped = new Map();
  for (const t of ts) {
    const key = JSON.stringify([t.vendor, bucketAt(t.start, bucket)]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(t);
  }
  const input = metric === "input";
  const series = vendors.map(vendor => ({vendor, points:buckets.map(at => {
    const tasks = grouped.get(JSON.stringify([vendor, at])) || [];
    const mature = tasks.filter(t => t.landed && t.mature);
    const k = mature.filter(t => t.reworked).length;
    const values = tasks.map(t => input ? t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite : t.tokens.output).sort((a,b) => a-b);
    const mid = Math.floor(values.length / 2);
    const median = !values.length ? null : values.length % 2 ? values[mid] : (values[mid-1] + values[mid]) / 2;
    return {at, n:tasks.length, mature:mature.length, k, rework:mature.length >= 3 ? k / mature.length : null, median};
  })}));
  return {vendors, buckets, series, switches:modelSwitches(ts, bucket)};
}
