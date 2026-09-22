# Agent Hong

Agent Hong 是面向建筑设计院的轻量 AI 工具。V0.1 只做一个入口：**施工图版本变更分析**。

## V0.1 做什么

用户上传 A / B 两版 PDF 或图片，浏览器端先把 PDF 转成页面图，再由 Cloudflare Worker 调用 MiniMax M3 做多模态比较，输出：

- 可观察到的版本变化
- 高风险变化
- 疑似漏同步 / 前后不一致
- 人工复核建议

> 该工具用于辅助版本核对，不替代设计人员、注册执业人员或法定施工图审查。

## 架构

- Frontend: 原生 HTML/CSS/JS
- PDF 预处理: 浏览器端 PDF.js，原始 PDF 不发送给 Worker
- Backend: Cloudflare Worker
- Model: MiniMax M3
- Domain: `zhanghong.fhkq.best`
- Storage: V0.1 不落库、不保存项目文件

## Cloudflare 配置

必须设置 Worker Secret：

```bash
npx wrangler secret put MINIMAX_API_KEY
```

默认使用中国区 OpenAI-compatible endpoint：

```text
https://api.minimaxi.com/v1
```

如使用国际站 API，请将 `MINIMAX_API_BASE` 改为 `https://api.minimax.io/v1`，并配套使用国际站 Key。

部署：

```bash
npm install
npm run check
npm run deploy
```

`wrangler.jsonc` 已声明 Custom Domain：`zhanghong.fhkq.best`。部署令牌需要 Worker 编辑权限，以及该域名所在 Zone 的 Workers Routes Write 权限。

## GitHub Actions

仓库内的 workflow 会在 `main` push 时尝试部署。需要在 GitHub Actions Secrets 中配置：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `MINIMAX_API_KEY`（可选；配置后 workflow 会在部署后同步为 Worker Secret）

## V0.1 边界

- 每版最多处理前 8 页 PDF
- 单文件建议不超过 35MB
- 不直接解析 DWG / 天正对象
- 不做法定规范审图结论
- 不保存上传文件
