---
checked: 2026-10-16
source: https://github.com/GoogleChrome/web-vitals https://web.dev/articles/vitals-measurement-getting-started
harness: any
---

# 사이트 안에서 방문자 측정값 모으기 (web-vitals)

## beginner

왜 필요한가: 방문자 수가 적은 사이트는 Google CrUX에 데이터가 없어 LCP·INP·CLS 실측값이 빈칸입니다. 이때 사이트 안에 작은 스크립트(web-vitals)를 넣어 방문자의 실제 측정값을 직접 모읍니다. 이 런북은 사이트 소스를 직접 고칠 수 있는 사람용입니다. 사이트를 고칠 수 없으면 건너뜁니다. 값이 쌓이는 데 시간이 걸리므로 이번 감사의 빈칸은 이 작업으로 바로 채워지지 않습니다.

1. 사이트의 모든 쪽에 공통으로 들어가는 파일(레이아웃·템플릿·푸터)을 엽니다. 어떤 파일인지 모르면 에이전트에게 로컬 소스에서 찾아 달라고 합니다.
2. `</body>` 닫는 태그를 찾습니다.
3. `</body>` 바로 위에 다음 코드를 붙여 넣습니다. 이 코드는 방문자의 측정값이 나올 때마다 브라우저 콘솔에 보여 줍니다.

```html
<script type="module">
  import {onCLS, onINP, onLCP} from 'https://unpkg.com/web-vitals@5?module';
  onCLS(console.log);
  onINP(console.log);
  onLCP(console.log);
</script>
```

4. 파일을 저장하고 사이트에 반영합니다.
5. 사이트를 브라우저로 열고 F12를 눌러 개발자 도구를 엽니다. **Console**(콘솔) 탭을 누릅니다.
6. 쪽을 한 번 클릭하거나 다른 탭으로 갔다 돌아오면 측정값 줄이 찍힙니다. LCP·INP·CLS 이름이 보이면 코드가 동작하는 것입니다. 일부 값은 클릭, 탭 전환, 쪽 이탈 때 처음 나옵니다.
7. 측정값을 모으려면 받는 곳이 필요합니다. 분석 도구가 이미 있으면 web-vitals 설명서(GitHub 저장소의 README)에 있는 분석 도구 전송 예시대로 `console.log` 자리에 전송 코드를 넣습니다. 분석 도구가 없으면 Google Analytics가 무료입니다.
8. 안정성을 원하면 코드가 가리키는 CDN 파일을 그대로 쓰지 말고 내 사이트 서버에 파일을 내려받아 올립니다. README도 같은 권고를 합니다.
9. 이 코드를 넣은 사실은 개인정보 처리방침에 맞는지 사이트 운영자와 확인합니다.
10. 며칠 뒤 분석 도구에서 방문자 측정값이 쌓이는지 확인합니다.

## brief

- 모든 쪽에 `<script type="module">import {onCLS, onINP, onLCP} from 'https://unpkg.com/web-vitals@5?module';`와 `onCLS(...)`·`onINP(...)`·`onLCP(...)` 호출을 넣습니다.
- 콜백에서 `navigator.sendBeacon`으로 내 수집 주소나 분석 도구(예: Google Analytics)에 보냅니다. 값은 클릭·탭 전환·쪽 이탈 때 나옵니다.
- 가능하면 CDN 대신 파일을 내 서버에서 제공합니다. 방문자 수가 적은 사이트는 값이 쌓이는 데 시간이 걸립니다.
