# SnapFence 用户操作指南

SnapFence 是一个本地运行的应用级备份一致性模型检查器。
它不备份真实数据，不连接真实数据库，不读取你的真实文件。
全部输入都是仓库内自带的合成场景。

## 1. 打开与运行

```sh
npm ci
npm run dev
```

在浏览器中打开开发服务器地址。也可以先构建再预览：

```sh
npm run build
npm run preview
```

## 2. 一次检查的步骤

1. **选择一个合成场景**（24 个，见 §3）。
2. **选择备份策略**：数据库优先 DB_FIRST、文件优先 FILE_FIRST 或暂停写入 PAUSE_WRITES。
3. 点击 **“运行模型检查”**。搜索在 Web Worker 中执行，不阻塞界面；
   最大规模场景（10 个事件）的搜索本身不到 11 ms。
4. 查看结果：
   - 上轨是数据库时间线，下轨是 Blob 存储时间线；竖向标记是两个快照位置。
   - 右侧（单列布局中为时间线下方）是诊断区：最终判定、不一致类型、
     受影响的文件 ID、最短反例长度与事件顺序。
   - 悬空引用用红色突出，孤立对象用黄色突出。
5. **逐步回放最短反例**：使用回放控制一步步前进，每步显示该事件前后的
   数据库与 Blob 状态。回放是查看搜索过程的暂停机制——搜索本身太快，
   没有单独的搜索暂停按钮。
6. **导出报告**：点击“导出 JSON”得到 `snapfence-<场景 ID>.json`
  （`snapfence.report/v1`），或“导出 HTML”得到同名独立 HTML 报告。
   HTML 自包含，不加载任何远程资源，离线可打开。

## 3. 24 个合成场景

| ID | 策略 | 内容 | 预期判定 |
|---|---|---|---|
| U01 | DB_FIRST | 上传 A，孤立 Blob | UNSAFE_WITHIN_BOUND |
| U02 | DB_FIRST | 删除 C，孤立 Blob | UNSAFE_WITHIN_BOUND |
| U03 | DB_FIRST | 更新 A，旧版本缺失 | UNSAFE_WITHIN_BOUND |
| U04 | DB_FIRST | 更新 A，新版本孤立 | UNSAFE_WITHIN_BOUND |
| U05 | DB_FIRST | 两次独立上传，多个孤立对象 | UNSAFE_WITHIN_BOUND |
| U06 | DB_FIRST | 上传 A + 删除 B，两组件状态不一致 | UNSAFE_WITHIN_BOUND |
| U07 | FILE_FIRST | 上传 B，孤立 Blob | UNSAFE_WITHIN_BOUND |
| U08 | FILE_FIRST | 删除 C，孤立对象 | UNSAFE_WITHIN_BOUND |
| U09 | FILE_FIRST | 更新 A，新版本缺失 | UNSAFE_WITHIN_BOUND |
| U10 | FILE_FIRST | 更新 A，旧版本孤立 | UNSAFE_WITHIN_BOUND |
| U11 | FILE_FIRST | 上传 A + 更新 B，版本混合 | UNSAFE_WITHIN_BOUND |
| U12 | FILE_FIRST | 更新 A + 删除 B，无共同完整操作边界 | UNSAFE_WITHIN_BOUND |
| G01 | DB_FIRST | 空闲状态 | SAFE_WITHIN_BOUND |
| G02 | DB_FIRST | 上传完整完成后备份 | SAFE_WITHIN_BOUND |
| G03 | DB_FIRST | 删除完整完成后备份 | SAFE_WITHIN_BOUND |
| G04 | DB_FIRST | 更新完整完成后备份 | SAFE_WITHIN_BOUND |
| G05 | FILE_FIRST | 空闲状态 | SAFE_WITHIN_BOUND |
| G06 | FILE_FIRST | 上传完整完成后备份 | SAFE_WITHIN_BOUND |
| G07 | FILE_FIRST | 删除完整完成后备份 | SAFE_WITHIN_BOUND |
| G08 | FILE_FIRST | 更新完整完成后备份 | SAFE_WITHIN_BOUND |
| G09 | PAUSE_WRITES | 上传完成后暂停写入 | SAFE_WITHIN_BOUND |
| G10 | PAUSE_WRITES | 删除完成后暂停写入 | SAFE_WITHIN_BOUND |
| G11 | PAUSE_WRITES | 更新完成后暂停写入 | SAFE_WITHIN_BOUND |
| G12 | PAUSE_WRITES | 四个上传操作全部完成后暂停写入（10 个事件，最大规模） | SAFE_WITHIN_BOUND |

## 4. 怎样读判定

| 判定 | 含义 | 你该怎么做 |
|---|---|---|
| `SAFE_WITHIN_BOUND` | 在本次指定的事件模板、策略与事件规模内，穷举搜索没有发现不一致路径。 | 这是有界结论，不是“真实系统绝对安全”。见 README 的诚实边界。 |
| `UNSAFE_WITHIN_BOUND` | 至少存在一条不一致路径，并已给出最短反例。 | 回放反例，看两个快照分别落在了哪一步；检查你的备份顺序或暂停写入机制是否允许这种交错。 |
| `INCONCLUSIVE_LIMIT` | 输入超过支持的有界搜索规模（超过 10 个事件）。 | 缩小场景规模；不要把它读成 SAFE。 |
| `INVALID_INPUT` | 事件 DAG、操作依赖或策略输入不合法。 | 检查场景定义（如 `snapshotsAfter` 引用的操作是否存在）。 |

## 5. 怎样读诊断

- `DANGLING_REFERENCE`（CRITICAL）：数据库引用了一个 Blob 快照里没有的对象版本——
  恢复后可能出现损坏记录或无法访问的文件。
- `ORPHAN_BLOB`（WARNING）：Blob 快照里有一个数据库没有引用的对象版本——
  不等于必然丢失用户数据，可能是可重新导入或清理的残留数据。
- `GENERATION_MISMATCH`（CRITICAL）：数据库引用的版本与 Blob 的版本不一致。
- `DIGEST_MISMATCH`（CRITICAL）：对象内容摘要与数据库记录不一致。
- `IN_FLIGHT_OPERATION`（WARNING）：快照捕获时有操作正在进行中——仅作解释性诊断。
- `NO_COMMON_BOUNDARY`（CRITICAL）：两份快照找不到共同对应的合法操作边界——
  这是快照对不一致的根本判定。

一个 UNSAFE 场景的最短反例只展示最小的失效模式（长度均为 3，见 `docs/ALGORITHM.md`）；
同一场景里更长的路径可能暴露其他失效模式（如 U02/U07 的悬空引用），
它们不在最短反例里，但不代表不存在。

## 6. 隐私

- 只使用合成数据；不接受真实数据库文件，不接受真实 Blob 目录。
- 不上传文件，不保存生产凭据，不记录浏览器遥测，不使用外部模型。
- 不使用浏览器本地存储；刷新页面即可清空当前实验状态。
- 导出的 HTML 报告只包含本次检查的合成场景与判定，不含任何真实数据。
