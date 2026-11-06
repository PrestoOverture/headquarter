// Frozen pre-extraction dashboard trends, used only as a regression oracle.
const DAY = 86400000;
// Fixed UTC Monday anchor keeps bucket boundaries stable when filters change.
const ANCHOR = Date.UTC(1970, 0, 5);
function bucketAt(at) {
  const span = ($("bucket").value === "week" ? 7 : 28) * DAY;
  return ANCHOR + Math.floor((at - ANCHOR) / span) * span;
}
const colors = ["#387bcb", "#d07724", "#8c59b5", "#28917d", "#c45169", "#7c8234"];
const color = vendor => colors[agents.indexOf(vendor) % colors.length];
function modelSwitches(tasks) {
  const vendors = new Map();
  for (const t of tasks) {
    if (!vendors.has(t.vendor)) vendors.set(t.vendor, new Map());
    const buckets = vendors.get(t.vendor), at = bucketAt(t.start);
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

function renderTrends(ts) {
  const vendors = [...new Set(ts.map(t => t.vendor))].sort();
  $("legend").innerHTML = vendors.map(v => '<span style="border-color:' + color(v) + '">' + esc(v) + '</span>').join("");
  if (!ts.length) {
    $("trend-rework").innerHTML = $("trend-tokens").innerHTML = '<p class="n">当前筛选无任务（n=0）</p>';
    return;
  }
  const span = ($("bucket").value === "week" ? 7 : 28) * DAY;
  const starts = ts.map(t => bucketAt(t.start));
  const first = Math.min(...starts), last = Math.max(...starts);
  const buckets = [];
  for (let at = first; at <= last; at += span) buckets.push(at);
  const grouped = new Map();
  for (const t of ts) {
    const key = JSON.stringify([t.vendor, bucketAt(t.start)]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(t);
  }
  const input = $("token-metric").value === "input";
  const series = vendors.map(vendor => ({vendor, points:buckets.map(at => {
    const tasks = grouped.get(JSON.stringify([vendor, at])) || [];
    const mature = tasks.filter(t => t.landed && t.mature);
    const k = mature.filter(t => t.reworked).length;
    const values = tasks.map(t => input ? t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite : t.tokens.output).sort((a,b) => a-b);
    const mid = Math.floor(values.length / 2);
    const median = !values.length ? null : values.length % 2 ? values[mid] : (values[mid-1] + values[mid]) / 2;
    return {at, n:tasks.length, mature:mature.length, k, rework:mature.length >= 3 ? k / mature.length : null, median};
  })}));
  const left = 72, right = 840, width = right-left, height = 236;
  const step = width / buckets.length;
  const x = at => left + ((at-first) / span + 0.5) * step;
  // Put marker labels in non-overlapping lanes above the plot, on both charts.
  const lanes = [];
  const markers = $("markers").checked ? modelSwitches(ts).map(p => {
      const text = p.vendor + ": " + p.old + " → " + p.model;
      const short = text.length > 80 ? text.slice(0,77) + "…" : text;
      const labelWidth = [...short].reduce((n,c) => n + (c.charCodeAt(0) > 0x2e80 ? 12 : 7), 0);
      const labelX = Math.max(left, Math.min(x(bucketAt(p.at))+4, right-labelWidth));
      let lane = lanes.findIndex(end => end+8 < labelX);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = labelX+labelWidth;
      return {...p, text, short, labelX, labelY:42+lane*20};
    }) : [];
  const top = 64+lanes.length*20, bottom = top+height;
  const line = (x1,y1,x2,y2,attrs='') => '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" ' + attrs + '/>';
  const label = (x,y,text,attrs='') => '<text x="' + x + '" y="' + y + '" fill="currentColor" ' + attrs + '>' + esc(text) + '</text>';
  const positives = series.flatMap(s => s.points.map(p => p.median)).filter(v => v > 0);
  const low = positives.length ? Math.floor(Math.log10(Math.min(...positives))) : 0;
  const high = Math.max(low+1, positives.length ? Math.ceil(Math.log10(Math.max(...positives))) : 1);
  const maxN = Math.max(1, ...series.flatMap(s => s.points.map(p => p.mature)));
  const yToken = v => bottom - (Math.log10(v)-low) / (high-low) * height;
  for (const type of ["rework", "tokens"]) {
    const title = type === "rework" ? "A · 14 天返工率 / 成熟 n" : "B · 每任务" + (input ? "总输入（含缓存）" : "输出") + " token 中位数（对数轴）";
    let svg = '<svg viewBox="0 0 920 ' + (bottom+60) + '" role="img" aria-label="' + esc(title) + '"><title>' + esc(title) + '</title>';
    svg += label(left, 20, title);
    const immature = buckets.filter(at => at >= m.generatedAt - 14*DAY && at <= m.generatedAt);
    if (type === "rework") for (const at of immature) {
      svg += '<rect x="' + (x(at)-step/2) + '" y="' + top + '" width="' + step + '" height="' + height + '" fill="var(--warn)" opacity="0.1"/>';
    }
    if (type === "rework" && immature.length) svg += label(x(immature[0])-step/2+4, top+14, "未满 14 天");
    const ticks = type === "rework" ? [0,0.25,0.5,0.75,1] : Array.from({length:high-low+1}, (_,i) => 10**(low+i));
    for (const tick of ticks) {
      const y = type === "rework" ? bottom-tick*height : yToken(tick);
      svg += line(left,y,right,y,'stroke="var(--line)"');
      svg += label(left-8,y+4,type === "rework" ? pct(tick) : tick.toLocaleString(), 'text-anchor="end"');
      if (type === "rework") svg += label(right+8,y+4,String(Math.round(tick*maxN)));
    }
    const every = Math.max(1, Math.ceil(buckets.length / 8));
    buckets.forEach((at,i) => { if (i % every === 0) svg += label(x(at), bottom+24, day(at), 'text-anchor="middle"'); });
    for (const [vi,s] of series.entries()) {
      let previous = null;
      for (const p of s.points) {
        const title = esc(s.vendor + " · " + day(p.at) + (type === "rework" ? " · 返工 " + p.k + "/" + p.mature + "（成熟 n）" : " · 中位数 " + (p.median === null ? "–" : p.median) + " · n=" + p.n + " · 返工 " + p.k + "/" + p.mature));
        if (type === "rework" && p.mature) {
          const barWidth = Math.max(0.2, Math.min(16, step*0.65/vendors.length));
          const h = p.mature/maxN*height;
          svg += '<rect data-series="mature" x="' + (x(p.at)+(vi-vendors.length/2)*barWidth) + '" y="' + (bottom-h) + '" width="' + barWidth + '" height="' + h + '" fill="' + color(s.vendor) + '" opacity="0.18"><title>' + title + '</title></rect>';
        }
        const value = type === "rework" ? p.rework : p.median;
        if (value === null || (type === "tokens" && value <= 0)) { previous = null; continue; }
        const point = {x:x(p.at), y:type === "rework" ? bottom-value*height : yToken(value)};
        if (previous) svg += line(previous.x,previous.y,point.x,point.y,'stroke="' + color(s.vendor) + '" stroke-width="2"');
        svg += '<circle data-series="' + type + '" cx="' + point.x + '" cy="' + point.y + '" r="4" fill="' + color(s.vendor) + '"><title>' + title + '</title></circle>';
        previous = point;
      }
    }
    for (const p of markers) {
      const at = bucketAt(p.at);
      svg += '<g data-model-marker="' + esc(p.text) + '"><title>' + esc(p.text + " · 主模型切换 " + day(p.at)) + '</title>' +
        line(x(at),p.labelY+4,x(at),bottom,'stroke="' + color(p.vendor) + '" stroke-dasharray="5 4"') +
        label(p.labelX,p.labelY,p.short) + '</g>';
    }
    svg += '</svg>';
    $(type === "rework" ? "trend-rework" : "trend-tokens").innerHTML = svg;
  }
}

