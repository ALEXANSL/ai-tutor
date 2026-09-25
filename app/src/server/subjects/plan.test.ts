import { describe, expect, it } from "vitest";
import { buildForecastPlan, MAX_NEXT_TOPICS, MAX_PREREQUISITES, type PlanTopicNode, type TopicDependencyEdge } from "./plan";

const topic = (id: string, sortOrder: number, pageFrom: number | null = null): PlanTopicNode => ({
  id,
  title: `Тема ${id}`,
  pageFrom,
  pageTo: pageFrom,
  sortOrder,
});

describe("buildForecastPlan (US-3.2 KP-1)", () => {
  it("returns null when the current topic id is unknown", () => {
    expect(buildForecastPlan("missing", [topic("a", 0)], [])).toBeNull();
  });

  it("splits topics into prerequisites (depends_on, ordered), current and next (by curriculum order)", () => {
    const topics = [topic("a", 0), topic("b", 1), topic("c", 2), topic("d", 3), topic("e", 4)];
    const deps: TopicDependencyEdge[] = [{ topicId: "c", dependsOnId: "a" }, { topicId: "c", dependsOnId: "b" }];
    const plan = buildForecastPlan("c", topics, deps);
    expect(plan?.currentTopic.id).toBe("c");
    expect(plan?.prerequisites.map((t) => t.id)).toEqual(["a", "b"]);
    expect(plan?.next.map((t) => t.id)).toEqual(["d", "e"]);
  });

  it("walks the dependency chain transitively (root-cause topics), not only direct prerequisites", () => {
    const topics = [topic("a", 0), topic("b", 1), topic("c", 2)];
    // c depends on b, b depends on a: a chain, both should surface as prerequisites.
    const deps: TopicDependencyEdge[] = [{ topicId: "c", dependsOnId: "b" }, { topicId: "b", dependsOnId: "a" }];
    const plan = buildForecastPlan("c", topics, deps);
    expect(plan?.prerequisites.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("is cycle-safe (does not loop forever on a dependency cycle)", () => {
    const topics = [topic("a", 0), topic("b", 1)];
    const deps: TopicDependencyEdge[] = [{ topicId: "a", dependsOnId: "b" }, { topicId: "b", dependsOnId: "a" }];
    const plan = buildForecastPlan("a", topics, deps);
    expect(plan?.prerequisites.map((t) => t.id)).toEqual(["b"]);
  });

  it("caps prerequisites and next topics so the plan stays readable", () => {
    const topics: PlanTopicNode[] = [];
    const deps: TopicDependencyEdge[] = [];
    for (let i = 0; i < 30; i++) topics.push(topic(`p${i}`, i));
    topics.push(topic("cur", 30));
    for (let i = 31; i < 61; i++) topics.push(topic(`n${i}`, i));
    for (let i = 0; i < 30; i++) deps.push({ topicId: "cur", dependsOnId: `p${i}` });
    const plan = buildForecastPlan("cur", topics, deps);
    expect(plan?.prerequisites.length).toBeLessThanOrEqual(MAX_PREREQUISITES);
    expect(plan?.next.length).toBe(MAX_NEXT_TOPICS);
  });

  it("returns an empty next list at the end of the textbook", () => {
    const topics = [topic("a", 0), topic("b", 1)];
    const plan = buildForecastPlan("b", topics, []);
    expect(plan?.next).toEqual([]);
    expect(plan?.prerequisites).toEqual([]);
  });
});
