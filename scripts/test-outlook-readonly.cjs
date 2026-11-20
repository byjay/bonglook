#!/usr/bin/env node
// ============================================================
//  test-outlook-readonly.cjs — Outlook 원본 불변(CLAUDE.md #1) 읽기 전용 가드 회귀 테스트 (의존성 0)
//  ------------------------------------------------------------
//  A) 실제 스크립트 전수: outlook.js 의 runPowerShell 호출부를 전부 스텁 spawn 위에서 실행해
//     모든 호출부가 통과하는지, 호출부 누락이 없는지(호출 줄 대조) 확인
//  B) 금지 호출 주입: 거부 + spawn 0회 (대소문자·공백·문자열 뒤 숨김 변형 포함)
//  C) 데이터 속 금지 문자열: 실제 스크립트 빌더에 넣어도 통과 (오탐 0)
//  D) 정당 호출 통과
//  --oracle : PowerShell 실제 파서(Parser.ParseInput, 실행 없음·COM 없음)로 A~C 판정을 대조한다.
//             환경 의존이라 selfcheck 에는 넣지 않는다.
//  사용: node scripts/test-outlook-readonly.cjs [--oracle]   (실패 있으면 exit 1)
//  🔴 실제 Outlook COM 을 실행하지 않는다. APPDATA·tmpdir 은 픽스처로 돌려 C: 를 건드리지 않는다.
// ============================================================
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..');
const SRC_FILE = path.join(ROOT, 'src', 'outlook.js');
const WORK = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.comguard-'));
const SIG_DIR = path.join(WORK, 'Microsoft', 'Signatures');
fs.mkdirSync(SIG_DIR, { recursive: true });
process.env.APPDATA = WORK;
os.tmpdir = () => WORK;

let passed = 0, failed = 0;
const ok = (name) => { passed++; if (process.env.VERBOSE) console.log('  PASS ' + name); };
const bad = (name, why) => { failed++; console.log('  FAIL ' + name + (why ? ' :: ' + why : '')); };
const check = (name, cond, why) => (cond ? ok(name) : bad(name, why));

// ---- 스텁 spawn: 실행하지 않고 스크립트와 호출 줄만 기록 ----
const realSpawnSync = cp.spawnSync;
const spawned = [];
const srcTail = path.basename(SRC_FILE);
cp.spawn = (cmd, args) => {
  const script = args[args.length - 1];
  const prevLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const frames = new Error().stack.split('\n').filter(l => l.includes(srcTail));
  Error.stackTraceLimit = prevLimit;
  const caller = frames[frames.findIndex(l => /\brunPowerShell\b/.test(l)) + 1];
  const m = caller && caller.match(/:(\d+):\d+\)?$/);
  spawned.push({ cmd, script, line: m ? Number(m[1]) : -1 });
  const ps = new EventEmitter();
  ps.stdout = new EventEmitter();
  ps.stderr = new EventEmitter();
  setImmediate(() => { ps.stdout.emit('data', Buffer.from('[]')); ps.emit('close', 0); });
  return ps;
};

const OL = require(SRC_FILE);
const silent = (p) => Promise.resolve().then(p).then(() => null, e => e);

// ---- 스크립트 빌더 호출표: q = 사용자 데이터 자리 ----
function builderCalls(q) {
  const range = { mode: 'range', start: '2026-01-01', end: '2026-02-01' };
  return [
    ['searchMails', () => OL.searchMails(q, 5, range)],
    ['getNewMailsSince', () => OL.getNewMailsSince('2026-01-01T00:00:00Z', 5)],
    ['getMailDetail', () => OL.getMailDetail(q)],
    ['saveAttachments', () => OL.saveAttachments(q)],
    ['saveAttachmentsBatch', () => OL.saveAttachmentsBatch([{ entryId: q, dir: q }])],
    ['checkConnection', () => OL.checkConnection()],
    ['getContacts', () => OL.getContacts(5)],
    ['getAllContacts', () => OL.getAllContacts(5)],
    ['getAccountSettings', () => OL.getAccountSettings()],
    ['scanFolder', () => OL.scanFolder(6, range, 5, {})],
    ['scanStores', () => OL.scanStores(range, 5, { names: [q] })],
    ['listStores', () => OL.listStores()],
    ['composeMail', () => OL.composeMail({ mode: 'reply', entryId: q, to: q, cc: q, subject: q, body: q, useSignature: true, signatureName: 'sig' })],
    ['composeMail(new)', () => OL.composeMail({ mode: 'new', subject: q, body: q, useSignature: false })],
    ['getSignature', () => OL.getSignature(q)],
    ['listFolderTree', () => OL.listFolderTree(3)],
    ['listNavFavorites', () => OL.listNavFavorites()],
    ['probeAttachments', () => OL.probeAttachments([q])],
    ['probeAttachments(light)', () => OL.probeAttachments([q], { light: true })],
    ['listRules', () => OL.listRules()],
    ['insertHtmlIntoCompose', () => OL.insertHtmlIntoCompose(q)],
    ['listCategories', () => OL.listCategories()],
    ['listAppointments', () => OL.listAppointments({ limit: 5 })],
    ['listTasks', () => OL.listTasks({ limit: 5 })],
    ['listSearchFolders', () => OL.listSearchFolders()],
    ['probeMailMeta', () => OL.probeMailMeta([q])],
    ['folderFingerprints', () => OL.folderFingerprints({ maxDepth: 3 })],
    ['folderItemStates', () => OL.folderItemStates([q], { limit: 5 })],
    ['countOutlookItems', () => OL.countOutlookItems()]
  ];
}

// 호출 지점에서 data(q) 가 그대로 PowerShell 문자열 값이 되는지 오라클로 본다.
const DATA_CASES = [
  '.Delete(',
  '$m.Send()',
  "O'Brien $m.Save()",
  "''.Move('",
  '$($m.Delete())',
  'a"b .Copy()"',
  '\u2019; $m.Delete(); \u2019',          // 둥근 작은따옴표: PowerShell 은 문자열 종료로 읽는다
  '\u2018.Delete()\u2019 \u201A \u201B',
  '\u201C.Send()\u201D \u201E',
  'x # .Save()',
  '<# .Delete() #>',
  "@'\n.Delete()\n'@",
  "tail\r'@\r\n$m.Delete()\r\n@'",        // 본문의 lone CR + 종결자: here-string 탈출 시도
  'back`tick`\'.Delete()',
  "c:\\path\\'; $m.Delete(); '",
  '.Close(0) Folders.Add( InvokeMember('
];

// 거부되어야 하는 스크립트 (주입)
const FORBIDDEN = [
  ['.Send', '$m.Send()'], ['.Send 공백', '$m.Send ()'], ['.send 소문자', '$m.send()'], ['.SEND 대문자+공백', '$m.SEND   ()'],
  ['.Delete', '$m.Delete()'], ['.DELETE 공백', '$m.DELETE ( )'], ['.PermanentlyDelete', '$m.PermanentlyDelete()'],
  ['.Save', '$m.Save()'], ['.save 공백', '$m.save ()'], ['.SaveAs', "$m.SaveAs('x.msg')"], ['.saveas 공백', "$m.saveas ('x')"],
  ['.Move', '$m.Move($f)'], ['.MOVE 공백', '$m.MOVE ($f)'], ['.MoveTo', '$f.MoveTo($g)'],
  ['.Copy', '$c = $m.Copy()'], ['.copy 공백', '$m.copy ()'], ['.CopyTo', '$f.CopyTo($g)'],
  ['Folders.Add', "$f.Folders.Add('x')"], ['folders . add 공백', "$f.folders . add ('x')"],
  ['Items.Add', '$f.Items.Add(0)'], ['Categories.Add', "$ns.Categories.Add('x')"], ['Categories.Remove', "$ns.Categories.Remove('x')"],
  ['.Close(0)', '$m.Close(0)'], ['.close ( 0 )', '$m.close ( 0 )'], ['.Close(00)', '$m.Close(00)'],
  ['.Close(변수)', '$m.Close($olSave)'], ['.Close(프롬프트 2)', '$m.Close(2)'],
  ['InvokeMember', "$t.InvokeMember('Delete', 'InvokeMethod', $null, $m, $null)"], ['invokemember 공백', "$t.invokemember ('x')"],
  ['.Invoke', '$d.Invoke()'], ['.InvokeScript', "$c.InvokeScript('x')"], ['.InvokeCommand', '$c = $ExecutionContext.InvokeCommand'],
  // 메서드 그룹 경유
  ['메서드 그룹', '$d = $m.Delete'],
  // 문자열 제거로 빠져나가면 안 되는 진짜 호출
  ['문자열 뒤', "'a'; $m.Delete()"],
  ["'' 이스케이프 뒤", "'it''s'; $m.Delete()"],
  ['\\ 는 이스케이프 아님', "'x\\'; $m.Delete()"],
  ['큰따옴표 백틱 뒤', '"a`"b"; $m.Delete()'],
  ['큰따옴표 "" 뒤', '"a""b"; $m.Delete()'],
  ['"$(...)" 안 호출', '"x $($m.Delete()) y"'],
  ['"$(...)" 중첩 문자열', '"x$( \'y\' + $m.Send() )z"'],
  ['"$(...)" 중첩 괄호', '"$( ($a) ; ($m.Send()) )"'],
  ['here-string 뒤', "$s = @'\nfoo .x\n'@\n$m.Delete()"],
  ['@"..."@ 안 $(...)', '$s = @"\nfoo $($m.Delete())\n"@'],
  ['둥근 따옴표로 닫은 뒤', "$s = '\u2019; $m.Delete(); \u2018'"],
  ['둥근 큰따옴표로 닫은 뒤', '$s = "\u201D; $m.Delete(); \u201C"'],
  ['here-string 을 lone CR 로 닫은 뒤', "$s = @'\nfoo\r'@\n$m.Delete()\n$t = @'\nbar\n'@"],
  ['주석 끝난 다음 줄', '# c\n$m.Delete()'],
  ['블록 주석 뒤', '<# c #> $m.Delete()'],
  ['백틱 낀 이름', '$m.De`lete()'],
  ['백틱 따옴표 뒤 호출', "echo `'; $m.Delete(); echo `'"],
  ['따옴표 멤버 이름', "$m.'Delete'()"],
  ['큰따옴표 멤버 이름', '$m."Delete"()'],
  ['변수 멤버 이름', '$m.$n()'],
  ['식 멤버 이름', "$m.('Delete')()"],
  ['${} 변수 뒤', '${a #b}; $m.Delete()'],
  ['문자열 실행 iex', "iex '$m.Delete()'"],
  ['Invoke-Expression', "Invoke-Expression '$m.Delete()'"],
  ['[scriptblock]', "$b = [scriptblock]::Create('$m.Delete()')"],
  ['점 소싱', ". ('x')"],
  ['& 문자열', "& 'iex' '$m.Delete()'"],
  // 해석 불능은 실행되지 않으므로 닫힌 쪽으로 거부
  ['미종결 작은따옴표', "$s = 'abc"],
  ['미종결 큰따옴표', '$s = "abc'],
  ['미종결 here-string', "$s = @'\nabc"],
  ['모호한 # (붙은 주석)', "$a#it's\n$m.Delete()\n$b#it's"],
  ['모호한 # (명령 모드 토큰 뒤 호출)', 'echo foo#bar $m.Delete()']
];

// 통과해야 하는 스크립트
const ALLOWED = [
  ['SaveAsFile', "$a.SaveAsFile('c:\\x.pdf')"],
  ['Display', '$item.Display($false)'],
  ['CreateItem', '$item = $ol.CreateItem(0)'],
  ['Attachments.Add', "[void]$item.Attachments.Add('c:\\x.pdf')"],
  ['$list.Add', '[void]$list.Add($x)'],
  ['Reply/ReplyAll/Forward', '$a = $s.Reply(); $b = $s.ReplyAll(); $c = $s.Forward()'],
  ['속성 Saved/SendUsingAccount/DeleteAfterSubmit', '$x = $m.Saved; $y = $m.SendUsingAccount; $z = $m.DeleteAfterSubmit'],
  ['정적 [IO.File]', "[System.IO.File]::Delete('x'); [IO.File]::Copy('a','b')"],
  ['닫기 Close()', '$reader.Close()'],
  ['닫기 Close(1) 저장 안 함', '$m.Close(1)'],
  ['범위 연산자', '0..$n | % { $_ }; 1..($n + 1)'],
  ['문자열 속 호출', "$s = '.Delete('"],
  ["'' 낀 문자열 속 호출", "$s = 'it''s $m.Delete()'"],
  ['큰따옴표 속 텍스트', '$s = "$m.Delete()"'],
  ['here-string 속 호출', "$s = @'\n$m.Delete()\n'@"],
  ['@"..."@ 속 텍스트', '$s = @"\n.Send()\n"@'],
  ['줄 주석 속 호출', '$a = 1 # $m.Send()'],
  ['블록 주석 속 호출', '<# $m.Send() #>\n$a = 1'],
  ['문자열 메서드', "$s = 'abc'.Replace('a', 'b')"],
  // 프로필 변경이지만 임의로 막지 않는다 (현재 src 사용 0건, 지휘자 보고 사항)
  ['AddStore 는 가드 대상 아님', "$ns.AddStore('x.pst')"],
  ['RemoveStore 는 가드 대상 아님', '$ns.RemoveStore($f)']
];

function readyGuard() {
  if (typeof OL.runPowerShell !== 'function' || typeof OL.checkReadOnlyScript !== 'function') {
    bad('가드 export', 'runPowerShell·checkReadOnlyScript export 없음');
    return false;
  }
  return true;
}

function writeSignatures(extraLine) {
  fs.writeFileSync(path.join(SIG_DIR, 'sig.htm'), `<html><body><p>이름 ${extraLine}</p>\n<p>.Delete( O'Brien</p></body></html>`);
}

async function main() {
  writeSignatures('');

  // ---- A) 실제 스크립트 전수 ----
  const src = fs.readFileSync(SRC_FILE, 'utf8').split(/\r?\n/);
  const sites = new Set();
  src.forEach((l, i) => { if (/\brunPowerShell\(/.test(l) && !/^\s*(async\s+)?function\b/.test(l) && !/^\s*\/\//.test(l)) sites.add(i + 1); });
  spawned.length = 0;
  const benign = 'plain-entry-id';
  for (const [name, fn] of builderCalls(benign)) {
    const before = spawned.length;
    const err = await silent(fn);
    check(`A 호출 ${name}`, !err && spawned.length > before, err ? err.message : 'spawn 0회');
  }
  const seen = new Set(spawned.map(s => s.line));
  const missed = [...sites].filter(l => !seen.has(l));
  check('A 호출부 전수(누락 0)', sites.size > 0 && missed.length === 0, `누락 줄 ${missed.join(',')}`);
  const realScripts = spawned.map(s => s.script);
  const guardReady = readyGuard();
  if (guardReady) {
    for (const s of spawned) {
      const v = OL.checkReadOnlyScript(s.script);
      check(`A 판정 outlook.js:${s.line}`, v.ok, JSON.stringify(v.violations));
    }
  }

  // ---- B) 금지 호출 주입 ----
  if (guardReady) {
    for (const [name, script] of FORBIDDEN) {
      const before = spawned.length;
      const err = await silent(() => OL.runPowerShell(script));
      check(`B 거부 ${name}`, !!err && /읽기 전용/.test(err.message), err ? err.message : '거부 안 됨(거짓 성공)');
      check(`B spawn 0회 ${name}`, spawned.length === before, 'spawn 호출됨');
      if (err && /readonly-script-text/.test(err.message)) bad(`B 오류에 스크립트 원문 ${name}`);
    }
    // 실제 스크립트 끝에 주입해도 거부
    for (const s of realScripts) {
      const before = spawned.length;
      const err = await silent(() => OL.runPowerShell(s + '\n$m.Delete()'));
      check('B 실제 스크립트+주입 거부', !!err && spawned.length === before);
    }
  }

  // ---- C) 데이터 속 금지 문자열 (실제 빌더 경유) ----
  const dataScripts = [];
  for (const q of DATA_CASES) {
    writeSignatures(q.replace(/[\r\n]/g, ' '));
    for (const [name, fn] of builderCalls(q)) {
      const before = spawned.length;
      const err = await silent(fn);
      check(`C ${name} <- ${JSON.stringify(q)}`, !err && spawned.length > before, err ? err.message : 'spawn 0회');
      for (let i = before; i < spawned.length; i++) dataScripts.push({ data: q, name, script: spawned[i].script });
    }
  }
  // 서명 파일이 here-string 종결자 줄을 포함해도 탈출 불가
  fs.writeFileSync(path.join(SIG_DIR, 'sig.htm'), "'@\n$m.Delete()\n<p>x</p>\n'@\n@'\n");
  {
    const before = spawned.length;
    const err = await silent(() => OL.composeMail({ mode: 'new', body: 'x', useSignature: true, signatureName: 'sig' }));
    check('C 서명 파일 here-string 종결자', !err && spawned.length > before, err ? err.message : 'spawn 0회');
    for (let i = before; i < spawned.length; i++) dataScripts.push({ data: "'@", name: 'composeMail(sig)', script: spawned[i].script });
  }

  // ---- D) 정당 호출 ----
  if (guardReady) {
    for (const [name, script] of ALLOWED) {
      const before = spawned.length;
      const err = await silent(() => OL.runPowerShell(script));
      check(`D 통과 ${name}`, !err && spawned.length === before + 1, err ? err.message : 'spawn 없음');
    }
  }

  // ---- 오라클: PowerShell 실제 파서로 대조 (--oracle) ----
  if (process.argv.includes('--oracle')) runOracle(realScripts, dataScripts, guardReady);

  console.log(`읽기 전용 가드 테스트: 스크립트 ${realScripts.length}개(호출부 ${sites.size}곳) · 금지 ${FORBIDDEN.length} · 데이터 ${DATA_CASES.length} · 허용 ${ALLOWED.length} — PASS ${passed} / FAIL ${failed}`);
}

// 파서만 돌린다(실행 없음). 멤버 이름은 AST 의 멤버 접근 전부에서 뽑는다.
const ORACLE_PS = String.raw`
param($inFile, $outFile)
$utf8 = New-Object System.Text.UTF8Encoding $false
$items = [IO.File]::ReadAllText($inFile, $utf8) | ConvertFrom-Json
$res = New-Object System.Collections.ArrayList
foreach ($it in $items) {
  $toks = $null; $errs = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($it, [ref]$toks, [ref]$errs)
  $members = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.MemberExpressionAst] }, $true) | ForEach-Object {
    $m = $_.Member
    if ($_.Static) { 'static:' + $m } elseif ($m -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $m.Value } else { '<dynamic>' }
  })
  $strs = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true) | ForEach-Object { $_.Value })
  [void]$res.Add([PSCustomObject]@{ errors = $errs.Count; members = $members; strings = $strs })
}
[IO.File]::WriteAllText($outFile, ($res | ConvertTo-Json -Depth 4 -Compress), $utf8)
`;

// 토큰 조각을 시드 고정 난수로 이어 붙인다. 파서가 금지 멤버를 본 스크립트를 가드가 놓치면 실패.
function fuzzScripts(count) {
  const P = ["'", "''", '"', '""', '`', '$(', ')', '(', "@'\n", "\n'@", '@"\n', '\n"@', '#', '<#', '#>', '\n', '\r', ' ', ';',
    '$m.Delete()', '$m.Send ()', '${a}', '${', '{', '}', '’', '‘', '“', '”', 'echo ', 'x', ',', '|', '.', '$a', '-replace '];
  let seed = 20261106;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % k; };
  const out = [];
  for (let i = 0; i < count; i++) {
    let s = '';
    for (let j = 2 + rnd(9); j > 0; j--) s += P[rnd(P.length)];
    if (!/Delete|Send/.test(s)) s += '$m.Delete()';
    out.push(s);
  }
  return out;
}

function runOracle(realScripts, dataScripts, guardReady) {
  const FORBID_MEMBER = /^(send|delete|permanentlydelete|save|saveas|move|moveto|copy|copyto|invokemember)$/i;
  const all = [
    ...realScripts.map(s => ({ kind: 'real', script: s })),
    ...dataScripts.map(d => ({ kind: 'data', script: d.script, data: d.data, name: d.name })),
    ...FORBIDDEN.map(([name, script]) => ({ kind: 'forbidden', script, name })),
    ...ALLOWED.map(([name, script]) => ({ kind: 'allowed', script, name })),
    ...fuzzScripts(4000).map((script, i) => ({ kind: 'fuzz', script, name: 'fuzz#' + i }))
  ];
  const inFile = path.join(WORK, 'oracle-in.json');
  const outFile = path.join(WORK, 'oracle-out.json');
  const psFile = path.join(WORK, 'oracle.ps1');
  fs.writeFileSync(inFile, JSON.stringify(all.map(a => a.script)));
  fs.writeFileSync(psFile, '\ufeff' + ORACLE_PS);
  const r = realSpawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile, inFile, outFile], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0 || !fs.existsSync(outFile)) { bad('오라클 실행', `EXIT=${r.status} ${String(r.stderr).slice(0, 400)}`); return; }
  const out = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^\ufeff/, ''));
  check('오라클 결과 수', out.length === all.length, `${out.length} != ${all.length}`);
  let realOk = 0, dataOk = 0, parseErrs = 0, roundTrip = 0, sound = 0, overBlock = [], valueMiss = [], fuzzValid = 0, fuzzHit = 0;
  out.forEach((o, i) => {
    const a = all[i];
    const members = [].concat(o.members || []).filter(Boolean);
    const strs = [].concat(o.strings || []).filter(x => x != null);
    const forbidden = members.filter(x => FORBID_MEMBER.test(x));
    if (a.kind === 'real' || a.kind === 'data') {
      if (o.errors) { parseErrs++; bad(`오라클 파싱 오류(${a.kind} ${a.name || ''} <- ${JSON.stringify(a.data)})`, `errors=${o.errors}`); }
      if (forbidden.length) bad(`오라클: 데이터가 코드로 탈출(${a.name} <- ${JSON.stringify(a.data)})`, forbidden.join(','));
      else if (a.kind === 'real') realOk++; else dataOk++;
      // 보간된 데이터는 PowerShell 문자열 값으로 그대로 돌아와야 한다(이스케이프 왕복).
      if (a.kind === 'data' && /^(searchMails|getMailDetail|saveAttachments|probeMailMeta|folderItemStates)$/.test(a.name)) {
        if (strs.includes(a.data)) roundTrip++; else valueMiss.push(`${a.name} <- ${JSON.stringify(a.data)}`);
      }
    }
    if (guardReady) {
      const v = OL.checkReadOnlyScript(a.script);
      // 건전성: 파서가 금지 멤버를 본 스크립트를 가드가 놓치면 안 된다 (파서 오류 스크립트는 실행되지 않음)
      if (a.kind === 'fuzz' && !o.errors) { fuzzValid++; if (forbidden.length) fuzzHit++; }
      if (forbidden.length && !o.errors) { if (v.ok) bad(`오라클: 가드 놓침 ${a.name} ${JSON.stringify(a.script)}`, forbidden.join(',')); else sound++; }
      if (a.kind === 'allowed' && !v.ok) overBlock.push(a.name);
    }
  });
  check('오라클 파싱 오류 0', parseErrs === 0);
  check('오라클 값 왕복', valueMiss.length === 0, valueMiss.slice(0, 6).join(' | '));
  check('오라클 허용 스크립트 오탐 0', overBlock.length === 0, overBlock.join(','));
  console.log(`오라클: 파서 대조 ${out.length}건 · 실제 ${realOk} · 데이터 ${dataOk} · 값 왕복 ${roundTrip} · 금지 멤버 탐지 일치 ${sound} · 퍼즈 파싱 성공 ${fuzzValid}(금지 멤버 포함 ${fuzzHit})`);
}

main().catch(e => { failed++; console.log('  FAIL 테스트 예외 :: ' + (e && e.stack || e)); }).finally(() => {
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
});
