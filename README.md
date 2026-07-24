# 📧 Outlook AI 어시스턴트 (데스크톱 앱)

Windows용 **독립 실행 프로그램**입니다. Outlook Add-in을 사용하지 않으므로 회사에서 Add-in을 막아놨어도 동작합니다. PC에 설치된 Outlook / PST 데이터를 읽어 **대화형 메일 검색**과 **첨부파일(PDF·엑셀·이미지·워드) AI 분석**을 제공합니다. AI는 **Cerebras**를 사용합니다.

---

## ✨ 주요 기능

- **PST / Outlook 연동**
  - `Outlook 연동(실시간)`: PC의 Outlook이 열고 있는 데이터를 실시간으로 읽음 → **새 메일 자동 수신** ✅
  - `PST 파일 직접`: Outlook을 켜지 않아도 `.pst` 파일을 직접 읽음
- **날짜 필터**: 기본 **최근 6개월** / **전체** / **기간 지정** (PST 용량이 커도 빠르게)
- **실시간 새 메일**: 설정한 주기(기본 60초)마다 새 메일을 자동 확인 + 시스템 알림
- **대화형 메일 검색**: "김부장이 보낸 견적서 찾아줘" 처럼 자연어로 검색
- **첨부파일 AI 분석**: PDF / 엑셀(xlsx·xls·csv) / 워드(docx) / 이미지 / 텍스트 — **한 번에 최대 5개**
- **API 키 5개 자동 폴백**: 앞 키가 실패/한도초과면 자동으로 다음 키 사용 → 안정성 극대화
- **원클릭 설치 + 자동 업데이트**: 설치 파일 더블클릭으로 설치, 이후 서버(깃허브 릴리스)에 새 버전 올리면 자동 업데이트

---

## 🛠️ .exe 설치 파일 만드는 법 (사용자가 직접, PC에서 1회)

> 이 저장소는 **소스코드**입니다. 아래 순서로 딱 한 번 빌드하면 `설치 파일(.exe)`이 만들어집니다.
> 이후에는 그 exe만 배포/실행하면 됩니다.

### 1단계: Node.js 설치 (한 번만)
- https://nodejs.org 에서 **LTS 버전** 다운로드 → 설치 (기본값으로 다음다음 클릭)
- 설치 확인: `시작` → `cmd` 실행 후
  ```cmd
  node -v
  ```
  버전 숫자가 나오면 성공.

### 2단계: 이 폴더에서 명령창 열기
- `outlook-ai-desktop` 폴더를 파일 탐색기에서 연 뒤, 주소창에 `cmd` 입력하고 Enter
- (또는 폴더에서 `Shift + 우클릭` → "여기에 PowerShell 창 열기")

### 3단계: 의존성 설치 (한 번만, 몇 분 걸림)
```cmd
npm install
```

### 4단계: 설치 파일(.exe) 빌드
```cmd
npm run dist
```
- 빌드가 끝나면 **`release`** 폴더 안에 아래 파일이 생깁니다:
  ```
  release\OutlookAI-Setup-1.0.0.exe
  ```
- 이 **`OutlookAI-Setup-1.0.0.exe`** 가 바로 배포용 설치 파일입니다.
  더블클릭하면 자동으로 설치되고 바탕화면에 아이콘이 생깁니다.

### (참고) 빌드 없이 바로 실행해보기
```cmd
npm start
```

---

## ⚙️ 처음 실행 후 설정 (필수)

앱을 처음 켜면 왼쪽 **⚙️ 설정**에서:

1. **Cerebras API 키 입력** (최소 1개, 최대 5개)
   - 키는 https://cloud.cerebras.ai 에서 발급
   - 여러 개 넣으면 하나가 막혀도 자동으로 다음 키 사용
2. **메일 데이터 소스 선택**
   - `Outlook 연동(실시간)` ← 추천 (새 메일 자동 수신)
   - 또는 `PST 파일 직접` → 📁 찾기로 `.pst` 선택
3. **읽어올 기간**
   - 기본 `최근 6개월` (권장) / `전체` / `기간 지정`
4. **💾 저장** 클릭

> 설정 하단의 "연결 상태"에 ✅ 표시가 나오면 정상입니다.

---

## 🔄 자동 업데이트 설정 (개발자/배포자용)

앱은 **GitHub Releases** 기반 자동 업데이트를 지원합니다.

1. `package.json` 의 `build.publish` 에서 본인 깃허브 정보로 수정:
   ```json
   "publish": {
     "provider": "github",
     "owner": "본인_깃허브_아이디",
     "repo": "outlook-ai-assistant"
   }
   ```
2. 새 버전 배포 시:
   - `package.json` 의 `version` 을 올림 (예: `1.0.0` → `1.0.1`)
   - 환경변수 `GH_TOKEN` 에 깃허브 토큰 설정 후:
     ```cmd
     npm run dist:publish
     ```
   - 그러면 GitHub Releases에 새 버전이 올라가고,
     사용자 앱은 실행 시 자동으로 감지 → 다운로드 → 재시작 시 적용됩니다.
   - **사용자는 아무것도 안 해도 됩니다.**

> GitHub 배포를 안 쓰면 자동 업데이트는 비활성 상태로 동작(수동 재빌드/재설치)합니다.

---

## 🧩 기술 구조

```
outlook-ai-desktop/
├── package.json          # 의존성 + electron-builder 설정 (원클릭 설치)
├── src/
│   ├── main.js           # 메인 프로세스: 창/업데이트/실시간폴링/IPC
│   ├── preload.js        # 보안 브릿지 (contextBridge)
│   ├── outlook.js        # Outlook COM 연동 (실시간, PowerShell)
│   ├── pst.js            # PST 파일 직접 파싱 (pst-extractor)
│   ├── attachments.js    # 첨부 분석: PDF/엑셀/워드/이미지/텍스트
│   ├── cerebras.js       # Cerebras API (키 5개 자동 폴백)
│   └── renderer/         # 화면(UI)
│       ├── index.html
│       ├── style.css
│       ├── renderer.js
│       └── assets/icon.ico
└── release/              # 빌드 결과물(.exe) — npm run dist 후 생성
```

### 연동 방식 설명
- **Outlook 연동(실시간)**: Windows COM으로 실행 중인 Outlook에 접근. Outlook이 PST/OST를 실시간 갱신하므로 새 메일이 즉시 반영됨. **관리자 권한·추가 설치 불필요**, Add-in 정책에 안 걸림.
- **PST 직접**: `.pst` 파일을 직접 파싱. Outlook을 켜지 않아도 되지만 실시간 반영은 안 됨(파일 스냅샷).

---

## ❓ 자주 묻는 문제

| 증상 | 해결 |
|------|------|
| "Outlook 오류" / 메일이 안 나옴 | Outlook이 실행 중이고 로그인되어 있는지 확인. 또는 PST 모드로 전환 |
| 새 메일이 안 뜸 | 설정 → 소스가 `Outlook 연동(실시간)` 인지, 실시간 토글이 켜져있는지 확인 |
| AI 응답이 안 옴 | 설정에서 Cerebras API 키가 올바른지 확인 (키 여러 개 권장) |
| 첨부 분석이 느림 | 파일이 크면 시간이 걸림. 한 번에 5개까지만 가능 |
| PST가 너무 커서 느림 | 기간을 `최근 6개월`로 (기본값) 두면 빠름 |

---

## 📌 요약 (한 줄)
**`npm install` → `npm run dist` → `release` 폴더의 Setup.exe 실행 → 앱에서 Cerebras 키 입력 → 끝.**
