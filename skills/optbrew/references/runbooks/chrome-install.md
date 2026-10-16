---
checked: 2026-10-16
source: https://support.google.com/chrome/answer/95346
harness: local
---

# 크롬 설치하기

## beginner

왜 필요한가: optbrew는 자바스크립트가 그린 뒤의 화면을 확인하려고 크롬을 잠깐 띄웁니다. 크롬이 없으면 이 확인만 빈칸으로 남고 나머지 감사는 그대로 됩니다. Microsoft Edge가 이미 있으면 그대로 쓰이므로 크롬을 새로 설치하지 않아도 됩니다. 설치 파일은 Google 공식 주소에서만 받습니다.

1. 브라우저 주소창에 `google.com/chrome`을 입력하고 Enter를 누릅니다. 주소가 `google.com`으로 끝나는지 확인합니다.
2. **Chrome 다운로드**(Download Chrome) 버튼을 누릅니다. (화면 확인 필요: 버튼 글자)
3. Windows는 받은 설치 파일을 두 번 누릅니다. "이 파일을 실행하시겠습니까?"라고 물으면 **실행**(Run)을 누릅니다. (화면 확인 필요: 한글 문구)
4. "이 앱이 디바이스를 변경하도록 허용하시겠어요?"라고 물으면 **예**(Yes)를 누릅니다. 이 컴퓨터를 직접 쓰는 중이고 방금 내가 받은 파일일 때만 누릅니다. (화면 확인 필요: 한글 문구)
5. 설치가 끝나면 크롬 창이 저절로 열립니다. Windows 10 이상 기준입니다.
6. macOS는 받은 `googlechrome.dmg`를 열고 나타난 창에서 Chrome 아이콘을 **Applications** 폴더로 끌어다 놓습니다. 관리자 암호를 물으면 직접 입력합니다.
7. Linux는 내 배포판과 CPU에 맞는 `.deb`(Debian·Ubuntu) 또는 `.rpm`(Fedora·openSUSE) 파일을 받아 열고 **설치**(Install)를 누른 뒤 관리자 암호를 입력합니다.
8. 설치가 끝났으면 에이전트에게 "크롬 설치했어"라고 말합니다. 에이전트가 표준 설치 위치에서 크롬을 찾습니다.
9. 에이전트가 크롬을 못 찾으면 크롬이 표준 위치가 아닌 곳에 설치된 것입니다. 크롬 실행 파일의 전체 경로를 환경 변수 `OPTBREW_CHROME`에 넣으면 됩니다. Windows의 표준 경로는 `C:\Program Files\Google\Chrome\Application\chrome.exe`입니다.

설치 파일을 받을 수 없거나 회사 정책으로 설치가 막힌 컴퓨터에서는 이 런북을 건너뜁니다. 감사는 렌더 확인 항목만 빈칸으로 두고 끝까지 갑니다.

## brief

- `google.com/chrome`에서 설치합니다. Windows는 설치 파일 실행, macOS는 `googlechrome.dmg`를 Applications로 끌기, Linux는 `.deb`/`.rpm` 설치입니다.
- 표준 설치 위치와 `PATH`의 `chrome`·`google-chrome`·`chromium`·`msedge`를 자동으로 찾습니다. Edge도 됩니다.
- 다른 위치에 설치했다면 환경 변수 `OPTBREW_CHROME`에 실행 파일의 전체 경로를 둡니다.
- 클라우드 하네스에서 설치하는 방법은 확인 안 됨입니다. 이 런북은 내 컴퓨터용입니다.
