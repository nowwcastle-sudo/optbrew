---
checked: 2026-10-16
source: https://seranking.com/api.html https://seranking.com/api/integrations/mcp
harness: any
---

# SE Ranking 연결하기 (선택, 유료 계정 필요)

## beginner

왜 필요한가: SE Ranking은 AI 검색 인용 같은 실측 수치를 줍니다. 기본 감사는 이 연결 없이 끝까지 갑니다. SE Ranking은 별도의 유료 계정이고 사용량(크레딧)이 내 계정에서 차감됩니다. 비용이 부담되면 이 런북 전체를 건너뜁니다.

1. 브라우저에서 seranking.com에 로그인합니다. 계정이 없으면 만들 수 있지만, 가입과 결제는 내가 직접 결정합니다.
2. API 사용 권한이 있는지 확인합니다. SE Ranking 문서는 API가 구독에 포함되며 무료 체험 계정에서도 시험할 수 있다고 안내합니다. 요금 조건은 서비스 화면에서 직접 확인합니다. (화면 확인 필요)
3. OAuth로 연결하는 경우에는 키를 복사할 필요가 없습니다. 아래 4번으로 갑니다. 키가 필요하다면 로그인 후 **Settings**의 **API** 탭을 열어 키를 확인합니다. (화면 확인 필요: 한글 이름과 위치)
4. Claude Code를 쓰는 경우, 터미널에서 다음 명령 한 줄을 실행해 MCP 서버를 등록합니다.

```
claude mcp add --transport http --scope local se-ranking https://api.seranking.com/mcp
```

5. Codex를 쓰는 경우, 터미널에서 다음 명령 한 줄을 실행합니다.

```
codex mcp add se-ranking --url https://api.seranking.com/mcp
```

6. 등록 뒤 인증 창이 브라우저에서 열리면 내 SE Ranking 계정으로 허용합니다. 허용 화면의 내용을 읽고 직접 결정합니다. (화면 확인 필요)
7. 에이전트를 다시 시작하고 SE Ranking 도구가 보이는지 확인합니다.
8. 키(`X-Api-Key`)를 설정 파일, 저장소, 대화창, 보고서에 적지 않습니다.

이 명령은 내 하네스 설정을 바꾸고 인증 절차를 시작할 수 있습니다. 실행 전에 하네스의 현재 도움말(`--help`)로 문법을 확인합니다.

## brief

- SE Ranking은 별도 유료 계정이며 크레딧이 내 계정에서 차감됩니다. 필수가 아닙니다.
- Claude Code: `claude mcp add --transport http --scope local se-ranking https://api.seranking.com/mcp`. Codex: `codex mcp add se-ranking --url https://api.seranking.com/mcp`. 등록 뒤 OAuth 인증을 브라우저에서 허용합니다.
- 키를 쓰는 경우는 **Settings → API** 탭에서 확인하고(화면 확인 필요) 설정 파일·대화에 적지 않습니다.
