/**
 * Scripted InteractionPort for headless runs (mirrors ai-exec's test
 * ScriptedPort): responses are FIFO queues keyed by state id, supplied as
 * JSON, e.g. `{"feature/plan/critique/human_review": [{"decision": "approve"}]}`.
 * The renderer-backed port replaces this in phase 4.
 */
import type { InteractionPort } from "@ai-exec/core";

export interface InteractionRequest {
  stateId: string;
  component: string;
  inputs: unknown;
}

export function parseInteractionScript(raw: unknown): Record<string, unknown[]> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("interaction script must be a JSON object of stateId → response array");
  }
  const script: Record<string, unknown[]> = {};
  for (const [stateId, responses] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(responses)) {
      throw new Error(`interaction script for '${stateId}' must be an array of responses`);
    }
    script[stateId] = [...responses];
  }
  return script;
}

export class ScriptedInteractionPort implements InteractionPort {
  readonly requests: InteractionRequest[] = [];

  constructor(private readonly responses: Record<string, unknown[]>) {}

  async request(req: InteractionRequest): Promise<unknown> {
    this.requests.push(req);
    const queue = this.responses[req.stateId];
    if (queue === undefined) throw new Error(`no scripted response for interactive state '${req.stateId}'`);
    if (queue.length === 0) throw new Error(`scripted responses for '${req.stateId}' exhausted`);
    return queue.shift();
  }
}
