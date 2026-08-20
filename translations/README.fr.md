# universal-mcp-toolkit

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <b>Français</b> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

**Le monorepo open source canonique de serveurs MCP prêts pour la production.**

Un seul endroit pour trouver d'excellents serveurs MCP pour GitHub, Slack, Notion, les bases de données, les plateformes cloud, les sources de recherche et les fichiers locaux — sans assembler une douzaine de repos à moitié finis.

## ⚡ Démarrage rapide

```bash
# Voir les 28 serveurs disponibles
npx universal-mcp-toolkit list

# Installation interactive — choisissez vos serveurs, le transport, écrit la config
npx universal-mcp-toolkit install

# Générer un snippet de config pour Claude Desktop
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# Lancer un serveur localement
npx universal-mcp-toolkit run github --transport stdio

# Vérifier votre environnement avant de déboguer
npx universal-mcp-toolkit doctor github
```

Ou installez-le globalement :

```bash
npm install -g universal-mcp-toolkit
umt list
```

## Pourquoi ce projet existe

L'écosystème MCP explose, mais l'expérience développeur reste fragmentée :

- La plupart des repos résolvent une intégration étroite
- Beaucoup de serveurs s'arrêtent à un ou deux outils de qualité démo
- Le support des transports, l'authentification, la doc et le packaging sont incohérents

`universal-mcp-toolkit` corrige ça avec un Turborepo de haute qualité :

- **28 serveurs MCP orientés production**
- Un cœur TypeScript partagé en mode strict
- Un CLI soigné : installer, configurer, lancer, diagnostiquer
- Validation Zod cohérente, erreurs structurées et logs pino
- Trois transports : stdio, SSE et HTTP streamable MCP 2026-07-28

## 🌐 L'AI Trio

UMT est l'un des trois projets frères qui se combinent :

| Projet | Rôle |
|--------|------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | Protocole MCP, registre de serveurs et routage d'outils |
| [memos](https://github.com/Markgatcha/memos) | Mémoire persistante en graphe entre sessions |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | Gardien du coût en tokens : compresse les prompts et injecte la mémoire |

L'adaptateur MCP de MemOS est publié sous `@mem-os/sdk` et s'associe directement à la commande `link memos` d'UMT.

## 🌐 Communauté

- Site web : https://context-core.dev/umt/
- Discord : https://discord.gg/DyQGgPuueu
- Twitter/X : https://x.com/Context_Core

## ⭐ Historique des étoiles

Si UMT vous évite d'assembler une douzaine de repos MCP à moitié finis, pensez à l'étoile — elle garde le projet visible.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## Licence

MIT — voir [LICENSE](../LICENSE) pour les termes complets.
