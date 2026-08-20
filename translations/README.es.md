# universal-mcp-toolkit

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <b>Español</b> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

**El monorepo open source canónico de servidores MCP listos para producción.**

Un solo lugar para encontrar grandes servidores MCP para GitHub, Slack, Notion, bases de datos, plataformas cloud, fuentes de investigación y archivos locales — sin unir una docena de repos a medio hacer.

## ⚡ Inicio rápido

```bash
# Ver los 28 servidores disponibles
npx universal-mcp-toolkit list

# Instalación interactiva — elige servidores, transporte y escribe la config
npx universal-mcp-toolkit install

# Generar un snippet de configuración para Claude Desktop
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# Ejecutar un servidor localmente
npx universal-mcp-toolkit run github --transport stdio

# Revisar tu entorno antes de depurar
npx universal-mcp-toolkit doctor github
```

O instálalo globalmente:

```bash
npm install -g universal-mcp-toolkit
umt list
```

## Por qué existe

El ecosistema MCP está explotando, pero la experiencia de desarrollo sigue fragmentada:

- La mayoría de los repos resuelven una integración estrecha
- Muchos servidores se quedan en una o dos herramientas de calidad demo
- El soporte de transporte, la autenticación, la documentación y el empaquetado son inconsistentes

`universal-mcp-toolkit` lo arregla con un Turborepo de alta calidad:

- **28 servidores MCP listos para producción**
- Un núcleo compartido de TypeScript en modo estricto
- Un CLI pulido: instalar, configurar, ejecutar y diagnosticar
- Validación Zod consistente, errores estructurados y logging con pino
- Tres transportes: stdio, SSE y HTTP streamable MCP 2026-07-28

## 🌐 El AI Trio

UMT es uno de tres proyectos hermanos que se combinan:

| Proyecto | Rol |
|----------|-----|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | Protocolo MCP, registro de servidores y enrutado de herramientas |
| [memos](https://github.com/Markgatcha/memos) | Memoria persistente basada en grafo entre sesiones |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | Guardián de costes de tokens: comprime prompts e inyecta memoria |

El adaptador MCP de MemOS se publica como `@mem-os/sdk` y se empareja directamente con el comando `link memos` de UMT.

## 🌐 Comunidad

- Sitio web: https://context-core.dev/umt/
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ Historial de estrellas

Si UMT te ahorra unir una docena de repos MCP a medio hacer, considera la estrella — mantiene el proyecto visible.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## Licencia

MIT — ver [LICENSE](../LICENSE) para los términos completos.
