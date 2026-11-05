import { type Session } from './types';

/** Slice a session's accounting at prompt boundaries following a linked commit. */
export function splitEpisodes(s: Session, commits: { at: number; sessionStart?: number }[]): Session[] {
  const prompts = s.events.filter(e => e.humanPrompts).map(e => e.at).sort((a,b) => a-b);
  const starts = [prompts[0] ?? s.start];
  for (const prompt of prompts.slice(1)) {
    if (commits.some(c => c.at >= starts.at(-1)! && c.at < prompt && (c.sessionStart === undefined || c.sessionStart >= starts.at(-1)!))) starts.push(prompt);
  }
  return starts.map((start, i) => {
    const next = starts[i+1] ?? Infinity;
    const times = s.times.filter(t => t >= (i ? start : -Infinity) && t < next);
    const events = s.events.filter(e => e.at >= (i ? start : -Infinity) && e.at < next);
    const sum = (key: 'humanPrompts'|'interrupts'|'waitMs'|'usage'|'input'|'cached'|'output') => events.reduce((n,e) => n+(e[key] ?? 0),0);
    const totalUsage = s.events.reduce((n,e) => n+(e.usage ?? 0),0);
    return { ...s, id: `${s.id}/episode-${i+1}`, start, end: i === starts.length-1 ? s.end : (times.at(-1) ?? start), times,
      events, humanPrompts: sum('humanPrompts'), interrupts: sum('interrupts'), waitMs: sum('waitMs'),
      costUSD: (s.costUSD ?? 0) * (totalUsage ? sum('usage')/totalUsage : 1/starts.length),
      tokens: s.tokens ? {input: sum('input'), cached: sum('cached'), output: sum('output')} : undefined,
    };
  });
}
