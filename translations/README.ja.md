# universal-mcp-toolkit

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <b>日本語</b> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

**本番対応MCPサーバーの正統なオープンソースmonorepo。**

GitHub、Slack、Notion、データベース、クラウドプラットフォーム、リサーチソース、ローカルファイルのための優れたMCPサーバーを1つの場所で — 半端なリポジトリを十数個つなぎ合わせる必要なし。

## ⚡ クイックスタート

```bash
# 利用可能な28サーバーをすべて表示
npx universal-mcp-toolkit list

# インタラクティブセットアップ — サーバー選択、トランスポート選択、設定書き込み
npx universal-mcp-toolkit install

# Claude Desktop用の設定スニペットを生成
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# サーバーをローカルで実行
npx universal-mcp-toolkit run github --transport stdio

# デバッグ前に環境をチェック
npx universal-mcp-toolkit doctor github
```

またはグローバルインストール：

```bash
npm install -g universal-mcp-toolkit
umt list
```

## なぜ存在するのか

MCPエコシステムは爆発的に成長していますが、開発者体験はまだ断片的です：

- ほとんどのリポジトリは1つの狭い統合しか解決しない
- 多くのサーバーはデモ品質の1〜2ツールで止まっている
- トランスポート対応、認証処理、ドキュメント、パッケージングがまちまち

`universal-mcp-toolkit`は高品質なTurborepoひとつでこれを解決します：

- **28の本番向けMCPサーバー**
- 共有のstrictモードTypeScriptコア
- 洗練されたCLI：インストール、設定、実行、診断
- 一貫したZodバリデーション、構造化エラー、pinoロギング
- 3つのトランスポート：stdio、SSE、MCP 2026-07-28ストリーマブルHTTP

## 🌐 AI Trio

UMTは、組み合わせ可能な3つの姉妹プロジェクトのひとつです：

| プロジェクト | 役割 |
|--------------|------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCPプロトコル、サーバーレジストリ、ツールルーティング |
| [memos](https://github.com/Markgatcha/memos) | セッションをまたぐグラフベースの永続メモリ |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | プロンプトを圧縮しメモリを注入するトークンコストガーディアン |

MemOS MCPアダプターは`@mem-os/sdk`として公開され、UMTの`link memos`コマンドと直接連携します。

## 🌐 コミュニティ

- ウェブサイト：https://context-core.dev/umt/
- Discord：https://discord.gg/DyQGgPuueu
- Twitter/X：https://x.com/Context_Core

## ⭐ スターの履歴

UMTが半端なMCPリポジトリのつなぎ合わせから解放してくれたら、スターをお願いします — プロジェクトの可視性が保たれます。

<p align="center">
  <a href="https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## ライセンス

MIT — 全文は[LICENSE](../LICENSE)を参照。
