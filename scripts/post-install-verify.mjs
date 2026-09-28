#!/usr/bin/env node
// ============================================================
//  post-install-verify.mjs — 설치 직후 무결성 점검 + 바로가기 자동 복구
//  ------------------------------------------------------------
//  왜 필요한가 (마스터 실사용 사고)
//   NSIS oneClick 재설치는 기존 바로가기를 '지웠다가 다시 만드는' 구간이 있다.
//   그 몇 초 사이에 시작메뉴/바탕화면 아이콘을 누르면
//   "Bmail.lnk을(를) 찾을 수 없습니다" 오류가 난다.
//   → 설치가 끝날 때마다 이 스크립트로 lnk 존재·대상 경로를 확인하고,
//     없거나 대상이 비어 있으면 즉시 다시 만든다.
//
//  사용: node scripts/post-install-verify.mjs [--fix]
//        --fix : 문제를 발견하면 바로가기를 재생성한다(기본은 점검만)
//  종료코드: 0 정상 / 1 문제 있음(--fix 로 못 고친 경우)
// ============================================================
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { DEFAULT_INSTALL_DIR, junctionTarget, samePath } from './install-dir.mjs';

const FIX = process.argv.includes('--fix');
const APP_NAME = 'Bmail';
const INSTALL_DIR = DEFAULT_INSTALL_DIR;
const EXE = join(INSTALL_DIR, `${APP_NAME}.exe`);
// 기본 경로가 정션이면(설치본 이전 PC) NSIS 는 바로가기를 실제 폴더 경로로 만든다 → 둘 다 정상.
const REAL_EXE = join(junctionTarget(INSTALL_DIR) || INSTALL_DIR, `${APP_NAME}.exe`);
const DESKTOP_LNK = join(homedir(), 'Desktop', `${APP_NAME}.lnk`);
const START_LNK = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`);

let problems = 0;
const ok = (m) => console.log('  PASS ' + m);
const bad = (m) => { problems++; console.log('  FAIL ' + m); };

function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true }).trim();
}

// 바로가기가 가리키는 실제 대상 경로를 읽는다
function lnkTarget(lnkPath) {
  if (!existsSync(lnkPath)) return null;
  try {
    return ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}'); $s.TargetPath`);
  } catch { return null; }
}

// 바로가기를 만든다(덮어쓰기). 삭제 후 생성이 아니라 그 자리에서 덮어쓴다.
function makeLnk(lnkPath, target) {
  ps([
    `$w = New-Object -ComObject WScript.Shell`,
    `$s = $w.CreateShortcut('${lnkPath.replace(/'/g, "''")}')`,
    `$s.TargetPath = '${target.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory = '${dirname(target).replace(/'/g, "''")}'`,
    `$s.IconLocation = '${target.replace(/'/g, "''")}, 0'`,
    `$s.Description = 'Bmail - 메일 검색·요약·번역·답장 초안'`,
    `$s.Save()`
  ].join('; '));
}

console.log('=== 설치본 점검 ===');
if (!existsSync(EXE)) {
  bad(`설치본이 없다: ${EXE}`);
  console.log('\n설치가 완료되지 않았습니다. 설치 프로그램을 먼저 실행하세요.');
  process.exit(1);
}
const st = statSync(EXE);
ok(`실행 파일 ${EXE} (${(st.size / 1048576).toFixed(0)}MB · ${st.mtime.toLocaleString('ko-KR')})`);

const asar = join(INSTALL_DIR, 'resources', 'app.asar');
if (existsSync(asar)) {
  const a = statSync(asar);
  ok(`app.asar ${(a.size / 1048576).toFixed(0)}MB · ${a.mtime.toLocaleString('ko-KR')}`);
} else bad('app.asar 없음 — 설치가 손상됐다');

console.log('\n=== 바로가기 점검 (마스터 실사용 사고 방지) ===');
for (const [name, lnk] of [['바탕화면', DESKTOP_LNK], ['시작메뉴', START_LNK]]) {
  const target = lnkTarget(lnk);
  if (!existsSync(lnk)) {
    if (FIX) {
      try { makeLnk(lnk, REAL_EXE); ok(`${name} 바로가기 없음 → 새로 만들었다`); }
      catch (e) { bad(`${name} 바로가기 없음 · 생성 실패: ${e.message}`); }
    } else bad(`${name} 바로가기 없음 (${lnk}) — --fix 로 복구 가능`);
    continue;
  }
  if (!target || !existsSync(target)) {
    if (FIX) {
      try { makeLnk(lnk, REAL_EXE); ok(`${name} 바로가기 대상이 깨져 있어 고쳤다 (→ ${REAL_EXE})`); }
      catch (e) { bad(`${name} 대상 깨짐 · 복구 실패: ${e.message}`); }
    } else bad(`${name} 바로가기 대상이 없다: ${target || '(빈 값)'} — --fix 로 복구 가능`);
    continue;
  }
  if (!samePath(target, EXE) && !samePath(target, REAL_EXE)) {
    if (FIX) {
      try { makeLnk(lnk, REAL_EXE); ok(`${name} 바로가기가 엉뚱한 곳을 가리켜 고쳤다`); }
      catch (e) { bad(`${name} 대상 불일치 · 복구 실패: ${e.message}`); }
    } else bad(`${name} 대상 불일치: ${target}`);
    continue;
  }
  ok(`${name} 바로가기 정상 → ${target}`);
}

console.log('\n=== 사용자 데이터 보존 점검 ===');
const dbPath = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
  'outlook-ai-assistant', 'data', 'mailstore.db');
if (existsSync(dbPath)) {
  const d = statSync(dbPath);
  ok(`메일 DB 유지 ${(d.size / 1048576).toFixed(0)}MB (재설치가 데이터를 지우지 않았다)`);
} else bad('메일 DB가 없다 — 데이터 연속성 문제');

console.log(problems ? `\n문제 ${problems}건${FIX ? '' : ' — `npm run verify:install` 로 자동 복구를 시도하라'}`
  : '\n설치·바로가기·데이터 모두 정상');
process.exit(problems ? 1 : 0);
