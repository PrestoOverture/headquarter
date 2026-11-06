import type { Task } from "./link";
export type Bucket = "week" | "4week";
export type Metric = "output" | "input";
export type Switch = { vendor: string; at: number; old: string; model: string };
export type Point = { at: number; n: number; mature: number; k: number; rework: number | null; median: number | null };
export function bucketAt(at: number, bucket?: Bucket): number;
export function modelSwitches(tasks: Task[], bucket?: Bucket): Switch[];
export function trend(tasks: Task[], bucket?: Bucket, metric?: Metric): {
  vendors: string[]; buckets: number[]; series: { vendor: string; points: Point[] }[]; switches: Switch[];
};
