# SnapFence 已知局限

本文件如实记录全部已知局限，按任务编号承载。每一项都来自对应任务的交接
或独立审查，未经核实的说法不在此列。状态标注以最新任务为准：
FIX-T003-L23 已关闭 FIX-T004-L17 的 L-23/L-24；FIX-V-01 已修复 T011 F-01
所述的 V-01 视觉缺陷（见 L-T011-01 的状态更新）。

## L-T005 — 24 个 Golden 场景（T005）

- **L-T005-01（U03/U04、U09/U10 形状相同）**：计划 §6.1 冻结目录把同一输入
  形状列为两个场景（U03 强调旧版缺失、U04 强调新版孤立；U09 强调新版缺失、
  U10 强调旧版孤立），二者最短反例相同。夹具如实保留两个场景，不做区分性改动。
- **L-T005-02（最短反例不展示全部失效模式）**：按 §4.6，期望反例必须是长度
  最小者；U02/U07 的悬空引用、U03 的旧版缺失、U05 的多孤立对象、U09/U11 的
  新版缺失/版本混合等模式只出现在更长的合法路径中，不在期望反例里。
  Manifest 的 coverage 条目标注为“场景级覆盖”，各场景 reason 中写明更长路径
  的事件顺序；测试不断言这些更长路径。
- **L-T005-03（诊断码集合的同质性）**：由推导记录引理 L-B，全部 12 个 U 场景
  的最短反例诊断码集合相同（各一个 IN_FLIGHT_OPERATION、NO_COMMON_BOUNDARY、
  ORPHAN_BLOB），孤立对象的文件/对象 ID 不同。这是长度 3 终态的结构性质，
  不是夹具复制错误。
- **L-T005-04（G01/G05 空闲场景）**：`operations: []` 是计划 §6.2 明列的合法
  场景（空闲状态 SAFE），不是“删除事件伪造正确”。测试断言除 G01/G05 外全部
  G 场景至少含一个操作，且全部 G 场景的总事件数等于其操作模板事件数 + 2。
- **L-T005-05（沿用 T004 L-20）**：测试文件不在 `tsconfig.json` 的 `include`
  内，`npm run typecheck` 不覆盖测试代码的类型错误；本任务未改 tsconfig
  （避免扩大范围）。测试代码仍保持 strict、无 `any`（shape guard 用 unknown 收窄）。
- **L-T005-06（探针临时文件已删）**：手工推导与 runSearch 的交叉核对经临时探针
  测试完成，探针文件已删除；核对结论（24/24 一致、零分歧）记录于推导记录 §4，
  自动化套件每次运行都会重新断言同一组期望。

## L-T006 — 独立 Python Oracle（T006）

- **L-T006-01（蕴含预存 digest 的 Oracle 本地推导）**：DELETE/UPDATE 蕴含的预存
  记录无 digest 时，Oracle 用 `fixture-digest-<fileId>-v1` 推导，D 与 B 取同一值。
  按构造它对任何判定不可见，但该字面值不是生产实现的推导值。
- **L-T006-02（同一 fileId 的多操作）**：同一场景内两个操作作用于同一 fileId
  时（如一删一改），Oracle 只靠通用事件前置条件处理（某交错中前置条件不满足
  的事件在该交错中跳过）。无 Golden 夹具覆盖此情形；该行为是模型选择，
  不是规格规则。
- **L-T006-03（等长反例的平局裁决）**：Oracle 按字典序 DFS 顺序取首个最短反例。
  在 24 个 Golden 场景上它与生产 BFS 的选择逐字一致（24/24），但该一致是针对
  本夹具集的实测结果，不是两种顺序一般等价的证明。
- **L-T006-04（无状态去重的全枚举）**：Oracle 枚举全部终态前缀，不做状态去重。
  在冻结的 10 事件界内精确且快速（最坏 G12 为 19,049 节点）；远超该规模的场景
  会触及 200,000 节点上限并报告 INCONCLUSIVE_LIMIT，而非完成枚举。
- **L-T006-05（Oracle 位置与 package.json 占位符）**：任务卡的验收命令把 Oracle
  定在工作区根目录（`oracle/python/`），而 IMPLEMENTATION_PLAN §3 把它画在
  `04_source/oracle/` 下。本任务遵循任务卡（验收命令固定了位置），npm 脚本因此
  使用相对路径 `../../oracle/python/tests`。另：`package.json` 中原本不存在
  `test:oracle` 的 NOT_IMPLEMENTED 占位符行，故新增一行而非替换。
- **L-T006-06（模型路由）**：任务开始时约 01:00 GMT 检查 WorkBuddy `/health`
  （经 3130 隧道代理）超时不可达（curl exit 28；Sam 的电脑已关机，符合预期）。
  本任务全部工作均在本地完成，未使用任何外部模型路由；无需路由即完成。
- **L-T006-07（`__pycache__/`）**：仓库 `.gitignore` 未覆盖 `__pycache__/`；
  运行 Oracle 测试套件会重新生成 `oracle/python/__pycache__/` 与
  `oracle/python/tests/__pycache__/`。本次提交前已删除；未修改 `.gitignore`
  （超出任务范围），后续运行后需同样清理或由后续任务处理。

## L-T007 — S0 核心正确性门禁（T007）

- **L-T007-01（计时为机器相对值）**：`< 1 s` 结论测于本 VM；最慢场景
  （G12，10.8 ms）余量约 92 倍，结论稳健，但绝对数字随机器而异，需在其他
  机器上重测。
- **L-T007-02（静态外部 API 检查是词法检查）**：0-API 断言对被调用的
  `src/core/**` 代码路径做网络调用 token 的 grep；它不执行网络沙箱，
  也不检查传递依赖（react/react-dom 仅用于 UI，不在门禁路径上；门禁路径只
  导入 `src/core/**` 与 Node 内置模块）。
- **L-T007-03（parity 范围）**：Oracle parity 只对 24 个 Golden 场景验证——
  冻结的验收集——不对任意场景验证。Oracle 自身单元套件覆盖了更多形状
  （非法 DAG、超限输入、`snapshotsAfter` 影响）。
- **L-T007-04（`__pycache__`）**：运行 Oracle 测试会重新生成
  `oracle/python/__pycache__/` 与 `oracle/python/tests/__pycache__`
  （T006 L-T006-07）。门禁在 Oracle 运行后删除这两个目录，保持仓库干净；
  `.gitignore` 特意未修改。
- **L-T007-05（日志文件与 git）**：仓库 `.gitignore` 忽略 `*.log`
  （`00_control/*.log` 除外），因此 `s0-gate.log` 与 `s0-oracle.log` 用
  `git add -f` 作为证据提交，未改 `.gitignore`。
- **L-T007-06（沿用 T005/T006）**：T005 L-T005-01–L-T005-06 与 T006
  L-T006-01–L-T006-06 仍然适用（同形 U03/U04 与 U09/U10 对；最短反例只展示
  最小失效模式；长度 3 反例上的同质诊断集；G01/G05 空闲场景；Oracle 的本地
  摘要推导；同一 fileId 多操作行为；字典序平局裁决仅在本夹具集上实测一致；
  Oracle 无去重枚举上限 200,000 节点）。

## L-T008 — 双轨时间线 UI（T008）

- **L-T008-01（无 Golden 最短反例携带 DANGLING_REFERENCE）**：12 个 U 场景的
  最短反例诊断集同质，均为 `IN_FLIGHT_OPERATION + NO_COMMON_BOUNDARY +
  ORPHAN_BLOB`。因此 U02“删除跨快照”截图显示的是孤立 Blob 的最短反例，
  而非项目书 §9.3 的四事件悬空引用路径（该路径非最短）。悬空引用与孤立对象
  的视觉区分（红/琥珀、不同标签、不同 kind）由冻结核心 `evaluateSequence`
  对 §9.3 序列的真实判定 + 合成结果渲染测试证明，非手工编造的诊断。
- **L-T008-02（UI 测试环境）**：测试在 node vitest 环境以
  `renderToStaticMarkup` 运行，未装 jsdom / @testing-library（安装会改动依赖
  与 lockfile，超出只改一行脚本的许可）。真实浏览器交互由 Chrome 无头
  `--dump-dom` 检查（21 项）与 5 张实拍截图覆盖；点击回放按钮的端到端操作
  未做自动化浏览器点击（无 Playwright 库可用，只有 Chrome 二进制）。
- **L-T008-03（Worker 在 T010）**：搜索异步目前是 macrotask 推迟，非 Web
  Worker；`runSearch` 本身仍在主线程执行（但 <11 ms，24 场景实测），
  `runSearchAsync` 保证的是调用不阻塞渲染与交互，而非真正的后台线程。
  （T010 已由真实 Web Worker 取代；见 L-T010-03。）
- **L-T008-04（`package.json` 并行提交）**：`test:ui` 行在 T009 代码提交
  `36d73b9` 入库，当时本任务的该行编辑已在工作区；终态已核对
  （`test:ui` 与 `test:export` 均已接通，`git diff HEAD -- package.json` 为空）。
  本任务代码提交因此不含 `package.json`。
- **L-T008-05（回归重跑副作用）**：本次 `s0:gate` 重跑改动了 T007 的
  `05_tests/test-results/s0-oracle.log` 仅一行耗时数字（2.001s → 2.057s），
  已恢复，未提交。`__pycache__` 由门禁自行清理，未残留。
- **L-T008-06（外壳归属）**：`TimelineApp` 是 T008 临时外壳，T010 以
  `src/app/App.tsx`（Worker 集成）接替；`?scenario=&run=1` 深链是 T008
  演示/截图辅助，非产品规范。
- **L-T008-07（折线 Y 位置近似）**：反例折线的 lane Y 由 CSS 几何常量推导
  （header 高随字体浮动数像素），截图目视确认折线穿过芯片；不是逐像素测量值。
- **L-T008-08（显示序列口径）**：UNSAFE 结果时间线只显示最短反例事件
  （非场景全部事件）；SAFE/其它结果显示完整规范序列。两种口径均在时间线头部
  明示，并在 `timeline-layout.ts` 注释。

## L-T009 — JSON 与 HTML 导出（T009）

- **L-T009-01（G12 报告快照为空）**：G12 的 `runSearch` 报告快照是 BFS 首个
  完整交错的快照对——两次快照均落在边界 0，故均为空。这是 S0 已验证的
  `runSearch` 语义（首个终态选择），不是导出错误；导出忠实携带该快照对。
  需要“全部上传完成后快照”内容的场景应另行构造，不属于 T009 范围。
- **L-T009-02（HTML 无交互）**：HTML 导出是纯静态文档，无 JavaScript、无反例
  回放交互；回放属于 T008/T010 的 UI 范围。HTML 仅呈现判定、诊断、反例顺序
  与快照内容。
- **L-T009-03（Schema 验证为手写）**：`validateReport` 是无依赖的手写校验器
  （未引入 ajv 等新依赖），与 `REPORT_JSON_SCHEMA` 并行维护；两者由同一测试
  套件覆盖（有效文档通过、各类畸形文档拒绝），但未来改 schema 时须同步改两处。
- **L-T009-04（JSON Schema 声明与校验分离）**：导出的 JSON 文档本身不内嵌
  `$schema` 字段（§8.4 的 12 个字段外不加字段，`additionalProperties: false`）；
  schema 通过 `report-schema.ts` 的 `REPORT_JSON_SCHEMA` /
  `getReportJsonSchema()` 提供。
- **L-T009-05（共享 package.json 提交）**：本次提交的 `package.json` 同时包含
  并行 T008 任务的 `test:ui` 一行（按任务并发指令保留）；T008 提交时该文件
  应无差异。
- **L-T009-06（诊断严重度双份）**：严重度映射在 `report-schema.ts` 与
  `src/core/search/search-result.ts` 中各有一份（有意为之：schema 模块不依赖
  搜索模块）；改动时须同步。

## L-T010 — UI、Worker 与核心集成（T010）

- **L-T010-01（Worker 超时是虚拟时间产物，不是产品缺陷）**：
  `--virtual-time-budget` 下真实 Worker 首次出现 5 秒超时（U07/U02/G12），
  因虚拟时间推进快于 Worker 线程的真实作答；同一代码在 CDP 实时等待下全部
  一次通过，Worker 往返实测 ≤ 10 ms。截图脚本已改用 CDP 实时等待；不要用
  `--virtual-time-budget` 测 Worker 路径。
- **L-T010-02（取消不能中断 Worker 内的同步搜索）**：`runSearch` 是同步函数，
  Worker 线程内一旦开始就跑到结束；取消只表示客户端不再要这个结果
  （发 cancel 消息、丢弃迟到响应），不抢占 Worker。搜索本身 < 11 ms，
  影响可忽略；如未来搜索变慢，需把 BFS 改为可分片执行。
- **L-T010-03（节点内 Worker 传输是进程内模拟）**：`LocalWorkerTransport` 经
  `handleWorkerMessage` 异步路由同一类型化协议，但不是真正的浏览器 Worker
  线程；真实 Worker 线程由生产构建 + Chrome CDP 截图/DOM 检查覆盖
  （worker chunk 拉取 4/4、5 个深链 URL 全部渲染出结果）。
- **L-T010-04（App 不做终止清理）**：Worker 随页面生命周期存在，`App` 卸载时
  不 `terminate()` 客户端（避免 StrictMode 重挂载杀掉 Worker）；单页应用内无影响。
- **L-T010-05（沿用 T008/T009）**：L-T008-01（无 Golden 最短反例携带
  DANGLING_REFERENCE，已由 §9.3 序列测试覆盖）、L-T008-02（无 jsdom，浏览器
  点击未做自动化——回放按钮点击仍只由截图 + 静态测试覆盖）、L-T008-07
  （反例折线 Y 位置近似）、L-T008-08（UNSAFE 只显示最短反例事件）、
  L-T009-01（G12 报告快照为空是 S0 语义）、L-T009-02（HTML 导出无交互）仍然适用。
- **L-T010-06（截图脚本日志小瑕疵）**：已提交的 `T010_INTERACTION.log` 末尾
  "CAPTURE RESULT: OK" 出现两次（`.mjs` 经 `tee` 记一次 + 旧版 `.sh` 又记一次）；
  提交的脚本已去掉重复，内容无影响。

## L-T011 — 完整回归测试与独立复审（T011）

- **L-T011-01（发现 F-01，P2；状态已更新，见下）**：V-01 未完全修复。
  `timeline.css:281-283` 的 `.sf-event-chip.sf-replay-future { opacity: 0.45; }`
  使回放第 0 步时所有未回放芯片半透明，反例紫色虚线与快照竖直虚线透过芯片
  底色、穿过芯片文字——在已提交的 t010-U01/U02/U07/G12 四张截图中均可见
  （已 2 倍放大裁切核实），与 T010 交接“线条不再穿过文字”的说法矛盾。
  仅影响视觉，不影响任何判定、诊断、搜索结果或测试；不阻断 T012–T014。
  **状态更新（FIX-V-01，2026-11-23）**：V-01 已真正修复，证据为
  `07_evidence/screenshots/fix-v01-u01.png`、`fix-v01-u02.png`、
  `fix-v01-u07.png`、`fix-v01-g12.png`。T010 的 `t010-*.png` 不得作为已修复
  证据引用；V-01 以 FIX-V-01 证据为准。
- **L-T011-02（minor F-02）**：T008 交接的 UI 分套件数字是转录错误
  （components 13 非 14、timeline-layout 17 非 16；总数 42 正确，且 T008
  提交当时文件内已是 13/17）。仅文档错误，代码与测试无问题。
- **L-T011-03（minor F-03）**：`diagnoseSnapshotPair` 信任调用方传入的
  `consistent`（沿用 L-27）；两个现有调用方（`runSearchDetailed`、
  `evaluateSequence`）均已核验传值正确；未来调用方误传才有风险。
- **L-T011-04（minor F-04）**：`extractCounterexample` 的值门是引用干净度代理
  （沿用 L-22）；等价性只在 9 个场景的全部枚举快照对上验证 + 逐模板论证，
  未作一般性证明；BFS 判定本身不依赖它。
- **L-T011-05（minor F-05；仍开放）**：计划 §3 列出的 `05_tests/TEST_PLAN.md`
  不存在，历来无任务产出过它。T013 不创建该文件（不在 T013 交付物范围内）；
  留给 T014 在发布包整理时处理。
- **L-T011-06（minor F-06）**：项目书 §5.4“开始、暂停和重新运行”无独立的
  搜索暂停控件（搜索 < 11 ms，逐步回放即暂停机制）；§5.2 诊断区在单列布局
  中位于时间线下方而非右侧。布局解读差异，不影响验收。
- **L-T011-07（测试完整性说明）**：全历史仅有一次测试期望改写——FIX-T004-L17
  的 2 个测试（严格读法 → ADR-002 值优先读法），系冻结 ADR 授权的改动，
  附 3 个新增回归测试覆盖同一路径；套件总数从未下降（70 → 73）。除此之外
  无测试删除、无跳过、无注释掉的测试（git 历史 `--diff-filter=D` 为空；
  `.skip/.todo/.only` grep 零命中）。
- **L-T011-08（审查范围边界）**：浏览器截图的 CDP 拍摄过程与 21/27 项 DOM
  检查未由复审员重跑（复核的是已提交 PNG 与 UI 测试）；性能门（T012）、
  文档/许可证（T013）、发布包（T014）不在本次审查范围。
- **L-T011-09（沿用既往）**：L-T005-01~06、L-T006-01~07、L-T007-01~06、
  L-T008-01~08、L-T009-01~06、L-T010-01~06 均已逐项复核属实
  （详见 T011_REVIEW.md §2.7），继续沿用；其中 FIX-T004-L17 的 L-23/L-24
  已由 FIX-T003-L23 关闭（已在现行代码中核验）。

## L-T012 — 10 事件性能测试（T012）

- **L-T012-01（Worker 往返为 node 内进程内测量）**：Worker round-trip 经
  `createLocalWorkerClient()` 的 `LocalWorkerTransport`（同一类型化协议
  `snapfence.worker/v1`，setTimeout 异步路由），不是真正的浏览器 Worker 线程；
  真实浏览器 Worker 往返由 T010 的 Chrome CDP 证据覆盖（≤ 10 ms，G12），与本次
  node 内测量（G12 稳态 max 8.239 ms、首跑 13.430 ms）同量级。浏览器内首跑含
  真实 Worker 线程创建，理论上高于 node 内首跑，但余量 > 70 倍。
- **L-T012-02（计时为机器相对值）**：`< 1 秒`结论测于本 VM；最慢场景
  （G12 纯算法 max 8.187 ms）余量 > 120 倍，结论稳健，但绝对数字随机器而异，
  需在其他机器上重测。两次验收跑的 G12 纯算法 max 分别为 5.340 ms 与
  8.187 ms（中位 4.920 → 5.609 ms），抖动属正常计时噪声。
- **L-T012-03（个别 Worker 样本低于纯算法样本是计时口径产物）**：如 U10 首跑
  0.445 ms、G09/G11 稳态 min 约 0.5–0.6 ms，低于同场景纯算法样本——
  `LocalWorkerTransport` 的 setTimeout(0) 回调在事件循环空闲时几乎立即触发，
  而 `performance.now()` 的计时粒度与事件循环调度会使个别样本偏小；所有样本
  均如实报告、未删改，PASS 结论取的是 max（最坏样本），不受此影响。
- **L-T012-04（`T012_TYPECHECK.log` 与 T011 的同名日志 SHA 相同）**：类型检查
  无错误输出，两次日志内容均为 npm 头部，SHA 相同属实，非复制粘贴错误。
- **L-T012-05（沿用既往）**：L-T011-01（V-01 未完全修复，兄弟 FIX-V-01 任务
  正在并行修复，本任务未碰）及 L-T005/L-T006/L-T007/L-T008/L-T009/L-T010
  系列继续沿用；性能门本身与之无关。注：FIX-V-01 随后已完成修复，
  见 L-T011-01 的状态更新。

## L-FIX-V-01 — 快照芯片文字重叠真正修复（FIX-V-01）

- **L-FIX-V-01-01（2 倍裁切图未提交）**：裁切图只存于 `/tmp/fix-v01-crops/`
  （按任务要求不提交）；复核者可用 `FIX-V-01_CAPTURE.log` 中的芯片 rect
  自行重裁，或直接目视四张 fix-v01 PNG 全图。
- **L-FIX-V-01-02（截图变体脚本未提交）**：`/tmp/fix-v01-capture.mjs` 未入库；
  它是 t010-capture.mjs 的改名改输出变体，逻辑相同，未来复拍可按同一做法重建。
- **L-FIX-V-01-03（沿用 T008/T010）**：L-T008-01（无 Golden 最短反例携带
  DANGLING_REFERENCE）、L-T008-02（无 jsdom，浏览器点击未做自动化）、
  L-T008-07（反例折线 Y 位置近似）、L-T008-08（UNSAFE 只显示最短反例事件）、
  L-T010-01/02/03（Worker 超时是虚拟时间产物；取消不抢占同步搜索；节点内
  Worker 传输是进程内模拟）仍然适用；本次纯 CSS 改动不影响其中任何一项。
- **纠正记录**：T010 交接中“V-01 修复 … 线条不再穿过文字”的结论被 T011 F-01
  与本任务的复核推翻（其自带 t010 截图即为反证）；本任务取代该结论，
  V-01 以本次 fix-v01 证据为准，状态为已修复。

## L-T013 — 本任务新增（文档、隐私与许可证）

- **L-T013-01（文档中的性能数字为机器相对值）**：README 与 ALGORITHM.md 引用
  的性能数字（G12 纯算法 max 8.187 ms 等）测于本 VM（见 performance.json 的
  environment）；在其他机器上须重测。`npm run verify:docs` 只比对文档引用的
  数字与 `performance.json` / `S0_GATE.md` 的一致性，不重新测量性能。
- **L-T013-02（验证脚本是文本与解析比对，不是独立重测）**：`verify:docs` 与
  `verify:license` 是确定性检查脚本（断言 + 文件解析），它们不重新运行 BFS、
  不重新测量性能、不重新执行 Oracle。真正的重测仍由 `npm test`、`s0:gate`
  与 `test:oracle` 承担。
- **L-T013-03（TEST_PLAN.md 仍缺失）**：计划 §3 列出的 `05_tests/TEST_PLAN.md`
  仍不存在（沿用 L-T011-05）；T013 未创建它，留给 T014 在发布包整理时处理。

## L-R1-07 — 终审 R1 P2 修复（R1-07）

- **L-R1-07-01（场景标识符仍含 DANGLING，标签已改名）**：R1-07 把
  `SCENARIO_LABELS` 中 U02/U07 由“悬空引用”改名为“孤立 Blob”，与二者最短反例
  的诊断 `ORPHAN_BLOB` 一致（改名是 P2-R1-01 的修复选择；见 L-T005-02：悬空
  引用只出现在更长的 4 事件路径中，不是期望反例）。但夹具 `scenarioId`
  （`U02_DB_FIRST_DELETE_DANGLING`、`U07_FILE_FIRST_UPLOAD_DANGLING`）未改名——
  它是 7 个测试文件与 `fixtures/golden/manifest.json` 引用的标识符，改名会波及
  测试套件，超出本次 P2 标签修复的许可范围。标识符与标签含义分裂是已知状态，
  待 R1-02 规格同步时与计划 §6 一并裁决；改名绝不能只改夹具不改测试。
- **L-R1-07-02（计划书 / 项目书 / 用户指南仍用旧名）**：IMPLEMENTATION_PLAN.md
  §6.1、PROJECT_BOOK.md §9.2/§9.3 与 `docs/USER_GUIDE.md` 的 U02/U07 表述仍为
  “悬空引用”——01_/02_ 不属于 R1-07 的修改范围（由 P030-R1-02 同步），
  USER_GUIDE.md 亦未列入本任务许可。UI 场景选择器显示的已是新名；旧名所指的
  4 事件悬空引用路径本身真实存在，只是不是最短反例（见 L-T005-02）。
- **L-R1-07-02 已修复（P030-R1-07b，2026-11-23）**：三处叙述已与 `SCENARIO_LABELS`
  新名一致——IMPLEMENTATION_PLAN.md §6.1 与 `docs/USER_GUIDE.md` §3 表格改用
  “孤立 Blob”；PROJECT_BOOK.md §9.2/§9.3 标题改为“孤立 Blob”，示例顺序同步改为
  夹具 `expectedCounterexample` 的 3 事件最短反例（U07：BLOB_PUT → BLOB_SNAPSHOT
  → DB_SNAPSHOT；U02：DB_UNLINK → DB_SNAPSHOT → BLOB_SNAPSHOT），诊断
  ORPHAN_BLOB。仅改标题会留下与示例矛盾的 DANGLING_REFERENCE 诊断，故示例一并
  改写；旧 4 事件悬空引用路径本身仍真实存在（见 L-T005-02 与 USER_GUIDE.md §5
  末段），只是不是最短反例。四份规格文件新 SHA-256（已同步 Drive，见交接
  `03_tasks/P030-R1-07b.md`）：PROJECT_BOOK.md
  `9746484531a8fac3c6f92b08c1da5b99a22364d5dfe98233f1758caa152a7217`、
  PROJECT_BOOK.docx
  `a80cfe88e393901eb9f80a3f9b3581c54ca8f239acd20b1083607339b2de1c97`、
  IMPLEMENTATION_PLAN.md
  `0026b85f756bb64d4d545fdb8e7b3cdfaba90b5f137ebb89311e4517200bd9e9`、
  IMPLEMENTATION_PLAN.docx
  `c7dee0c70b12d496e0c78424cb08a9154d04e72cdf314c2896e7221ecf463532`。

## L-R1-01 — INVALID_INPUT 报告归一化（P030-R1-01，终审 R1 P1-R1-01）

- **L-R1-01-01（归一化契约）**：终审 R1 发现空 scenarioId 与非法策略
  "DB_LAST" 的 INVALID_INPUT 报告违反 snapfence.report/v1（前者违
  `scenarioId` minLength 1，后者违策略枚举），`exportJson()` 照原样序列化。
  修复统一在 `buildInvalidInputResult` 内归一化：scenarioId 为空、空白或非字
  符串时报告字段取占位值 `UNKNOWN_SCENARIO`；策略非三个合法字面值时取默认值
  `DB_FIRST`（首个枚举值，仅为模式合法占位，不表示输入策略）；合法的
  scenarioId / 策略一律原样保留。归一化是唯一 choke point：runSearchDetailed
  的非法对象路径、非对象路径与 runSearch 的 fail-closed 兜底路径都经它出报告。
- **L-R1-01-02（原始输入保存在 limitations，不在模式受限字段）**：原始非法输入
  保存在一条独立的 `limitations` 条目中（`limitations` 是 schema 已允许的
  `string[]`，见 L-T009-04）：对象输入为
  `Raw invalid input (the normalized report values are placeholders, not the input values): scenarioId=<JSON> strategy=<JSON>.`；
  非对象输入（null / undefined / 非对象）为整段输入的同款记录。仅当归一化确实
  改动了值时才写该条；合法 id 的 INVALID_INPUT（如重复操作 id）不写。
  未新增任何顶层字段，§8.4 的 12 个字段与 `additionalProperties: false` 不变，
  Schema 未被削弱（minLength 与枚举均保留）。
- **L-R1-01-03（HTML 路径）**：HTML 导出在场景 ID / 策略栏位渲染归一化后的值，
  原始非法值只出现在经转义的 limitations 列表文本中，不出现在任何字段位置；
  HTML 本身无 Schema，但同一份 SearchResult 保证两路导出一致。
- **L-R1-01-04（buildLimitResult 未动）**：INCONCLUSIVE_LIMIT 路径不可达非法
  id/策略——进入该路径要求全部 issue 均为 MAX_EVENTS_EXCEEDED，而该条件蕴含
  id 与策略已通过校验；故不对其加归一化。
- **L-R1-01-05（回归测试位置）**：12 项新回归在
  `tests/integration/export/invalid-input-report.test.ts`（断言的是导出契约，
  且 `scripts/s0-gate.ts` 把 `test:search` 冻结在 98 项，改 scripts 不在本任务
  许可内）；全量 `npm test` 为 467 项（455 + 12），S0 仍 14/14 PASS。
