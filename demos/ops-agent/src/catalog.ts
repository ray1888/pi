import { ToolFailure, wait } from "./failures.js";

export type SimulatedStatus = "healthy" | "degraded" | "unknown";
export type Symptom = "none" | "slow_downstream" | "own_5xx" | "insufficient";

export interface SimulatedHealth {
  readonly source: "simulated-local";
  readonly kind: "health";
  readonly serviceId: ServiceId;
  readonly status: SimulatedStatus;
  readonly symptom: Symptom;
  readonly httpStatus: number;
  readonly latencyMs: number;
  readonly note: string;
}

interface ServiceSpec {
  readonly status: SimulatedStatus;
  readonly httpStatus: number;
  readonly latencyMs: number;
  readonly note: string;
  readonly failBeforeSuccess?: number;
  readonly delayMs?: number;
  readonly firstDelayMs?: number;
  readonly symptom?: Symptom;
  readonly unclearUntilRead?: number;
  readonly dependencies?: readonly { readonly id: string; readonly status: "healthy" | "unavailable" }[];
  readonly errorLines?: readonly string[];
}

const SPECS: { readonly [name: string]: ServiceSpec } = {
  "checkout-api": {
    status: "healthy",
    httpStatus: 200,
    latencyMs: 12,
    note: "模拟：错误率在阈值内",
  },
  payments: {
    status: "degraded",
    httpStatus: 200,
    latencyMs: 840,
    note: "模拟：延迟升高，没有真实告警",
    symptom: "slow_downstream",
    dependencies: [{ id: "ledger", status: "unavailable" }],
    errorLines: ["payments 本地日志没有 Exception"],
  },
  inventory: {
    status: "healthy",
    httpStatus: 200,
    latencyMs: 40,
    note: "模拟：前两次上游返回 503，之后恢复",
    failBeforeSuccess: 2,
  },
  ledger: {
    status: "healthy",
    httpStatus: 200,
    latencyMs: 15,
    note: "模拟：上游一直 503，用来观察重试耗尽",
    failBeforeSuccess: 100,
  },
  "slow-probe": {
    status: "healthy",
    httpStatus: 200,
    latencyMs: 5,
    note: "模拟慢读，用来观察取消",
    delayMs: 400,
  },
  "slow-then-fast": {
    status: "healthy",
    httpStatus: 200,
    latencyMs: 9,
    note: "模拟：第一次读超过单次时限，之后立即返回",
    firstDelayMs: 80,
  },
  "edge-api": {
    status: "degraded",
    httpStatus: 500,
    latencyMs: 120,
    note: "模拟：自身 5xx 升高",
    symptom: "own_5xx",
    dependencies: [{ id: "payments", status: "healthy" }],
    errorLines: ["edge-api NullPointerException at Handler.java:40"],
  },
  "partial-api": {
    status: "degraded",
    httpStatus: 500,
    latencyMs: 80,
    note: "模拟：再次观察后看到 5xx",
    symptom: "own_5xx",
    unclearUntilRead: 2,
    dependencies: [{ id: "payments", status: "healthy" }],
    errorLines: ["partial-api NullPointerException at Handler.java:12"],
  },
};

export type ServiceId = string & { readonly __brand: "ServiceId" };

export function isServiceId(value: string): value is ServiceId {
  return Object.hasOwn(SPECS, value);
}

export function parseServiceId(value: string): ServiceId | undefined {
  return isServiceId(value) ? value : undefined;
}

export interface ServiceListing {
  readonly source: "simulated-local";
  readonly kind: "listing";
  readonly services: readonly { readonly serviceId: ServiceId; readonly status: SimulatedStatus }[];
}

export interface DependencyReport {
  readonly source: "simulated-local";
  readonly kind: "dependencies";
  readonly serviceId: ServiceId;
  readonly dependencies: readonly { readonly id: string; readonly status: "healthy" | "unavailable" }[];
}

export interface ErrorReport {
  readonly source: "simulated-local";
  readonly kind: "errors";
  readonly serviceId: ServiceId;
  readonly lines: readonly string[];
}

export function knownServiceIds(): readonly ServiceId[] {
  return Object.keys(SPECS).filter(isServiceId);
}

export interface SimulatedDirectory {
  readHealth(serviceId: string, signal: AbortSignal): Promise<SimulatedHealth>;
  readDependencies(serviceId: string, signal: AbortSignal): Promise<DependencyReport>;
  readErrors(serviceId: string, signal: AbortSignal): Promise<ErrorReport>;
  listServices(): ServiceListing;
  readsOf(serviceId: string): number;
  totalReads(): number;
  /** 只读目录没有写入口。这个计数用来证明 A/B 都没有生产副作用。 */
  writes(): number;
}

export function createSimulatedDirectory(): SimulatedDirectory {
  const reads = new Map<string, number>();

  return {
    listServices() {
      const services = Object.entries(SPECS).map(([serviceId, spec]) => {
        if (!isServiceId(serviceId)) {
          throw new ToolFailure("terminal", "catalog_bug", "terminal code=catalog_bug");
        }
        return { serviceId, status: spec.status };
      });
      return { source: "simulated-local", kind: "listing", services };
    },
    readsOf(serviceId) {
      return reads.get(serviceId) ?? 0;
    },
    totalReads() {
      let total = 0;
      for (const count of reads.values()) total += count;
      return total;
    },
    writes() {
      return 0;
    },
    async readDependencies(serviceId, signal) {
      const known = requireKnown(serviceId);
      await wait(0, signal);
      return {
        source: "simulated-local",
        kind: "dependencies",
        serviceId: known,
        dependencies: SPECS[known]?.dependencies ?? [],
      };
    },
    async readErrors(serviceId, signal) {
      const known = requireKnown(serviceId);
      await wait(0, signal);
      return {
        source: "simulated-local",
        kind: "errors",
        serviceId: known,
        lines: SPECS[known]?.errorLines ?? [],
      };
    },
    async readHealth(serviceId, signal) {
      const known = parseServiceId(serviceId);
      if (!known) {
        throw new ToolFailure(
          "terminal",
          "unknown_service",
          `terminal code=unknown_service serviceId=${serviceId}`,
        );
      }
      const spec = SPECS[known];
      if (!spec) {
        throw new ToolFailure("terminal", "catalog_bug", "terminal code=catalog_bug");
      }
      const seen = (reads.get(known) ?? 0) + 1;
      reads.set(known, seen);
      const delay = seen === 1 ? (spec.firstDelayMs ?? spec.delayMs ?? 0) : (spec.delayMs ?? 0);
      if (delay > 0) await wait(delay, signal);
      const failBeforeSuccess = spec.failBeforeSuccess ?? 0;
      if (seen <= failBeforeSuccess) {
        throw new ToolFailure(
          "retryable",
          "simulated_upstream_503",
          `retryable code=simulated_upstream_503 serviceId=${known} read=${seen}`,
        );
      }
      if (spec.unclearUntilRead !== undefined && seen < spec.unclearUntilRead) {
        return {
          source: "simulated-local",
          kind: "health",
          serviceId: known,
          status: "unknown",
          symptom: "insufficient",
          httpStatus: 0,
          latencyMs: 0,
          note: "模拟：单次样本不足",
        };
      }
      return {
        source: "simulated-local",
        kind: "health",
        serviceId: known,
        status: spec.status,
        symptom: spec.symptom ?? "none",
        httpStatus: spec.httpStatus,
        latencyMs: spec.latencyMs,
        note: spec.note,
      };
    },
  };
}

function requireKnown(serviceId: string): ServiceId {
  const known = parseServiceId(serviceId);
  if (!known) {
    throw new ToolFailure("terminal", "unknown_service", `terminal code=unknown_service serviceId=${serviceId}`);
  }
  return known;
}
