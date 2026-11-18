/**
 * A run's refused sign-in reaches the screen at once: laid over the last check of that agent the moment
 * the call fails, without waiting for — or depending on — the full check that follows.
 *
 * 2026-11-18: a chat's call through claude-cli was refused ("OAuth session expired and could not be
 * refreshed"), and neither the composer nor the error offered Sign in or Check again — the follow-up
 * check read the configuration, which that running build could not parse, so the refusal never landed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Failure } from "@declarative-ai/json";
import { agentDownOf, type AvailabilitySnapshot, type ProbeResult, type PushMessage } from "@jaira/shared";
import { testHome } from "@jaira/testing";
import { AppService } from "@jaira/service";

const REFUSED: Failure = {
  classification: "permanent",
  reason: "claude-cli: AgentError: claude-cli agent error: Failed to authenticate: OAuth session expired and could not be refreshed",
  code: "authentication_failed",
};

/** The two private seams this reaches: the snapshot the screen reads, and the observer every agent call reports to. */
interface Internals {
  availability: AvailabilitySnapshot;
  onAgentOutcome: (agent: string, error: Failure | undefined) => void;
}

let service: AppService;
let pushes: PushMessage[];

beforeEach(() => {
  pushes = [];
  service = new AppService({ baseDir: testHome(), publish: (m) => pushes.push(m), watchWorkflows: false });
});

afterEach(async () => {
  await service.close();
});

function seed(probe: ProbeResult): Internals {
  const internals = service as unknown as Internals;
  internals.availability = { routes: [], executors: [probe], checkedAt: 1 };
  pushes.length = 0;
  return internals;
}

describe("a run's refused sign-in", () => {
  it("lands on the agent's login at once, and says so to the screen", () => {
    const internals = seed({ name: "claude-cli", status: "ok", detail: "'claude' responded", accounts: [{ label: "me@example.com", active: true }] });

    internals.onAgentOutcome("claude-cli", REFUSED);

    // Read synchronously: nothing waited on a new check.
    const probe = service.readAvailability().executors.find((one) => one.name === "claude-cli")!;
    expect(probe.status).toBe("needs-sign-in");
    expect(probe.accounts?.[0]?.refused).toBe("Failed to authenticate: OAuth session expired and could not be refreshed");
    expect(pushes).toContainEqual({ type: "store:invalidate", scope: "availability" });
    // …which is what turns the composer's route red and gives the error its Sign in.
    expect(agentDownOf(probe)).toMatchObject({ signIn: true });
  });

  it("fails an agent with no login to land on, with the command that signs it in", () => {
    const internals = seed({ name: "claude-cli", status: "ok", detail: "'claude' responded" });

    internals.onAgentOutcome("claude-cli", REFUSED);

    const probe = service.readAvailability().executors.find((one) => one.name === "claude-cli")!;
    expect(probe.status).toBe("failed");
    expect(probe.fix).toBe("run 'claude auth login' in a terminal, then Re-check");
  });

  it("leaves an agent the last check never saw alone", () => {
    const internals = seed({ name: "codex-cli", status: "ok", detail: "'codex' responded" });

    internals.onAgentOutcome("claude-cli", REFUSED);

    expect(service.readAvailability().executors).toEqual([{ name: "codex-cli", status: "ok", detail: "'codex' responded" }]);
    expect(pushes).not.toContainEqual({ type: "store:invalidate", scope: "availability" });
  });
});
