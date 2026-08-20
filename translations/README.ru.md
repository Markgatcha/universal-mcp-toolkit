# universal-mcp-toolkit

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <b>Русский</b> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

**Канонический опенсорсный монорепо продакшен-готовых MCP-серверов.**

Одно место, где собраны отличные MCP-серверы для GitHub, Slack, Notion, баз данных, облачных платформ, источников исследований и локальных файлов — без склеивания дюжины наполовину готовых репозиториев.

## ⚡ Быстрый старт

```bash
# Показать все 28 доступных серверов
npx universal-mcp-toolkit list

# Интерактивная установка — выбор серверов, транспорта, запись конфига
npx universal-mcp-toolkit install

# Сгенерировать конфиг для Claude Desktop
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# Запустить сервер локально
npx universal-mcp-toolkit run github --transport stdio

# Проверить окружение перед отладкой
npx universal-mcp-toolkit doctor github
```

Или установите глобально:

```bash
npm install -g universal-mcp-toolkit
umt list
```

## Зачем это нужно

Экосистема MCP взрывной растёт, но опыт разработчика всё ещё фрагментирован:

- Большинство репозиториев решают одну узкую интеграцию
- Многие серверы останавливаются на паре демо-инструментов
- Поддержка транспортов, аутентификация, документация и упаковка сильно различаются

`universal-mcp-toolkit` решает это одним качественным Turborepo:

- **28 продакшен-ориентированных MCP-серверов**
- Одно общее ядро на TypeScript в строгом режиме
- Отполированный CLI: установка, настройка, запуск, диагностика
- Последовательная Zod-валидация, структурированные ошибки и логирование pino
- Три транспорта: stdio, SSE и MCP 2026-07-28 streamable HTTP

## 🌐 AI Trio

UMT — один из трёх родственных проектов, которые сочетаются друг с другом:

| Проект | Роль |
|--------|------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | Протокол MCP, реестр серверов и маршрутизация инструментов |
| [memos](https://github.com/Markgatcha/memos) | Графовая постоянная память между сессиями |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | Страж стоимости токенов: сжимает промпты и внедряет память |

MCP-адаптер MemOS публикуется как `@mem-os/sdk` и напрямую работает с командой UMT `link memos`.

## 🌐 Сообщество

- Сайт: https://context-core.dev/umt/
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ История звёзд

Если UMT избавляет вас от склеивания дюжины наполовину готовых MCP-репозиториев — поставьте звезду, это держит проект на виду.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## Лицензия

MIT — полные условия в [LICENSE](../LICENSE).
