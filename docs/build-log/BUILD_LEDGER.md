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
2026-11-20 | 푸시 | 보류 | 대상 github.com/byjay/bonglook = 공개(private:false), 원격에 무관한 기존 프로젝트(Vite Outlook add-in, .github Pages 배포, 2026-01-27) 존재 — 이력 불일치라 강제푸시 필요, 이력에 실명·회사명·라이선스키 포함 → 푸시 안 함 | 지휘자 확인(GitHub API 무인증 200)
2026-11-20 | 테스트(Red) | 의도된 실패 | test-outlook-readonly --oracle EXIT 1, FAIL 49: 가드 export 없음 + 둥근 따옴표(U+2019) 데이터가 PowerShell 파서상 코드로 탈출(getSignature·probeAttachments 등, 파싱 오류 없이 .Delete 인식) | E:/tmp/comguard/red.txt
2026-11-20 | 테스트(Green) | 성공 | test-outlook-readonly --oracle EXIT 0, PASS 708/FAIL 0, 실제 스크립트 29개(호출부 28곳), 파서 대조 4580건(퍼즈 4000, 금지 멤버 탐지 197건 전부 일치) | E:/tmp/comguard/green3.txt
2026-11-20 | 뮤테이션 | 성공 | mutate.cjs 41건 전부 KILLED(가드 호출 제거 FAIL 157, 금지 항목 13개·패턴 8개 각각 제거 FAIL), 복구 sha 일치, 원복 EXIT 0 | E:/tmp/comguard/mutate.txt
2026-11-20 | TLC | 성공 | formal/outlook_readonly.tla MC_ro EXIT 0, 1297 generated/324 distinct (스크립트 4개 경계); bug_nogate·bug_falsesuccess·bug_classifier·bug_overblock·sanity_spawn·sanity_refuse 전부 EXIT 12 | E:/tmp/comguard/tlc/
2026-11-20 | selfcheck·키·고아 | 성공 | selfcheck EXIT 0([22] 가드 704/0), 키 패턴 grep 0줄, scan-orphans --guard EXIT 1 = 기존 syncControlTower 1건뿐(신규 0) | E:/tmp/comguard/selfcheck.txt
2026-11-20 | 푸시 | 성공 | origin=github.com/byjay/bonglook 브랜치 bmail = 20d5778(34+1 커밋), main 미변경·Pages 배포 미발생(deploy.yml 은 main 만), 마스터 지시 「그냥해」로 공개 저장소 푸시 | git ls-remote
