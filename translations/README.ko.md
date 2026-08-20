# universal-mcp-toolkit

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · <b>한국어</b> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.pt-BR.md">Português</a> · <a href="README.ru.md">Русский</a> · <a href="README.hi.md">हिन्दी</a> · <a href="README.ar.md">العربية</a>
</p>

**프로덕션 준비 완료 MCP 서버의 정통 오픈소스 모노레포.**

GitHub, Slack, Notion, 데이터베이스, 클라우드 플랫폼, 리서스 소스, 로컬 파일을 위한 훌륭한 MCP 서버를 한곳에서 — 미완성 레포 열 개를 꿰맞출 필요 없이.

## ⚡ 빠른 시작

```bash
# 사용 가능한 28개 서버 모두 보기
npx universal-mcp-toolkit list

# 대화형 설치 — 서버 선택, 전송 방식 선택, 설정 작성
npx universal-mcp-toolkit install

# Claude Desktop용 설정 스니펫 생성
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# 서버를 로컬에서 실행
npx universal-mcp-toolkit run github --transport stdio

# 디버깅 전에 환경 점검
npx universal-mcp-toolkit doctor github
```

또는 전역 설치:

```bash
npm install -g universal-mcp-toolkit
umt list
```

## 왜 존재하는가

MCP 생태계는 폭발적으로 성장하고 있지만, 개발자 경험은 여전히 파편화되어 있습니다:

- 대부분의 레포는 하나의 좁은 통합만 해결
- 많은 서버가 데모 수준의 도구 한두 개에서 멈춤
- 전송 지원, 인증 처리, 문서화, 패키징이 제각각

`universal-mcp-toolkit`은 고품질 Turborepo 하나로 이를 해결합니다:

- **28개의 프로덕션 지향 MCP 서버**
- 하나의 공유 strict 모드 TypeScript 코어
- 세련된 CLI: 설치, 설정, 실행, 진단
- 일관된 Zod 검증, 구조화된 에러, pino 로깅
- 세 가지 전송: stdio, SSE, MCP 2026-07-28 스트리머블 HTTP

## 🌐 AI Trio

UMT는 함께 구성할 수 있는 세 개의 자매 프로젝트 중 하나입니다:

| 프로젝트 | 역할 |
|----------|------|
| [universal-mcp-toolkit](https://github.com/Markgatcha/universal-mcp-toolkit) | MCP 프로토콜, 서버 레지스트리, 도구 라우팅 |
| [memos](https://github.com/Markgatcha/memos) | 세션을 아우르는 그래프 기반 영구 메모리 |
| [llm-guardian](https://github.com/Markgatcha/llm-guardian) | 프롬프트를 압축하고 메모리를 주입하는 토큰 비용 가디언 |

MemOS MCP 어댑터는 `@mem-os/sdk`로 배포되며, UMT의 `link memos` 명령과 직접 연동됩니다.

## 🌐 커뮤니티

- 웹사이트: https://context-core.dev/umt/
- Discord: https://discord.gg/DyQGgPuueu
- Twitter/X: https://x.com/Context_Core

## ⭐ 스타 히스토리

UMT가 미완성 MCP 레포를 꿰맞추는 수고에서 벗어나게 해준다면, 스타를 부탁드립니다 — 프로젝트가 계속 보이게 됩니다.

<p align="center">
  <a href="https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date">
    <img src="https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date" alt="Star History Chart" width="640" />
  </a>
</p>

## 라이선스

MIT — 전체 조건은 [LICENSE](../LICENSE) 참조.
