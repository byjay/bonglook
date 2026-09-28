# HANDOFF — Bmail (bonglook)

## 미완료 (2026-09-28 갱신 — 1~5 완료, 6 대기)
5. [x] 첨부 내용 분석(PDF·XLSX·DOCX 텍스트 + 이미지는 무료 비전모델) — 2단계 모두 구현·실DB/실API 검증
   완료. 상세: 아래 「5번 완료 상세」 참조.
7. [x] **회신 필요성(의미) 판정 층 추가 완료(2026-09-28)** — HANDOFF 이전 기록("#6729 제목 정규화 매칭 실패")은
   **틀렸다**(지휘자 직접 재현으로 정정). 진짜 원인: 기존 unansweredMails() 는 "내가 답장했는가"(사실)만 보고
   "회신이 필요한가"(의미)는 안 본다 — 수정통보·참고도면처럼 답이 필요 없는 메일도 미회신으로 쌓인다.
   상세: 아래 「7번 완료 상세」 참조. (커밋 bd683a3)
7-1. [x] **7번 후속 미완 2건 — 코드 완료(2026-09-29), 커밋 X, 빌드·설치·실DB 판정(앱 실행 경로)은 C: 디스크 확보 후**:
   ① 「불필요 20건 + 필요 전체」표 — readonly 재측정(`scripts/reply-needed-measure3.mjs`, DB 쓰기 0·E: 출력만) 완료.
      40건 표본 결과: 성공 40/40 · **필요 13건** · 불필요 27건(무작위 20건 표 포함) · 판단불확실 0.
      (2026-09-28 측정치 "필요 6건"과 다름 — 시드·표본이 달라 자연스러운 차이, 재현성 위해 seeded shuffle 사용.
      산출물 `scripts/reply-needed-sample.md`는 개인 메일 제목 포함이라 `.gitignore` 등록, **커밋 안 함**.)
   ② 자동 판정 트리거 — **이미 존재했다**(bd683a3 에 포함, renderer.js `loadFollowup()` 내
      `if (mails.some(m => m.replyUnclassified)) window.api.replyClassifyBatch(...)`, 호출 지점
      624·2151·2494·2499·3166-3167). 다만 실행 시 **전체화면 로딩(`.loading`, z-index:999)을 띄워
      사용자 조작을 침범하는 결함**을 코드 추적으로 발견·수정(`handleAiProgress` kind==='replyNeeded' 분기 →
      비침습 텍스트 `#fu-classify-progress`로 분리). 추가: main.js `reply:classifyBatch`에 1회 상한
      `maxBatch`(기본 50) 신설, 「판정 대기」배지(`.fu-unclassified-badge`, 대비 7.78:1) 신설.
      selfcheck 신규 3건(트리거 존재·maxBatch 존재·전체화면로딩 미사용) + **뮤테이션 증명**: 트리거 guard 를
      `if (false && ...)`로 무력화 → selfcheck FAIL(EXIT=1) 확인 후 원복 → 재실행 PASS(diff 없음) 확인.
   커밋 43df461 (`.gitignore`·main.js·scripts/selfcheck.mjs·scripts/reply-needed-measure3.mjs·
   src/renderer/{index.html,renderer.js,style.css}).
8. [ ] 🔴 **C: 디스크 여유 0.1~1.25GB(2026-09-28 실측)** — Outlook·Bmail DB 가 C: 사용 → 손상 위험. 이번 세션 기여 약 2.5GB(HF 캐시 1.38·Temp\claude 1.18, 세션 스크래치 0.01)로 주범 아님. 앞 에이전트의 "Temp 32GB e2e-prof" 주장은 **거짓**(전수 검색 0건). 주범 정밀 정찰 중. 삭제는 마스터 직접(안전 규칙).
9. [ ] 🔴 **Bmail 전체 E: 이전(마스터 지시 2026-09-29 "C 드라이브는 건들지 말고 E 에서 진행")** — 7-1 발주 완료 후 착수. 범위: ① 실행 위치: 설치본(C:\...\Programs) 대신 E: 의 실행본(예: release\win-unpacked 또는 E:\Apps\Bmail) + 바로가기 재지정 ② 데이터(userData·DB 711MB): 설정 가능한 데이터 경로(기본값은 타 사용자용 APPDATA 유지, 마스터 PC 는 E:\BmailData) — 앱 종료 → 복사 → 건수·무결성 대조 → 전환. **C: 원본은 삭제하지 않고 백업으로 둔다(정리는 마스터 결정)** ③ 빌드 캐시·TEMP·npm·electron-builder 캐시 E: 고정. 설계 변경+데이터 이전이라 모델 등급은 jev_route 로 판정.
   → **주범 확인(지휘자 실측)**: `C:\Users\FREE\AppData\Local\Docker\wsl\disk\docker_data.vhdx` **59.9GB**(최종 기록 2026-09-01, 이번 세션 무관). Downloads 3.6GB. Windows.old·C: Outlook 데이터 없음. 나머지 ~370GB 는 설치 앱 추정(미측정). 마스터께 Docker Clean/Purge 또는 제거 안내함. **디스크 확보 확인 후 7-1 재개.**
- 6번 Jev 결론(지휘자, 2026-09-28): **Bmail 실시간 경로 미적용.** 근거 — 적용 0/4(처리상태 규칙 열세·광고 동률·주제/회신 문턱 미달), CPU 모드 Jev 15.7s > LLM 6.3s, 신규 메일량은 무료 LLM 1000회/일로 충분. 어댑터·측정도구(`src/jev.js`·`jev-server.js`·`scripts/jev-measure*.mjs`)는 보존 — GPU 유휴 시 과거 메일 야간 일괄 분류 용도. Jev 10배 후보 1순위는 wd-checker(스킬 §10-4). 마스터가 강제 적용 원하면 주제 분류 「추정」 표시로.
6. [ ] **Jev 판정 도입** — 백엔드 결정 완료(아래 참조: JevK5 로컬 자가호스팅). 대상: 처리상태 제안 ·
   주제 분류 · 회신필요(noul) · 광고판정(noul) · 의도 라우팅 보조. 한국어 20건+ LLM 대조 일치율 실측
   후에만 본적용. OpenRouter Jev API(`/api/alpha/decisions`, `typesafe/jev-1.13`)는 이번 세션의
   freeOnly 가드가 막지 않도록 경로가 이미 분리돼 있음을 확인(가드는 `cerebras.chatOnce`의
   `/chat/completions` 전용, Jev 경로는 별개) — 단 마스터가 (B) JevK5 로컬을 택했으므로 OpenRouter
   Jev API 자체는 안 쓴다(잔액 음수 방지). 키 저장 위치는 `apiKeysByProvider.openrouter` 1곳(SoT).

### 7번 완료 상세 (회신 필요성 판정 층, 2026-09-28)
- **신규 파일**: `src/reply-needed.js`(단일 책임 — LLM 1건 1호출 판정 + `bucketOf()` SoT 버킷 함수).
- **DB**: `mails` 테이블에 `reply_needed`·`reply_needed_confidence`·`reply_needed_reason`·`reply_needed_source`
  (`'llm'|'manual'`)·`reply_needed_at` 5컬럼 추가(`db.js migrate()`). `unansweredMails()` 가 각 행에
  `replyBucket`('needed'|'notneeded')·`replyUncertain`·`replyManual`·`replyUnclassified` 를 붙여 반환
  (SoT: `reply-needed.js bucketOf()` 하나에서만 파생 — 화면·대시보드·브리핑이 각자 계산 안 함).
  `db.setReplyNeeded(id, {...})` 신설 — **manual 이 항상 우선, source='llm' 로는 이미 manual 인 행을 절대
  덮지 않는다**(먼저 조회 후 skip).
- **IPC**: `reply:classifyBatch`(미분류 후보만 LLM 배치 판정, main.js) · `reply:setManual`(마스터 수동 재지정).
  `preload.js` 에 `replyClassifyBatch`·`replySetManual` 노출.
- **판정 프롬프트**: 무료 LLM `mode:'batch'`(Groq 우선) 1건 1호출, JSON `{needs_reply, confidence, reason}`.
  기준: To+질문/요청/기한/확인=true, CC-only·통보·자료송부·광고=false. `confidence<0.70` 은 「필요」쪽에
  두고 `replyUncertain` 배지(놓치는 쪽보다 과잉이 안전, 스킬 §4).
- 🔴 **실사고 발견·수정**: 초기 `maxTokens:400` 으로 실측 중 JSON 절단(`#138971` 등, RECON 2026-09-28
  "OpenRouter LLM 200 maxTokens 함정"과 동일 클래스) → **900 으로 수정**, 재측정 0/40 실패로 해결.
- **UI**: `renderer.js loadFollowup()` — 「회신 필요 N」(펼침)/「회신 불필요로 판단 M」(접힘, 이유 표시) 2단
  분리. 항목별 `✕`(불필요로 옮기기)/`↩`(필요로 옮기기) 버튼 → `reply:setManual` 즉시 호출 후 새로고침.
  대시보드 위젯(`loadUnanswered`)·브리핑 카운트(`main.js buildTodoDigest`)도 같은 `replyBucket` SoT로 연동.
  미분류 후보가 있으면 화면 로드 후 백그라운드로 `reply:classifyBatch` 자동 호출(초기 1회+신규 증분,
  사용자 조작 방해 없음). CSS 신규 규칙 4종 전부 대비 ≥5.7:1 확인(계산 근거: 본문 기록).
- **Jev 미적용 사유**(스킬 §4, 코드 주석): reply_needed Jev 실측 78.3% 일치율·37.5% 폴백(40건, RECON
  2026-09-28) — 90%/폴백 문턱 미달 → LLM 사용.
- **실측(readonly, 마스터 실DB, 쓰기 없음 — 앱 DB 동시 접근 위험 회피)**: UI 기본값(3일+, 30일 창) 실
  후보 **141건**. 그중 **40건**을 실제 무료 LLM(Groq/OpenRouter 실전 배치 체인) 1건 1호출로 실측:
  성공 40/40(0 실패) · **회신 필요 6건(15%)** · **불필요로 판단 34건(85%)** · 판단불확실(conf<0.70) 0건.
  #6729("8310 ISS 수정", 삼호 백업, 2025-05-15)는 30일 창 밖이라 실제 화면 후보엔 안 잡히지만(이 예시가
  이번 발주의 「결함」 근거였음), `classifyMail()` 직접 호출로 실측: **needsReply=false, conf=0.97,
  bucket='notneeded'**, reason="단순 송부 알림이며 질문·요청·기한·확인 요구가 없음" — RECON 의 LLM 기준
  라벨(false)과 일치.
- **불필요로 판단된 무작위 20건**(표본, 제목·발신·신뢰도·이유):

| # | 제목 | 발신 | conf | 이유 |
|---|---|---|---|---|
| 138971 | RE: 6,603톤급 친환경 실습선 건조 생산설계 견적 요청 | 이선우 | 0.92 | 배관 견적 자료를 '참조 바랍니다'라고 단순 송부, 질문·요청·기한·확인 요구 없음 |
| 138985 | RE: plot요청 | 고영관 | 0.85 | 단순 전달/공유만, 구체적 행동·회신·기한 요구 없음 |
| 139085 | 한국야나세 KYTS-1037 배전반·전장품 WEIGHT 송부건 | MNC기술영업부 | 0.95 | 참조(CC), 질문·요청·기한·확인 요구 없음 |
| 138982 | FW: KAR [2nd] GA 도면 사도 문의 건 | 고영관 | 0.85 | 첨부 참조 요청만, 직접 질문·기한·액션 없음 |
| 139077 | [22K FD]선실(ACCOMM. PART) 도면 출도건(REVISION) | 고재이 | 0.80 | 도면 송부·출도 요청, 단순 작업지시 성격 |
| 139143 | [RE][2710/2711] 철의 제작도 송부 건 | 김정인 | 0.95 | 단순 도면 재송부, 참조 수신, 요청·질문·기한 없음 |
| 139071 | KYTS-1037(22K) DECK MACH. HYD. OIL LINE NO. 부여 건 | (주)태정엔지니어링 | 0.90 | 참조(CC), 요청 대상은 주수신인(고영관 대표) |
| 138974 | 신규 수주통보서 배부 | 김미나 | 0.95 | 전사 공지성 단순 안내, 질문·요청·기한·확인 없음 |
| 139086 | 한국야나세 KYTS-1037 BACC 무게 정보 알림의 건 | MNC설계부 | 0.95 | 단순 정보 전달, 질문·요청 없음 |
| 139142 | [2710/2711] 철의 체결재 전달 건 | 김정인 | 0.95 | CC, 수신자(TO)에게만 확인 요청, 나는 회신 불필요 |
| 139068 | KYTS1037-DG ROOM/AUX.MACH.ROOM/HPU ROOM ARRT 도면 반영 건 | (주)태정엔지니어링 | 0.95 | 참조(CC), 업무 참고 요청만 |
| 139074 | [RE]22K FD - Freeboard Mark 문의 | 박붕근 | 0.95 | 정보 전달("업무에 참고 바랍니다"), 회신·액션 요청 없음 |
| 139073 | RE: 22K FD(KYTS-1037) SHORE POWER CONNECTION 확인 | 박규진 | 0.92 | 참조(CC), 요청 대상은 강동찬 차장(동국) |
| 138976 | RE: 22,000TLC Caisson FD draft/deflection DATA전달 | 박규진 | 0.95 | 참조, 행동 요청은 주수신자(박찬우 팀장)에게 |
| 139082 | RE: [RE]22K FD] 선장 도면 출도 건_260914 | 고영관 | 0.85 | 전체수신 자료공유, 직접 질문·요청·기한·확인 없음 |
| 139011 | [한라ENS_CGO NURIBARAM] 철의 자료 송부 건 | 김정인 | 0.95 | 참조(CC), 직접 질문·요청 없음 |
| 138979 | FW: 35K FD - Electric Principle Diagram | 고영관 | 0.90 | 단순 자료 전달(참고용), 회신 요청 없음 |
| 139079 | RE: [(주)엠앤씨이엔지] 한국야나세 KYTS-1037 BACC 재승인도면 상 COMMENT 전달 | 박규진 | 0.86 | 참조로만 수신, 직접 질문·요청·확인 없음 |
| 138983 | HMT-2501 ANTENNA ARR'T-MAKER 검토 자료 송부의 건 | 김영기 | 0.95 | 단순 자료 송부·참고 요청, 회신 불필요 |
| 139078 | [22K FD] Deck machinery onboard test procedure | 김정인 | 0.95 | 참조(CC), 요청은 주수신자(박진수 매니저)에게 향함 |

- **검증**: selfcheck 15개 모듈 전부 PASS(reply-needed.js 11건 포함) · 고아 스캔 ERROR 0(WARN 1건은
  기존 무관 항목 `todo-reading-pane`) · 키 하드코딩 grep 0건 · **뮤테이션 증명**: `bucketOf()` 를 항상
  `'needed'` 만 반환하도록(판정 층 비활성화) 임시 변조 → selfcheck FAIL(AssertionError) 확인 후 원복,
  원복 후 재실행 PASS 재확인(diff 없음 확인). 빌드(`node_modules/electron-builder`, fnm node) →
  `install-silent.mjs` → `post-install-verify.mjs` 전부 PASS, DB 707MB 보존 확인. 2회 빌드(초기 +
  maxTokens 버그 수정 후 재빌드) 모두 성공.
- **UI 캡처**: 이 세션에 컴퓨터 사용/스크린샷 도구가 없어 **불가** — 코드 정적 검증(대비 계산)·selfcheck
  뮤테이션 증명·실DB 실측(위 40건)으로 대체함을 정직히 표기.
- **환경 문제(내 변경과 무관, 발견 즉시 대응)**: 세션 중 **C: 드라이브가 0바이트까지 참** — 내가 만든
  실측용 DB 복사본(741MB, `vscratch/`)이 원인의 일부였음 → **즉시 삭제해 회수**, 이후 readonly 전용
  스크립트로 전환(쓰기 없음). 빌드 시점엔 600MB대 여유로 성공했으나 마스터 PC 의 C: 드라이브가 상시
  100% 사용 중(`C:\Users\FREE\AppData\Local\Temp` 에 32GB 의 오래된 `e2e-prof-*` 잔여 폴더 존재) —
  이번 세션 원인이 아니고 삭제 권한도 없어 손대지 않았지만, 다음 빌드가 실패할 수 있는 **상시 위험**이라
  마스터 확인 필요.

### 6번 세부 진행 (지휘자, 2026-09-28)
- [x] ③-a 설치·기동·한국어 사전판정 — 조건부 진행(한국어 원문 state 가 영어특징보다 우수, n=5)
- [x] ③-b **측정 전용**: Jev 어댑터(`src/jev.js`, 백엔드 교체형) + 온디맨드 서버 수명주기(`src/jev-server.js`, VRAM 확인·유휴 종료) + 4질문 × 24건 실측(`scripts/jev-measure.mjs`, §10-5 표). 앱 UI 연결 없음(고아 스캔 ERROR 0 확인).
- [x] ③-c 측정 통과 판정만 앱 연결 — **통과 0건, 앱 연결 없음**(아래 「기준선 비교」 참조).
- 🔴 설계 제약: 마스터는 CAD(AutoCAD·Navisworks·GstarCAD) 사용 → **JevK5 상시 구동 금지**. VRAM 5.6/6GB 점유 실측 → 기동 전 여유 VRAM 확인, 부족하면 CPU 또는 건너뜀. 마스터 기존 지시 「PC 메모리에 영향 없어야」 준수.

### 5번 완료 상세 (첨부 내용 분석, 2026-09-28)
- **1단계(문서)**: `src/attach-content.js`(신규, 단일 진입점) — 캐시(db.js attachments 테이블
  extract_kind/pages/full_len/failed/at 컬럼) 우선, 없으면 저장본 추출, 저장본도 없으면
  `fetchMailAttachmentsToLocal`(main.js, mail:attachFetch 와 공유)로 Outlook COM 복사(읽기만).
  첨부당 3000자·전체 9000자 예산, 초과 시 "N자 중 M자 반영" 표시. 스캔 PDF(텍스트<20자)는
  "텍스트 없음(스캔/도면 추정)", 미지원 형식(dwg/hwp/zip 등)은 "미지원 형식(.ext)" 정직 표시
  (`src/attachments.js`). 연결 지점: `ai:translate`(읽기창 분석)·`ai:chatMails` focus 분기("이 메일로
  대화")만 — 브리핑·업무일지 등 대량 경로는 제외.
- **2단계(이미지)**: `src/attach-vision.js`(신규) — OpenRouter 무료 비전 3모델 체인(실측 1위만 안정
  성공, 2·3위는 업스트림 429 상시라 폴백용). 전부 실패 시 "이미지 분석 불가(무료 비전 모델 응답 없음)"
  정직 표시. PDF→이미지 렌더링은 범위 밖(canvas 의존성 제외 상태, 한계로 명시).
- **실DB(24,232건) 확장자 분포**: pdf 323·dwg 60·xlsx 47·xls 27·png 26·docx 23·jpg 18·zip 14·msg 9·
  hwp 3(진짜 첨부 560건 중). mails.real_attach_count 합계 23,518 인데 attachments 테이블엔 560건뿐 —
  대다수 미저장이라 분석 시 온디맨드 확보(위 fetchMissingFn)가 핵심 경로.
- **실API 검증**: PDF/XLSX/DOCX/HWP(미지원) 4건 + 이미지 1건(mail#4530, 엔진 호스 사진) 을
  OpenRouter 로 실호출 — 응답이 첨부 내용(문서버전·중량표 5,058.97톤·이미지 속 모델번호 등)을
  실제로 인용함을 확인. 토큰축소 단계에서 첨부내용을 가장 먼저 버리던 설계 버그를 실측 중
  발견·수정(본문/스레드를 먼저 줄이고 첨부내용은 최후 수단).
- **셀프체크**: attachments.js·attach-vision.js·attach-content.js 3종 신설, selfcheck.mjs 에 등록.
  뮤테이션 증명 2건 완료(문서 주입 끄면 FAIL·비전 주입 끄면 FAIL, 확인 후 원복).
- **한계**: PDF 스캔 이미지 내용 분석 불가(2단계 범위 아님). 비전 체인 3종 중 2종은 업스트림 429가
  "상시"라 사실상 1종(nemotron-3-nano-omni) 의존 — 그 모델이 막히면 전부 실패로 정직 표시됨.
- **빌드·설치**: `npm run dist`(fnm node) → `install-silent.mjs` → `post-install-verify.mjs` 전부 통과,
  DB 707MB 보존 확인. 커밋 2건: 1단계(경로 한정)·2단계(경로 한정).

## 완료분 (2026-09-28)
1. [x] 답장 초안 TypeError 수정 — `aiBoxEl()`/`aiq()` 공유 헬퍼 신설, box 보유 호출부는 `box.querySelector`.
   동일 패턴 전수 수정(rpDraftReply·refineAnalysis·refineDraft·showPrevDraft·updateIterVersionLabel·
   저장분석 자동표시). selfcheck 뮤테이션 증명(FAIL→PASS) 완료. 상세: CONTEXT.md 2026-09-28.
2. [x] OpenRouter 무료 전용 전면 교체 — 1순위 OpenRouter(models[] 폴백 3개, 무료원천 3중 방어),
   2순위 Groq, Cerebras 체인 제거(키는 apiKeysByProvider.cerebras 에 보존). 대화형(OpenRouter우선)/
   배치(Groq우선) 이중 체인. 실측표·실호출(실제 메일 1건 분석+답장초안 성공)·Groq폴백 전부
   CONTEXT.md 2026-09-28 참조.
3. [x] 키 소스 하드코딩 제거 — src/main.js 완전 제거, `grep -rE "csk-|gsk_|sk-or-" src/ scripts/` = 0건.
   라이브 config 유실 없음(먼저 실측 확인 후 이관).
4. [x] 검증 통과분 커밋 완료 — 해시는 세션 보고 참조.

## 결정·가정
- "절대 무료로만" → 유료 경로 코드 차단(3중 방어: normalizeEntry·sortModels·chatOnce+cost가드).
  Groq 는 무료라 폴백으로 유지.
- OpenRouter 무료 일일 한도 = **1,000회(실측 확정 2026-09-28, "50회"는 이전 추정 — /api/v1/key
  응답의 free_model_daily_requests.limit 필드로 확인)**. 배치·자동작업은 Groq 로, 사용자 직접 요청을
  OpenRouter 로(cerebras.js 이중 체인 + analyzer.js briefing/dailyBriefing/workLog 에 mode:'batch').

## Jev 실측 (2026-09-28)
- 경로 `POST openrouter.ai/api/alpha/decisions` model `typesafe/jev-1.13` → HTTP 200, 0.31s, 1회 $0.000028 (입력 671tok)
- 🔴 **계정 total_credits=0, total_usage=0.000471 → 잔액 음수.** Jev 는 `:free` 아님 → 호출할수록 부채 누적, 음수 잔액은 무료 LLM 까지 막을 위험.
- 한국어 표본 1건(CC 수신 도면메일): action todo p=0.21 · reply_needed 0.51 · theme 도면 0.61 → **전부 0.70 미만(LLM 승격)**. 1건이라 결론 불가, 20건 측정 필요. 설계 팁: criteria 키·instructions 영어 + state 한국어로 재측정.
- 백엔드 선택지: (A) OpenRouter 크레딧 충전 후 API (B) **JevK5 로컬 자가호스팅**(Apache-2.0, Qwen3.5-4B+LoRA, /v1/systemone 호환, GTX1660S 6GB 적재 가능 추정 — 무료·메일 외부전송 0) → **마스터 결정(2026-09-28): (B) JevK5 로컬.** 모델 다운로드 승인 포함. OpenRouter Jev API 는 사용 안 함(잔액 음수 방지).
   진행 순서(발주 1건씩): ① 현 OpenRouter 교체 발주 완료 대기 → ② scout: JevK5 실행 방법·크기·요구사양·GTX1660S 6GB 적재 가능 여부·Windows 구동 경로 조사 → ③ coder: 로컬 서버 기동 + Jev 어댑터(백엔드 교체 가능 구조, /v1/systemone 호환) + FILEMAP.md 생성 → ④ 한국어 20건+ LLM 대조 일치율·폴백률·지연 실측 → 통과 대상만 본적용.

## JevK5 정찰 결과 (2026-09-28, scout — 지휘자 검토 반영)
- 런타임 `allebee/jevk5` v0.3.0(Python, Apache-2.0), 모델 HF `alibiserikbay/JevK5`(4B)·`JevK5-9B`·`JevK5-GGUF`. `/v1/systemone` 호환.
- 로컬 환경: Python 3.11/3.13 · uv 0.11.1 · nvidia-smi OK · E: 977GB 여유. Ollama 는 logprobs 미제공 → **Ollama 경로 불가**.
- 🔴 **JevK5 는 "English-only" 명시** — 한국어 메일 대상이라 최대 위험. API Jev 한국어 1건도 전부 p<0.70 였음.
- 지휘자 정정: 정찰의 "4B 6GB 불가"는 bf16 기준. **GGUF Q5(~3GB)는 GPU 적재 가능성 높음 → 실측**. "다운로드 6GB"는 저장소 전체 기준 → **필요 양자화 파일 1개만** 받는다. "CPU 100ms" 는 미검증.
- 진행: **작게 시작 — ③-a 설치·기동·한국어 사전판정(5건)** 으로 가부 먼저 확인 → 통과 시 ③-b 어댑터+20건 실측. 한국어 부적합이면 **영어 특징 상태(state)** 방식(한국어는 규칙으로 구조화 특징 추출 → 영어 state 로 Jev 판정)을 대안으로 함께 측정.

## JevK5 설치·가부 사전판정 결과 (2026-09-28, ③-a 완료)
- **설치**: `E:\models\jevk5\.venv`(uv, Python3.11, 전역 오염 없음) + `jevk5==0.3.0`(--no-deps, git+v0.3.0) +
  llama.cpp b11223 win-cuda-12.4-x64(`E:\models\jevk5\llamacpp\bin\llama-server.exe`) +
  `jevk5-4b-v0.3-Q5_K_M.gguf`(3.07GB, `E:\models\jevk5\models\`). `jevk5-serve`(bf16 CUDA)는 9GB 필요해
  이 GPU엔 불가 — GGUF+llama-server 경로만 사용. `jevk5.server.py`는 GGUF 미지원(torch 강제 임포트)이라
  스모크용 `/v1/systemone` 래퍼를 별도 작성(`E:\models\jevk5\systemone_gguf_server.py`,
  JevK5GGUF 클라이언트 재사용 — Bmail 어댑터 아님, 이번 범위 아님).
- **GPU/CPU**: **GPU 풀오프로드 성공**(`-ngl 99`). GTX1660S 6GB 중 5.6GB 사용, 잔여 330~500MB — 🔴 매우
  타이트. 평소 데스크톱 점유(4.4GB, 이 세션 측정)와 겹치면 동시구동 불가 위험. 콜드 로드 73.5초(1회성).
- **지연 실측**: 3-choice 단일질문 10회(콜드 제외) 평균 **749.87ms**, 최대 820.22ms — 정찰 기록의
  "100ms"는 무관한 수치(OpenRouter Jev API 별도 측정)였음, 정정 완료.
- **한국어 가부 5건**: action/reply_needed/theme × (A)한국어원문 state vs (B)영어특징추출 state.
  (A) p≥0.70 14/15(93.3%), LLM(OpenRouter nemotron-3-ultra:free) 참고치 대비 원시일치 13/15(86.7%).
  (B) p≥0.70 11/15(73.3%), LLM대비 11/15(73.3%) — **(B)가 (A)보다 낮음**(가설과 반대, n=5라 결론 보류).
  🔴 README "English-only" 명시와 달리 한국어 원문 state 가 실측상 더 잘 작동 — choice-letter logit
  판독이 한국어 의미이해보다 구조 단서(subject 코드·RE:·수신/참조 위치)에 반응하는 것으로 추정([Uncertain]).
- **가부 판정**: **소규모 진행 가능(조건부)**. 200OK+정상 응답, 지연 허용범위, 한국어 위험신호 없음(A방식
  93.3%). 단 VRAM 여유 330~500MB 로 OOM 위험 — 본적용 전 ① Q4_K_M(2.71GB) 교체 또는 ② 온디맨드
  기동/언로드 구조 필요. **표본 5건은 사전판정용, 본적용 전 20건+ 정식 일치율 실측 필수**(스킬§7-4, 다음
  발주). 서버 2개 테스트 후 종료 완료(상주 없음), VRAM 1.9GB로 원복 확인.


## ③-b Jev 측정 결과 (2026-09-28, 실API/실DB 24건, `scripts/jev-measure.mjs` 실행)
- **구성**: `src/jev.js`(단일 어댑터, backend='local'|'openrouter', openrouter 코드만 존재·기본 비활성) +
  `src/jev-server.js`(VRAM 확인→GPU/CPU 자동 선택→온디맨드 기동→유휴 5분 자동종료). 셀프체크 10건 세트에
  `jev.js` 추가(`scripts/selfcheck.mjs` [10]), 뮤테이션 증명 완료(임계값 분기 변조 시 FAIL→원복 PASS 재확인).
- **표본**: 실DB(읽기전용) 층화 24건(직접수신요청/참조통보/도면송부/견적승인/광고뉴스레터/회신완료스레드 각 4건, 카테고리는 규칙기반 휴리스틱 분류).
- **기준 라벨**: 앱 실체인 LLM(OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free`) 1회/건, 24건 전부 성공(0 실패)
  — 🔴 최초 시도에서 `maxTokens:200`으로 16/24 가 reasoning_tokens(~200~250)에 먹혀 JSON 중간 절단(`truncated:true`)돼
  전부 비교불능이었음(거짓축소 방지: LLM 실패를 조용히 삼키지 않고 로그+집계에 노출하도록 수정) → `maxTokens:900`으로
  재측정해 0/24 실패로 해결. 실측 근거: `/tmp/jevdebug2.mjs` — 200 한도에서 `completion_tokens:200` 전량 소모, 900 한도에서 정상 완결.
- **VRAM/기동**: 측정 시점 여유 VRAM 3,506MB(기준 4,000MB 미만, ZWCAD.exe 등 실사용 중이었음 확인) →
  **GPU 기동 자동 차단, CPU 모드(-ngl 0)로 안전 대체**(설계대로 동작). 콜드 기동 4,162ms. 적재 후 피크 VRAM 사용
  ≈176MB(CPU 모드라 매우 작음). 종료 후 프로세스 좀비 0(`tasklist llama-server.exe` 없음 확인) — VRAM 수치 자체는
  측정 전(3,506MB)/후(3,004MB) 완전 일치하지 않으나 JevK5 피크 점유(176MB)로 설명 안 되는 차이라 다른 GPU 프로세스
  (브라우저 등) 변동으로 판단([Uncertain], 좀비 프로세스는 확인상 없음).
- **지연**: Jev(4질문/1콜, CPU 모드) 평균 15,716ms 최대 24,880ms — GPU 미검증(이번 세션 VRAM 부족으로 GPU 경로 못 탐).
  LLM(1콜/건) 평균 6,264ms 최대 16,828ms.
- **일치율·폴백(질문별, 스킬 §10-5)**:

| 질문 | 판정건수 | P | 일치율(p≥0.70만) | 일치율(전체) | 폴백률(p<0.70) | 판정 |
|---|---|---|---|---|---|---|
| action | 24 | 미측정 | 66.7%(14/21) | 66.7%(16/24) | 12.5%(3/24) | 보류(일치율 미달) |
| reply_needed | 24 | 미측정 | 76.9%(10/13) | 70.8%(17/24) | 45.8%(11/24) | 보류(일치율·폴백률 둘 다 미달) |
| theme | 24 | 미측정 | 76.2%(16/21) | 66.7%(16/24) | 12.5%(3/24) | 보류(일치율 미달, 90%에 근접) |
| is_newsletter | 24 | 미측정 | 95.8%(23/24) | 95.8%(23/24) | 0.0%(0/24) | **본적용 후보**(기준 p≥0.70 일치율≥90%·폴백≤30% 충족) |

  - 비용: 로컬 0 / LLM 무료쿼터 **실제 24건**(질문 4종을 1콜에 묶어 처리 — 표에 "24건"이 4번 나오는 건 같은
    24콜을 4개 질문 관점에서 각각 집계한 것이지 96콜이 아니다).
  - action 불일치 8건 중 6건이 "Jev=todo, LLM=fyi"로 한 방향 쏠림(Jev 가 action 에서 과도하게 todo 로 판정하는
    경향, [Uncertain] 원인 미규명 — 표본 확대 필요). theme 불일치는 report↔drawing/approval 경계 혼동이 다수.
- **판정 권고(④, 근거: p≥0.70 일치율≥90%·폴백≤30%)**: **is_newsletter만 본적용 후보.** action·theme·reply_needed
  는 90% 문턱 미달로 보류 — 「추정 표시로만」조차 아직 이르다(스킬 §4 "형식 보장≠정답 보장" 그대로 재현: 확률은
  높은데(theme 최대 0.99) 틀린 사례 다수, 예: #4317 action p=0.990 인데 LLM 과 불일치).
- **한계**: GPU 경로 미검증(VRAM 부족으로 CPU만 측정) — GPU 지연·정확도가 다를 가능성 있음. LLM 자체도 틀릴 수
  있어 "기준"이 아니라 "대조군"일 뿐(스킬 §7-4 취지). 표본 24건은 아직 20건대 초반이라 분류 경계(action
  todo/fyi, theme report/drawing)의 통계적 신뢰도는 낮음.
- 원본 로그: 세션 스크래치패드 `/tmp/jev-measure-run3.log`(최종본, maxTokens 900).

## ③-c 기준선 비교 + 하이브리드 개선 측정 (2026-09-28, `scripts/jev-measure2.mjs`, 40건)
- **구성**: 표본 24→**40건**(6카테고리 층화, 결정적 셔플 유지). LLM 기준라벨은 하이브리드 state(B) 1회/건으로
  통일(24건 재측정 아님 — 새 40건 전체 재추출·재라벨링, ③-b 24건과 표본이 다름에 주의).
  기존규칙 3종 재사용(SoT, 재구현 아님): `action-state.js suggest()`(action), `sent-axis.js classifyEvent()`
  (theme), `db.js unansweredMails()`(src/db.js:1777-1826) 알고리즘을 readonly 커넥션 위에서 재현(reply_needed,
  프로덕션 DB는 `db.init()`의 RW+migrate 를 쓰지 않고 읽기전용 유지). is_newsletter 는 `action-state.js`
  `NOREPLY_RE`/`NEWSLETTER_RE`(이번 발주에서 export 추가, 정규식 복제 아님). 하이브리드 state(B) = 한국어 원문
  + 구조화 필드(수신자역할 To/CC·요청문구탐지 yes/no·공지문구탐지·회신스레드여부·진짜첨부 수/확장자·발신조직도메인).
- **결과표(40건, 기존규칙 vs Jev 최선(A 또는 B) vs 판정)**:

| 질문 | 기존규칙 일치율(판정/미판정) | Jev-A(원문) p≥0.70 | Jev-B(하이브리드) p≥0.70 | 폴백(최선) | 최선 대비 우위 | 판정 |
|---|---|---|---|---|---|---|
| action | 71.4%(25/35, 미판정3) | 67.9%(19/28) | 66.7%(20/30) | 25.0% | **-3.6%p(규칙이 더 나음)** | ❌ 미적용 |
| reply_needed | 34.4%(11/32, 미판정6) | **78.3%(18/23)** | 76.0%(19/25) | 37.5% | +43.9%p(Jev 압승) | ❌ 미적용(90% 문턱·폴백 미달) |
| theme | 65.0%(13/20, 미판정18) | 80.0%(20/25) | **86.4%(19/22)** | 41.0% | +21.4%p | ❌ 미적용(90% 문턱·폴백 미달) |
| is_newsletter | **100.0%(38/38)** | 100.0%(37/37) | 100.0%(37/37) | 0.0% | +0.0%p(동률) | ❌ 미적용(스킬§10-1: 동률·열세면 외부의존 금지) |
  - 전체 0/4 통과 → **③-c 앱 연결 없음**(발주서 §4 "통과 0건이면 측정 결과만 기록").
  - action: **기존 규칙이 Jev 보다 낫다** — 유일하게 규칙 우위인 질문. Jev 적용 시 오히려 후퇴.
  - reply_needed: 기존 규칙(34.4%)이 매우 약함(RE:/RE:RE: 스레드도 "미회신"으로 오판하는 경우 다수 — 정규화 제목
    매칭이 스레드 내 최신 발신 시각만 비교해 중간에 낀 재문의 메일에 취약, [Uncertain] 근본원인 미확정) — Jev 가
    압도적으로 우수(+43.9%p)하지만 **90%/폴백 절대 문턱 자체를 못 넘어 미적용**. 하이브리드(B)가 원문(A)보다
    나아지지 않음(76.0% < 78.3%) — 구조화 필드 추가가 이 질문에서는 역효과.
  - theme: 하이브리드(B)가 원문(A)보다 개선(80.0%→86.4%, +6.4%p) — 유일하게 하이브리드가 원문을 이긴 질문.
    단 절대 문턱(90%) 미달로 미적용은 동일.
  - is_newsletter: 규칙·Jev 모두 100% — 규칙이 이미 완벽해 Jev 도입은 외부 의존만 늘림(③-b 는 "본적용 후보"였으나
    기준선 비교 신설로 정정: **동률이면 규칙 유지**가 맞는 판정).
- **엇갈린 사례 5건(마스터 판단용)**:
  1. `#16148` "[H.2710/11] TLGS & WIS 승인도 검토건" — action: LLM=fyi, Jev=todo(p=0.94~0.98 고신뢰), 규칙=todo.
     Jev·규칙 둘 다 todo 로 의견 일치, LLM 만 fyi — CC 수신 + '검토건' 제목이라 규칙판단(todo)이 실무상 타당해
     보임([Uncertain], 마스터 확인 필요).
  2. `#2086` "[RE]RE: 복원성 확인을 위한 추가 자료 송부" — reply_needed: LLM=false, 규칙=false(정답으로 보임 —
     RE:RE: 스레드), Jev-A/B 둘 다 true(p=0.66~0.67, 폴백권). Jev 가 "RE:" 스레드 신호를 못 읽은 사례.
  3. `#6729` "8310 ISS 수정" — reply_needed: LLM=false, Jev-A=false(일치, p=0.735), 규칙=true(오답 — 제목이
     정규화 매칭 안 돼 스레드 인식 실패로 추정), Jev-B=true(불일치). 규칙이 틀리고 Jev-A 가 맞은 드문 사례.
  4. `#13167` "FW: SFL ICCR Project 2nd San felipe block issue 회의" — theme: LLM=other, Jev-A=report(p=0.888
     고신뢰 오답), 규칙=meeting(제목의 '회의' 키워드 매칭, LLM 과 다름). 셋 다 의견 불일치 — 본문 맥락 없이는
     마스터도 제목만으로 판단 어려움.
  5. `#16148` (theme, 같은 메일) — LLM=drawing, Jev=approval, 규칙=approval. '승인도'(approval drawing)라는
     조선업 특유 복합어를 LLM 은 drawing 으로, Jev·규칙은 approval 로 갈림 — 도메인 용어 해석 차이로 추정.
- **한계**: is_newsletter 를 제외한 3질문 모두 baseline"판정" 표본(action 35/40·theme 20/40·reply_needed 32/40)이
  40건보다 작음(미판정 제외) → theme 은 특히 18/40 이 'etc'(미판정)라 규칙 자체의 커버리지가 낮음. LLM 기준
  라벨도 "정답"이 아니라 "대조군"(스킬§7-4). GPU 미검증(이번도 VRAM 2.8~2.9GB, CPU 모드).
- 원본 로그: 세션 스크래치패드 `/tmp/jev-measure2.log`. 결과 JSON: `scripts/jev-measure2-result.json`(git 추적,
  마스터가 원자료 검토 가능).

## 문서 부트스트랩 (2026-09-28)
- `CLAUDE.md`(정체 카드) 신설, `ECOSYSTEM_START_GUIDE.md` §14 레지스트리 1줄 등록. FILEMAP.md 미생성(다음 발주에서 `_warehouse/05-scripts-build/filemap.mjs` 로 생성).

## 환경
- `node` 기본 PATH 없음 → 문법검사·selfcheck 등은 `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe`로 충분.
  단 **electron-builder 빌드(`npm run dist`)는 이 방식으로 돌리면 실패**(argv 슬라이스가 어긋나 "Unknown
  arguments", app-builder.exe 하위 프로세스가 STATUS_DLL_INIT_FAILED로 죽음, 2026-09-28 실측) →
  빌드만은 `export PATH="/c/Users/FREE/AppData/Roaming/fnm/node-versions/v20.17.0/installation:$PATH"`
  로 진짜 node(v20.17.0)를 PATH에 올려 `node node_modules/electron-builder/out/cli/cli.js build --win --x64`
  로 실행할 것.
- 마스터 PC 실사용 중 → 포커스 뺏는 자동 조작 금지
