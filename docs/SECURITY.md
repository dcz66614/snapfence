# SnapFence 安全说明

## 1. 运行边界

- SnapFence 是本地运行的静态应用：不需要后端，不需要数据库，不访问互联网，
  不调用任何模型，不上传任何输入，不需要 GPU，不要求安装 Docker。
- 全部输入都是仓库内自带的合成场景；产品不接受真实数据库文件，不接受真实
  Blob 目录，不读取用户的真实文件。
- 不使用浏览器本地存储（无 localStorage / sessionStorage / indexedDB）；
  刷新页面即可清空当前实验状态。
- 不记录浏览器遥测，不保存生产凭据，不使用外部模型。

## 2. 导出报告的安全性

导出的 HTML 报告必须满足（PROJECT_BOOK §11.2，T009 已验收）：

- 自包含：不加载远程脚本，不加载远程字体，不发起网络请求。
- 报告中的全部文本经过正确转义（`escapeHtml`），不将报告中的字符串解释为
  可执行代码；HTML 导出不含 `<script>` 与内联事件处理。
- 导出的 JSON 符合 `snapfence.report/v1`（见 `src/export/report-schema.ts`），
  由手写校验器 `validateReport` 校验；同一 `SearchResult` 对象既用于 UI 渲染
  也用于导出，两者判定一致。

## 3. 依赖与供应链

- 产品运行时依赖只有 `react` 与 `react-dom`（MIT）。
- 全部依赖（含传递依赖）固定在 `package-lock.json` 中；许可证逐项记录在
  `THIRD_PARTY_NOTICES.md`（95 个包，MIT 84、Apache-2.0 3、ISC 6、
  BSD-3-Clause 1、CC-BY-4.0 1；无 copyleft 许可证）。
- 独立 Python Oracle 只用 Python 标准库，无第三方 Python 包。
- 项目自有代码使用 MIT License（见 `LICENSE`）。

## 4. 漏洞报告

SnapFence 目前没有已发布的公开仓库，也没有安全联系邮箱——**不要编造联系邮箱**。

- 如果你在使用 SnapFence 时发现安全问题，请在项目公开后通过该仓库的
  GitHub Issues 报告（选择安全相关标签并描述复现步骤）。
- 在公开仓库建立之前，请通过项目维护者已公布的公开联系渠道反馈，
  不要把漏洞细节发到公开社交平台。
- 请勿提交真实生产数据、真实凭据或真实用户文件作为复现材料；
  复现请只用合成场景。

## 5. 不在安全承诺内的事项

- SnapFence 不备份真实数据，不承诺工业级备份正确性（见 README 的诚实边界）。
- `SAFE_WITHIN_BOUND` 是有界模型结论，不是真实系统安全的保证。
- 本文件不承诺任何响应时限；公开仓库建立后，响应流程以仓库的
  SECURITY.md 为准。
