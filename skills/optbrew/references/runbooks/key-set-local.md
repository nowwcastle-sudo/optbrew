---
checked: 2026-10-18
source: https://learn.microsoft.com/en-us/powershell/scripting/windows-powershell/starting-windows-powershell https://code.claude.com/docs/en/plugins/install https://code.claude.com/docs/en/plugins-reference
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
4. `Google API key (input is hidden):`라는 안내가 나옵니다. 키를 붙여 넣습니다. 입력한 글자는 화면에 보이지 않는 것이 정상입니다.
5. Enter를 누릅니다.
6. `google key saved`가 나오면 끝납니다.
7. 저장됐는지 확인하려면 다음 명령을 붙여 넣고 Enter를 누릅니다. 결과 한 줄에 `"present":true`가 보이면 저장된 것입니다. 키 전체는 보이지 않고 해시 앞 8자(`sha256_8`)만 보입니다.

```
node "{{skill_root}}/scripts/key.mjs" status
```

8. 터미널 창을 닫습니다.
9. 에이전트에게 "키 넣었어"라고만 말합니다. 키 값은 말하지 않습니다.

npm으로 optbrew를 설치했다면 같은 일을 `optbrew key set google`, `optbrew key status`로 할 수 있습니다. 저장한 키를 지울 때는 같은 방법으로 `key remove google` 명령을 씁니다. 지우면 `google key removed`가 나옵니다.

**Claude 데스크톱 앱을 쓰면 위의 PowerShell 키 파일 방법(`key set google`)을 쓰십시오.** 아래 플러그인 설정 방법은 데스크톱 앱 세션에 키가 전달되지 않았습니다. 2026-10-18 Windows에서 이렇게 확인했습니다.

- 데스크톱 앱(함께 설치된 claude.exe 2.1.299)이 시작한 세션: 플러그인의 SessionStart 훅은 실행됐지만 `CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY` 값이 세션에 오지 않았습니다.
- 같은 PC의 터미널 `claude` 2.1.302로 시작한 세션(`claude -p`): 값이 왔습니다.
- 원인이 데스크톱 앱인지 2.1.299 버전인지는 아직 가르지 못했습니다.

**터미널에서 Claude Code(`claude`)를 쓰고 optbrew를 플러그인으로 설치했다면** 키 파일 대신 플러그인 설정에 키를 넣을 수 있습니다. Claude Code가 이 값을 운영체제의 자격 증명 저장소에 보관합니다. 값이 세션에 전달되면 키 파일과 `OPTBREW_GOOGLE_API_KEY`보다 먼저 쓰입니다. 전달되지 않으면 키 파일이나 `OPTBREW_GOOGLE_API_KEY`가 쓰입니다.

1. 터미널을 엽니다(위 1단계와 같습니다).
2. `claude`를 입력하고 Enter를 누릅니다. 데스크톱 앱의 Code 탭에는 아래 `/plugin` 화면이 없습니다.
3. Claude Code 입력창에 `/plugin`을 입력하고 Enter를 누릅니다.
4. Tab 키로 **Installed** 탭으로 갑니다.
5. 목록에서 `optbrew`를 골라 Enter를 누릅니다.
6. **Configure options**를 고릅니다.
7. **Google API key (optional)** 칸에 키를 붙여 넣고 저장합니다. 입력한 글자는 가려져 보이는 것이 정상입니다.
8. 새 세션을 시작합니다. 키는 새 세션부터 쓰입니다.
9. 에이전트에게 "키 넣었어"라고만 말합니다. 에이전트가 위 `status` 명령으로 확인합니다. 결과의 `"sources"`에서 `"plugin_setting":true`이면 플러그인 설정이 이 세션에 왔고, `"used"`가 실제로 쓰이는 출처입니다. `"plugin_setting":false`이면 키 파일 방법을 쓰십시오.

플러그인 설정의 키를 지우려면 같은 칸을 비우고 저장한 뒤 새 세션을 시작합니다.

## brief

- 내 터미널에서 `node "{{skill_root}}/scripts/key.mjs" set google`(npm 설치는 `optbrew key set google`)을 실행하고, 숨겨진 입력 창에 키를 붙여 넣습니다.
- 키는 `~/.optbrew/credentials.json`에 저장됩니다. `OPTBREW_GOOGLE_API_KEY` 환경 변수가 있으면 그것이 먼저입니다.
- Claude 데스크톱 앱을 쓰면 키 파일 방법(`key set google`)을 씁니다. 2026-10-18 Windows 측정에서 데스크톱 앱(claude.exe 2.1.299) 세션에는 플러그인 설정 값이 오지 않았습니다.
- 터미널 `claude`의 플러그인 설치는 터미널에서 `claude`를 실행한 뒤 `/plugin` → **Installed** → optbrew → **Configure options**의 **Google API key**에 넣어도 됩니다. 값이 세션에 전달될 때만 가장 먼저 쓰이고, 새 세션부터 적용됩니다.
- `key status`로 존재와 해시 앞 8자, 그리고 `sources`(출처별 존재와 실제로 쓰이는 `used`)만 확인하고, 지우려면 `key remove`입니다.
- 키를 대화창에 붙이지 않습니다.
