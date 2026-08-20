# universal-mcp-toolkit

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <b>Deutsch</b> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

**Das kanonische Open-Source-Monorepo für produktionsreife MCP-Server.**

Ein einziger Ort für großartige MCP-Server für GitHub, Slack, Notion, Datenbanken, Cloud-Plattformen, Recherchequellen und lokale Dateien — ohne ein Dutzend halbfertiger Repos zusammenzuflicken.

## ⚡ Schnellstart

```bash
# Alle 28 verfügbaren Server anzeigen
npx universal-mcp-toolkit list

# Interaktive Einrichtung — Server wählen, Transport wählen, Config schreiben
npx universal-mcp-toolkit install

# Claude-Desktop-Config-Snippet erzeugen
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# Einen Server lokal ausführen
npx universal-mcp-toolkit run github --transport stdio

# Umgebung vor dem Debuggen prüfen
npx universal-mcp-toolkit doctor github
```

Oder global installieren:

```bash
npm install -g universal-mcp-toolkit
umt list
```

## Warum es das gibt

Das MCP-Ökosystem explodiert, aber die Developer Experience ist immer noch fragmentiert:

- Die meisten Repos lösen eine schmale Integration
- Viele Server bleiben bei ein, zwei Demo-Tools stehen
- Transport-Support, Auth-Handling, Doku und Packaging sind wild inkonsistent

`universal-mcp-toolkit` behebt das mit einem hochwertigen Turborepo:

- **28 produktionsorientierte MCP-Server**
- Ein gemeinsamer TypeScript-Kern im Strict-Modus
- Ein ausgereiftes CLI: installieren, konfigurieren, ausführen, diagnostizieren
- Konsistente Zod-Validierung, strukturierte Fehler und pino-Logging
- Drei Transporte: stdio, SSE und MCP 2026-07-28 Streamable HTTP

## 🌐 Das AI Trio

UMT ist eines von drei Schwesterprojekten, die zusammenpassen:

| Projekt | Rolle |
|---------|-------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCP-Protokoll, Server-Registry und Tool-Routing |
| [memos](https://github.com/Markgatcha/memos) | Graph-basiertes persistentes Gedächtnis über Sessions hinweg |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | Token-Kostenwächter: komprimiert Prompts und injiziert Erinnerungen |

Der MemOS-MCP-Adapter wird als `@mem-os/sdk` veröffentlicht und passt direkt zum `link memos`-Befehl von UMT.

## 🌐 Community

- Website: https://context-core.dev/umt/
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ Star-Verlauf

Wenn UMT dir das Zusammenflicken eines Dutzends halbfertiger MCP-Repos erspart, denk an den Stern — er hält das Projekt sichtbar.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## Lizenz

MIT — vollständige Bedingungen in [LICENSE](../LICENSE).
