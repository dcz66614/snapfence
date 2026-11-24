/**
 * P030-T010 browser capture via Chrome DevTools Protocol (node, no deps).
 *
 * Why CDP instead of `chrome --headless --screenshot --virtual-time-budget`:
 * under virtual time the renderer's 5000 ms client timeout can fire in
 * virtual time before the Worker thread answers in real time, so runs
 * flakily time out (U01 passed, U07/U02/G12 timed out in the first
 * t010-capture.sh run). Real-time polling for the rendered verdict is the
 * correct wait: the Worker answers in ~10 ms of real time.
 *
 * Usage: node scripts/t010-capture.mjs <port> <shotsDir> <logFile>
 * Exits 0 only when every screenshot and every DOM check succeeds.
 * Chrome: $HOME/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const PORT = Number(process.argv[2] ?? "4174");
const SHOTS = process.argv[3] ?? "";
const LOG = process.argv[4] ?? "";
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome`;
const DEBUG_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;

function log(line) {
  console.log(line);
}

let failures = 0;
function check(label, ok) {
  log(`  ${ok ? "OK" : "MISSING"}: ${label}`);
  if (!ok) failures += 1;
}

async function waitForHttp(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome DevTools not reachable at ${url}`);
}

const chrome = spawn(CHROME, [
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  "--hide-scrollbars",
  `--remote-debugging-port=${DEBUG_PORT}`,
  "--window-size=1280,1400",
  "about:blank",
], { stdio: "ignore" });

let ws;
try {
  const version = await waitForHttp(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  function send(method, params = {}, sessionId) {
    const id = nextId;
    nextId += 1;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false,
  }, sessionId);

  async function evaluate(expression) {
    const res = await send("Runtime.evaluate", {
      expression, returnByValue: true,
    }, sessionId);
    return res?.result?.value;
  }

  async function waitForText(text, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const present = await evaluate(`document.body ? document.body.innerText.includes(${JSON.stringify(text)}) : false`);
      if (present) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async function shot(name, url, waitText) {
    log(`Screenshot: ${url} -> ${name}`);
    await send("Page.navigate", { url }, sessionId);
    const ok = await waitForText(waitText);
    if (!ok) {
      log(`  FAILED: '${waitText}' did not appear within 20s`);
      failures += 1;
      return;
    }
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(`${SHOTS}/${name}`, Buffer.from(data, "base64"));
    log(`  captured ${name}`);
  }

  async function domcheck(label, url, waitText, patterns, expectWorker = true) {
    log(`DOM check: ${label} — ${url}`);
    await send("Page.navigate", { url }, sessionId);
    const appeared = await waitForText(waitText);
    if (!appeared) {
      log(`  FAILED: '${waitText}' did not appear within 20s`);
      failures += 1;
      return;
    }
    const html = await evaluate("document.documentElement.outerHTML");
    for (const pattern of patterns) {
      check(`contains '${pattern}'`, typeof html === "string" && html.includes(pattern));
    }
    // The Worker chunk must have been fetched on run pages: the verdict
    // can only come from the Worker (the App has no other search path).
    // On the no-run main page the transport is lazy, so no Worker exists
    // yet and the chunk is correctly not fetched.
    if (expectWorker) {
      const resources = await evaluate(
        "performance.getEntriesByType('resource').map((r) => r.name).join('\\n')",
      );
      check("worker chunk fetched (snapfence.worker-)", typeof resources === "string" && resources.includes("snapfence.worker-"));
    }
  }

  await shot("t010-main-ui.png", `${BASE}/`, "运行模型检查");
  // Wait texts must only appear AFTER a run completes: "UNSAFE_WITHIN_BOUND"
  // and "SAFE_WITHIN_BOUND" are present from page load (the fixture's
  // expected verdict in the meta line, and the honesty footer), so waiting
  // for them would screenshot the pre-run page. "最短反例路径" /
  // "完整事件顺序" only render with a result.
  await shot("t010-scenario-a-u01-orphan.png", `${BASE}/?scenario=U01&run=1`, "最短反例路径");
  await shot("t010-scenario-b-u07.png", `${BASE}/?scenario=U07&run=1`, "最短反例路径");
  await shot("t010-delete-cross-snapshot-u02.png", `${BASE}/?scenario=U02&run=1`, "最短反例路径");
  await shot("t010-safe-g12.png", `${BASE}/?scenario=G12&run=1`, "完整事件顺序");

  await domcheck("main UI (no run)", `${BASE}/`, "运行模型检查", [
    "运行模型检查", "合成场景", "备份策略", "刷新页面可清空当前状态",
    "取消", "导出 JSON", "导出 HTML", "Web Worker",
  ], false);
  await domcheck("scenario A U01 (orphan, Worker)", `${BASE}/?scenario=U01&run=1`, "最短反例路径", [
    "UNSAFE_WITHIN_BOUND", "ORPHAN_BLOB", "孤立对象", "数据库快照", "Blob 快照",
    "最短反例路径", "upload-A:BLOB_PUT", "第 0 / 3 步", "导出 JSON", "导出 HTML",
  ]);
  await domcheck("scenario B U07 (Worker)", `${BASE}/?scenario=U07&run=1`, "最短反例路径", [
    "UNSAFE_WITHIN_BOUND", "ORPHAN_BLOB", "upload-B:BLOB_PUT",
  ]);
  await domcheck("delete cross-snapshot U02 (Worker)", `${BASE}/?scenario=U02&run=1`, "最短反例路径", [
    "UNSAFE_WITHIN_BOUND", "delete-C:DB_UNLINK", "最短反例路径",
  ]);
  await domcheck("safe G12 (Worker)", `${BASE}/?scenario=G12&run=1`, "完整事件顺序", [
    "SAFE_WITHIN_BOUND", "完整事件顺序", "无诊断",
  ]);

  await send("Target.closeTarget", { targetId });
} finally {
  try {
    ws?.close();
  } catch {
    // ignore
  }
  chrome.kill();
}

if (failures !== 0) {
  log(`CAPTURE RESULT: FAILED (${failures} failed checks)`);
  process.exit(1);
}
log("CAPTURE RESULT: OK");
