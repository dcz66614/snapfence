/**
 * SnapFence (P030) — the 24 Golden scenarios bundled for the UI. T008.
 *
 * Authority: IMPLEMENTATION_PLAN.md §6 (Golden catalogue U01–U12 / G01–G12).
 * The fixtures are the frozen T005 inputs (read-only here); this module only
 * loads them for the scenario selector and the screenshot deep-links.
 * `asFixture` validates the shape at runtime and narrows `unknown` to the
 * frozen `GoldenFixture` type — no `any`, no silent repair of bad data.
 */

import type { BackupStrategy, Scenario, SearchVerdict } from "../core/model/types";

/** One Golden fixture as the UI consumes it. */
export interface GoldenFixture {
  fixtureId: string;
  scenario: Scenario;
  expectedVerdict: SearchVerdict;
  expectedDiagnostics: readonly string[];
  expectedCounterexample: readonly string[];
  expectedCounterexampleLength: number;
  eventCount: number;
  reason: string;
}

const STRATEGIES: readonly BackupStrategy[] = ["DB_FIRST", "FILE_FIRST", "PAUSE_WRITES"] as const;

/** Validate one imported fixture JSON and narrow it to GoldenFixture. */
export function asFixture(raw: unknown, source: string): GoldenFixture {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Scenario fixture ${source} is not an object.`);
  }
  const record = raw as Record<string, unknown>;
  const scenario = record["scenario"] as Record<string, unknown> | undefined;
  if (
    typeof record["fixtureId"] !== "string" ||
    scenario === undefined ||
    typeof scenario["scenarioId"] !== "string" ||
    typeof scenario["strategy"] !== "string" ||
    !STRATEGIES.includes(scenario["strategy"] as BackupStrategy) ||
    !Array.isArray(scenario["operations"]) ||
    typeof scenario["maxEvents"] !== "number"
  ) {
    throw new Error(`Scenario fixture ${source} has an invalid shape.`);
  }
  return raw as unknown as GoldenFixture;
}

import rawG01 from "../../fixtures/golden/G01.json";
import rawG02 from "../../fixtures/golden/G02.json";
import rawG03 from "../../fixtures/golden/G03.json";
import rawG04 from "../../fixtures/golden/G04.json";
import rawG05 from "../../fixtures/golden/G05.json";
import rawG06 from "../../fixtures/golden/G06.json";
import rawG07 from "../../fixtures/golden/G07.json";
import rawG08 from "../../fixtures/golden/G08.json";
import rawG09 from "../../fixtures/golden/G09.json";
import rawG10 from "../../fixtures/golden/G10.json";
import rawG11 from "../../fixtures/golden/G11.json";
import rawG12 from "../../fixtures/golden/G12.json";
import rawU01 from "../../fixtures/golden/U01.json";
import rawU02 from "../../fixtures/golden/U02.json";
import rawU03 from "../../fixtures/golden/U03.json";
import rawU04 from "../../fixtures/golden/U04.json";
import rawU05 from "../../fixtures/golden/U05.json";
import rawU06 from "../../fixtures/golden/U06.json";
import rawU07 from "../../fixtures/golden/U07.json";
import rawU08 from "../../fixtures/golden/U08.json";
import rawU09 from "../../fixtures/golden/U09.json";
import rawU10 from "../../fixtures/golden/U10.json";
import rawU11 from "../../fixtures/golden/U11.json";
import rawU12 from "../../fixtures/golden/U12.json";

/** Chinese short description of each Golden scenario (plan §6). */
export const SCENARIO_LABELS: Readonly<Record<string, string>> = {
  G01: "空闲状态（数据库优先）",
  G02: "上传完成后再备份（数据库优先）",
  G03: "删除完成后再备份（数据库优先）",
  G04: "更新完成后再备份（数据库优先）",
  G05: "空闲状态（文件优先）",
  G06: "上传完成后再备份（文件优先）",
  G07: "删除完成后再备份（文件优先）",
  G08: "更新完成后再备份（文件优先）",
  G09: "上传完成后暂停写入",
  G10: "删除完成后暂停写入",
  G11: "更新完成后暂停写入",
  G12: "四次上传完成后暂停写入（10 事件）",
  U01: "上传 A：孤立 Blob（数据库优先）",
  U02: "删除 C：孤立 Blob（数据库优先）",
  U03: "更新 A：旧版本缺失（数据库优先）",
  U04: "更新 A：新版本孤立（数据库优先）",
  U05: "两次上传：多个孤立对象（数据库优先）",
  U06: "上传 A + 删除 B：两组件不一致（数据库优先）",
  U07: "上传 B：孤立 Blob（文件优先）",
  U08: "删除 C：孤立对象（文件优先）",
  U09: "更新 A：新版本缺失（文件优先）",
  U10: "更新 A：旧版本孤立（文件优先）",
  U11: "上传 A + 更新 B：版本混合（文件优先）",
  U12: "更新 A + 删除 B：无共同边界（文件优先）",
} as const;

/** All 24 Golden fixtures, in fixture order (U01–U12, G01–G12). */
export const GOLDEN_SCENARIOS: readonly GoldenFixture[] = [
  asFixture(rawG01, "G01.json"),
  asFixture(rawG02, "G02.json"),
  asFixture(rawG03, "G03.json"),
  asFixture(rawG04, "G04.json"),
  asFixture(rawG05, "G05.json"),
  asFixture(rawG06, "G06.json"),
  asFixture(rawG07, "G07.json"),
  asFixture(rawG08, "G08.json"),
  asFixture(rawG09, "G09.json"),
  asFixture(rawG10, "G10.json"),
  asFixture(rawG11, "G11.json"),
  asFixture(rawG12, "G12.json"),
  asFixture(rawU01, "U01.json"),
  asFixture(rawU02, "U02.json"),
  asFixture(rawU03, "U03.json"),
  asFixture(rawU04, "U04.json"),
  asFixture(rawU05, "U05.json"),
  asFixture(rawU06, "U06.json"),
  asFixture(rawU07, "U07.json"),
  asFixture(rawU08, "U08.json"),
  asFixture(rawU09, "U09.json"),
  asFixture(rawU10, "U10.json"),
  asFixture(rawU11, "U11.json"),
  asFixture(rawU12, "U12.json"),
];

/** Find one Golden fixture by its ID (e.g. "U01"). */
export function getGoldenFixture(fixtureId: string): GoldenFixture | undefined {
  return GOLDEN_SCENARIOS.find((fixture) => fixture.fixtureId === fixtureId);
}

/** Scenario (with strategy override) for a fixture + strategy choice. */
export function scenarioWithStrategy(fixture: GoldenFixture, strategy: BackupStrategy): Scenario {
  return { ...fixture.scenario, strategy };
}
