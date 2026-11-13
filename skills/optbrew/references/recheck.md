# Re-checking after deploy

SKILL.md 11단계가 쓰는 문서다. 고친 뒤, 또는 사용자가 배포 뒤 다시 감사해 비교하자고 할 때 연다. `<SKILL_DIR>`과 `<OUT>`은 SKILL.md와 같다.

## 비교하기 전에 스스로 묻는다

- 사이트가 정말 바뀌었는가? 로컬에서 고친 파일은 배포해야 사이트에 나온다. 배포 전에 다시 감사하면 고친 것이 실패로 보인다.
- 두 실행이 같은 조건인가? 답 파일이나 사전 점검 폴더가 다르면 같은 쪽과 같은 검사를 잰 것이 아니다. 그때는 「해결됨」이라고 쓰지 않는다.
- 통과가 늘어난 것을 성과로 말하고 있지 않은가? 비교는 사이트에서 읽은 결과다. 색인, 유입, 인용이 늘었다는 증명이 아니다.

## 순서

사용자가 배포했는지부터 묻는다.

이전 결과 폴더(`<OUT>`)를 모르면(새 대화에서 비교를 요청받았을 때) 작업 폴더의 `optbrew-audit/` 아래에서 그 호스트 이름으로 시작하고 `report.json`이 있는 폴더 중 가장 최근 것을 쓴다. 그 경로를 사용자에게 한 줄로 알린다. 그 폴더의 `intake-answers.json`이 답 파일이고 `score-input.json`이 이전 `score_input`이다. 그런 폴더가 없으면 비교할 이전 감사가 없다고 말하고 1단계부터 새로 감사한다.

(a) 사용자가 배포했다고 답하면 이렇게 한다.
1. 새 결과 폴더 `<OUT>-after`를 정한다. 이미 있으면 뒤에 `-2`, `-3`을 붙인다.
2. 이전 `<OUT>`의 `preflight` 폴더를 통째로 `<OUT>-after/preflight`로 복사한다. 실행은 감사할 쪽을 결과 폴더의 `preflight`(사이트맵과 첫 화면의 링크)에서 고른다. 이 폴더가 없으면 첫 화면과 사실 쪽만 골라 쪽 종류가 달라지고, 비교는 `page_types_changed`로 `not_comparable`이 된다. SKILL.md 3단계 점검은 다시 하지 않는다. 다시 하면 그 사이 바뀐 사이트맵으로 다른 쪽을 고를 수 있다.
3. 같은 `intake-answers.json`을 그대로 `--answers`로 두고 `--out`에만 `<OUT>-after`를 써서 SKILL.md 7단계와 8단계를 한다. 그 사이 키나 크롬을 준비했어도 답 파일을 바꾸지 않는다. 목표, 질문, 사실, 표본이 바뀌면 검사 묶음이 달라져 비교할 수 없다.
4. 이전 실행과 이후 실행의 `done` JSON에서 `score_input` 경로를 읽는다. 아래 명령에 넣는다.

```
node "<SKILL_DIR>/scripts/cli.mjs" compare --before "<이전 score_input>" --after "<이후 score_input>" --fixes "<OUT>/fixes.md" --output "<OUT>-after/comparison.json"
```

`--fixes`는 이전 결과 폴더의 `fixes.md`다. 그 목록의 고칠 것마다 이후 상태를 `finding_outcomes`에 받는다.

5. 「해결됨」은 고칠 것 하나 단위로 쓴다. `finding_outcomes`가 고칠 것마다 `resolved`(그 고칠 것이 가리킨 모든 단위가 이후 실행에서 pass), `remaining`(하나라도 fail이나 partial로 남음), `unknown`(이후 실행이 그 단위를 채점하지 않았거나 판정이 없음)을 준다. `resolved`만 "해결됨", `remaining`은 "남음", `unknown`은 "모름"이라고 쓴다. 쪽이 빠졌거나 판정이 적용 안 됨으로 바뀐 것을 해결됨으로 세지 않는다. `finding_outcomes`는 결과가 `comparable`이거나 `not_comparable`의 사유가 `page_types_changed`, `applicable_units_changed`, `cwv_window_overlap`뿐일 때만 있다. 수정이 적용 단위를 바꾼 경우다. 다른 사유가 하나라도 있으면 없고, 이때는 "해결됨"이라고 쓰지 않는다. 프로필 점수 차는 `comparable`일 때만 말한다. `not_comparable`이면 점수 차를 말하지 않고 `reasons`를 그대로 알린다. 결과의 `unit_transitions`는 있다: `changed`(상태가 바뀐 단위), `only_before`·`only_after`(한쪽에만 있는 단위)를 사실로 보여 줄 수 있다. 점수나 성과로 말하지 않는다. 점수 차를 말할 때는 `by_evaluator`의 `host_model` 몫이 움직였는지 함께 본다. 모델 판정은 사이트가 같아도 흔들릴 수 있다.
   방문자 실측(CWV) 값은 28일 창의 자료다. 이후 창이 이전 창과 하루라도 겹치면 `cwv_window_overlap`으로 비교를 거절한다. 배포 전 날짜가 섞여 있어 통과가 고친 결과가 아닐 수 있기 때문이다. 결과의 `cwv_windows`에 두 창의 날짜가 있다. 창이 겹쳐도 CWV가 아닌 고칠 것은 `finding_outcomes`로 말할 수 있다. 이 경우 CWV는 이전 창이 끝난 날로부터 28일이 지나 창이 겹치지 않게 된 뒤에 다시 감사해서 비교한다. 창을 확인할 수 없으면(`warnings`의 `cwv_window_unverifiable`) 비교는 하되 CWV 변화는 "창을 확인하지 못했다"고 덧붙여 말한다.
6. 확인은 사이트에서 읽은 결과다. 색인, 유입, 인용이 좋아졌다는 증명은 아니라고 한 줄 덧붙인다. 사용자가 「해결됨」의 조건을 더 물을 때만 [evidence.md](evidence.md)를 연다.

(b) 사용자가 아직 배포하지 않았다고 답하면 이렇게 말하고 멈춘다: "로컬 수정은 아직 확인되지 않았습니다. 사이트에 배포한 뒤 알려 주시면 다시 확인합니다."
