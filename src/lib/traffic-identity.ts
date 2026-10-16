/** Shared by the feed and its UI. A timestamp and route are not a request ID. */
type EventIdentity = {
  rid?: string | null;
  ts: number | null;
  service: string;
  method: string;
  path: string;
  model?: string | null;
  target?: string | null;
  caller?: string | null;
  source: string;
};

export function trafficIdentity(event: EventIdentity): string {
  return event.rid
    ? JSON.stringify(["rid", event.rid])
    : JSON.stringify(["legacy", event.ts, event.service, event.method, event.path, event.model ?? null, event.target ?? null, event.caller ?? null, event.source]);
}

/** Assign before filtering/sorting so legacy collisions retain separate rows. */
export function keyTrafficEvents<T extends EventIdentity>(events: T[]): Array<T & { uiKey: string }> {
  const occurrences = new Map<string, number>();
  return events.map(event => {
    const identity = trafficIdentity(event);
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    return { ...event, uiKey: JSON.stringify([identity, occurrence]) };
  });
}

/** The live copy wins over its persisted copy, including pending updates. */
export function mergeTrafficHistory<T extends EventIdentity>(live: T[], stored: T[]): T[] {
  const seen = new Set(live.map(trafficIdentity));
  const result = [...live];
  for (const event of stored) {
    const identity = trafficIdentity(event);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(event);
  }
  return result.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
}
