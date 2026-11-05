export type Row = {
  key: string; tasks: number; withCommits: number; landed: number; landedRate: number | null; mature: number;
  reworkRate: number | null; revertRate: number | null; ci: number; ciPassRate: number | null; costPerTask: number;
  costPerLanded: number | null; codexMTokPerTask: number; promptsPerTask: number; interruptsPerTask: number;
  waitMinPerTask: number; linesLandedPerTask: number | null; exactShare: number | null;
};
export function aggregate<T>(tasks: T[], keyOf: (t: T) => string): Row[];
