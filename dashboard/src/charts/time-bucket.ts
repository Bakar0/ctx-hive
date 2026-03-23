export type TimeWindow = "day" | "week" | "month";

export interface BucketPoint {
  label: string;
  value: number;
}

export function bucketByTime(
  timestamps: string[],
  window: TimeWindow,
): BucketPoint[] {
  const now = Date.now();
  let keys: string[];
  let bucketFn: (ts: string) => string;
  let labelFn: (k: string) => string;
  let cutoff: number;

  if (window === "day") {
    cutoff = now - 24 * 3600000;
    keys = [];
    for (let i = 23; i >= 0; i--) {
      keys.push(new Date(now - i * 3600000).toISOString().slice(0, 13));
    }
    bucketFn = (ts) => new Date(ts).toISOString().slice(0, 13);
    labelFn = (k) => k.slice(11, 13) + ":00";
  } else if (window === "week") {
    cutoff = now - 7 * 86400000;
    keys = [];
    for (let i = 6; i >= 0; i--) {
      keys.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
    }
    bucketFn = (ts) => new Date(ts).toISOString().slice(0, 10);
    labelFn = (k) =>
      new Date(k + "T12:00:00").toLocaleDateString("en", { weekday: "short" });
  } else {
    cutoff = now - 30 * 86400000;
    keys = [];
    for (let i = 29; i >= 0; i--) {
      keys.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
    }
    bucketFn = (ts) => new Date(ts).toISOString().slice(0, 10);
    labelFn = (k) => k.slice(5);
  }

  const counts: Record<string, number> = {};
  for (const k of keys) counts[k] = 0;
  for (const ts of timestamps) {
    if (new Date(ts).getTime() >= cutoff) {
      const key = bucketFn(ts);
      if (key in counts) counts[key]++;
    }
  }
  return keys.map((k) => ({ label: labelFn(k), value: counts[k] ?? 0 }));
}
