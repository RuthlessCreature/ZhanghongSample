# Agent Hong

Agent Hong 是面向建筑设计院的轻量 AI 版本校核工具。当前只完成一个入口：**施工图版本变更分析**。

## 完整版第一入口：三层校核

1. **PDF Text Diff（确定性层）**
   - 浏览器用 PDF.js 直接提取 PDF 文字层、尺寸、图号和坐标。
   - 数字/文字差异由程序比较，不依赖模型 OCR。
   - 可识别数值替换并计算差值，例如 `12000 → 12800 / Δ +800`。
   - 优先按图号（如 `A-101`）配对页面，找不到图号时再按页码配对。

2. **Visual Region Diff（视觉定位层）**
   - 浏览器将 A/B 页面二值化后做像素差异。
   - 自动合并差异区域并生成 A/B 对照裁图。
   - 只把主要差异区域作为高精度视觉证据，减少模型在整张 A3 图纸里“找针”。

3. **MiniMax M3 Engineering Review（语义层）**
   - 完整页面以低精度提供上下文。
   - 差异区域以高精度提供给 MiniMax M3。
   - 程序提取的精确文字/数字被声明为最高优先级证据，模型不得用视觉 OCR 覆盖。
   - 重点检查平面↔立面、平面↔剖面、平面↔门窗表/材料表、尺寸链↔修订说明等跨图漏同步。

## 输出

- 确定性文字 / 数字变化（程序证据）
- 工程语义变化（AI）
- 跨图漏同步风险
- 视觉变化区域 A/B 对照图
- 人工复核清单
- 本次分析局限
- JSON 报告下载
- 浏览器打印 / 导出 PDF

## 隐私与架构

- Frontend：原生 HTML/CSS/JS
- PDF 预处理：浏览器端 PDF.js
- Backend：Cloudflare Worker
- Model：MiniMax M3
- Domain：`zhanghong.fhkq.best`
- Storage：不落库、不保存项目文件
- 原始 PDF 不上传 Worker；只发送压缩页面图、程序提取的差异证据和差异区域图。

## 当前边界

- 每版最多读取前 8 页。
- 单文件建议 ≤ 35MB。
- PDF 有文字层时进入 `HYBRID` 模式；扫描 PDF / 图片进入 `VISUAL` 模式。
- 不直接解析 DWG / 天正对象。
- 不做法定规范审图结论。
- AI 判断用于辅助核对，最终以原始图纸与专业人员复核为准。

## MiniMax

中国区 OpenAI-compatible endpoint：

```text
https://api.minimaxi.com/v1
```

Worker Secret：

```bash
npx wrangler secret put MINIMAX_API_KEY
```

国际站需同时切换 endpoint 与对应国际站 Key。

## 部署

```bash
npm install
npm run check
npm run deploy
```

GitHub Actions `main` 分支自动部署。Repository Secrets：

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `MINIMAX_API_KEY`

## 回归测试

`tests/diff-core.test.mjs` 覆盖：

- 精确数字替换与 delta 计算
- 房间名替换
- 未变化文字过滤
- 按图号跨页配对
- HYBRID / VISUAL 模式判定基础逻辑
