# WhereScore MVP

공공데이터 API 기반 입지·공간분석 MVP 웹앱입니다.

## GitHub Pages로 바로 보기

이 프로젝트는 정적 파일만으로 동작합니다.

1. GitHub 저장소 **Settings → Pages**로 이동합니다.
2. **Build and deployment**에서 `Deploy from a branch` 선택
3. Branch를 `main`(또는 배포 브랜치) / 폴더는 `/ (root)` 선택
4. 저장 후 발급된 URL로 접속하면 바로 실행됩니다.

예시 URL:
- 홈: `https://<username>.github.io/<repo>/`
- 결과 페이지 직접 링크: `https://<username>.github.io/<repo>/?page=result&lat=37.5665&lon=126.9780&mode=founder&radius=500`

## 로컬 실행

```bash
python3 -m http.server 4173
```

브라우저에서 `http://localhost:4173` 접속.
