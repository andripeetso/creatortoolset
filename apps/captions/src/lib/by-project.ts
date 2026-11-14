/**
 * A list kept apart by project: what is in the project on hand, and how many of the rest each other project has (most
 * first). An item says its project (`projectId`, given by the server with the first brand's for an old one); one with
 * none, or a person in no project, is here.
 */
export function byProject<T extends { projectId?: string }>(items: T[], current: string | null): { here: T[]; elsewhere: Array<{ projectId: string; count: number }> } {
  if (!current) return { here: items, elsewhere: [] };
  const here: T[] = [];
  const counts = new Map<string, number>();
  for (const i of items) {
    if (!i.projectId || i.projectId === current) here.push(i);
    else counts.set(i.projectId, (counts.get(i.projectId) ?? 0) + 1);
  }
  return { here, elsewhere: [...counts].map(([projectId, count]) => ({ projectId, count })).sort((a, b) => b.count - a.count) };
}
