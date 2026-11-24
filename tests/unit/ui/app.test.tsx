/**
 * SnapFence (P030) — T008 app-shell tests.
 *
 * Renders TimelineApp to static markup in the node vitest environment
 * (react-dom/server; no window, so no deep-link auto-run) and asserts the
 * Chinese control surface: scenario + strategy selectors with all 24
 * Golden scenarios, the run button, the refresh-clears-state note, and
 * that no component persists state in browser storage (PROJECT_BOOK.md
 * §11.1: refreshing the browser clears the current state — implemented by
 * keeping state only in React state).
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TimelineApp } from "../../../src/components/TimelineApp";
import { GOLDEN_SCENARIOS } from "../../../src/components/scenarios";

const COMPONENTS_DIR = fileURLToPath(new URL("../../../src/components/", import.meta.url));

function readComponentFiles(): readonly string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        files.push(path);
      }
    }
  };
  walk(COMPONENTS_DIR);
  return files;
}

describe("TimelineApp shell", () => {
  it("renders the Chinese control surface with all 24 scenarios", () => {
    expect(GOLDEN_SCENARIOS).toHaveLength(24);
    const html = renderToStaticMarkup(<TimelineApp />);
    expect(html).toContain("SnapFence — 快照栅");
    expect(html).toContain("合成场景");
    expect(html).toContain("备份策略");
    expect(html).toContain("运行模型检查");
    expect(html).toContain("刷新页面可清空当前状态");
    expect(html).toContain("状态：未运行");
    expect(html).toContain("U01_DB_FIRST_UPLOAD_ORPHAN");
    expect(html).toContain("G12_PAUSE_WRITES_FOUR_UPLOADS");
    expect(html).toContain("数据库优先");
    expect(html).toContain("文件优先");
    expect(html).toContain("暂停写入");
    expect(html).toContain("预期判定");
    expect(html).toContain("UNSAFE_WITHIN_BOUND");
    // 24 scenario options + 3 strategy options = 27 <option> elements.
    expect((html.match(/<option/g) ?? []).length).toBe(27);
    expect(html).not.toContain("T001 scaffold");
  });

  it("no component persists state in browser storage (refresh clears state)", () => {
    const files = readComponentFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(file, "utf-8");
      expect(content, file).not.toContain("localStorage");
      expect(content, file).not.toContain("sessionStorage");
      expect(content, file).not.toContain("indexedDB");
    }
  });
});
