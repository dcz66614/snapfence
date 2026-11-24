/**
 * SnapFence (P030) — counterexample step-replay. T008.
 *
 * Authority: PROJECT_BOOK.md §5.4 (user can step-replay the shortest
 * counterexample and view the state before/after each event), §4.6
 * (counterexample output contents: per-event input/output state).
 * Inputs (frozen, read-only): src/core/events/event-types.ts
 * (`expandScenario`), src/core/events/apply-event.ts (`initialState`,
 * `applyEvent`). Pure and deterministic: replaying the same event list
 * always yields the same states, because the frozen state machine is.
 */

import type { Scenario, SystemState } from "../../core/model/types";
import { expandScenario } from "../../core/events/event-types";
import type { SnapFenceEvent } from "../../core/events/event-types";
import { applyEvent, initialState } from "../../core/events/apply-event";

/** One replay step: the state before and after one event. */
export interface ReplayStep {
  /** 0-based step index (event position in the replayed sequence). */
  stepIndex: number;
  eventId: string;
  kind: SnapFenceEvent["kind"];
  /** State before this event. */
  stateBefore: SystemState;
  /** State after this event. */
  stateAfter: SystemState;
  /** Operation IDs in flight after this event. */
  inFlightAfter: readonly string[];
}

/** Clamp a requested replay step into 0..total (inclusive: total = end). */
export function clampReplayStep(requested: number, total: number): number {
  if (Number.isNaN(requested)) {
    return 0;
  }
  return Math.max(0, Math.min(Math.floor(requested), total));
}

/**
 * Build the replay steps for an ordered event-ID list (normally the
 * shortest counterexample, or the canonical display sequence for a SAFE
 * result). Each step applies one event with the frozen state machine, so
 * the before/after states are exactly the model's states. Throws
 * `EventApplicationError` if the sequence is not a legal path — callers
 * must only pass sequences the search produced or `buildDisplaySequence`
 * validated (fail-closed, never a silently repaired replay).
 */
export function buildReplaySteps(
  scenario: Scenario,
  eventIds: readonly string[],
): readonly ReplayStep[] {
  const expansion = expandScenario(scenario);
  const byId = new Map<string, SnapFenceEvent>();
  for (const event of expansion.allEvents) {
    byId.set(event.eventId, event);
  }
  let current = initialState(scenario);
  const executed: string[] = [];
  const steps: ReplayStep[] = [];
  for (let index = 0; index < eventIds.length; index += 1) {
    const eventId = eventIds[index];
    if (eventId === undefined) {
      continue;
    }
    const event = byId.get(eventId);
    if (event === undefined) {
      throw new Error(`Replay: unknown event ID ${eventId} for scenario ${scenario.scenarioId}.`);
    }
    const stateBefore = current;
    const applied = applyEvent(current, event, executed);
    current = applied.state;
    executed.push(event.eventId);
    const inFlightAfter: string[] = [];
    for (const [opId, status] of Object.entries(current.operationStatus)) {
      if (status === "IN_FLIGHT") {
        inFlightAfter.push(opId);
      }
    }
    steps.push({
      stepIndex: index,
      eventId: event.eventId,
      kind: event.kind,
      stateBefore,
      stateAfter: current,
      inFlightAfter,
    });
  }
  return steps;
}

/**
 * State after applying the first `step` events of a replay (step 0 is the
 * initial state). Pure helper for the inspector's "current state" panel.
 */
export function stateAfterSteps(
  scenario: Scenario,
  eventIds: readonly string[],
  step: number,
): SystemState {
  const steps = buildReplaySteps(scenario, eventIds);
  const clamped = clampReplayStep(step, steps.length);
  if (clamped === 0) {
    return initialState(scenario);
  }
  const last = steps[clamped - 1];
  if (last === undefined) {
    return initialState(scenario);
  }
  return last.stateAfter;
}
