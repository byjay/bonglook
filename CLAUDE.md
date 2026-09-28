# Bmail (bonglook) — Outlook 미러링 + AI 분석 데스크톱 메일 클라이언트

> 🚀 세션 시작 시 가장 먼저 읽을 것: `E:\code-project\ECOSYSTEM_START_GUIDE.md` → 이 파일 → `.claude/HANDOFF.md` → `RECON.md`(재조사 금지 원장) → `FILEMAP.md`(없으면 생성)

## 정체 카드
- 도메인: 사용자 PC의 **클래식 Outlook(COM)·PST 를 그대로 미러링**하고 AI 로 분석·요약·답장초안·일정/업무일지를 만드는 개인 메일 도구. 추후 회사(SEASTAR) 전체 배포 예정.
- 스택: Electron 31 + 바닐라 JS 렌더러 · better-sqlite3(FTS) · Outlook COM(PowerShell 스폰) · LLM(OpenAI 호환 체인) · **Jev(판정 전용)**
- 배포: 로컬 NSIS 설치본 `release\Bmail-Setup-1.0.0.exe` → `%LOCALAPPDATA%\Programs\outlook-ai-assistant\Bmail.exe` (CF 배포 없음)
- DB: `%APPDATA%\outlook-ai-assistant\data\mailstore.db` (userData 경로 **고정** — package name 변경 금지)
- 인증: 없음(로컬 Outlook 세션 사용). API 키는 **userData config 에만** 저장
- 진입 파일: `src/main.js`(IPC·수명주기) · `src/renderer/renderer.js`(UI) · `src/db.js` · `src/outlook.js`(COM) · `src/cerebras.js`(AI 호출 엔진, 제공자 중립) · `src/ai-providers.js` · `src/analyzer.js`
- 봉인 파일: 없음
- 절대 금지: 아래 Non-Negotiables

## ⛔ Non-Negotiables
1. **Outlook 원본 불변** — `Send()`·`Delete()`·`Save()`·폴더 생성/이동 COM 호출 금지. 발송은 항상 마스터가 Outlook 작성창에서 직접.
2. **LLM 은 무료 전용** — 채팅 경로는 `:free` 모델만(코드 차단). 유료 제공자(Cerebras 등) 체인 금지.
3. **Jev 는 판정 전용** — 아래 「Jev 판정 규율」 준수. 산문·코드·근거 설명·비가역 최종판단에 쓰지 않는다.
4. **API 키 소스 하드코딩 금지** — config 전용. 커밋 전 `grep -rE "csk-|gsk_|sk-or-" src/ scripts/` = 0.
5. **사용자별 미러링** — 계정·폴더·즐겨찾기·서명·규칙은 실행 PC 의 Outlook 에서 동적으로. 마스터 개인값 기본값 금지.
6. **UI 검증은 실제 렌더 캡처로** — DOM 좌표만으로 PASS 금지. 마스터가 PC 사용 중이면 포커스 뺏는 자동 조작 금지.
7. 대비 ≥ 4.5:1 · 고아 0(`scripts/scan-orphans.mjs`) · 셀프체크 통과(`scripts/selfcheck.mjs`).

## Jev 판정 규율 (전역 CLAUDE.md §1-B · 스킬 `jev-typed-decisions`)
- **대상(후보 고정·산문 불필요·대량 반복)**: 메일 처리상태 제안(todo/hold/done/fyi) · 주제/이벤트 분류(도면·승인·견적·회의·발주…) · 회신 필요 여부(noul) · 광고/뉴스레터 판정(noul) · 대화 의도 라우팅(규칙이 불확실할 때만 보조).
- **비대상**: 요약·분석·답장 초안(LLM) · 첨부 인라인 판정(MAPI 결정적) · To/CC(결정적).
- 임계값: `p≥0.90` 사용 / `0.70~0.90` 「추정」 표시 / `p<0.70` LLM 승격. 확률 버리고 라벨만 쓰기 금지.
- 기존 규칙이 확신한 건은 Jev 호출 안 함(보조). 폴백 없는 호출 금지, 실패는 「Jev 미적용」으로 기록(거짓 성공 금지).
- 한국어 표본 **20건 이상 LLM 대조 일치율 실측 전에 「대체했다」 금지**. 보고는 스킬 §10-5 표(판정건수·P·일치율·속도·비용·폴백률).

## 공통 작업 규율
- 호출부 전수 grep 후 공유 함수 1곳 수정 · 뮤테이션 증명(되돌리면 실패) · 증거 없는 PASS 금지.
- `git stash`/`checkout .`/`reset --hard`/`sed -i` 금지. 커밋은 `git commit -m ... -- <경로>` 경로 한정, push 는 지시 시에만.
- `node` 가 PATH 에 없으면 `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe` 로 대체.
- 재설치는 `scripts/install-silent.mjs`(앱 종료→잠금해제 대기→/S)로만.

## 메뉴 ↔ 파일 매핑
| 영역 | 파일 |
|---|---|
| 메일 목록·읽기창·폴더 트리·4열 그리드 | `src/renderer/renderer.js` · `index.html` · `style.css` |
| Outlook 수집(메일·폴더·즐겨찾기·규칙·연락처·서명) | `src/outlook.js` · `src/sync.js` |
| AI 분석·요약·초안·브리핑·업무일지 | `src/analyzer.js` · `src/cerebras.js` · `src/ai-providers.js` · `src/ai-errors.js` |
| 첨부 판정·정리·내보내기 | `src/attach-classify.js` · `src/attach-organize.js` · `src/attachments.js` · `src/exporter.js` |
| 대시보드·타임라인·보낸분류·일정 | `src/dashboard-agg.js` · `src/timeline-agg.js` · `src/sent-axis.js` · `src/schedules.js` |
| 처리상태·대용량첨부·정리스케줄러 | `src/action-state.js` · `src/bigmail.js` · `src/cleanup.js` |

## 진행 이력
→ `.claude/HANDOFF.md` 참조
