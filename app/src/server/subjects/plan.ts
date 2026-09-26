/**
 * Forecast-plan logic (US-3.2): pure and DB-free so it is covered by plain
 * unit tests. Prerequisites / next topics are derived from the subject's
 * topic order and the `topic_dependencies` graph already built during
 * indexing (S1, `indexing_structure`) — no new AI call is needed for S2.
 *
 * Scope decision (documented in docs/STATUS.md): the plan is built within one
 * subject's topics; dependencies pointing outside it (future cross-year
 * links, ADR-021) are not resolved here yet — that is the knowledge map's
 * job (S6).
 */
export interface PlanTopicNode {
  id: string;
  title: string;
  pageFrom: number | null;
  pageTo: number | null;
  sortOrder: number;
}

export interface TopicDependencyEdge {
  topicId: string;
  dependsOnId: string;
}

export interface ForecastPlan {
  currentTopic: PlanTopicNode;
  prerequisites: PlanTopicNode[];
  next: PlanTopicNode[];
}

export const MAX_PREREQUISITES = 12;
export const MAX_NEXT_TOPICS = 6;

/**
 * Builds prerequisites (transitive `depends_on` closure of the current
 * topic, ordered by curriculum order), the current topic, and the next
 * topics in the subject's order after it.
 */
export function buildForecastPlan(
  currentTopicId: string,
  topics: PlanTopicNode[],
  dependencies: TopicDependencyEdge[],
): ForecastPlan | null {
  const byId = new Map(topics.map((t) => [t.id, t]));
  const currentTopic = byId.get(currentTopicId);
  if (!currentTopic) return null;

  const dependsOnOf = new Map<string, string[]>();
  for (const d of dependencies) {
    if (!dependsOnOf.has(d.topicId)) dependsOnOf.set(d.topicId, []);
    dependsOnOf.get(d.topicId)!.push(d.dependsOnId);
  }

  // BFS over the "depends on" graph from the current topic; cycle-safe.
  const seen = new Set<string>([currentTopicId]);
  const queue = [...(dependsOnOf.get(currentTopicId) ?? [])];
  const prerequisites: PlanTopicNode[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (node) prerequisites.push(node);
    if (prerequisites.length >= MAX_PREREQUISITES) break;
    for (const dep of dependsOnOf.get(id) ?? []) if (!seen.has(dep)) queue.push(dep);
  }
  prerequisites.sort((a, b) => a.sortOrder - b.sortOrder);

  const next = topics
    .filter((t) => t.sortOrder > currentTopic.sortOrder && !seen.has(t.id))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, MAX_NEXT_TOPICS);

  return { currentTopic, prerequisites, next };
}
