# universal-mcp-toolkit

<p align="center">
  <a href="../README.md">English</a> · <b>简体中文</b> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

**生产级 MCP 服务器的权威开源 monorepo。**

一个地方找到 GitHub、Slack、Notion、数据库、云平台、研究来源和本地文件的优秀 MCP 服务器 —— 无需拼凑十几个半成品仓库。

## ⚡ 快速开始

```bash
# 查看全部 28 个可用服务器
npx universal-mcp-toolkit list

# 交互式安装 —— 选择服务器、选择传输方式、写入配置
npx universal-mcp-toolkit install

# 生成 Claude Desktop 配置片段
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# 本地运行服务器
npx universal-mcp-toolkit run github --transport stdio

# 调试前检查环境
npx universal-mcp-toolkit doctor github
```

或全局安装：

```bash
npm install -g universal-mcp-toolkit
umt list
```

## 为什么存在

MCP 生态正在爆发，但开发者体验仍然碎片化：

- 大多数仓库只解决一个狭窄的集成
- 许多服务器停留在演示质量的一两个工具
- 传输支持、认证处理、文档和打包质量参差不齐

`universal-mcp-toolkit` 用一个高质量 Turborepo 解决这些问题：

- **28 个面向生产的 MCP 服务器**
- 一个共享的严格模式 TypeScript 核心
- 一个完善的 CLI：安装、配置、运行、诊断
- 一致的 Zod 校验、结构化错误和 pino 日志
- 三种传输：stdio、SSE 和 MCP 2026-07-28 流式 HTTP

## 🌐 AI 三件套

UMT 是三个可组合的姊妹项目之一：

| 项目 | 角色 |
|------|------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCP 协议、服务器注册表与工具路由 |
| [memos](https://github.com/Markgatcha/memos) | 跨会话的图结构持久记忆 |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | 压缩提示词、注入记忆切片的 token 成本守卫 |

MemOS MCP 适配器以 `@mem-os/sdk` 发布，与 UMT 的 `link memos` 命令直接配对。

## 🌐 社区

- 网站：https://context-core.dev/umt/
- Discord：https://discord.gg/DyQGgPuueu
- Twitter/X：https://x.com/Context_Core

## ⭐ Star 趋势

如果 UMT 让你免于拼凑十几个半成品 MCP 仓库，请点一颗星 —— 它让项目保持可见。

<p align="center">
  <a href="https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## 许可证

MIT —— 完整条款见 [LICENSE](../LICENSE)。
