# HANDOFF — Bmail (bonglook)

## 미완료 (2026-09-28 갱신 — 1~4 완료, 5~6 대기)
5. [ ] 첨부 내용 분석(PDF·XLSX·DOCX 텍스트 + 이미지는 무료 비전모델) — scout 정찰 후 별도 발주.
6. [ ] **Jev 판정 도입** — 백엔드 결정 완료(아래 참조: JevK5 로컬 자가호스팅). 대상: 처리상태 제안 ·
   주제 분류 · 회신필요(noul) · 광고판정(noul) · 의도 라우팅 보조. 한국어 20건+ LLM 대조 일치율 실측
   후에만 본적용. OpenRouter Jev API(`/api/alpha/decisions`, `typesafe/jev-1.13`)는 이번 세션의
   freeOnly 가드가 막지 않도록 경로가 이미 분리돼 있음을 확인(가드는 `cerebras.chatOnce`의
   `/chat/completions` 전용, Jev 경로는 별개) — 단 마스터가 (B) JevK5 로컬을 택했으므로 OpenRouter
   Jev API 자체는 안 쓴다(잔액 음수 방지). 키 저장 위치는 `apiKeysByProvider.openrouter` 1곳(SoT).

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
