---
checked: 2026-10-16
source: https://learn.microsoft.com/en-us/powershell/scripting/windows-powershell/starting-windows-powershell
harness: local
---

# 내 컴퓨터에서 Google 키 저장하기 (optbrew key set google)

## beginner

왜 필요한가: 복사해 둔 Google API 키를 optbrew가 쓸 수 있게 내 컴퓨터에만 저장합니다. 키는 내 사용자 폴더의 `.optbrew` 폴더에 저장되고 화면·보고서·로그에는 남지 않습니다. 이 단계는 반드시 내가 직접 내 터미널에서 합니다. 키를 에이전트 대화창에 붙여 넣지 않습니다.

1. 터미널을 엽니다. Windows는 시작(Start) 메뉴를 열고 `Windows PowerShell`을 입력한 뒤 **Windows PowerShell**을 골라 **열기**(Open)를 누릅니다. macOS는 Spotlight(⌘+Space)에서 `Terminal`을 입력해 엽니다. (화면 확인 필요: macOS)
2. 다음 명령 한 줄을 그대로 붙여 넣습니다. 붙여 넣기는 Windows PowerShell에서 Ctrl+V 또는 마우스 오른쪽 버튼, macOS에서 ⌘+V입니다. 이 명령은 optbrew 스킬 폴더의 키 스크립트를 실행합니다.

```
node "{{skill_root}}/scripts/key.mjs" set google
```

3. Enter를 누릅니다.
4. 키를 입력하라는 안내가 나옵니다. 키를 붙여 넣습니다. 입력한 글자는 화면에 보이지 않는 것이 정상입니다.
5. Enter를 누릅니다.
6. 저장되었다는 안내가 나오면 끝납니다.
7. 저장됐는지 확인하려면 다음 명령을 붙여 넣고 Enter를 누릅니다. 키가 있는지와 해시 앞 8자만 보이고 키 전체는 보이지 않습니다.

```
node "{{skill_root}}/scripts/key.mjs" status
```

8. 터미널 창을 닫습니다.
9. 에이전트에게 "키 넣었어"라고만 말합니다. 키 값은 말하지 않습니다.

npm으로 optbrew를 설치했다면 같은 일을 `optbrew key set google`, `optbrew key status`로 할 수 있습니다. 저장한 키를 지울 때는 같은 방법으로 `key remove` 명령을 씁니다. (화면 확인 필요: 안내 문구 글자와 remove 인자)

## brief

- 내 터미널에서 `node "{{skill_root}}/scripts/key.mjs" set google`(npm 설치는 `optbrew key set google`)을 실행하고, 숨겨진 입력 창에 키를 붙여 넣습니다.
- 키는 `~/.optbrew/credentials.json`에 저장됩니다. `OPTBREW_GOOGLE_API_KEY` 환경 변수가 있으면 그것이 먼저입니다.
- `key status`로 존재와 해시 앞 8자만 확인하고, 지우려면 `key remove`입니다.
- 키를 대화창에 붙이지 않습니다.
