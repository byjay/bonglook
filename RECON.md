# RECON — 조사 착지 원장 (1줄씩, 발주 전 grep)

[답장초안 TypeError] → rpq()=본문영역 조회, revealAiBox()=우측 AI칸 반환 → 버튼 null (renderer.js:5301 rpq, :5756 revealAiBox, :6267/:6271 호출) — 수정완료(aiBoxEl/aiq 공유헬퍼, box.querySelector 통일), selfcheck 회귀테스트 뮤테이션증명 완료 2026-09-28
[OpenRouter 키] → 유효, is_free_tier=false(2026-09-28 재조회 — 이전 기록 true 는 구값), usage≈$0.002, free_model_daily_requests.limit=1000/일(실측, "50회" 추정 정정) (/api/v1/key)
[OpenRouter 모델] → 전체 458 / 무료(:free) 17(2026-09-28 재조회, 목록 변동)
[OpenRouter 무료모델 실측비교] → 한국어요약+JSON구조화 실호출(2026-09-28): 1위 nvidia/nemotron-3-ultra-550b-a55b:free(품질+안정) 2위 nvidia/nemotron-3-super-120b-a12b:free(최속 78ms) 3위 cohere/north-mini-code:free. 제외: gemma-4-31b/26b·qwen3.8-27b(업스트림 429 상시) · nemotron-3.5-lightning(사고과정 유출로 JSON파싱 실패) · liquid/lfm·poolside·dots-studio(빈응답/429/JSON실패)
[OpenRouter models[] 배열] → 실측: 최대 3개까지만 허용(4개째부터 400 "must have 3 items or fewer"). 1순위 실패(429)해도 서버가 자동으로 다음 모델로 전환함을 실호출로 확인(model used 필드 변화)
[OpenRouter provider.max_price] → {prompt:0,completion:0} 라우팅 파라미터 실측 수용됨(200 OK) — 무료원천 보장 추가 방어로 채택
[openrouter/free 라우터] → nvidia/nemotron-3.5-content-safety:free 선택, 빈 응답 — 요약용 부적합, 기본 체인 제외
[Groq] → 키 5개 HTTP 200, 무료 TPM 8,000 (큰 프롬프트 413)
[Cerebras] → 유료 전환(2026-08-17), 잔액 $0 → 402 — 2026-09-28 마스터 지시로 aiChain 에서 제거(키는 apiKeysByProvider.cerebras 에 보존, 삭제 아님)
[node] → PATH 없음, electron.exe(ELECTRON_RUN_AS_NODE=1) v20.18.0 로 대체. 단 electron-builder(빌드)는 이 방식으로 돌리면 argv 슬라이스 어긋남+app-builder.exe STATUS_DLL_INIT_FAILED → plain node(fnm v20.17.0, PATH 등록)로 실행해야 함(2026-09-28 실측)
[키 하드코딩] → src/main.js DEFAULT_AI_CHAIN·store defaults 에 Groq5+Cerebras7 키 박혀있었음 → 2026-09-28 전부 제거(빈 배열), grep 0건 확인. 라이브 config(outlook-ai-config.json)엔 이미 실키 보존돼 있어 유실 없음
[OpenRouter 키 저장위치] → userData/outlook-ai-config.json 의 apiKeysByProvider.openrouter 1곳(SoT) — Jev 어댑터(다음 발주)도 같은 키 재사용 가능
[Jev] → typesafe/jev-1.13, POST https://openrouter.ai/api/alpha/decisions, :free 아님(과금) — freeOnly 가드는 /chat/completions 경로(cerebras.chatOnce)에만 적용되므로 Jev 를 막지 않음(설계상 분리, 이번 세션은 Jev 어댑터 미작성)
[OpenRouter 잔액] → 지휘자 실측(2026-09-28): 크레딧 0·누적사용 있어 잔액 음수(~-$0.0005) 가능성 — 이 세션 실호출(분석·초안·폴백테스트 등 10여회)에서는 402/negative balance 재현 안 됨, 재현 시 기존 quota kind 폴백 경로로 처리됨(신규코드 아님)
