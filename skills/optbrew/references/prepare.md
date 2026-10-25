# Preparation answers

SKILL.md 5단계와 7단계가 쓰는 문서다. 사용자가 시작 질문의 「준비」 항목에 단어(「키」, 「크롬」, 「내보내기」)로 답했을 때, SE Ranking 연결을 따로 요청했을 때, 7단계에서 런북을 보여 줘야 할 때만 연다. `<SKILL_DIR>`은 SKILL.md와 같다.

1. 「준비」 항목의 `line`이 알려 준 단어로 답했으면 그 단어의 일만 한다. 여러 단어면 순서대로 한다. 런북을 펼치는 법은 아래 「런북 펼치기」에 있다.
   - "키": 먼저 아래 「키 파일 점검」을 한다. 문제가 없으면 `google-api-key`를 펼치고, 이어서 `probe.harness`에 맞는 키 저장 런북을 펼친다: `claude-code`와 `other`는 `key-set-local`, `codex`는 `key-set-codex`, `claude-code-cloud`는 `key-set-claude-cloud`다.
   - "크롬": `chrome-install`을 펼친다.
   - "SE Ranking": 사용자가 SE Ranking 연결을 따로 요청했을 때만 `seranking`을 펼친다. 감사가 끝난 뒤에 요청했으면 「'시작'이라고 알려 주세요」를 붙이지 않는다. 연결 명령은 사용자가 직접 실행한다.
   - "내보내기": `gsc-export`를 펼친다(명령이 `naver-searchadvisor-export`까지 함께 낸다). 같은 메시지 끝에 "내려받은 파일이 있으면 파일이 있는 경로를 알려 주세요. 파일 내용은 붙이지 마세요. 없으면 '시작'이라고 답해 주세요."라고 묻는다. 사용자가 알려 준 경로를 Search Console 파일이면 `{ "kind": "gsc", "path": "…" }`, 네이버 서치어드바이저 파일이면 `{ "kind": "naver", "path": "…" }`로 모아 둔다. SKILL.md 6단계의 `owner_exports`에 쓴다. 파일이 없다고 하면 아무것도 모으지 않는다.
2. 런북 펼치기. 펼칠 런북이 여럿이면 `--ids`에 쉼표로 이어 한 번에 낸다. `<수준>`은 「안내 수준」 답(`beginner` 또는 `brief`)이다.

```
node "<SKILL_DIR>/scripts/cli.mjs" runbook --ids "<id>" --level <수준>
```

   1. 출력은 사용자에게 보낼 Markdown이다. 경로는 이미 사용자 환경에 맞게 바뀌어 있다. 런북 파일을 직접 열지 않는다. 파일에는 바뀌기 전의 자리표시가 남아 있다.
   2. 출력을 줄이거나 요약하지 않고 이 턴의 마지막 메시지에 그대로 붙인다. 그 메시지 끝에 아래 「런북 뒤」의 안내나 「내보내기」의 질문을 붙인다.
3. 키 파일 점검. "키"를 펼치기 전에 한다. 이 점검은 파일을 읽기만 하고 아무것도 바꾸거나 지우지 않는다.
   1. `node "<SKILL_DIR>/scripts/key.mjs" status`를 실행한다. 출력은 `google.present`와 `google.sha256_8`이고, 키 파일이 JSON 객체가 아니면 `google.corrupt: true`가 더 붙는다. `google.sources`는 값 없이 출처별 상태(`plugin_setting`·`env`·`key_file`)와 실제로 쓰이는 출처(`used`)를 보여 준다.
   2. `google.present`가 `true`이면 키가 이미 있다. 키 런북을 펼치지 않고 그렇게 말한다.
   3. `present`가 `false`이고 `google.corrupt`가 `true`이면 키 파일이 깨진 것이다. 파일은 사용자 홈 폴더의 `.optbrew/credentials.json`이다. 그 경로를 알려 주고 "이 파일을 고치거나 지운 뒤 다시 말해 주세요"라고 한다. 키 입력 안내는 하지 않는다.
   4. 그 밖이면(`present`가 `false`이고 `corrupt`가 없음) 문제가 없다. "키"의 런북을 이어 펼친다.
4. 런북 뒤. 런북을 펼친 메시지는 "다 하셨으면 '시작'이라고 알려 주세요"로 끝내고(「내보내기」는 위의 질문으로 끝낸다) 기다린다. 사용자가 아무것도 하지 않고 '시작'이라고 해도 된다.
5. 런북의 일을 마친 뒤에는 SKILL.md 5단계 3번으로 간다.
