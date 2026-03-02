# WhereScore MVP

공공데이터 API 기반 입지·공간분석 MVP 웹앱입니다.

## 접속 URL

- 배포 URL: `https://sc0801kr.github.io/geo/`
- 루트(`/`)로 접속해야 하며, 브랜치/Pages 설정이 끝난 뒤 반영까지 보통 1~5분 정도 걸립니다.

## GitHub Pages 배포 (권장: GitHub Actions)

이 저장소는 `.github/workflows/deploy-pages.yml`을 포함하고 있어 `main` 브랜치에 푸시하면 자동 배포됩니다.

1. GitHub 저장소 **Settings → Pages** 이동
2. **Build and deployment → Source**를 **GitHub Actions**로 선택
3. `main`에 푸시
4. **Actions 탭**에서 `Deploy static site to GitHub Pages` 성공 확인
5. `https://sc0801kr.github.io/geo/` 접속

## 404가 뜰 때 체크리스트

404 화면(“File not found”)은 코드 문제가 아니라 **Pages 소스/브랜치 설정 문제**인 경우가 대부분입니다.

- Pages Source가 `GitHub Actions`가 아니라면 변경하기
- `main` 브랜치에 `index.html`이 실제로 존재하는지 확인
- 저장소명이 `geo`인지(대소문자 포함) 확인
- 최근 푸시 후 Actions 배포가 성공했는지 확인
- 브라우저 강력 새로고침 (`Ctrl+F5` / `Cmd+Shift+R`) 후 재시도

## 로컬 실행

```bash
python3 -m http.server 4173
```

브라우저에서 `http://localhost:4173` 접속.
