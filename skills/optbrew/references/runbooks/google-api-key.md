---
checked: 2026-10-16
source: https://docs.cloud.google.com/docs/authentication/api-keys https://docs.cloud.google.com/apis/docs/getting-started https://docs.cloud.google.com/resource-manager/docs/creating-managing-projects https://developer.chrome.com/docs/crux/api https://developers.google.com/speed/docs/insights/v5/get-started
harness: any
---

# Google API 키 발급하고 CrUX·PageSpeed API 켜기

## beginner

왜 필요한가: 방문자가 실제로 겪은 속도 점수(LCP·INP·CLS)는 Google의 Chrome UX Report(CrUX)와 PageSpeed Insights(PSI)에서 가져옵니다. 키가 있으면 이 세 항목이 채워지고, 없으면 빈칸으로 남습니다. 키는 본인 Google 계정에서 직접 만듭니다. 두 API는 무료이며 CrUX는 프로젝트당 분당 150회 한도가 있습니다. 결제 정보를 입력하라는 화면이 나오면 멈추세요. 키가 없어도 감사는 끝까지 갑니다.

1. 브라우저에서 console.cloud.google.com을 엽니다.
2. Google 계정으로 로그인합니다. 처음이면 약관 동의 창이 뜰 수 있습니다. 내용을 읽고 직접 결정합니다.
3. 화면 맨 위 프로젝트 이름 상자(Project picker)를 누릅니다.
4. 쓸 프로젝트가 있으면 그것을 고르고 8번으로 갑니다. 없으면 **새 프로젝트**(New project)를 누릅니다.
5. **프로젝트 이름**(Project name)에 `optbrew`처럼 알아볼 이름을 적습니다.
6. **만들기**(Create)를 누릅니다. 몇 초 뒤 프로젝트가 만들어집니다. 알림에서 방금 만든 프로젝트를 고릅니다. (화면 확인 필요: 한글 버튼 이름)
7. 위쪽 프로젝트 이름 상자에 방금 만든 프로젝트 이름이 보이는지 확인합니다.
8. 왼쪽 메뉴(☰)에서 **API 및 서비스**(APIs & Services) → **라이브러리**(Library)를 누릅니다. (화면 확인 필요: 한글 메뉴 이름)
9. 검색 상자에 `Chrome UX Report API`를 입력하고 결과를 누릅니다.
10. **사용**(ENABLE) 버튼을 누릅니다. (화면 확인 필요: 한글 버튼 이름)
11. 라이브러리로 돌아가 검색 상자에 `PageSpeed Insights API`를 입력하고 결과를 누릅니다.
12. **사용**(ENABLE) 버튼을 누릅니다.
13. 왼쪽 메뉴에서 **API 및 서비스** → **사용자 인증 정보**(Credentials)를 누릅니다. (화면 확인 필요: 한글 메뉴 이름)
14. 위쪽 **사용자 인증 정보 만들기**(Create credentials)를 누르고 **API 키**(API key)를 고릅니다. (화면 확인 필요: 한글 버튼 이름)
15. 키를 만들기 전에 제한을 하나 이상 고르라고 안내가 나옵니다. **API 제한사항**(API restrictions) 영역에서 **키 제한**(Restrict key)을 고릅니다.
16. 목록에서 **Chrome UX Report API**와 **PageSpeed Insights API**만 체크합니다.
17. **만들기**(Create)를 누릅니다.
18. **API 키 생성됨**(API key created) 창에 키 문자열이 나옵니다. 키 옆 복사 아이콘을 눌러 복사합니다. 창을 닫기 전에 복사를 마칩니다. (화면 확인 필요: 창 이름과 복사 아이콘 위치)
19. 키를 채팅창, 메모, 문서, 화면 공유에 붙여 넣지 않습니다. 키를 optbrew에 넣는 방법은 사용 중인 환경에 맞는 런북을 따릅니다. 내 컴퓨터의 터미널은 `key-set-local`, Claude Code 클라우드는 `key-set-claude-cloud`, Codex는 `key-set-codex`입니다.

키가 유출됐다고 의심되면 **사용자 인증 정보** 목록에서 그 키를 삭제하고 새로 만듭니다.

## brief

- console.cloud.google.com에서 프로젝트를 고르거나 만들고, API 라이브러리에서 `Chrome UX Report API`와 `PageSpeed Insights API`를 각각 **ENABLE** 합니다.
- **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → API 키**. 콘솔이 제한을 하나 이상 요구하므로 위 두 API로 제한하고 **만들기**를 누릅니다. (화면 확인 필요: 한글 이름)
- 키 문자열은 한 번 복사해 `key-set-local`·`key-set-claude-cloud`·`key-set-codex` 중 맞는 런북으로만 입력합니다. 대화창에 붙이지 않습니다.
- CrUX는 무료, 프로젝트당 분당 150회. 결제 정보를 요구하면 멈춥니다.
