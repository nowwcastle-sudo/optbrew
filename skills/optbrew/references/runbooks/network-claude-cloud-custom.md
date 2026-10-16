---
checked: 2026-10-16
source: https://code.claude.com/docs/en/cloud-environments https://code.claude.com/docs/en/claude-code-on-the-web
harness: claude-code-cloud
---

# Claude Code 클라우드에서 감사할 사이트 허용하기 (Network access: Custom)

## beginner

왜 필요한가: Claude Code 클라우드 세션은 허용 목록에 있는 사이트로만 나갈 수 있습니다. 감사할 사이트가 목록에 없어서 막혔습니다. 환경의 네트워크 수준을 Custom으로 바꾸고 감사할 도메인을 추가합니다. Full(모든 사이트 허용)보다 범위가 좁아 안전합니다.

1. 브라우저에서 claude.ai/code를 엽니다.
2. 세션을 시작하는 화면(새 세션 화면)으로 갑니다. 이미 실행 중인 세션이면 위쪽 세션 제목 옆 화살표(caret)를 누르고 **Edit cloud environment**를 고른 뒤 7번으로 갑니다.
3. 메시지 입력 상자 바로 아래 줄에서 첫 번째 컨트롤(환경 이름이 적힌 버튼)을 누릅니다.
4. 열린 목록의 **Cloud** 아래에서 쓰려는 환경 줄에 마우스를 올립니다. 환경이 보이지 않으면 **More** 줄을 먼저 누릅니다.
5. 줄 오른쪽에 나타나는 설정 아이콘(톱니바퀴)을 누릅니다. 환경 설정 창이 열립니다.
6. 창에서 **Network access** 항목을 찾습니다.
7. **Network access**의 선택 상자를 눌러 **Custom**을 고릅니다.
8. **Allowed domains** 칸에 감사할 사이트의 도메인을 한 줄에 하나씩 적습니다. 예: `example.com` 한 줄, `*.example.com` 한 줄. 맨 앞 `*.`는 하위 주소 전부를 뜻합니다.
9. 패키지 설치도 계속 쓰려면 **Also include default list of common package managers**를 체크합니다. 필요 없으면 비워 둡니다.
10. 창의 저장 버튼(**Save changes**)을 누릅니다. (화면 확인 필요: 저장 버튼 이름)
11. 약 1분을 기다립니다. 이미 열린 세션에도 새 설정이 적용됩니다.
12. 에이전트에게 "다시 시도해 줘"라고 말합니다. 사이트를 읽기 시작하면 끝난 것입니다.

한글 화면에서는 항목 이름이 번역되어 있을 수 있습니다. 위 영문 이름과 같은 자리의 항목을 고릅니다. (화면 확인 필요)

## brief

- claude.ai/code 새 세션 화면에서 메시지 상자 아래 첫 컨트롤 → 환경 행의 설정 아이콘 → **Network access**를 **Custom**으로.
- **Allowed domains**에 감사할 도메인을 한 줄에 하나씩(`example.com`, `*.example.com`). 저장하면 약 1분 안에 기존 세션에도 적용됩니다.
- 실행 중인 세션은 제목 옆 caret → **Edit cloud environment**.
- Full 대신 Custom을 권합니다. 환경마다 목록이 따로이고 조직 전체 목록은 없습니다.
