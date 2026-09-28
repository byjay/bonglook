# HANDOFF — Bmail (bonglook)

## 미완료 (2026-09-28 갱신 — 1~4 완료, 5~6 대기)
5. [ ] 첨부 내용 분석(PDF·XLSX·DOCX 텍스트 + 이미지는 무료 비전모델) — scout 정찰 후 별도 발주.
6. [ ] **Jev 판정 도입** — 백엔드 결정 완료(아래 참조: JevK5 로컬 자가호스팅). 대상: 처리상태 제안 ·
   주제 분류 · 회신필요(noul) · 광고판정(noul) · 의도 라우팅 보조. 한국어 20건+ LLM 대조 일치율 실측
   후에만 본적용. OpenRouter Jev API(`/api/alpha/decisions`, `typesafe/jev-1.13`)는 이번 세션의
   freeOnly 가드가 막지 않도록 경로가 이미 분리돼 있음을 확인(가드는 `cerebras.chatOnce`의
   `/chat/completions` 전용, Jev 경로는 별개) — 단 마스터가 (B) JevK5 로컬을 택했으므로 OpenRouter
   Jev API 자체는 안 쓴다(잔액 음수 방지). 키 저장 위치는 `apiKeysByProvider.openrouter` 1곳(SoT).

### 6번 세부 진행 (지휘자, 2026-09-28)
- [x] ③-a 설치·기동·한국어 사전판정 — 조건부 진행(한국어 원문 state 가 영어특징보다 우수, n=5)
- [x] ③-b **측정 전용**: Jev 어댑터(`src/jev.js`, 백엔드 교체형) + 온디맨드 서버 수명주기(`src/jev-server.js`, VRAM 확인·유휴 종료) + 4질문 × 24건 실측(`scripts/jev-measure.mjs`, §10-5 표). 앱 UI 연결 없음(고아 스캔 ERROR 0 확인).
- [x] ③-c 측정 통과 판정만 앱 연결 — **통과 0건, 앱 연결 없음**(아래 「기준선 비교」 참조).
- 🔴 설계 제약: 마스터는 CAD(AutoCAD·Navisworks·GstarCAD) 사용 → **JevK5 상시 구동 금지**. VRAM 5.6/6GB 점유 실측 → 기동 전 여유 VRAM 확인, 부족하면 CPU 또는 건너뜀. 마스터 기존 지시 「PC 메모리에 영향 없어야」 준수.

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
