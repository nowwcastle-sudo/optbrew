---
checked: 2026-10-16
source: https://learn.chatgpt.com/docs/config-file/config-basic https://learn.chatgpt.com/docs/agent-approvals-security
harness: codex
---

# Codex에서 Google 키 쓰기

## beginner

왜 필요한가: Codex는 명령을 sandbox 안에서 실행하고, 환경 변수를 명령에 어떻게 넘기는지는 설정에 따라 다릅니다. 가장 확실한 방법은 키를 내 컴퓨터의 키 파일에 저장해 두는 것입니다. 파일은 환경 변수 설정과 관계없이 optbrew가 읽습니다. 키는 내 터미널에서만 넣고 Codex 대화창에는 붙이지 않습니다.

1. Codex 창이 아니라 별도의 터미널 창을 엽니다. Windows는 시작(Start) 메뉴에서 `Windows PowerShell`을 입력해 열고, macOS는 Spotlight(⌘+Space)에서 `Terminal`을 입력해 엽니다. (화면 확인 필요: macOS)
2. 다음 명령 한 줄을 붙여 넣고 Enter를 누릅니다.

```
node "{{skill_root}}/scripts/key.mjs" set google
```

3. 키를 입력하라는 안내가 나오면 복사해 둔 키를 붙여 넣고 Enter를 누릅니다. 입력한 글자가 화면에 보이지 않는 것이 정상입니다.
4. 터미널 창을 닫고 Codex로 돌아가 감사를 요청합니다. 저장 확인 명령은 `key-set-local` 런북 7번에 있습니다.
5. 에이전트가 "Google 키 있음"이라고 알려 주면 끝입니다.
6. "Google 키 없음"이라고 나오면 Codex sandbox가 키 파일을 읽지 못하는 것입니다. 에이전트에게 알리고 아래 대체 방법을 씁니다. (화면 확인 필요: sandbox가 사용자 폴더의 키 파일을 읽는지)
7. 대체 방법 1: 운영체제에 `OPTBREW_GOOGLE_API_KEY` 환경 변수를 만듭니다. Windows는 시작 메뉴에서 `환경 변수`를 검색해 **계정에 대한 환경 변수 편집**을 열고, **새로 만들기**를 눌러 변수 이름에 `OPTBREW_GOOGLE_API_KEY`, 변수 값에 키를 붙여 넣고 **확인**을 누릅니다. (화면 확인 필요: 한글 이름)
8. 대체 방법 2: Codex 설정 파일 `config.toml`(위치는 `network-codex-config` 런북 2번)에 `[shell_environment_policy]` 표를 만들고 `ignore_default_excludes = true`를 둡니다. 이 값이면 이름에 KEY가 든 변수도 명령에 넘어갑니다. 설정 문서의 기본값은 true이지만 Codex 버전에 따라 다를 수 있습니다. (화면 확인 필요)
9. 설정 파일에는 키 값을 적지 않습니다.
10. Codex를 다시 켜고 감사를 요청합니다.

## brief

- 기본: 내 터미널에서 `key-set-local`대로 `node "{{skill_root}}/scripts/key.mjs" set google`을 실행합니다. 키 파일은 sandbox 설정과 관계없이 읽힙니다. (sandbox의 파일 읽기 허용은 화면 확인 필요)
- 파일이 안 읽히면 OS 환경 변수 `OPTBREW_GOOGLE_API_KEY`를 만들고 `config.toml`의 `[shell_environment_policy]`에 `ignore_default_excludes = true`를 둡니다. 키 값을 설정 파일에 적지 않습니다.
- 키를 Codex 대화창에 붙이지 않습니다.
