import { describe, expect, it } from "vitest";
import { cpuScale, elevatedCpu, mergeResources, resourceSeries, type ResourceSnapshot } from "../src/app/shell/resources/resource-data";
const time = "2026-09-25T12:00:00Z";
function snapshot(): ResourceSnapshot {
  return { runId: "one", now: time, logicalProcessors: 8, history: [{ timestamp: time, services: [
    { appId: "a", service: "web", runtime: "localCommand", timestamp: time, cpuPercent: 20, memoryBytes: 100 },
    { appId: "a", service: "api", runtime: "docker", timestamp: time, cpuPercent: 40, memoryBytes: 200 },
    { appId: "b", service: "api", runtime: "docker", timestamp: time, cpuPercent: 80, memoryBytes: 400 },
    { appId: "hosty.core", service: "core", runtime: "core", timestamp: time, cpuPercent: 5, memoryBytes: 50 },
  ] }] };
}
describe("runtime resources", () => {
  it("aggregates services, apps and fleet while excluding Core", () => {
    const data = snapshot();
    expect(resourceSeries(data, "a")[0]).toMatchObject({ cpu: 60, memory: 300 });
    expect(resourceSeries(data, "a", "api")[0]).toMatchObject({ cpu: 40, memory: 200 });
    expect(resourceSeries(data)[0]).toMatchObject({ cpu: 140, memory: 700 });
    expect(cpuScale(data)).toBe(200);
  });
  it("does not turn missing or stale service readings into zeros or partial totals", () => {
    const data = snapshot();
    data.history[0].services[0].cpuPercent = null;
    data.history[0].services[2].cpuPercent = 250;
    expect(cpuScale(data)).toBe(300);
    expect(resourceSeries(data, "a")[0].cpu).toBeNull();
    expect(resourceSeries(data, "absent")[0].memory).toBeNull();
    data.history[0].services[0].timestamp = "2026-09-25T11:59:00Z";
    expect(resourceSeries(data, "a")[0].memory).toBeNull();
  });
  it("resets on Core restart and bounds retained history", () => {
    const old = snapshot();
    expect(mergeResources(old, { ...snapshot(), runId: "two", history: [] }).history).toEqual([]);
    expect(mergeResources(old, snapshot()).history).toHaveLength(1);
    expect(mergeResources(old, { ...snapshot(), now: "2026-09-25T12:06:00Z", history: [] }).history).toEqual([]);
  });
  it("requires a substantial sustained increase, not a tiny relative jump", () => {
    const points = Array.from({ length: 13 }, (_, i) => ({ timestamp: i, cpu: i < 10 ? 2 : 20, memory: 1 }));
    expect(elevatedCpu(points)).toBe(true);
    expect(elevatedCpu(points.map(p => ({ ...p, cpu: p.cpu / 100 })))).toBe(false);
    points[12].cpu = 2;
    expect(elevatedCpu(points)).toBe(false);
  });
});
