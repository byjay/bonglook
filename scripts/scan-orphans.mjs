#!/usr/bin/env node
// ============================================================
//  scan-orphans.mjs — Bmail 고아 전수 스캔
//  ------------------------------------------------------------
//  글로벌 규율(고아 컴포넌트 절대 금지)에 따라 "만들었지만 연결 안 된 것"을
//  전부 찾아낸다. 빌드 가드로도 쓸 수 있게 고아 발견 시 exit 1.
//
//  검사 항목
//   1) 모듈 고아      : src/*.js 중 아무 데서도 require 되지 않는 파일
//   2) IPC 채널 정합  : ipcMain.handle ↔ preload invoke (양방향 고아)
//   3) preload API    : contextBridge 노출 API 중 렌더러 미사용
//   4) DOM ID         : index.html id ↔ renderer.js 참조 (양방향)
//   5) 렌더러 함수    : 정의했지만 아무도 호출하지 않는 함수
//   6) db exports     : db.js 내보내기 중 사용처 없는 것
//   7) CSS 클래스     : style.css 정의 중 HTML/JS 어디에도 없는 것
//
//  사용: node scripts/scan-orphans.mjs [--guard]
//        --guard : 고아가 있으면 종료코드 1 (CI/빌드 차단용)
// ============================================================
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const REND = join(SRC, 'renderer');
const GUARD = process.argv.includes('--guard');

const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const uniq = (a) => [...new Set(a)];
const matchAll = (s, re) => [...s.matchAll(re)].map(m => m[1]).filter(Boolean);

// ---------- 파일 로드 ----------
const srcFiles = readdirSync(SRC).filter(f => f.endsWith('.js'));
const rendFiles = existsSync(REND) ? readdirSync(REND).filter(f => f.endsWith('.js')) : [];
const F = {
  main: read(join(SRC, 'main.js')),
  preload: read(join(SRC, 'preload.js')),
  db: read(join(SRC, 'db.js')),
  renderer: read(join(REND, 'renderer.js')),
  html: read(join(REND, 'index.html')),
  css: read(join(REND, 'style.css'))
};
const mainSrcAll = srcFiles.map(f => read(join(SRC, f))).join('\n');
const ALL_JS = [...srcFiles.map(f => read(join(SRC, f))), ...rendFiles.map(f => read(join(REND, f)))].join('\n');

const findings = [];   // { level:'ERROR'|'WARN', kind, items[] }
const add = (level, kind, items, note = '') => { if (items.length) findings.push({ level, kind, items, note }); };

// ---------- 1) 모듈 고아 ----------
//  ★ src/*.js 뿐 아니라 scripts/*.mjs 의 require 도 사용처로 인정한다.
//    (별도 프로세스로 도는 워커가 쓰는 모듈을 고아로 오판하던 사각지대 — 실측: cleanup.js)
const SCRIPTS = join(ROOT, 'scripts');
const scriptSrcAll = existsSync(SCRIPTS)
  ? readdirSync(SCRIPTS).filter(f => /\.(mjs|js|cjs)$/.test(f)).map(f => read(join(SCRIPTS, f))).join('\n')
  : '';
const USAGE_SRC = mainSrcAll + '\n' + scriptSrcAll;
const ENTRY = new Set(['main.js', 'preload.js']);
const moduleOrphans = srcFiles.filter(f => {
  if (ENTRY.has(f)) return false;
  const name = basename(f, '.js');
  // require('./cleanup')  ·  require('./cleanup.js')  ·  require(join(ROOT,'src','cleanup.js'))
  const re = new RegExp(`require\\([^)]*['"](?:\\./)?${name}(?:\\.js)?['"]\\)|['"]${name}\\.js['"]`);
  return !re.test(USAGE_SRC);
});
add('ERROR', '모듈 고아 (require 되지 않는 src/*.js)', moduleOrphans);

// ---------- 2) IPC 채널 정합 ----------
const handled = uniq(matchAll(F.main, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g));
const invoked = uniq(matchAll(F.preload, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g));
// webContents.send 직접 호출 + send('채널') 헬퍼 경유 모두 수집
const sent = uniq([
  ...matchAll(F.main, /webContents\.send\(\s*['"]([^'"]+)['"]/g),
  ...matchAll(F.main, /(?<!\w)send\(\s*['"]([^'"]+)['"]/g)
]);
const listened = uniq(matchAll(F.preload, /ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g));
add('ERROR', 'IPC 핸들러 고아 (main 에 있으나 preload 가 호출 안 함)', handled.filter(c => !invoked.includes(c)));
add('ERROR', 'IPC 호출 대상 없음 (preload 가 부르는데 main 에 핸들러 없음)', invoked.filter(c => !handled.includes(c)));
add('ERROR', '이벤트 고아 (main 이 보내는데 preload 가 안 받음)', sent.filter(c => !listened.includes(c)));
add('ERROR', '이벤트 수신 대상 없음 (preload 가 받는데 main 이 안 보냄)', listened.filter(c => !sent.includes(c)));

// ---------- 3) preload API 고아 ----------
const apiNames = uniq(matchAll(F.preload, /^\s{2}([A-Za-z_$][\w$]*)\s*:/gm));
const rendererAndHtml = F.renderer + F.html;
add('ERROR', 'preload API 고아 (노출했으나 렌더러 미사용)',
  apiNames.filter(n => !new RegExp(`\\b(api\\.|window\\.api\\.)?${n}\\s*\\(`).test(rendererAndHtml)));

// ---------- 4) DOM ID 정합 ----------
const htmlIds = uniq(matchAll(F.html, /\sid="([^"]+)"/g));
const jsIdRefs = uniq([
  ...matchAll(F.renderer, /getElementById\(\s*['"]([^'"]+)['"]/g),
  ...matchAll(F.renderer, /\$\(\s*['"]#([A-Za-z0-9_-]+)['"]/g),
  ...matchAll(F.renderer, /querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)/g),
  // 변수/객체에 담아 쓰는 형태도 참조로 인정: rpTargets = { content: '#rp-content' }
  //  ※ CSS 색상값('#7719aa')은 id 가 아니므로 제외한다
  ...matchAll(F.renderer, /['"]#([A-Za-z0-9_-]+)['"]/g)
    .filter(v => !/^[0-9a-fA-F]{3,8}$/.test(v)),
  ...matchAll(F.main, /getElementById\(\s*['"]([^'"]+)['"]/g)
]);
// 렌더러가 동적 생성하는 id (템플릿 문자열 안) 도 수집
const dynIds = uniq(matchAll(F.renderer, /id="([A-Za-z0-9_-]+)"/g));
const allJsIds = uniq([...jsIdRefs, ...dynIds]);
// 오탐 방지 화이트리스트
//  - 레이아웃 컨테이너: CSS 선택자로만 쓰이는 골격 id
//  - view-*: switchView('#view-' + view) 로 동적 조합되므로 정적 스캔에 안 잡힌다
const LAYOUT_IDS = new Set(['app', 'titlebar', 'menu-tabs', 'ribbon', 'body', 'content', 'reading-pane', 'help-title', 'folders', 'fu-reading-pane', 'sent-reading-pane', 'chat-reading-pane']);
//  rs-*/rz-* 는 우측 스택 제어가 문자열 조합('rs-'+key, 'rs-'+key+'-sub')으로 참조한다 → 정적 스캔 사각지대(오탐)
const isDynamicId = (id) => /^view-/.test(id) || id === 'view-' || /^(rs|rz)-/.test(id);
add('WARN', 'HTML id 고아 (선언됐으나 코드에서 참조 안 함)',
  htmlIds.filter(id => !allJsIds.includes(id) && !LAYOUT_IDS.has(id) && !isDynamicId(id)));
add('ERROR', '코드가 참조하는 id 없음 (HTML/동적생성 모두에 없음)',
  jsIdRefs.filter(id => !htmlIds.includes(id) && !dynIds.includes(id) && !isDynamicId(id)));

// ---------- 5) 렌더러 함수 고아 ----------
const fnDefs = uniq(matchAll(F.renderer, /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm));
const fnOrphans = fnDefs.filter(fn => {
  // 정의부 1회를 제외한 참조가 있는지
  const uses = (F.renderer.match(new RegExp(`\\b${fn}\\b`, 'g')) || []).length;
  const inHtml = new RegExp(`\\b${fn}\\b`).test(F.html);
  return uses <= 1 && !inHtml;
});
add('ERROR', '렌더러 함수 고아 (정의만 있고 호출 없음)', fnOrphans);

// ---------- 6) db exports 고아 ----------
const dbExportBlock = (F.db.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\};/) || [])[1] || '';
const dbExports = uniq(matchAll(dbExportBlock, /(?:^|[\s,])([A-Za-z_$][\w$]*)\s*(?:,|$)/gm))
  .filter(n => !['get', 'dbPath', 'ftsEnabled'].includes(n));
const dbConsumers = [F.main, read(join(SRC, 'sync.js')), read(join(SRC, 'analyzer.js'))].join('\n');
add('ERROR', 'db exports 고아 (내보냈으나 사용처 없음)',
  dbExports.filter(n => !new RegExp(`db\\.${n}\\s*\\(`).test(dbConsumers)));

// ---------- 7) CSS 클래스 고아 ----------
const cssClasses = uniq(matchAll(F.css, /^\s*\.([a-zA-Z][\w-]*)/gm));
const cssConsumers = F.html + F.renderer;
add('WARN', 'CSS 클래스 고아 (정의됐으나 HTML/JS 미사용)',
  cssClasses.filter(c => !new RegExp(`[\\s"'\`.]${c}[\\s"'\`,.:){]`).test(cssConsumers) && !cssConsumers.includes(c)));

// ---------- 출력 ----------
const errors = findings.filter(f => f.level === 'ERROR');
const warns = findings.filter(f => f.level === 'WARN');

console.log('='.repeat(64));
console.log(' Bmail 고아 전수 스캔');
console.log('='.repeat(64));
console.log(`검사 대상: src/*.js ${srcFiles.length}개 · renderer ${rendFiles.length}개`);
console.log(`IPC: 핸들러 ${handled.length} / preload 호출 ${invoked.length} / 이벤트 ${sent.length}`);
console.log(`preload API ${apiNames.length} · HTML id ${htmlIds.length} · 렌더러 함수 ${fnDefs.length} · db exports ${dbExports.length} · CSS 클래스 ${cssClasses.length}`);
console.log('');

if (!findings.length) {
  console.log('고아 0건 — 모든 구성요소가 연결돼 있습니다.');
} else {
  for (const f of findings) {
    console.log(`[${f.level}] ${f.kind}: ${f.items.length}건`);
    f.items.forEach(i => console.log(`    - ${i}`));
    console.log('');
  }
}
console.log('-'.repeat(64));
console.log(`결과: ERROR ${errors.reduce((a, f) => a + f.items.length, 0)}건 · WARN ${warns.reduce((a, f) => a + f.items.length, 0)}건`);

if (GUARD && errors.length) {
  console.error('\n빌드 차단: 연결되지 않은 구성요소(ERROR)가 있습니다.');
  process.exit(1);
}
