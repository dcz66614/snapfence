/**
 * SnapFence (P030) — dual-track timeline container. T008.
 *
 * Authority: PROJECT_BOOK.md §5.2/§5.3 (two fixed horizontal lanes, snapshot
 * vertical markers, counterexample highlight line) and §5.4 (step replay).
 * Composes DatabaseLane + BlobLane + SnapshotMarker + CounterexamplePath
 * over the pure timeline-layout model. The SVG polyline connects the
 * counterexample events across lanes at their layout x positions (lane
 * centres at 25% / 75% of the container height).
 */

import { useMemo } from "react";
import type { Scenario, SearchResult } from "../../core/model/types";
import { buildTimelineModel } from "./timeline-layout";
import type { TimelineEventItem } from "./timeline-layout";
import { buildReplaySteps, clampReplayStep, stateAfterSteps } from "./replay";
import { DatabaseLane } from "../DatabaseLane";
import { BlobLane } from "../BlobLane";
import { SnapshotMarker } from "../SnapshotMarker";
import { CounterexamplePath } from "../CounterexamplePath";

export interface TimelineProps {
  scenario: Scenario;
  result: SearchResult;
  replayStep: number;
  onReplayStepChange: (step: number) => void;
}

/** Lane-centre y (percent of the lanes area) for the counterexample polyline.
 *
 * Geometry (see timeline.css — these numbers must match it):
 * - 46px label strip sits above the lanes; the SVG covers the lanes only.
 * - One lane box = 8px top padding + ~24px header + track + 8px bottom
 *   padding: 158px with the 118px track, 220px with the 180px compact track.
 * - Lanes are stacked with an 8px gap: SVG height = 2 * lane + 8.
 * - Normal mode: chip centre = 8 + 24 + track/2 = 91px into its lane.
 * - Compact mode: chips stagger in two rows, centres 77px / 167px into
 *   the lane (track 180px, rows at 25% / 75%).
 * The values are approximate (header height varies a few px with fonts);
 * the polyline only has to pass through the chips, which it does with
 * several px of slack on every side.
 */
const LANE_GAP_PX = 8;
const NORMAL_LANE_PX = 158;
const COMPACT_LANE_PX = 220;

function polylinePointY(
  item: TimelineEventItem,
  compact: boolean,
): number {
  const laneHeight = compact ? COMPACT_LANE_PX : NORMAL_LANE_PX;
  const svgHeight = 2 * laneHeight + LANE_GAP_PX;
  const laneTop = item.lane === "database" ? 0 : laneHeight + LANE_GAP_PX;
  const chipCentre = compact ? (item.index % 2 === 0 ? 77 : 167) : 91;
  return ((laneTop + chipCentre) / svgHeight) * 100;
}

export function Timeline({ scenario, result, replayStep, onReplayStepChange }: TimelineProps) {
  const model = useMemo(
    () => buildTimelineModel(scenario, result, replayStep),
    [scenario, result, replayStep],
  );
  const steps = useMemo(
    () => buildReplaySteps(scenario, model.sequence.eventIds),
    [scenario, model.sequence.eventIds],
  );
  const clampedStep = clampReplayStep(replayStep, model.items.length);
  const currentState = useMemo(
    () => stateAfterSteps(scenario, model.sequence.eventIds, clampedStep),
    [scenario, model.sequence.eventIds, clampedStep],
  );
  const lastAppliedStep = clampedStep > 0 ? (steps[clampedStep - 1] ?? null) : null;
  // Compact (staggered two-row) layout once more than 6 events are shown:
  // at 7+ events the even chip spacing drops below the 148px chip width.
  const compact = model.items.length > 6;
  // The SVG overlay MUST carry an explicit pixel height: an <svg> is a
  // replaced element, so with only top/bottom set the browser sizes it
  // from its intrinsic 1:1 viewBox ratio (width 100% => height = width)
  // and ignores bottom — the highlight line would spill far below the
  // timeline. Height here is exactly the lanes area the polyline's
  // percentages are computed against (2 lanes + the 8px gap).
  const svgHeight = 2 * (compact ? COMPACT_LANE_PX : NORMAL_LANE_PX) + LANE_GAP_PX;
  const pathPoints = model.items
    .filter((item) => item.isCounterexample)
    .map((item) => `${item.xPercent},${polylinePointY(item, compact)}`)
    .join(" ");
  return (
    <section className="sf-timeline" aria-label="双轨时间线">
      <div className="sf-timeline-head">
        <h2>双轨时间线</h2>
        <span>
          显示序列：
          {model.sequence.isCounterexample
            ? `最短反例（${model.items.length} 个事件）`
            : `完整事件顺序（${model.items.length} 个事件）`}
          ；场景共 {model.totalEvents} 个原子事件
        </span>
      </div>
      <div className="sf-timeline-body">
        {pathPoints.length > 0 ? (
          <svg
            className="sf-counterexample-svg"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
            style={{ height: svgHeight }}
          >
            <polyline
              points={pathPoints}
              fill="none"
              stroke="#7c3aed"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeDasharray="6 3"
            />
          </svg>
        ) : null}
        {model.snapshotMarkers.map((marker) => (
          <SnapshotMarker
            key={marker.eventId}
            labelZh={marker.labelZh}
            xPercent={marker.xPercent}
            lane={marker.lane}
          />
        ))}
        <div className="sf-lanes">
          <DatabaseLane items={model.databaseItems} compact={compact} />
          <BlobLane items={model.blobItems} compact={compact} />
        </div>
      </div>
      <CounterexamplePath
        items={model.items}
        isCounterexample={model.sequence.isCounterexample}
        replayStep={clampedStep}
        onReplayStepChange={(step) =>
          onReplayStepChange(clampReplayStep(step, model.items.length))
        }
        lastAppliedStep={lastAppliedStep}
        currentState={currentState}
      />
    </section>
  );
}
