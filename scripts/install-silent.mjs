#!/usr/bin/env node
// ============================================================
//  install-silent.mjs — 설치본 무인(silent) 설치
//  ------------------------------------------------------------
//  왜 필요한가 (2026-08-14 사고)
//   release\Bmail-Setup-1.0.0.exe 를 그냥 실행하면 NSIS 가
//   "Bmail 이 실행 중입니다" 프롬프트를 띄우고 무한 대기한다.
//   (자동화 세션에서는 그 창을 누를 사람이 없어 설치가 영원히 안 끝난다)
//   → 항상 ① 실행 중인 앱을 정상 종료하고 ② NSIS 무인 스위치 /S 로 설치한다.
//
//  사용: node scripts/install-silent.mjs [--no-relaunch] [--dir=<설치폴더>]
//  종료코드: 0 성공 / 1 실패
//
//  ★ 2026-09-29 설치 위치 이전(정션) 대응
//   기본 설치 경로(%LOCALAPPDATA%\Programs\outlook-ai-assistant)를 다른 드라이브로 옮기고
//   그 자리에 NTFS 정션을 두면, NSIS 가 구버전 제거 시 정션을 지우고 기본 경로에 실제 폴더를
//   새로 만들어 설치한다(실측: 정션 소멸 + 원래 드라이브에 350MB 재생성).
//   → 설치 폴더 = ① --dir= ② 환경변수 BMAIL_INSTALL_DIR ③ 기본 경로가 정션이면 그 대상.
//     지정되면 NSIS 에 /D=<폴더> 로 넘기고, 설치 후 기본 경로를 그 폴더로 향하는 정션으로 복구한다
//     (바로가기·verify 스크립트의 기본 경로 호환). 아무것도 없으면 기존 동작(기본 경로) 그대로.
// ============================================================
import { existsSync, statSync, readdirSync, rmdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { DEFAULT_INSTALL_DIR as DEFAULT_DIR, junctionTarget, samePath } from './install-dir.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(ROOT, 'release', 'Bmail-Setup-1.0.0.exe');
const RELAUNCH = !process.argv.includes('--no-relaunch');

const argDir = (process.argv.find((a) => a.startsWith('--dir=')) || '').slice('--dir='.length);
const TARGET_DIR = (argDir || process.env.BMAIL_INSTALL_DIR || junctionTarget(DEFAULT_DIR) || '').trim() || null;
const RELOCATED = !!TARGET_DIR && !samePath(TARGET_DIR, DEFAULT_DIR);
const INSTALL_DIR = RELOCATED ? resolve(TARGET_DIR) : DEFAULT_DIR;
const EXE = join(INSTALL_DIR, 'Bmail.exe');

const ps = (script) => execFileSync('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-Command', script],
  { encoding: 'utf8', windowsHide: true }).trim();

const mtime = (p) => (existsSync(p) ? statSync(p).mtime.toLocaleString('ko-KR') : '(없음)');

if (!existsSync(SETUP)) {
  console.error(`설치 파일이 없다: ${SETUP}\n먼저 npm run dist 를 실행하라.`);
  process.exit(1);
}

console.log('=== 1) 실행 중인 Bmail 정상 종료 ===');
// CloseMainWindow() 로 창을 정상적으로 닫는다(강제 종료는 그래도 안 죽을 때만).
// 2026-09-29: 기동 직후 동기화 중에는 10초 안에 안 닫혀 강제 종료된 실측 → 대기 30초로 늘림(DB 보호).
const wasRunning = ps(`
  $p = Get-Process Bmail -ErrorAction SilentlyContinue
  if (-not $p) { 'none'; exit }
  $n = @($p).Count
  $win = 0
  foreach ($x in $p) { try { if ($x.CloseMainWindow()) { $win++ } } catch {} }
  for ($i=0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process Bmail -ErrorAction SilentlyContinue)) { break }
  }
  $left = Get-Process Bmail -ErrorAction SilentlyContinue
  if ($left) { $ids = ($left | % Id) -join ','; $left | Stop-Process -Force; Start-Sleep -Seconds 2; "killed:$n (창닫기 요청 성공 $win · 30초 후 잔존 $ids)" } else { "closed:$n" }
`);
console.log(`  ${wasRunning === 'none' ? '실행 중 아님' : wasRunning}`);

// NSIS 규칙: /D= 는 반드시 마지막 인자, 따옴표 없이(공백 포함 경로도 그대로).
const SETUP_ARGS = RELOCATED ? `/S /D=${INSTALL_DIR}` : '/S';
console.log('=== 2) 무인 설치 (/S) ===');
console.log(`  설치 폴더: ${INSTALL_DIR}${RELOCATED ? ` (이전됨 · 기본 경로 ${DEFAULT_DIR} 는 정션으로 유지)` : ''}`);
console.log(`  설치 전 Bmail.exe: ${mtime(EXE)}`);
//  ★ 2026-08-25 사고: 앱을 방금 닫아도 exe/DLL 파일 잠금이 즉시 풀리지 않을 때가 있고
//    (백신 스캔·핸들 반환 지연), 이 상태에서 NSIS 가 "Failed to uninstall old application
//    files" 오류를 내면 electron-builder 기본 NSIS 스크립트는 /S 무인 모드에서도 그 특정
//    MessageBox를 억제하지 않아 마스터 화면에 그대로 뜬다(실측: ExitCode 2/1 로 스크립트는
//    이미 실패 처리했는데도 설치 프로그램 프로세스/대화상자가 화면에 남아 있었다).
//    → ① 고정 sleep 대신 exe 파일이 실제로 잠금 해제됐는지 폴링으로 확인하고 시작한다.
//      ② 재시도 횟수를 늘리고 매 시도 사이·최종 실패 시 Bmail-Setup*.exe 잔여 프로세스를
//         강제 종료해 대화상자가 화면에 남지 않게 한다(무인 규율 — GUI 노출 절대 금지).
const waitUnlocked = (path, timeoutMs) => {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const locked = ps(`
      if (-not (Test-Path '${path}')) { 'free'; exit }
      try {
        $fs = [System.IO.File]::Open('${path}', 'Open', 'ReadWrite', 'None')
        $fs.Close(); 'free'
      } catch { 'locked' }
    `);
    if (locked === 'free') return true;
    ps('Start-Sleep -Milliseconds 500');
  }
  return false;
};
const killSetupStray = () => {
  ps(`Get-Process 'Bmail-Setup*' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`);
};
const runSetup = () => {
  const t = Date.now();
  //  -Wait 로 잡히지 않는 UAC 재실행 자식 프로세스까지 대비해, 종료 후에도
  //  동일 이름 프로세스가 남아 있으면 화면에 뜬 대화상자로 간주하고 강제 종료한다.
  const c = Number(ps(`
    $p = Start-Process -FilePath '${SETUP}' -ArgumentList '${SETUP_ARGS}' -PassThru -Wait
    Start-Sleep -Milliseconds 500
    $stray = Get-Process 'Bmail-Setup*' -ErrorAction SilentlyContinue
    if ($stray) { $stray | Stop-Process -Force -ErrorAction SilentlyContinue }
    $p.ExitCode
  `));
  return { code: c, secs: ((Date.now() - t) / 1000).toFixed(1) };
};
if (wasRunning !== 'none') {
  console.log('  파일 잠금 해제를 폴링으로 확인 (최대 15초)');
  const unlocked = waitUnlocked(EXE, 15000);
  console.log(`  ${unlocked ? '잠금 해제 확인됨' : '15초 내 잠금 해제 미확인 → 그래도 진행'}`);
}
let { code, secs } = runSetup();
console.log(`  ExitCode=${code} · ${secs}s`);
const RETRY_WAITS = [8000, 15000];
for (let i = 0; code !== 0 && i < RETRY_WAITS.length; i++) {
  console.log(`  설치 실패 → ${RETRY_WAITS[i] / 1000}초 대기 후 재시도(${i + 1}/${RETRY_WAITS.length})`);
  killSetupStray();                 // 재시도 전 잔여 설치 프로세스/대화상자 정리
  ps(`Start-Sleep -Milliseconds ${RETRY_WAITS[i]}`);
  ({ code, secs } = runSetup());
  console.log(`  재시도 ExitCode=${code} · ${secs}s`);
}

if (code !== 0) {
  killSetupStray();                 // ★ 최종 실패 — 대화상자가 화면에 남지 않도록 반드시 정리
  console.error('설치 실패(ExitCode≠0) — 잔여 설치 프로세스 정리 완료, 로그로만 보고한다.');
  process.exit(1);
}

console.log('=== 3) 결과 ===');
console.log(`  설치 후 Bmail.exe: ${mtime(EXE)}`);
console.log(`  설치 후 app.asar : ${mtime(join(INSTALL_DIR, 'resources', 'app.asar'))}`);

if (RELOCATED) {
  console.log('=== 3-b) 기본 경로 정션 확인·복구 ===');
  const same = (t) => samePath(t, INSTALL_DIR);
  let cur = junctionTarget(DEFAULT_DIR);
  if (!cur && existsSync(DEFAULT_DIR) && readdirSync(DEFAULT_DIR).length === 0) {
    // 구버전 제거기가 파일만 지우고 빈 폴더를 남긴다(2026-09-29 실측) — 빈 폴더만 비재귀로 지운다
    rmdirSync(DEFAULT_DIR);
    console.log(`  빈 기본 폴더 제거: ${DEFAULT_DIR}`);
  }
  if (same(cur)) {
    console.log(`  정션 유지됨: ${DEFAULT_DIR} -> ${cur}`);
  } else if (cur || existsSync(DEFAULT_DIR)) {
    // 다른 곳을 가리키는 정션이거나 내용 있는 실제 폴더 — 자동 삭제하지 않는다(데이터 보호). 실패로 보고.
    console.error(`  기본 경로에 ${cur ? `다른 정션(-> ${cur})` : '내용 있는 실제 폴더'}가 있다: ${DEFAULT_DIR} — 수동 확인 필요`);
    process.exit(1);
  } else {
    ps(`New-Item -ItemType Junction -Path '${DEFAULT_DIR}' -Target '${INSTALL_DIR}' | Out-Null`);
    const made = junctionTarget(DEFAULT_DIR);
    if (!same(made)) {
      console.error(`  정션 복구 실패: ${DEFAULT_DIR}`);
      process.exit(1);
    }
    console.log(`  정션 복구함: ${DEFAULT_DIR} -> ${made}`);
  }
}

if (RELAUNCH) {
  spawn(EXE, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  console.log('  앱 재기동 요청함');
}
console.log('\n무인 설치 완료 — 이어서 npm run verify:install 로 바로가기를 점검하라.');
