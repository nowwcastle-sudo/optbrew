# Intake and preflight

먼저 대상 URL과 원하는 결과를 확인한다. 결과는 사용자의 말로 받되 검색 유입, 네이버 노출, AI 답변의 출처 인용, 브랜드 사실 정확성, 전환 중 관련된 목표를 제시할 수 있다. 사용자가 URL·목표를 이미 줬다면 그 값을 기록하고 반복 질문하지 않는다. `optbrew 실행해`만 주어진 경우에는 URL과 목표가 비어 있다는 상태를 알리고 두 값만 묻는다.

그다음 필요한 값만 확인한다: 대상 경로의 권한과 환경, 변경 가능한 로컬 경로, 지역·언어·대상 검색엔진, 핵심 페이지와 질문, 소유자 패널/내보내기 자료, 수집·비용 상한. 모르는 값은 unknown으로 남긴다. 소유자 자료나 유료 API가 없어도 허용된 공개 HTTP/HTML로 기본 감사를 진행할 수 있다. 원격 전용이면 수정 가능하다고 가정하지 않는다.

Baseline 전 `RunContext`를 저장한다. 고정 page_types와 URL, engines, family 적용 조건, 질문·브랜드/비브랜드 범주, locale·region, surface·model·search 사용, device·browser, target identity, evaluation/protocol versions를 확정한다. 정책·sitemap 파일이 필요하면 `auxiliary_resources`에 `kind: robots|sitemap|policy`, 원문 URL과 정규화 URL을 명시한다. 모든 URL은 허용 origin과 경로 안에 있어야 한다. 페이지 URL과 보조 URL의 합은 50 이하다. 비용이 드는 첫 호출 전에 예상 단가의 출처·날짜, 승인된 한도, 중단 조건을 기록한다. 단가를 모르면 0으로 넣지 말고 유료 경로를 보류한다.

재개 시 같은 run_id의 context·원시 자료·비용 장부를 읽는다. 새 실행으로 조용히 바꾸거나 증거를 덮어쓰지 않는다. 목표·범위·표본이 바뀌면 변경된 프로토콜을 새로 기록하고 이전 결과와의 비교 가능성을 판정한다.
