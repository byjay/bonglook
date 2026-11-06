# BUILD_LEDGER — Bmail (전역 CLAUDE.md §1-F)

> 빌드·테스트·배포·푸시·실패를 그때마다 맨 아래에 추가한다. 측정값만, 기존 줄 수정 금지.
> 형식: `날짜 | 종류 | 결과 | 값 | 근거`

2026-10-06 | 빌드·설치 | 성공 | EXIT 0, install-silent EXIT 0, post-install-verify EXIT 0, 2회 | c8d4c80 기준, 에이전트 보고(소급 기록)
2026-10-06 | 실다운로드 | 성공 | 16,359,892B PDF 헤더 확인, E:\Bmail\링크다운로드 | 지휘자 직접 확인
2026-10-08 | 빌드 | 성공 | EXIT 0, Setup 96,080,682B, app.asar 87,942,610B, HEAD a66d953, 설치 안 함 | 지휘자 직접 확인
2026-11-06 | 푸시 | 불가 | `git remote -v` 출력 없음 — **원격 저장소 없음**, 커밋 32개 전부 로컬에만 있음 | 마스터 보고함, 저장소 생성은 마스터 결정 대기
2026-11-06 | 테스트 | 실패(Red) | scripts/test-config-keys.cjs EXIT 1, PASS 7·FAIL 20 — 수정 전 재현 | E:\tmp\red.txt
2026-11-06 | 테스트 | 성공(Green) | test-config-keys EXIT 0, PASS 27·FAIL 0, 핸들러 121개 전수 호출, selfcheck EXIT 0 | E:\tmp\cfgkeys\self.txt
2026-11-06 | 뮤테이션 | 성공 | 9건 전부 mutated EXIT 1 → restored EXIT 0 | E:\tmp\cfgkeys\mut.txt
2026-11-06 | TLC | 성공 | MC EXIT 0, 671,555 generated·7,427 distinct / MC_k2 EXIT 0, 18,835·643 (제공자 2, 키 3·2, 저장 3회) | E:\tmp\cfgkeys\tlc\
2026-11-06 | TLC | 의도된 실패 | bug_last4·bug_stale·bug_blank·bug_token·bug_leak·sanity_del·sanity_add 전부 EXIT 12 | E:\tmp\cfgkeys\tlc\
2026-11-06 | E2E | 성공 | offscreen 실렌더+실 electron-store 21개 항목 PASS, EXIT 0, 테스트 config 사용 | E:\tmp\cfgkeys\e2e-result.txt
2026-11-06 | 실 config 대조 | 성공 | 메모리 sanitize: 키 패턴 26→0, 고유 키 14개 원문 0, 왕복 동일, 파일 무변경 | E:\tmp\cfgkeys\real.txt
2026-11-06 | 고아 스캔 | 실패 | 작업 트리 scan-orphans --guard EXIT 1, ERROR 1건 = preload API 고아, 타 세션(10-21) 미커밋 코드, prebuild 가드가 막힘 | E:\tmp\cfgkeys\orph.txt
2026-11-06 | 고아 스캔 | 성공 | 이 커밋만 내보낸 트리 scan-orphans --guard EXIT 0, ERROR 0·WARN 1(todo-reading-pane), 키 테스트 EXIT 0, 27/27 | E:\tmp\cfgkeys\orph-head.txt
