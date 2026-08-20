# universal-mcp-toolkit

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <b>Português</b> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

**O monorepo open source canônico de servidores MCP prontos para produção.**

Um único lugar para encontrar ótimos servidores MCP para GitHub, Slack, Notion, bancos de dados, plataformas cloud, fontes de pesquisa e arquivos locais — sem costurar uma dúzia de repositórios pela metade.

## ⚡ Início rápido

```bash
# Ver todos os 28 servidores disponíveis
npx universal-mcp-toolkit list

# Instalação interativa — escolha servidores, transporte e escreve a config
npx universal-mcp-toolkit install

# Gerar um snippet de config para o Claude Desktop
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# Rodar um servidor localmente
npx universal-mcp-toolkit run github --transport stdio

# Checar seu ambiente antes de depurar
npx universal-mcp-toolkit doctor github
```

Ou instale globalmente:

```bash
npm install -g universal-mcp-toolkit
umt list
```

## Por que existe

O ecossistema MCP está explodindo, mas a experiência de desenvolvimento ainda é fragmentada:

- A maioria dos repositórios resolve uma integração estreita
- Muitos servidores param em uma ou duas ferramentas de qualidade demo
- Suporte de transporte, tratamento de auth, docs e empacotamento são inconsistentes

O `universal-mcp-toolkit` resolve isso com um Turborepo de alta qualidade:

- **28 servidores MCP focados em produção**
- Um núcleo TypeScript compartilhado em modo estrito
- Um CLI polido: instalar, configurar, rodar e diagnosticar
- Validação Zod consistente, erros estruturados e logging com pino
- Três transportes: stdio, SSE e HTTP streamable MCP 2026-07-28

## 🌐 O AI Trio

O UMT é um dos três projetos irmãos que se combinam:

| Projeto | Papel |
|---------|-------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | Protocolo MCP, registro de servidores e roteamento de ferramentas |
| [memos](https://github.com/Markgatcha/memos) | Memória persistente baseada em grafo entre sessões |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | Guardião de custo de tokens: comprime prompts e injeta memória |

O adaptador MCP do MemOS é publicado como `@mem-os/sdk` e se conecta diretamente ao comando `link memos` do UMT.

## 🌐 Comunidade

- Site: https://context-core.dev/umt/
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ Histórico de estrelas

Se o UMT te poupa de costurar uma dúzia de repositórios MCP pela metade, considere a estrela — ela mantém o projeto visível.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## Licença

MIT — veja [LICENSE](../LICENSE) para os termos completos.
