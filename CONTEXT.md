## 2026-09-28 — 답장초안 TypeError 근본수정 + OpenRouter 무료전용 전면교체 + 키 하드코딩 제거
핵심결정:
- **답장초안 TypeError(임무1)**: `revealAiBox()`가 메일 뷰에서 돌려주는 실제 렌더 대상(우측 AI칸
  `#rs-ai-body`)은 `rpq()`가 보는 `rpTargets.content`(본문영역) 밖에 있다. box 에 그린 `#copy-reply`
  등을 `rpq`로 찾으면 항상 null → addEventListener TypeError. 공유 헬퍼 `aiBoxEl()`/`aiq()` 신설(SoT),
  box 를 갖고 있는 호출부는 `box.querySelector`로 통일. 동일 패턴 전수 grep 후 수정 지점:
  `rpDraftReply`(#copy-reply/#open-in-outlook) · `refineAnalysis`/`refineDraft`/`showPrevDraft`
  (#iter-* 입력줄·`.reply-draft pre`) · `updateIterVersionLabel`(#iter-*-ver) · **덤으로 발견**: 저장된
  분석 기록을 메일 열자마자 자동표시하는 코드도 `rpq('#rp-ai-result')`로 고정돼 있어 메일 뷰에서는
  숨은 박스에 그려지고 있었다(`aiBoxEl()`로 교체). selfcheck에 회귀 테스트 추가(가짜 DOM으로
  aiBoxEl/aiq는 성공·rpq는 실패함을 실행 검증) — **뮤테이션 증명**: `aiq` 함수명을 일부러 바꾸면
  selfcheck EXIT=1(FAIL), 원복하면 EXIT=0(PASS) 실행 확인.
- **OpenRouter 무료 전용 전면교체(임무2, 마스터: "절대 무료로만")**: 1순위 OpenRouter, 2순위 Groq,
  **Cerebras 는 체인에서 제거**(유료 전환, 잔액 $0). 실측(2026-09-28 /api/v1/key): 키 유효·
  `free_model_daily_requests.limit=1000`/일(RECON 의 "50회" 추정을 실측으로 정정). 무료(:free)
  모델 17개 실호출 비교(한국어 요약1+JSON구조화1) 결과 상위 3개를 OpenRouter `models[]` 폴백
  배열로 고정: `nvidia/nemotron-3-ultra-550b-a55b:free`(1위, 품질+안정) ·
  `nvidia/nemotron-3-super-120b-a12b:free`(2위, 최속) · `cohere/north-mini-code:free`(3위).
  제외: gemma-4-31b/26b·qwen3.8-27b(업스트림 429 상시) · nemotron-3.5-lightning(사고과정 유출로
  JSON 실패) · nemotron-3.5-content-safety(RECON 기록: 빈 응답). **`models[]` 는 실측 확인상 최대
  3개**(4개째부터 400) — OpenRouter 서버가 1순위 실패 시 자체적으로 다음 모델로 넘어간다(라이브
  검증: gemma 429 → 자동으로 nemotron-super 로 전환, `model used` 필드로 확인).
  **무료 원천 보장 3중 방어**: ① `ai-providers.normalizeEntry`가 :free 아닌 모델을 프리셋 기본값으로
  강제 대체 ② `sortModels`가 freeOnly 제공자는 :free 아닌 항목을 드롭다운에서 아예 제외
  ③ `cerebras.chatOnce`가 실제 호출 직전 재확인(차단) + 응답에 `usage.cost>0` 찍히면 성공으로
  돌려주지 않고 즉시 차단 + `provider:{max_price:{prompt:0,completion:0}}` 라우팅 동봉(실측: 수용됨).
  **대화형 vs 배치 우선순위**(마스터 지시): 사용자 직접 요청(번역/분석·답장초안·대화)은 OpenRouter
  우선, 배치·자동(업무일지·브리핑·스케줄러)은 Groq 우선 — OpenRouter 일일 한도를 대화용으로 아낀다.
  `cerebras.js`에 대화형/배치 이중 체인(`setChain(list,batchList)`, `usableChain(mode)`) 신설,
  `ai-providers.reorderForBatch()`가 Groq 를 앞으로 당긴다. `analyzer.briefing/dailyBriefing/workLog`
  내부 호출에 `mode:'batch'` 고정(스케줄러·수동 트리거 모두 같은 함수를 타므로 자동 적용).
  교차검증 2번째 경로는 별도 코드 없이 이미 `chain[1]`(대화형 순서=OpenRouter,Groq → chain[1]=Groq)을
  쓰므로 요구사항이 구조적으로 이미 충족됨(코드 추가 없음). 일일 한도 표시·자동전환은 기존
  Groq 용 제네릭 메커니즘(`limits`/`usageSnapshot`/`refreshAiUsage`)에 `limits:{rpd:1000}` 만
  추가해 그대로 재사용(신규 UI 코드 0).
  🔴 **다음 세션 참고(지휘자 실측 경고 2026-09-28)**: OpenRouter 계정 크레딧 0·누적사용 있어 잔액이
  음수(~-$0.0005)일 수 있다 — 무료 모델도 402/negative balance 로 막힐 수 있음(이번 세션 실호출
  에서는 재현 안 됐음). 또한 Jev(typesafe/jev-1.13, `/api/alpha/decisions`) 는 `:free` 가 아니라
  **이 세션의 freeOnly 가드가 자동으로 막지 않는다**(가드는 `chatOnce`의 `/chat/completions` 경로에만
  적용 — Jev 어댑터는 이번 범위에서 만들지 않음, 다음 발주에서 별도 설계). 키는 이미
  `apiKeysByProvider.openrouter` 한 곳(SoT)에 있어 Jev 어댑터도 그대로 재사용 가능.
- **키 하드코딩 제거(임무3)**: `src/main.js`의 `DEFAULT_AI_CHAIN`·store 기본값에 박혀 있던 Groq 5개·
  Cerebras 7개 키 문자열 전부 제거(빈 배열로). 유실 방지: 라이브 `outlook-ai-config.json`(electron-store)
  에 이미 실키가 있음을 먼저 실측 확인 후, OpenRouter 키(창고 `secrets.json`)를 그 파일에 1회
  이관(백업 파일도 생성) + `aiChain`을 `[openrouter, groq]`로 갱신, Cerebras 는 체인에서만 제거하고
  `apiKeysByProvider.cerebras`는 데이터 유실 방지 차원에서 보존.
- **회귀 방지**: settings UI 텍스트박스의 placeholder 예시("csk-... 또는 sk-...")가 키 grep 패턴에
  우연히 걸려 문구를 바꿈(진짜 비밀값 아님, 실제 코드에는 0건이지만 grep 결과를 깨끗하게 함).

검증(실측): 문법검사 22/22 PASS · `scripts/selfcheck.mjs` 10종 전부 PASS(신규 AI박스 회귀 포함,
뮤테이션 증명 FAIL→PASS 확인) · `scan-orphans.mjs --guard` ERROR 0/WARN 1(기존 todo-reading-pane,
회귀 아님) · `grep -rE "csk-|gsk_|sk-or-" src/ scripts/` = **0건**(exit 1) ·
빌드(`node node_modules/electron-builder/out/cli/cli.js build --win --x64`, **plain node 로 실행 —
`ELECTRON_RUN_AS_NODE=1 electron.exe`로 electron-builder 를 돌리면 argv 슬라이스가 어긋나
"Unknown arguments" 로 실패하고, app-builder.exe 하위 프로세스는 STATUS_DLL_INIT_FAILED 로 죽는다.
plain node(fnm v20.17.0, PATH 등록)로 전환하니 정상 완료 — 다음 세션 참고) EXIT0 → install-silent
EXIT0(15.6s) → post-install-verify --fix PASS(exe/asar 2026-09-28 14:25 최신·바로가기 정상·메일DB
707MB 보존) · **OpenRouter 실호출**: 라이브 DB 실제 메일(id=1, 주간보고 xls) 1건으로
translateAnalyze(ok=true, 요지 3줄 정확) + draftReply(ok=true, "확인했습니다" 톤의 정중한 회신 생성)
성공 · 유료 모델 강제 지정 시 즉시 차단(`errorKind=blocked_paid_model`, 네트워크 호출 전에 거부) 확인 ·
Groq 폴백: 무효 OpenRouter 키로 1순위를 막았더니 `switched=true, switchedTo=groq`로 자동 전환 후
정상 응답 확인.

미해결(정직 명시): Jev 어댑터(`/api/alpha/decisions`)는 이번 범위 밖 — 다음 발주에서 설계.
OpenRouter 계정 잔액 음수 가능성으로 인한 402 는 이번 세션 실호출에서 재현되지 않아 실제 방어
동작(자동 Groq 전환)은 코드상으로만 확인됨(402 는 `shouldSwitchProvider`의 quota kind 로 기존에
이미 처리되는 경로 — 신규 코드 아님). 실 GUI 클릭(마우스로 답장초안 버튼을 눌러보는 것)은 이
세션에 컴퓨터 사용 도구가 없어 미실시 — 코드경로 동일성(analyzer.draftReply 직접 호출)으로 대체
검증함. 첨부 내용 분석(HANDOFF 5번)은 이번 범위 아님 — 손대지 않음.

다음할일: 마스터 검수(설치본 이미 띄워둠) → Jev 어댑터 설계는 별도 발주 → 잔액 확인/충전 필요 시
OpenRouter 대시보드에서 확인.

## 2026-09-04 - 4탭 UI(타임라인/목록/사람별/키워드별) 프런트엔드 완성 — 지난 세션 미완료분 해결
핵심결정:
- **재조사 없이 착수**: 이전 세션들이 백엔드(main.js buildResultTabs·detectTabSwitch·timeline-agg.js·
  ai:summarizeGroups·exporter.js·preload.js)를 이미 100% 완성해 두고 세션 한도로 반복 중단됐음을
  grep 으로 먼저 확인. index.html 에도 `#result-tabs`(4버튼+엑셀) 스캐폴드가 숨김 상태로 이미 있었다.
  → 이번 세션은 **renderer.js·style.css 만** 수정(백엔드/HTML 변경 0).
- **타임라인 기본 탭**: `showResultTabs()`가 검색 성공 시 항상 `activeResultTab='timeline'`으로 연다
  (마스터 지시 "정렬·검토하면 무조건 타임라인"). 날짜그룹 헤더+항목(방향◀▶·상대·제목·요지·첨부/상태배지·
  스레드 들여쓰기)은 즉시 렌더(구조 데이터는 검색 응답에 이미 동기 포함), 상단 종합요약+날짜별 한줄은
  `ai:summarizeGroups`로 비동기 요청해 스켈레톤→교체(실패해도 목록은 유지, `cv-badge cv-warn` 재사용).
- **사람별/키워드별 표**: 사람별 행 클릭 시 `mailsForPersonKey()`로 그 사람과의 왕복만 걸러 클라이언트에서
  즉시 타임라인 재구성(재조회 없음, `timelineRowsClient()`). 키워드별 행 클릭은 대표메일(repId) 오픈.
- **엑셀 내보내기**: `exportActiveResultTab()`이 활성 탭(타임라인/사람별/키워드별/목록)별로 한글 헤더 표를
  만들어 기존 `export:excel`(rows 배열 지원, 백엔드 무변경) 재사용.
- **대화창 탭 전환 라우팅**(이전 세션 중단 지점): `sendChat()`이 `res.resultTabs` 있으면
  `mirrorResultTabsFromChat()` 호출. `kind==='tab-switch'`("사람별로 정리해줘"/"타임라인으로 보여줘",
  백엔드 `detectTabSwitch` 가 이미 감지)면 **즉시 메일 뷰로 전환**해 해당 탭 렌더. 그 외(검색·할일브리핑 등
  resultTabs 동반 응답)는 데이터만 반영해 두고 카드 안 `[타임라인·표로 보기]` 버튼으로 이동(대화 흐름을
  강제로 끊지 않음). `search-grouped` 응답은 이미 같은 왕복에서 AI 날짜별요약을 만들어와 재요청 안 함.
- **정렬 갱신**: 결과탭 모드(`resultTabsData` 있음)에서 정렬 변경은 재조회 대신 클라이언트 정렬만
  다시 적용(`sortMailsClient`, date는 `received_ts` 없으면 `received_at` 파싱 폴백).
- CSS 는 **신규 색쌍을 만들지 않고** 기존 검증색만 재사용(`#0b4f8a`·`#166534`·`#b91c1c`·`cv-badge cv-warn`
  등 이미 대비검증된 클래스/값) — 재검증 리스크를 줄였다.

검증(실측): selfcheck 9종 PASS + timeline-agg 자체 셀프체크 PASS(들여쓰기·날짜그룹·사람별·키워드별·빈입력) ·
CSS 브레이스 998/998 균형 · 고아 스캔 ERROR 0/WARN 1(기존 todo-reading-pane, 베이스라인 유지 — 신규 오탐
tl-dir-recv/sent 는 동적 템플릿을 리터럴 삼항으로 바꿔 해소) · 함수 정의 1:1(showResultTabs 등 14개 전부
정확히 1회 선언) · DOM id 1:1(#result-tabs/.rt-tab/#rt-xls 전부 index.html 에 존재) ·
**실 DB(707MB, better-sqlite3 직접조회) 대조**: "8월 설병헌 hole" SQL 1건=timelineRows 1건(정렬 정상),
personTable.recv 가 SQL 직접 COUNT 와 MATCH, 300건 표본에서 timeline/person/keyword 집계 16ms(즉시 렌더
가능) · exporter.writeExcel 한글 헤더·값 왕복 일치(XLSX 재읽기로 확인) · `TAB_SWITCH_RE` 가 마스터 예문
"사람별로 정리해줘"/"타임라인으로 보여줘" 정확 매칭 · 빌드(`npm run dist`) EXIT0(yargs 문제 이번엔
재현 안 됨) → install-silent EXIT0 12.6s → verify:install PASS(바로가기·DB 707MB 보존) → Bmail.exe
기동 확인(8프로세스 안정, 마스터 사용 가능하게 띄워둠).

미해결(정직 명시): **실제 GUI 클릭·화면캡처 검증은 이 세션에 computer-use 도구가 없어 미실시** —
백엔드 로직+실DB+엑셀+정규식+DOM-id/함수 존재 여부는 전부 실측했으나, 마우스로 4탭을 눌러 렌더를 눈으로
보는 단계는 다음 세션(또는 마스터 육안)이 확인해야 한다. ②"정렬 변경 자동갱신"·⑥"캐시 재조회 방지"도
구조적으로는 맞게 짰으나 GUI 클릭으로 최종 확인은 안 됐다.

다음할일: 마스터가 실제로 검색해 4탭 확인 → 문제 있으면 devtools 콘솔부터 확인 → 커밋 여부 지시 대기.

## 2026-09-03 - 검색 필드 문법(임무A) + 분석 강화(임무B) + 메일별 대화 이력 완료, 4탭 UI(타임라인/표/엑셀)는 미착수
핵심결정:
- **임무A 검색 필드 문법**: `제목:`/`보낸사람:`/`받는사람:`/`참조:`/`본문:`/`첨부:`/`폴더:`/`기간:`(한영 별칭) 지원.
  같은 필드 여러 값=OR, 다른 필드=AND(`likeOrClause` 헬퍼 1곳). `기간:` 은 "2026-08"(연월)·"지난달"·"8/1~8/20"
  범위·"8월"(일자없음) 까지 `parseDateExpr` 로 통합. 자연어 추론 확장(참조/제목에/본문에 패턴).
  ★ 함정: subject/body 필드검색에 FTS5 prefix-token 매칭(`col:"val"*`)을 썼다가 직접 SQL LIKE 대비
    **27% 리콜 손실**(한글은 공백 없는 긴 토큰이라 prefix 매칭이 중간~후행 매칭을 놓침) → 정확도 우선,
    LIKE 로 원복(성능 640ms/300ms목표 미달은 인정하고 보고 — 정확도>속도).
  랭킹(`rankSearchResults`): 제목적중+3·본문적중+1·최신성 가중·광고후순위(키워드 있을 때만 재정렬).
  동명이인 후보(`findContactCandidates`)는 안내용(검색 자체는 막지 않음).
- **마스터 합격 문장 4종 실측**(원문 그대로 파싱→DB 검색): "8월에 설병헌이 보낸 hole 관련 메일 찾아줘"
  →조건 3개(기간2026-08·발신설병헌·키워드hole) 정확 분해·1건. "지난달 김정인이 보낸 도면 메일"→15건.
  "8월에 받은 CAMBER 관련"→0건(정직 표시). "설병헌이 참조된 hole 메일"→8건. 전부 chips 정확·날짜그룹 생성.
  `ai:chatMails` (4-b) 분기 신설: structured&&keywords 인 복합검색은 `groupMailsByDate`+`analyzer.summarizeByDate`
  로 날짜별 한줄+전체종합 응답(캡 60건, "N건 중 M건 요약" 명시).
- **임무B 분석 강화**: `translateAnalyze`에 threadContext(같은 thread_key 이전 최대5통, db.getThreadContext)·
  attachments(진짜 첨부파일명) 주입. 스키마에 decisions/risks 추가. 도면·호선·프로젝트코드는 **규칙기반 정규식**
  (`extractProjectCodes`, LLM 미경유라 항상 원문대조 성립)으로 추출(2710/11·M-011·22K FD·KYTS-1037 패턴).
  actions[].due·keyFacts[].value 는 `isGrounded()` 로 원문(본문+제목+스레드맥락) 대조해 없으면 제거/공백화.
  analyzer 셀프체크에 코드추출4종+그라운딩2종 회귀 추가(PASS).
- **메일별 '대화하기'**: 기존 `chatScope==='mail'`+`ai:chatMails`focus분기 재사용(신규 대화엔진 없음).
  focus분기에 스레드맥락 5통 주입 + `mail_chat` 테이블(신규)로 대화 이력 영속화. `rp-ask-btn`을
  레거시 `switchView('chat')`+수동컨텍스트 주입에서 **gchat 사이드패널 오픈+서버측 맥락 재사용**으로 교체
  (중복 토큰낭비 제거), 이력 있으면 "이전 대화 N턴 이어보기" 복원. `rp-ask-clear`(대화 초기화) 신규.
  IPC `chat:history`/`chat:historyClear` + preload 2종.
- **미착수(중대, 정직 명시)**: 코디네이터가 작업 중 3차례 요구 확장(① 사람별/키워드별 표+타임라인 탭+엑셀
  내보내기 4탭 UI ② 위 전체) — dashboard-agg.js/exporter.js/sent-axis.js 재사용 전제로 설계는 가능하나
  실제 UI(타임라인 렌더·표·탭전환·엑셀버튼 연결)는 **미구현**. 별도 세션/에이전트로 이어받아야 함.
  또한 Groq(1순위)가 세션 중 TPM 80으로 급락(240초 대기해도 미회복 — 계정단 이슈로 추정)해 B·메일대화의
  **실제 AI 생성 응답은 라이브 검증 불가**(코드/그라운딩/스레드조회는 실DB로 검증 완료). Cerebras(2순위)는
  기존대로 402 지속.

검증(실측): db.js/main.js/analyzer.js/preload.js/renderer.js 문법검사 PASS · selfcheck 9종 전체 PASS
(analyzer 신규 6건 포함) · 고아 스캔 ERROR 0/WARN 1(기존 todo-reading-pane) · 필드문법 5종 DB직접대조 전부 PASS ·
같은필드OR·여러필드AND PASS · 마스터 문장4종 조건분해 PASS · 실 스레드 2건(145건/8건) getThreadContext
정확성 확인 · 빌드(electron-builder, yargs hideBin electron 우회 패치) EXIT0 · install-silent EXIT0 9.2s ·
post-install-verify PASS(바로가기·707MB DB보존) · 설치본 기동 확인(프로세스 4개).

다음할일: [중대] 4탭(타임라인/사람별표/키워드표/엑셀) UI 구현 — 별도 세션. Groq TPM 정상화 후 B·메일대화
실호출 재검증. 마스터 검수 → 커밋 여부 지시 대기.

## 2026-08-25 15:21 - 레이아웃 넘침 수정 (화면 우측 빈 공간 426px 제거)
핵심결정:
- **마스터 화면이 왼쪽으로 몰리고 우측 426px 가 비던 진짜 원인**: 옛 '우하단 팝업' 시절 규칙
  `body.gchat-reserve #body{padding-right:calc(var(--gchat-w,400px) + 26px)}` 가 남아 있었고,
  `applyGchatReserve()` 가 여전히 body 에 클래스를 붙이고 있었다. 4열 전환 후에는 대화창이 그리드 셀
  안에 있으므로 여백이 필요 없다 -> CSS 규칙 삭제 + 함수는 클래스 제거만 하도록 무력화.
- 부수 원인 2건도 함께 제거:
  · 본문 트랙의 `minmax(480px,1fr)` 최소값이 (창폭 - 트리 232) 보다 커지면 그리드가 밖으로 밀렸다
    -> `minmax(0,1fr)` 로 바꾸고 목록/도구도 축소 가능하게(minmax) 변경.
  · flex 자식에 준 `width:100%` 가 초기 폭에 고정돼 리사이즈를 못 따라갔다 -> 제거(min-width:0 만 유지).
  · 그리드 아이템 기본 `min-width:auto` 로 인한 밀림 차단(`> * { min-width:0 }`).
- **세로 분할 균등화**: 펼쳐진 섹션은 기본 1:1(:1). 저장 비율이 있으면 합을 정규화해 적용.
  저장 키를 v3 로 올려 이전의 불균등 값 무효화. 도구 패널이 320px 미만이면 자동 탭 모드(문구 깨짐 방지).

검증(실측, 창 6종): 1920x1080 / 1500x950 / 1280x1024 / 1100x1400 / **980x1300(마스터 비율)** / 860x1200
-> 전부 **우측 빈 공간 0 · 가로 스크롤 0 · 좌측 잘림 0**. 본문이 가장 넓은 영역(1920 -> 956px, 1500 -> 536px,
1280 -> 376px, 1100 -> 774px, 980 -> 654px). 세로 분할 균등: 2단 371:371, 3단 259:259:259 (편차 0),
접힘 36px. 콘솔 오류 0 · 고아 ERROR 0 · 셀프체크 통과 · 설치본 2026-08-25 15:21:08 + verify:install PASS.
캡처: of-fhd/of-std/of-sq/of-tall/of-master/of-narrow.png · even-2.png · even-3.png

미해결(대기열, 이번 턴 미착수): 교차검증 · 대화창 액션바 · 첨부 버튼 통합 · 첨부 자동정리 ·
아침 브리핑 · 우클릭/트리 재점검 · 파일 탐색기 뷰 · 달력 뷰.

다음할일: 마스터 확인 후 대기열 순차 진행.

## 2026-08-25 11:46 - 4열 레이아웃 정정 + 선택 메일 우선 대화 + CSS 유실 사고 복구
핵심결정:
- **레이아웃 정정(마스터 지시)**: 3분할(본문 273px)이 반대였다 -> **4열**로 재구성.
  트리 232 | 목록 380 | **본문 520(단독 열·항상 최대)** | 도구 패널 340(분석/대화/미리보기 세로 3단).
  목록 폭에 **상한 28vw** 를 둬 본문이 언제나 가장 넓은 영역이 되게 했다.
  본문은 세로로 쪼개지 않는다. 도구 섹션은 접히면 헤더 36px 만 차지하고, 패널 전체를 접으면 본문이 폭을 회수(520->866).
  읽기창이 자체적으로 갖고 있던 좌우 분할(rp-right)도 메일 뷰에서는 접어 본문이 열 전체를 쓴다.
- **선택 메일 우선 대화(치명 결함 수정)**: 메일을 열어 둔 채 "무슨내용이지?" 를 물으면 검색을 돌려 0건 +
  "동기화하세요" 를 답하던 오동작. -> 검색은 **명시적일 때만**(조건 파싱됨 또는 '찾아줘/검색' 동사),
  그 외에는 **선택 메일 -> 직전 결과 -> 되묻기** 순으로 대상을 정한다. 의문 표현(무슨내용/언제까지/어떻게 답장 등)은
  검색어에서 제거. 맥락 칩에 대상을 표시하고 [전체로]/[이 메일로] 전환 가능.
- 🔴 **사고 기록(정직)**: 내가 CSS 를 '주석 A ~ 주석 B' 범위로 통째 교체하다 **style.css 320줄을 날렸다**
  (.mail-item/.mi-preview/리본 규칙 소실 -> 목록이 텍스트 덤프처럼 깨짐). 커밋이 없어 git 복구가 불가했고,
  **설치본 app.asar 에서 직전 style.css(1428줄)를 추출**해 복구한 뒤 4열 CSS 만 정밀 치환/추가했다.
  교훈: 범위 삭제 금지, 치환은 '정확한 원문 매칭 + 끝에 추가'로만.

검증(실측): 1500px 트리232/목록380/**본문520**/도구340 · 가장 넓은 영역=**본문** ·
섹션 접힘 36px · 도구 전체 접기 시 본문 520->866 · 반응형 1400/1100/900 겹침 0 ·
선택 메일 대화 "무슨내용이지?"/"언제까지 회신?"/"어떻게 답장할까" 전부 kind=focus(그 메일 근거) ·
선택 해제 시 직전 결과로 답(동기화 문구 없음) · "KSIT 메일 찾아줘"는 검색 유지 ·
셀프체크 통과 · 고아 ERROR 0/WARN 1 · 콘솔 오류 0 · 설치본 2026-08-25 11:46:22 + verify:install PASS.
캡처: g4-1500.png · g4-side-collapsed.png · g4-1400/1100/900.png

미해결(대기열): A 교차검증, 대화창 액션바, 첨부 버튼 통합(20MB), 첨부 자동정리(F 드라이브),
아침 브리핑, 우클릭/트리 재점검, 파일 탐색기 뷰, 달력 뷰.

다음할일: [A] API 병렬 교차 검증 -> 대화창 액션 바.

## 2026-08-20 19:15 - [대기열 2+B+C] 바둑판 레이아웃 전환 · 성능 실측 · 팝업 제거
핵심결정:
- **레이아웃을 CSS Grid 바둑판으로 재구성**(마스터 지시): 트리 | 목록 | 리사이저 | **우측 세로 3분할**
  (① 메일 본문 ② AI 분석 ③ AI 대화/첨부 미리보기 탭). 팝업·플로팅 전부 제거 — 대화창과 미리보기가
  이제 그리드 셀 안에 산다(#rs-pane-chat / #rs-pane-prev).
  ★ 함정: `.view.active{display:flex!important}` 가 `.mail-split{display:grid}` 를 이겨 그리드가 적용되지 않았다
    → `#view-mail.mail-split, .view.mail-split.active` 로 특이도를 올려 해결(실측으로 발견).
- **AI 분석 슬롯 분리**: 메일 뷰만 `rpTargets.ai = '#rs-ai-body'` 로 별도 셀에 그린다.
  다른 뷰(회신대기·보낸분류·검색·할일)는 기존 `#rp-ai-result` 그대로 → 회귀 0.
- **섹션 헤더 규격 통일**: 높이 36px · 제목 12px/700 · 아이콘 16px · 우측 부제(지금 무엇을 보는지).
  헤더 클릭으로 접기(접히면 36px만 차지하고 다른 구역이 공간 회수), 상태 기억.
- **드래그 리사이저 3곳**(목록 폭 · 읽기창/분석 · 분석/대화) + 비율 localStorage 저장.
- **반응형**: 1400+ 3열·우측 3분할 / ~1400 우측 2분할 / ~1100 트리 접힘 / ~900 단일 열
  (메일을 열면 자동으로 본문 전환 + [◀ 목록] 복귀 버튼 — 좁은 창에서 본문을 못 보던 문제 해결).
- **성능 실측**: 병목은 렌더러가 아니라 **읽기창을 열 때마다 도는 COM 첨부 조회(평균 834ms)** 였다.
  → 메일별 메타 캐시(30분) 도입. 나머지 지표는 이미 목표 이내였다.

검증(실측, 실제 DB 23,933건): display=grid · 열 [643,6,603] · 우측행 [273,6,228,6,228] · 섹션 3개 ·
헤더 36/36/36 · AI 접기 36px + 읽기창 확대 · 리사이저 643→763(저장됨) · 탭 전환(대화/미리보기, 팝업 아님) /
반응형 4폭 겹침 0·화면 안 / 성능 폴더클릭 67ms · 메일클릭 15ms · 뷰전환 3~14ms · 목록렌더 18ms · 부팅 507ms
(목표: 클릭 100ms·전환 200ms·부팅 3s 전부 충족) / 콘솔 오류 0 / 고아 ERROR 0 / 셀프체크 통과 /
설치본 2026-08-20 19:12:24 + verify:install PASS.
캡처: grid-1500.png · grid-tabs.png · grid-1400/1100/900/700.png · grid-final.png

미해결(대기열): A 교차검증, ③ 대화창 액션바, ④ 첨부 버튼 통합, ⑤ 첨부 자동정리(F 드라이브),
⑥ 아침 브리핑, ⑦ 우클릭/트리, D 파일 탐색기 뷰, E 달력 뷰.

다음할일: [A] API 병렬 교차 검증 → [대기열 3] 대화창 액션 바.

## 2026-08-20 15:45 - [대기열 1] 대화 맥락 이해 완료
핵심결정:
- **"전체요약해봐" 가 0건이던 원인 2개**: ① '전체'가 검색 키워드로 남아 AND 조건이 됨 ② 직전 결과를 세션에
  보관하지 않아 매 턴 새 검색. → 범위어(전체·모두·전부)·지시대명사(이 중·그거·더 자세히)를 검색어에서 제거하고,
  검색/브리핑 결과의 메일 id 를 `chatCtx` 에 1시간 보관해 후속 지시는 그 집합에만 적용한다(새 검색 금지).
- **업무 질의 라우팅**: "내가 뭘하면되니" 류(TODO_INTENT_RE)는 검색이 아니라 '할 일 브리핑'.
  기존 자산만 조합(unansweredMails + actionMails todo/hold), 마감 임박·방치 순 정렬.
- **근거 정합성**: 광고·뉴스레터(noreply·(광고)·인크루트 등) 제외 + 키워드 적중·최신성 가중(rankGrounding),
  키워드가 있는데 하나도 안 맞으면 근거로 쓰지 않는다. analyzer 프롬프트에 '컨텍스트 밖 메일 언급 금지' 규칙 추가.
- **중복 카드 제거**: 근거 목록을 별도 말풍선이 아니라 **응답 카드 안**(.grounded-inline)에 붙인다.
  0건일 때도 카드 1개(안내를 카드 안에 통합), '동기화하세요'는 DB가 실제로 빈 경우에만.

검증(실측, 실제 DB+Groq): 어제 8건 검색 -> "전체요약해봐" **usedPrevious=true·직전 8건 요약** /
"이 중 첨부 있는 것만" 5건 = DB 첨부 5건 일치 / "더 자세히" 직전 5건 상세화 / "KSIT 메일 찾아줘"는 새 검색(11/12 적중) /
"내가 뭘하면되니" -> 할 일 브리핑 15건·광고 0건·우선순위 표 / 근거 밖 메일 인용 **0건**(정밀 대조) /
UI 캡처로 질문 1개 = 카드 1개 확인(ctx-followup.png, ctx-empty.png) / 콘솔 오류 0 / 고아 ERROR 0 /
설치본 2026-08-20 15:44:36 + verify:install PASS.

미해결: 대기열 2~7 (분할 패널, 대화창 액션바, 첨부 버튼 통합, 첨부 자동정리, 아침 브리핑, 우클릭/트리).

다음할일: [대기열 2] 대화창 팝업 -> 분할 패널.

## 2026-08-20 11:15 - 우하단 대화 런처 가시성 수정 + 첨부 미리보기 패널 + 설치 실패 방어
핵심결정:
- **"대화창이 안 보인다"의 진짜 원인**: 접힘 상태 헤더 배경이 `#faf9f8`(거의 흰색)이라 흰 본문 위에서 묻혔다.
  내 이전 검증이 DOM 좌표만 봤고 실제 렌더 캡처를 안 봐서 놓쳤다(검증 방법의 결함).
  → 접힘 = **파란 런처 바**(accent 배경, 흰 글자 4.60:1, 그림자, "AI 대화 Ctrl+/") 로 교체.
    `dock='main'` 이어도 런처는 항상 남기고(대화 전용 뷰에서만 숨김), 저장키를 v2 로 올려 옛 상태값 때문에
    숨겨지는 사고를 차단. 첫 실행 기본은 펼침.
- **첨부 미리보기 패널** 신규: 첨부 파일명을 누르면 외부 프로그램이 아니라 읽기창 오른쪽에서 연다.
  PDF 는 Chromium 내장 뷰어(webPreferences.plugins=true + iframe file://) 로 페이지 이동·확대·인쇄까지 지원,
  이미지는 <img>, 텍스트/CSV 는 파일을 읽어 표시(512KB 상한), 그 외는 미지원 안내 + [기본 프로그램].
  저장 안 된 첨부는 클릭 시 자동으로 가져온 뒤 표시. ◀▶ 이동, [저장(복사)]·[폴더]·Esc 닫기.
  1200px 이하는 오버레이(하단 62px 띄워 대화 런처와 물리적 분리), 이상은 3분할 옆 520px 도킹.
- **설치 실패(ExitCode 2, 312초) 원인**: 앱 종료 직후 파일 잠금이 안 풀린 상태에서 NSIS 가 시작돼 롤백.
  → install-silent.mjs 에 종료 후 3초 안정화 + 실패 시 8초 뒤 1회 자동 재시도 추가.

산출물: src/main.js(file:preview·file:saveAs·plugins), src/preload.js, src/renderer/renderer.js(미리보기 엔진·런처),
src/renderer/index.html(#att-preview), src/renderer/style.css(.att-preview/.gchat.collapsed), scripts/install-silent.mjs.

검증(실측): 실제 렌더 캡처로 우하단 파란 런처 육안 확인(dock-collapsed.png) /
실제 첨부로 PDF(10페이지 뷰어)·PNG·CSV·XLSX(미지원 안내) 4종 렌더 확인 · ◀▶ 이동 · Esc 닫기 ·
폭 4종(700/900/1100/1400) 화면 안 유지 · 콘솔 오류 0 / selfcheck 9종 · 고아 ERROR 0 /
설치본 2026-08-20 11:08:00 · verify:install PASS.

미해결(대기 중인 신규 임무 3건): ① 첨부 자동 정리(F:\!!!진행프로젝트 루트·프로젝트 폴더 매핑·히스토리별)
② 아침 브리핑(회신대기·안읽음·어제 수신, 전 제공자 총동원) ③ Outlook 1:1 우클릭 메뉴 + 폴더 트리 재점검.

다음할일: 위 3건 순차 착수.

## 2026-08-20 11:00 - 첨부 목록 회귀·"어제 브리핑" 결함 수정 + 대화창 우하단 고정 + 분석/초안 연속 대화
핵심결정:
- **읽기창 첨부가 안 보이던 진짜 원인**: 클립 아이콘이 뜨는 메일 13,668건 중 **13,357건은 attachments 테이블에
  행 자체가 없었다**(동기화 때 첨부 미저장 구간). 읽기창이 DB 행에만 의존해 아무것도 못 그렸다.
  → 저장 전이라도 Outlook 속성만 읽어(파일 저장 0) 이름·크기를 보여주고, [가져오기]로 그때 저장한다
    (`mail:attachMeta` / `mail:attachFetch`). 인라인 이미지는 목록에서 분리.
- **"어제 메일 브리핑해줘" 0건 결함 = 원인 2개**: ① 대화 경로가 `parseSearchQuery` 를 안 쓰고 키워드 검색만 해
  '어제'가 불용어로 지워졌다 ② '브리핑해줘'가 키워드로 남아 AND 조건이 되어 0건이 됐다.
  → 대화 경로를 검색 뷰와 같은 파서로 통일 + 요청 동사 제거 + 브리핑 의도는 기존 브리핑 기능으로 라우팅.
    날짜 표현도 보강(M월 D일 · M/D · 달력 기준 이번/지난 주). 조건 칩 표시 + 0건 안내를 정직하게 수정.
- **대화창을 우측 하단에 상시 고정**(마스터 요구). 접힘=헤더만, 펼침=폭·상태 기억, Ctrl+/ 토글·Esc 접기,
  1100px 이상에서는 본문 우측 여백을 확보해 가림 0. [메인에 크게] 전체 모드는 유지.
- **분석/초안을 대화로 계속 다듬는 흐름**(앱 핵심 가치): 분석 카드·초안 아래 입력줄에서 지시하면
  같은 카드가 그 자리에서 갱신되고 버전 히스토리·되돌리기 제공. 백엔드는 기존 analyzer 재사용
  (translateAnalyze refine / draftReply previousDraft). AI 출력 형식이 어긋나도 텍스트로 폴백해 UI가 안 깨진다.

산출물: src/main.js(첨부 IPC 2종·대화 라우팅·날짜 파서·브리핑 헬퍼), src/analyzer.js(refine/previousDraft),
src/preload.js, src/renderer/renderer.js(첨부 지연 로딩·우하단 고정·연속 대화 엔진·조건 칩),
src/renderer/index.html, src/renderer/style.css.

검증(실측): 첨부 표본 10/10 리스트-읽기창 일치(문제 메일 EB-505 등 5건 정상 노출) /
어제(2026-08-19) DB 8건 = 파서 8건 일치, 일일 브리핑 라우팅 OK / 오늘 2건·8월19일 8건·이번주 16건·지난주 106건 DB 대조 일치 /
7개 뷰에서 우하단 고정(우측·하단 14px, fixed) · 폭 4종(700/900/1100/1400) 겹침 0 · 접힘/폭 기억 · Ctrl+/·Esc /
분석 "핵심 정보에 추가" -> 카드 갱신·버전2·되돌리기 / 초안 "더 짧게" -> 본문 대체(쌓이지 않음)·버전2 /
멀티턴 3회 맥락 유지 · 맥락 칩 '분석 결과' / 콘솔 오류 0 / selfcheck 9종 PASS · 고아 ERROR 0 /
설치본 2026-08-20 10:55:36 · verify:install PASS.

미해결: 마스터 육안 확인·커밋 대기. 첨부 미저장분 13,357건은 열람 시 즉시 목록이 뜨고 필요할 때만 저장한다
(일괄 백필은 COM 부하가 커서 하지 않음 - 필요하면 별도 지시).

다음할일: 마스터 검수 -> 커밋 여부 지시 대기.

## 2026-08-20 10:35 — Groq 5키 1순위 등록 · reasoning 예산 사고 수정 · 사용량 한도 방어
핵심결정:
- **Groq 를 1순위로 등록**(키 5개, `openai/gpt-oss-120b`), Cerebras 는 키 7개 그대로 **2순위 보존**(잔액 충전 시 즉시 복구).
  기본값은 `DEFAULT_AI_CHAIN` 상수 1곳에 두고, 시작 시 `migrateAiChain()` 이 비어 있는 설정을 채운다.
  ★ 함정: `store.store` 는 '저장된 값'이 기본값을 이겨서 복구에 쓸 수 없다(실측으로 확인) → 상수 참조로 근본 수정.
- **업무일지가 17자로 잘리던 진짜 원인 = reasoning 토큰이 max_tokens 예산을 먹은 것.**
  실측: gpt-oss-120b 는 짧은 프롬프트에도 reasoning 655토큰. map(maxTokens 1600)에서 본문이 남지 않았다.
  → gpt-oss 계열에 `reasoning_effort:'low'` 를 붙인다(추론 655→55, 2.4s→1.1s, 본문은 오히려 완전해짐).
    이 파라미터를 모르는 제공자가 400 을 내면 해당 엔드포인트를 기억해 옵션만 빼고 즉시 재시도한다.
- **Groq 무료 한도 실측 반영**(30 RPM · 1,000 RPD · 8K TPM · **200K TPD**): 호출마다 usage.total_tokens 를 누적하고,
  하루 한도의 **85% 를 넘으면 막히기 전에** 다음 순위 제공자로 자동 전환 + 토스트 경고. 설정에 '오늘 사용량' 막대 표시.
  사용량은 userData(`aiUsage`)에 저장돼 재시작해도 이어진다.

산출물: src/main.js(DEFAULT_AI_CHAIN·migrateAiChain·ai:usage·사용량 저장소 연결), src/cerebras.js(reasoning_effort·
사용량 추적·한도 근접 전환), src/ai-providers.js(Groq 모델·limits), src/preload.js(aiUsage),
src/renderer/renderer.js(오늘 사용량·한도 경고 토스트), src/renderer/index.html·style.css.

검증(실측): 실제 메일로 ① 번역/분석 3.0s ② 답장 초안 0.7s ③ 대화 질의 1.8s(근거 6건) ④ 업무일지 2.8s(17자→202자 복구) —
전부 한국어 정상. 키 라운드로빈 1→2→3. 전체 연결 테스트 **Groq 5키 200 / Cerebras 7키 402**.
한도 근접 전환: 4회째 100% 도달 → 5회째 자동으로 2순위 호출(1순위 서버 호출 4, 2순위 2).
마스터 설정 파일에 1순위 groq(키5)·2순위 cerebras(키7) 기록 확인. 설치본 2026-08-20 10:33:26 · verify:install PASS ·
셀프체크 9종 PASS · 고아 ERROR 0.

미해결: 마스터 육안 확인·커밋 대기. Cerebras 는 402 지속(잔액 충전 시 2순위로 자동 복귀).

다음할일: 마스터 검수 → 커밋 여부 지시 대기.

## 2026-08-20 09:40 — AI 제공자 다중화·자동 폴백 + 402 친절 안내 + 대화창 메인 배치 + EPIPE 수정
핵심결정:
- **Cerebras 무료 티어가 막혔다**(키 7개 전부 HTTP 402 quota, /models 는 200). 코드 문제 아님 →
  **제공자를 여러 개 등록하고 순위대로 자동 폴백**하는 구조로 전환. 신규 `src/ai-providers.js`(프리셋 9종·체인 정규화),
  `src/ai-errors.js`(실패 → 사람이 읽는 문구, raw JSON 노출 금지). `cerebras.js` 는 제공자 중립 클라이언트로 일반화
  (파일명 유지, `setChain`/`chatOnce`/`chat` 체인 래퍼). 402·401·403·5xx·네트워크는 다음 제공자로 전환,
  **429는 전환하지 않고 키 백오프 유지**(실측 확인).
- 프리셋 실측 정정: openrouter 기본 모델을 `z-ai/glm-5.2:free` 로(구 meta-llama/llama-3.3-70b-instruct:free 는 실재하지 않음),
  gemini `gemini-3-flash`. 로컬 **Ollama 를 목록 1순위·권장**으로(메일이 PC 밖으로 나가지 않음). gemini/openrouter 무료 등급은
  "학습에 쓰일 수 있음" 경고 표기. cloudflare 는 계정 ID 입력칸 제공.
- 대화창을 주 작업 화면으로: 패널 기본 460px + 드래그 조절·폭 기억, [메인에 크게] 도킹 토글(기억),
  진입 버튼 강조 + Ctrl+/ 배지, 안내 접기.
- **EPIPE 오류창** 원인은 닫힌 stdout 파이프에 console.log → uncaught. 스트림 error 흡수 + console 안전 래퍼 +
  uncaughtException 에서 EPIPE 무시로 근본 차단.

산출물: src/ai-providers.js·src/ai-errors.js(신규), src/cerebras.js(제공자 중립+체인), src/main.js(EPIPE 방어·체인 설정·
ai:status/ai:providers/ai:models/ai:chainTest), src/preload.js, src/renderer/renderer.js(제공자 체인 UI·오류 카드·상태 배지·
토스트·패널 폭/도킹), src/renderer/index.html(제공자 카드·토스트), src/renderer/style.css(.chain-*/.ai-*).

검증(실측): 402 문구·[설정 열기]·상태 배지 / 목 서버로 1순위 402 → 2순위 전환 성공(switched=true, 2순위 호출 1회) ·
쿨다운 후 1순위 건너뜀 · 429 전환 안 함 / 전체 연결 테스트 표(제공자·키·상태·응답시간) / 프리셋 전환 시 키 보존 /
EPIPE 100회 호출에도 예외 0 / selfcheck 9종 PASS · 고아 ERROR 0 · 대비 14쌍 통과 / 설치본 2026-08-20 09:34 + verify:install PASS.

미해결: 마스터 육안 확인·커밋 대기 / Groq·Gemini·NVIDIA·OpenRouter 실 키가 없어 실호출 검증 미실시(키 받으면 즉시 가능).

다음할일: 마스터 검수 → 키 제공 시 실호출 검증 → 커밋 여부 지시 대기.

## 2026-08-14 19:05 — 무인 설치 근본 해결 + 대화로 첨부 정리(액션 실행) 신규
핵심결정:
- **NSIS 설치가 멈추던 진짜 원인 = 실행 중인 앱 + 대화형 실행**. oneClick 이어도 앱이 떠 있으면
  프롬프트가 뜨고 무인 세션에서는 영원히 대기한다. → `scripts/install-silent.mjs`(정상 종료 → `/S` → 재기동)
  + `npm run install:app` / `npm run dist:install` 로 고정. 실측 설치 7.5~9.2초, ExitCode 0.
- **"대화로 첨부 정리"** 신규: 새 검색기·새 첨부엔진을 만들지 않고 기존 것을 재사용한다 —
  검색조건은 main.js `parseSearchQuery`, 진짜첨부 판정은 `attach-classify`, 추출은 `outlook.saveAttachmentsBatch`.
  신규는 `src/attach-organize.js` 하나(의도파싱·경로안전·구조계산·복사엔진)뿐.
- 안전 설계: **[실행] 누르기 전 파일 기록 0**(계획은 첨부 '속성'만 읽음) · 복사만(삭제·이동 없음) ·
  덮어쓰기 금지(-1/-2) · 같은 이름+같은 크기는 건너뜀(멱등) · destRoot 밖 쓰기 차단 ·
  시스템 폴더/드라이브 루트/앱 내부 폴더 차단 · 실행 이력 `userData\organize-history.json`.

산출물: src/attach-organize.js(신규), src/main.js(IPC organize:plan/run/history + 헬퍼),
src/preload.js(4종 브리지), src/renderer/renderer.js(계획 카드·실행/취소·진행률·이력),
src/renderer/style.css(.org-* 16규칙), scripts/install-silent.mjs(신규), scripts/selfcheck.mjs·package.json 갱신.

검증(실측): 설치 후 Bmail.exe/app.asar 2026-08-14 19:00 · verify:install PASS · asar 안에 parseOrganizeIntent/organize:run 포함 /
main.js 실제 핸들러 추출 실행 = 계획 13메일·15첨부·67.2MB(2.5초) → 실행 15개 저장 → 재실행 0개(건너뜀 15) /
UI 하네스 9/9(카드·취소 시 파일 0·후속수정 재확인·실행 1회·폴더열기·일반질문 오인 0·시스템경로 차단·이력·대비 9쌍 4.5:1↑) /
셀프체크 7종 PASS · 고아 ERROR 0(WARN 1 기존 todo-reading-pane) · 전역 대화 패널 회귀 5뷰 OK.

미해결: 마스터 육안 확인 대기 · 커밋 미실행(검수 대기) · 정리 결과 폴더 구조는 실행마다 누적(구조를 바꿔
재실행하면 같은 파일이 다른 레이아웃으로 한 벌 더 생긴다 — 의도된 동작이나 안내 문구 보강 여지 있음).

다음할일: 마스터 검수 → 커밋 여부 지시 대기.

## 2026-08-04 17:36 — 폴더 트리 계층 렌더 + 시작 시 증분 동기화 결함(치명) 해결
핵심결정:
- **증분 동기화가 구조적으로 0건이었다**: DASL(`urn:schemas:httpmail:datereceived`)은 UTC 로 비교되는데
  `daslDate()`가 로컬시각(KST) 문자열을 넣어 기준선이 9시간 미래 → 최근 9시간 메일이 항상 제외.
  UTC 출력으로 수정(공유 함수 1곳). 실측: 같은 조회 0건 → 2건. 설치본 재기동 후 3.2초 만에 4건 반영.
  시작·수동 확인은 72시간 따라잡기 창 + limit 300, `isNew` 는 upsert 전에 판정.
- **폴더 트리가 평면으로 보인 진짜 원인은 CSS 특이도**: `button:not()×6`(0,6,1)이 `.tree-item`(0,1,0)을 눌러
  padding 8px 14px 강제 → 행 35px, 들여쓰기 13px 가 묻힘. `button:where(:not(...))`로 0,0,1 로 낮춤.
  같은 원인으로 부풀었던 필터 탭·상태 칩도 정상 크기 복원(191개 버튼 스냅샷: 139 동일/52 축소/0 확대).
- 폴더 순서 정본은 **PR_SORT_POSITION(sortPos) 1곳**으로 통일(DB 사전계산 ord·applyOutlookSortPositions 삭제).
- 트리는 캐시(userData\folder-tree-cache.json) 즉시 렌더 → 라이브(COM 9.4초) 교체. 첫 그림 515ms.
- 사이드바 3구역(즐겨찾기 / 계정 폴더 / 기타)으로 통합, '내 계정' 중복 섹션 제거.

산출물: src/outlook.js(daslDate UTC), src/main.js(트리 캐시·숨김폴더 필터·따라잡기 창·로그),
src/sync.js(isNew 사전판정), src/db.js(순서 정본 정리), src/renderer/renderer.js(계층 트리 렌더·토글·상태줄),
src/renderer/index.html(사이드바 3구역), src/renderer/style.css(특이도·트리·반응형).
검증: 렌더 DOM 덤프 43/43 PASS · 반응형 4폭 겹침·꺾임 0 · 대비 15쌍 PASS · selfcheck 5종 · 고아 ERROR 0 · verify:install PASS.

미해결: 마스터 육안 확인 대기 · 커밋 미실행(검수 대기) · WARN 1건(todo-reading-pane id 미참조).

다음할일: 마스터 검수 → 커밋 여부 지시 대기.

## 2026-07-30 — Bmail 1.0 완성 (대규모 기능 배치 전체 완료)
핵심결정:
- 앱명 Bmail 확정(구 bonglook/BONGMAIL), 설치본 전환 완료 — release\Bmail-Setup-1.0.0.exe (91.6MB, 11:14판) 설치됨. userData는 %APPDATA%\outlook-ai-assistant 고정(데이터 연속성 보장).
- Cerebras 키 7개 소스 기본값 고정(로컬 전용 승인, 배포 시 제거 주석 있음). 키별 독립 쿼터 실측 — 평시 라운드로빈 + 대량분석 3동시(3.94배).
- Outlook 원본 보호 원칙: Send()/Delete()/폴더변경 COM 쓰기 0건. 모든 폴더/삭제/분류는 로컬 가상 계층.

산출물: 전 기능 목록은 이 커밋 시점 소스 참조. 주요: 전 폴더 동기화 23,700건(특수폴더+아카이브 PST), 폴더트리 1:1(순서만 13/24 — COM이 사용자 순서 미노출, 우클릭 수동 조정 영속), 3분 실시간 폴링(하위폴더 재귀), 자연어 전역검색(Ctrl+E), AI 분석 패널(한국어 번역 생략 3중 방어), 답장/새메일 Outlook COM 창(서명 자동), 일일브리핑/업무일지(mapReduce 429 방어), 회신대기 3일+ 뷰(2분할), To/CC 구분(10/10 대조), 보낸메일 프로젝트 트리(기타 16.5%), 주소록 653건(그룹 7), 고아 스캔 상주(scan-orphans.mjs, prebuild 가드).

미해결: ① 폴더 표시 순서 완전 재현 불가(COM 한계, 수동 보정으로 대체) ② 커밋 미실행 — 마스터 검수 대기(변경 대규모, "커밋해" 지시 시 일괄).

다음할일: 마스터 검수 → 커밋 → (차기 후보) 지운편지함 수집 옵션, 캘린더/규칙, SGW 배포판(키 제거 빌드).
