---
checked: 2026-10-18
source: https://docs.cloud.google.com/docs/authentication/api-keys https://docs.cloud.google.com/apis/docs/getting-started https://docs.cloud.google.com/resource-manager/docs/creating-managing-projects https://developer.chrome.com/docs/crux/api https://developers.google.com/speed/docs/insights/v5/get-started
harness: any
---

# Google API 키 발급하고 CrUX·PageSpeed API 켜기

## beginner

왜 필요한가: 방문자가 실제로 겪은 속도 점수(LCP·INP·CLS)는 Google의 Chrome UX Report(CrUX)와 PageSpeed Insights(PSI)에서 가져옵니다. 키가 있으면 이 세 항목이 채워지고, 없으면 빈칸으로 남습니다. 키는 본인 Google 계정에서 직접 만듭니다. 두 API는 무료이며 CrUX는 프로젝트당 분당 150회 한도가 있습니다. 결제 정보를 입력하라는 화면이 나오면 멈추세요. 키가 없어도 감사는 끝까지 갑니다.

1. 브라우저에서 console.cloud.google.com을 엽니다.
2. Google 계정으로 로그인합니다.
3. 처음이면 약관 동의 창이 뜰 수 있습니다. 내용을 읽고 직접 결정합니다.
4. 화면 맨 위 프로젝트 이름 상자(Project picker)를 누릅니다.
5. 열린 목록에 쓸 프로젝트가 있으면 그 이름을 누르고 10번으로 갑니다.
6. 쓸 프로젝트가 없으면 **새 프로젝트**(New project)를 누릅니다.
7. **프로젝트 이름**(Project name) 칸에 `optbrew`처럼 알아볼 이름을 적습니다.
8. **만들기**(Create)를 누릅니다.
9. 몇 초 기다린 뒤 위쪽 프로젝트 이름 상자(프로젝트 선택기)를 눌러 방금 만든 프로젝트를 고릅니다.
10. 위쪽 프로젝트 이름 상자에 쓸 프로젝트 이름이 보이는지 확인합니다.
11. 왼쪽 위의 메뉴 아이콘(☰)을 누릅니다.
12. **API 및 서비스**(APIs & Services) → **라이브러리**(Library)를 누릅니다. 공식 문서는 이 화면을 **API 라이브러리**라고 부릅니다.
13. 검색 상자에 `Chrome UX Report API`를 입력합니다.
14. 검색 결과에서 **Chrome UX Report API**를 누릅니다.
15. **사용 설정**(Enable) 버튼을 누릅니다.
16. 12번처럼 **라이브러리**로 돌아갑니다.
17. 검색 상자에 `PageSpeed Insights API`를 입력합니다.
18. 검색 결과에서 **PageSpeed Insights API**를 누릅니다.
19. **사용 설정**(Enable) 버튼을 누릅니다.
20. 왼쪽 메뉴에서 **사용자 인증 정보**(Credentials)를 누릅니다.
21. 위쪽 **+ 사용자 인증 정보 만들기**(+ Create credentials)를 누릅니다. 열린 메뉴에 **API 키**(API key), OAuth 클라이언트 ID, 서비스 계정이 나옵니다.
22. 열린 메뉴에서 **API 키**(API key)를 누릅니다.
23. 키 만들기 화면에 **API 제한사항**(API restrictions) 영역이 보이면 **키 제한**(Restrict key)을 누릅니다. 보이지 않으면 27번으로 갑니다.
24. API 목록을 엽니다.
25. 목록에서 **Chrome UX Report API**를 체크합니다.
26. 목록에서 **PageSpeed Insights API**를 체크합니다.
27. **만들기**(Create)를 누릅니다.
28. **API 키 생성 완료**(API key created) 창에 키 문자열이 나옵니다. 키 옆 복사 아이콘을 눌러 복사합니다. 창을 닫기 전에 복사를 마칩니다.
29. 키를 채팅창, 메모, 문서, 화면 공유에 붙여 넣지 않습니다.
30. 키를 optbrew에 넣는 방법은 사용 중인 환경에 맞는 런북을 따릅니다. 내 컴퓨터의 터미널은 `key-set-local`, Claude Code 클라우드는 `key-set-claude-cloud`, Codex는 `key-set-codex`입니다.

키가 유출됐다고 의심되면 **사용자 인증 정보** 목록에서 그 키를 삭제하고 새로 만듭니다.

## brief

- console.cloud.google.com에서 프로젝트를 고르거나 만들고, API 라이브러리에서 `Chrome UX Report API`와 `PageSpeed Insights API`를 각각 **ENABLE** 합니다.
- **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → API 키**. 문서는 키를 제한하라고 권하므로 위 두 API로 제한하고 **만들기**를 누릅니다.
- 키 문자열은 한 번 복사해 `key-set-local`·`key-set-claude-cloud`·`key-set-codex` 중 맞는 런북으로만 입력합니다. 대화창에 붙이지 않습니다.
- CrUX는 무료, 프로젝트당 분당 150회. 결제 정보를 요구하면 멈춥니다.
