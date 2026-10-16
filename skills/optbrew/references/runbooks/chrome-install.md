---
checked: 2026-10-16
source: https://support.google.com/chrome/answer/95346
harness: local
---

# 크롬 설치하기

## beginner

왜 필요한가: optbrew는 자바스크립트가 그린 뒤의 화면을 확인하려고 크롬을 잠깐 띄웁니다. 크롬이 없으면 이 확인만 빈칸으로 남고 나머지 감사는 그대로 됩니다. Microsoft Edge가 이미 있으면 그대로 쓰이므로 크롬을 새로 설치하지 않아도 됩니다. 설치 파일은 Google 공식 주소에서만 받습니다.

1. 브라우저 주소창에 `google.com/chrome`을 입력하고 Enter를 누릅니다.
2. 열린 사이트의 주소창에 `google.com`이 보이는지 확인합니다. 다른 이름이면 닫고 1번부터 다시 합니다.
3. **Chrome 다운로드**(Download Chrome) 버튼을 누릅니다. (화면 확인 필요: 버튼 글자)
4. 내 운영체제에 맞는 아래 목록 하나만 따라 합니다.

Windows:

1. 받은 설치 파일을 두 번 누릅니다.
2. "이 파일을 실행하시겠습니까?"라고 물으면 **실행**(Run)을 누릅니다. (화면 확인 필요: 한글 문구)
3. "이 앱이 디바이스를 변경하도록 허용하시겠어요?"라고 물으면 방금 내가 받은 파일일 때만 **예**(Yes)를 누릅니다. (화면 확인 필요: 한글 문구)
4. 설치가 끝나면 크롬 창이 저절로 열립니다. Windows 10 이상 기준입니다.

macOS:

1. 받은 `googlechrome.dmg`를 엽니다.
2. 나타난 창에서 Chrome 아이콘을 **Applications** 폴더로 끌어다 놓습니다.
3. 관리자 암호를 물으면 직접 입력합니다.

Linux:

1. 내 배포판과 CPU에 맞는 `.deb`(Debian·Ubuntu) 또는 `.rpm`(Fedora·openSUSE) 파일을 받습니다.
2. 받은 파일을 열고 **설치**(Install)를 누릅니다.
3. 관리자 암호를 입력합니다.

설치를 마친 뒤 이어서 합니다.

5. 에이전트에게 "크롬 설치했어"라고 말합니다. 에이전트가 표준 설치 위치에서 크롬을 찾습니다.
6. 에이전트가 크롬을 찾았다고 하면 끝입니다.
7. 에이전트가 크롬을 못 찾았다고 하면, 크롬을 표준 위치가 아닌 곳에 설치한 것입니다. 이때 크롬 실행 파일의 전체 경로를 에이전트에게 알려 줍니다. Windows의 표준 경로는 `C:\Program Files\Google\Chrome\Application\chrome.exe`, macOS는 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, Linux는 `/opt/google/chrome/chrome`입니다.
8. 에이전트가 그 경로를 환경 변수 `OPTBREW_CHROME`에 넣고 감사를 이어 갑니다. 에이전트가 하지 못하면 아래 9번부터 직접 합니다.
9. Windows에서 직접 하려면 시작 메뉴에서 `환경 변수`를 검색해 **계정에 대한 환경 변수 편집**을 엽니다. (화면 확인 필요: 한글 이름)
10. **새로 만들기**(New)를 누릅니다.
11. 변수 이름에 `OPTBREW_CHROME`을 적습니다.
12. 변수 값에 크롬 실행 파일의 전체 경로를 적고 **확인**을 누릅니다. 열려 있는 터미널과 에이전트를 닫았다 다시 켭니다.
13. macOS·Linux에서 직접 하려면 터미널에서 쓰는 셸 설정 파일에 `export OPTBREW_CHROME="크롬 실행 파일의 전체 경로"` 한 줄을 넣습니다. 파일 위치가 셸마다 다르므로 에이전트에게 내 셸에 맞는 파일을 묻습니다.

설치 파일을 받을 수 없거나 회사 정책으로 설치가 막힌 컴퓨터에서는 이 런북을 건너뜁니다. 감사는 렌더 확인 항목만 빈칸으로 두고 끝까지 갑니다.

## brief

- `google.com/chrome`에서 설치합니다. Windows는 설치 파일 실행, macOS는 `googlechrome.dmg`를 Applications로 끌기, Linux는 `.deb`/`.rpm` 설치입니다.
- 표준 설치 위치와 `PATH`의 `chrome`·`google-chrome`·`chromium`·`msedge`를 자동으로 찾습니다. Edge도 됩니다.
- 다른 위치에 설치했다면 환경 변수 `OPTBREW_CHROME`에 실행 파일의 전체 경로를 둡니다.
- 클라우드 하네스에서 설치하는 방법은 확인 안 됨입니다. 이 런북은 내 컴퓨터용입니다.
