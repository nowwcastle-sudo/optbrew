---
checked: 2026-10-16
source: https://platform.claude.com/docs/en/get-api-key
harness: any
---

# Anthropic API 키 만들기 (선택, 내 계정에 비용 발생)

## beginner

왜 필요한가: 기본 감사는 이 키 없이 끝까지 갑니다. 이 키는 optbrew가 Claude API를 직접 불러 쓰는 선택 기능용입니다. 호출 비용은 내 Anthropic 계정에 청구됩니다. 구독(Claude Pro·Max, Claude Code 요금제)과는 별개의 결제입니다. 비용이 부담되면 이 런북 전체를 건너뜁니다.

1. 브라우저에서 platform.claude.com을 열고 로그인합니다. 계정이 없으면 만들 수 있지만, 계정 생성과 결제 설정은 내가 직접 결정합니다.
2. 주소창에 `platform.claude.com/settings/keys`를 입력하고 Enter를 누릅니다. **API keys** 페이지가 열립니다.
3. **Create key** 버튼을 누릅니다. 버튼이 비활성이면 내 역할로는 키를 만들 수 없는 것이므로 조직 관리자에게 요청합니다.
4. 키 이름(예: `optbrew`)을 적습니다.
5. 만료 시기(expiration)를 고릅니다. 짧게 쓸 키면 가까운 날짜를 고릅니다. (화면 확인 필요: 선택지)
6. **Linked account**가 나 자신으로 되어 있는지 확인합니다.
7. 만들기를 확정하는 버튼을 누릅니다. (화면 확인 필요: 버튼 이름)
8. 키 전체가 한 번만 표시됩니다. 복사 아이콘으로 복사합니다. 창을 닫으면 다시 볼 수 없습니다.
9. 키를 대화창, 메모, 문서에 붙여 넣지 않습니다.
10. Windows에서 컴퓨터에 넣으려면 시작 메뉴에서 `환경 변수`를 검색해 **계정에 대한 환경 변수 편집**을 엽니다. (화면 확인 필요: 한글 이름)
11. **새로 만들기**(New)를 누릅니다.
12. 변수 이름에 `ANTHROPIC_API_KEY`를 적습니다.
13. 변수 값 칸에 복사한 키를 붙여 넣고 **확인**을 누릅니다. 열려 있는 터미널과 에이전트를 모두 닫았다 다시 켭니다.
14. macOS·Linux는 터미널에서 쓰는 셸 설정 파일에 `export ANTHROPIC_API_KEY=키` 한 줄을 넣는 방식이 일반적이지만, 파일 위치가 셸마다 다르므로 에이전트에게 내 셸에 맞는 방법을 묻습니다. 키 값은 말하지 않고 "붙여 넣을 칸을 알려 달라"고만 합니다.

키 사용 한도와 요금은 Anthropic Console의 결제 화면에서 확인합니다. 키가 새어 나갔다고 의심되면 **API keys** 목록에서 그 키를 삭제합니다. (화면 확인 필요: 삭제 메뉴 위치)

## brief

- platform.claude.com/settings/keys → **Create key** → 이름·만료·Linked account를 정하고 만듭니다. 키는 생성 때 한 번만 보입니다.
- 환경 변수 `ANTHROPIC_API_KEY`에 넣습니다. 키를 대화창에 붙이지 않습니다.
- 호출 비용은 내 Anthropic 계정에 청구되며 Claude 구독과는 별개입니다. 필수가 아닙니다.
