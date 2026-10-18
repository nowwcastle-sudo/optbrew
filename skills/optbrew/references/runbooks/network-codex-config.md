---
checked: 2026-10-16
source: https://learn.chatgpt.com/docs/agent-approvals-security https://learn.chatgpt.com/docs/config-file/config-basic
harness: codex
---

# Codex 설정 파일로 네트워크 미리 허용하기 (선택)

## beginner

왜 필요한가: 승인 창을 매번 누르기 싫을 때, Codex 설정 파일에 한 줄을 넣어 sandbox 안에서 네트워크를 미리 허용합니다. 선택 사항이며, 하지 않아도 승인 창으로 감사를 할 수 있습니다.

1. Codex를 모두 닫습니다.
2. 설정 파일 `config.toml`을 엽니다. 위치는 사용자 폴더 안의 `.codex` 폴더입니다. Windows는 `C:\Users\<내 계정 이름>\.codex\config.toml`, macOS와 Linux는 `~/.codex/config.toml`입니다.
3. 파일이 없으면 메모장(Windows) 또는 텍스트 편집기(macOS)에서 새 파일을 만들어 같은 이름으로 같은 폴더에 저장합니다. 확장자가 `.txt`로 붙지 않게 주의합니다.
4. 파일 안에 `[sandbox_workspace_write]`라는 줄이 이미 있는지 찾습니다.
5. 이미 있으면 그 줄 바로 아래에 `network_access = true` 한 줄만 추가합니다.
6. 없으면 파일 맨 아래에 다음 두 줄을 붙여 넣습니다.

```toml
[sandbox_workspace_write]
network_access = true
```

7. 파일을 저장합니다.
8. Codex를 다시 켭니다.
9. 감사를 다시 요청합니다. 이제 네트워크 승인 창이 뜨지 않으면 성공입니다.
10. 그래도 막히면 설정이 적용되지 않은 것입니다. 설정에 `sandbox_mode = "workspace-write"`가 있는지 확인하고, macOS에서는 이 설정이 적용되지 않는다는 사용자 보고가 있으므로 `network-codex-approval` 런북(승인 창)으로 돌아갑니다. (화면 확인 필요)

설정을 되돌리려면 위에서 추가한 줄을 지웁니다. 이 설정은 Codex가 실행하는 모든 작업에 적용되므로, 신뢰하지 않는 프로젝트가 있는 컴퓨터에서는 승인 창 방식을 권합니다.

## brief

- 사용자 설정 `~/.codex/config.toml`(Windows는 사용자 폴더의 `.codex\config.toml`)에 `[sandbox_workspace_write]` 아래 `network_access = true`를 둡니다.
- 한 번의 실행에만 필요하면 `-c 'sandbox_workspace_write.network_access=true'`를 인자로 줍니다.
- Codex를 다시 켠 뒤 적용됩니다. macOS에서는 적용되지 않는다는 보고가 있어 안 되면 승인 창(`network-codex-approval`)으로 갑니다. (화면 확인 필요)
