// ============================================================
//  outlook.js - Windows 로컬 Outlook / PST 연동 (PowerShell + COM)
//  ------------------------------------------------------------
//  ★ Add-in 사용 안 함. 별도 독립 프로그램으로 동작.
//  ★ 이미 PC에 설치·로그인된 Outlook의 데이터(PST 포함)에 COM으로 접근.
//     → Outlook이 PST를 실시간 갱신하므로 "실시간 새 메일"이 반영됨.
//  ★ 관리자 권한 불필요. 회사 정책(Add-in 차단)에 걸리지 않음.
//  ------------------------------------------------------------
//  날짜 필터:
//    - 기본: 최근 6개월 (성능/용량 문제 방지)
//    - 사용자 설정: 'all'(전체) 또는 'range'(시작~종료 기간)
//  ------------------------------------------------------------
//  ★ 순수 PST 파일 직접 파싱은 pst.js 가 담당 (Outlook 미실행 시).
// ============================================================
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const attachClassify = require('./attach-classify');   // 진짜 첨부 vs 인라인 이미지 판정

// 첨부 저장 PowerShell 에 넘길 '항상 진짜 첨부' 확장자 목록 (판정 기준을 한 곳에서 관리)
const DOC_EXTS_PS = [...attachClassify.ALWAYS_REAL_EXT].map(e => `'${e}'`).join(',');

// ------------------------------------------------------------
//  한글 깨짐 방지(근본 원인 차단):
//  Windows PowerShell 5.1 은 stdout 리다이렉트 시 콘솔 OEM 코드페이지
//  (한국어 Windows = ks_c_5601-1987 / cp949)로 바이트를 출력한다.
//  Node 가 이를 'utf8' 로 디코드하면 모든 한글이 U+FFFD(���)로 소실된다.
//  → 모든 스크립트 앞에 UTF-8 출력 강제 프리앰블을 붙이고,
//    stdout 은 Buffer 로 모아 마지막에 한 번만 UTF-8 디코드한다
//    (청크 경계에서 멀티바이트 문자가 잘리는 문제도 동시에 해결).
// ------------------------------------------------------------
const PS_UTF8_PREAMBLE = `
try {
  $__enc = New-Object System.Text.UTF8Encoding $false
  [Console]::OutputEncoding = $__enc
  $OutputEncoding = $__enc
} catch {}
`;

// ------------------------------------------------------------
//  읽기 전용 가드 (CLAUDE.md Non-Negotiable #1 — Outlook 원본 불변)
//  ------------------------------------------------------------
//  이 모듈의 모든 PowerShell 은 runPowerShell 한 곳으로 나간다. spawn 직전에 스크립트를 검사해
//  금지 호출이 있으면 spawn 없이 거부한다.
//  스크립트에는 메일 제목·검색어 같은 사용자 데이터가 PowerShell 문자열로 보간되므로,
//  문자열·주석을 PowerShell 토큰 규칙대로 걷어 낸 "코드 뼈대"만 검사한다.
//  한계: 우리 코드의 실수를 막는 장치다. 이름을 런타임에 조립하는 의도적 우회
//  (`$m | % Delete`, `.ForEach('Delete')`, `$fs = $f.Folders; $fs.Add()` 등)까지 막는다고 주장하지 않는다.
//  속성 대입(`$f.Name = 'x'`)도 검사하지 않는다. 해석할 수 없는 스크립트는 닫힌 쪽(거부)으로 처리한다.
// ------------------------------------------------------------
const PS_SINGLE_QUOTES = "'\u2018\u2019\u201A\u201B";   // PowerShell 은 둥근 따옴표도 ASCII 따옴표와 똑같이 읽는다
const PS_DOUBLE_QUOTES = '"\u201C\u201D\u201E';
const isPsSq = (c) => c !== undefined && PS_SINGLE_QUOTES.includes(c);
const isPsDq = (c) => c !== undefined && PS_DOUBLE_QUOTES.includes(c);
const isPsNl = (c) => c === '\r' || c === '\n';
// '#' 앞이 이 글자들이면 토큰 경계라 명령·식 모드 어느 쪽에서도 주석이다.
const isPsTokenStart = (c) => c === undefined || /\s/.test(c) || ';(){},|&'.includes(c);

function psCodeSkeleton(src) {
  const n = src.length;
  let out = [];
  const fail = (msg) => { throw new Error(msg); };
  // 직전 코드 토큰이 멤버 접근 '.' 이면 문자열이 곧 멤버 이름이다: $m.'Delete'()
  const afterDot = () => {
    let j = out.length - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    return out[j] === '.' && out[j - 1] !== '.';
  };
  const skipSingle = (i) => {
    for (; i < n; i++) {
      if (isPsSq(src[i])) return i + 1;   // '' 이스케이프는 닫고 곧바로 다시 여는 것과 판정이 같다
    }
    return fail('작은따옴표 문자열이 닫히지 않음');
  };
  const scanDouble = (i, depth) => {
    while (i < n) {
      const c = src[i];
      if (c === '`') { i += 2; continue; }
      if (isPsDq(c)) return i + 1;        // "" 이스케이프도 같다
      if (c === '$' && src[i + 1] === '(') { out.push(' '); i = scanCode(i + 2, depth + 1); out.push(' '); continue; }
      i++;
    }
    return fail('큰따옴표 문자열이 닫히지 않음');
  };
  const scanHere = (i, isQuote, expand, depth) => {
    let lineStart = true;
    while (i < n) {
      const c = src[i];
      if (lineStart && isQuote(c) && src[i + 1] === '@') return i + 2;
      lineStart = isPsNl(c);
      if (lineStart) { i++; continue; }
      if (expand) {
        if (c === '`') { i += isPsNl(src[i + 1]) ? 1 : 2; continue; }
        if (c === '$' && src[i + 1] === '(') { out.push(' '); i = scanCode(i + 2, depth + 1); out.push(' '); continue; }
      }
      i++;
    }
    return fail('here-string 이 닫히지 않음');
  };
  function scanCode(i, depth) {
    if (depth > 64) fail('$( ) 중첩이 너무 깊음');
    const inSub = depth > 0;
    let parens = 0;
    while (i < n) {
      const c = src[i], next = src[i + 1];
      if (c === '`') {
        if (next !== undefined && /\w/.test(next)) out.push(next); else out.push(' ');
        i += 2;
        continue;
      }
      if (c === '@' && (isPsSq(next) || isPsDq(next))) {
        let j = i + 2;
        while (src[j] === ' ' || src[j] === '\t') j++;
        if (isPsNl(src[j])) {
          j += (src[j] === '\r' && src[j + 1] === '\n') ? 2 : 1;
          out.push(' ');
          i = isPsSq(next) ? scanHere(j, isPsSq, false, depth) : scanHere(j, isPsDq, true, depth);
          out.push("''");
          continue;
        }
      }
      if (isPsSq(c)) {
        const end = skipSingle(i + 1);
        out.push(afterDot() ? src.slice(i + 1, end - 1) : "''");
        i = end;
        continue;
      }
      if (isPsDq(c)) {
        const dot = afterDot();
        const outer = out;
        out = [];
        const end = scanDouble(i + 1, depth);
        const inner = out.join('');
        out = outer;
        out.push(dot ? src.slice(i + 1, end - 1).replace(/`/g, '') : "''", inner);
        i = end;
        continue;
      }
      if (c === '$' && next === '{') {
        let j = i + 2;
        while (j < n && src[j] !== '}') j += src[j] === '`' ? 2 : 1;
        if (j >= n) fail('${ } 변수가 닫히지 않음');
        out.push('$v');
        i = j + 1;
        continue;
      }
      if (c === '<' && next === '#' && isPsTokenStart(src[i - 1])) {
        const j = src.indexOf('#>', i + 2);
        if (j < 0) fail('블록 주석이 닫히지 않음');
        out.push(' ');
        i = j + 2;
        continue;
      }
      if (c === '#') {
        // `foo#bar` 는 명령 모드면 한 토큰, 식 모드면 주석이다. 문맥을 모르므로 거부한다
        // (잘못 읽으면 뒤따르는 따옴표로 진짜 호출이 문자열 속에 숨는다).
        if (!isPsTokenStart(src[i - 1])) fail("토큰에 붙은 '#' 는 주석 여부가 모호함");
        while (i < n && !isPsNl(src[i])) i++;
        continue;
      }
      if (inSub) {
        if (c === '(') parens++;
        else if (c === ')') {
          if (parens === 0) return i + 1;
          parens--;
        }
      }
      out.push(c);
      i++;
    }
    if (inSub) fail('$( ) 가 닫히지 않음');
    return i;
  }
  scanCode(0, 0);
  return out.join('');
}

// 멤버 이름(대소문자 무시). SaveAsFile·Saved·SendUsingAccount 는 \b 로 구분돼 걸리지 않는다.
//  괄호 없는 메서드 그룹($d = $m.Delete)도 같은 이름으로 막는다.
//  .Reply/.ReplyAll/.Forward 는 메모리 초안 생성(composeMail 이 Display 만 하고 저장 안 함)이라 허용.
const PS_FORBIDDEN_MEMBERS = [
  'Send',
  'Delete',
  'PermanentlyDelete',
  'Save',
  'SaveAs',
  'Move',
  'MoveTo',
  'Copy',
  'CopyTo',
  'InvokeMember',
  'Invoke',
  'InvokeScript',
  'InvokeCommand'
];
const PS_FORBIDDEN_PATTERNS = [
  ['Folders.Add', /\.\s*Folders\s*\.\s*Add\b/i],
  ['Items.Add', /\.\s*Items\s*\.\s*Add\b/i],
  ['Categories.Add', /\.\s*Categories\s*\.\s*Add\b/i],
  ['Categories.Remove', /\.\s*Categories\s*\.\s*Remove\b/i],
  ['동적 멤버 이름($m.$n / $m.(...) / 점 소싱)', /(^|[^.])\.\s*[$(]/m],
  // 문자열을 코드로 실행하면 뼈대 검사가 무의미해진다
  ['문자열 실행 명령', /(^|[^\w$.-])(Invoke-Expression|iex|Invoke-Command|icm|Start-Job|Start-Process|saps|powershell|pwsh)(?![\w-])/i],
  ['[scriptblock]', /\[\s*(System\.Management\.Automation\.)?scriptblock\s*\]/i],
  ['& 호출 연산자', /&\s*(''|\$|\()/]
];
const PS_FORBIDDEN_MEMBER_RES = PS_FORBIDDEN_MEMBERS.map(name => [`.${name}`, new RegExp(`\\.\\s*${name}\\b`, 'i')]);

// 순수 함수: 위반이 없으면 { ok:true }, 있으면 { ok:false, violations:[이름…] }. 원문(사용자 데이터)은 돌려주지 않는다.
function checkReadOnlyScript(script) {
  let code;
  try { code = psCodeSkeleton(String(script)); }
  catch (e) { return { ok: false, violations: ['해석 불가: ' + e.message] }; }
  const violations = [];
  for (const [name, re] of PS_FORBIDDEN_MEMBER_RES) if (re.test(code)) violations.push(name);
  for (const [name, re] of PS_FORBIDDEN_PATTERNS) if (re.test(code)) violations.push(name);
  // Close: 인자 없음(.NET 스트림 등)과 olDiscard(1)만 허용. olSave(0)·프롬프트(2)·변수는 저장 가능성이 있어 거부.
  for (const m of code.matchAll(/\.\s*Close\s*\(([^)]*)\)/gi)) {
    const arg = m[1].trim();
    if (arg !== '' && arg !== '1') { violations.push(`.Close(${arg.slice(0, 20)})`); break; }
  }
  return violations.length ? { ok: false, violations } : { ok: true };
}

function runPowerShell(script) {
  const fullScript = PS_UTF8_PREAMBLE + script;
  const verdict = checkReadOnlyScript(fullScript);
  if (!verdict.ok) {
    return Promise.reject(new Error(`Outlook 읽기 전용 가드가 PowerShell 실행을 차단했습니다: ${verdict.violations.join(', ')}`));
  }
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', fullScript
    ], { windowsHide: true });
    const outChunks = [], errChunks = [];
    ps.stdout.on('data', d => outChunks.push(d));
    ps.stderr.on('data', d => errChunks.push(d));
    ps.on('error', err => reject(err));
    ps.on('close', code => {
      const stdout = Buffer.concat(outChunks).toString('utf8').replace(/^﻿/, '');
      const stderr = Buffer.concat(errChunks).toString('utf8').replace(/^﻿/, '');
      if (code !== 0 && !stdout) return reject(new Error(stderr || `PowerShell 종료 코드 ${code}`));
      resolve(stdout);
    });
  });
}

function parseJsonOutput(raw) {
  const text = (raw || '').replace(/^﻿/, '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    const start = text.indexOf('[');
    const startObj = text.indexOf('{');
    const s = (start !== -1 && (startObj === -1 || start < startObj)) ? start : startObj;
    if (s !== -1) {
      try {
        const parsed = JSON.parse(text.slice(s));
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch (_) {}
    }
    throw new Error('Outlook 응답 파싱 실패: ' + text.slice(0, 300));
  }
}

// ------------------------------------------------------------
//  날짜 필터 → Outlook Restrict 용 DASL 조건 문자열 생성
//  dateFilter: { mode: '6months'|'all'|'range', start?, end? }
//  반환: PowerShell 에서 Items.Restrict() 에 넣을 DASL 문자열 (없으면 null)
//
//  ★ 로케일 독립성:
//     기존 "[ReceivedTime] >= 'M/D/YYYY'" 방식은 미국식 날짜 형식이라
//     한국 로케일 Windows/Outlook 에서 Restrict() 가 오작동할 수 있음.
//     → DASL 쿼리(@SQL) + urn:schemas:httpmail:datereceived 사용.
//       DASL 은 항상 "yyyy/MM/dd HH:mm" 형식을 요구하며 로케일 무관하게 동작.
// ------------------------------------------------------------
// DASL 날짜 형식(로케일 독립): yyyy/MM/dd HH:mm
//  🔴 반드시 UTC 로 적어야 한다 (2026-08-04 실측으로 확정).
//     urn:schemas:httpmail:datereceived 는 MAPI PT_SYSTIME(UTC)라
//     Restrict 의 비교 문자열도 UTC 로 해석된다.
//     로컬시각(KST)을 그대로 적으면 기준선이 9시간 미래가 되어
//     "최근 9시간 안에 온 메일"이 전부 필터에서 빠진다.
//     실측(2026-08-04 17:29, 받은편지함 하위 포함 6시간 조회):
//       로컬시각 문자열 → 0건 / UTC 문자열 → 2건(13:34 FW: 30K Floating Dock, 15:49 22K FD)
//     증분 동기화(syncNew)는 항상 mode:'range' 라 이 오차 때문에 새 메일이 영구히 0건이었다.
function daslDate(dt) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}/${pad(dt.getUTCMonth() + 1)}/${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}

function buildDateFilter(dateFilter) {
  const mode = (dateFilter && dateFilter.mode) || '6months';
  if (mode === 'all') return null; // 필터 없음 = 전체

  let startDate = null, endDate = null;

  if (mode === '6months') {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    startDate = d;
  } else if (mode === 'range') {
    if (dateFilter.start) startDate = new Date(dateFilter.start);
    if (dateFilter.end) { endDate = new Date(dateFilter.end); endDate.setHours(23, 59, 59); }
  }

  // DASL 쿼리 (로케일 독립): urn:schemas:httpmail:datereceived
  const prop = 'urn:schemas:httpmail:datereceived';
  const parts = [];
  if (startDate) parts.push(`"${prop}" >= '${daslDate(startDate)}'`);
  if (endDate) parts.push(`"${prop}" <= '${daslDate(endDate)}'`);
  if (!parts.length) return null;
  // @SQL= 접두사 → Outlook 이 DASL 쿼리로 해석
  return `@SQL=` + parts.join(' AND ');
}

// ------------------------------------------------------------
//  1) 메일 검색 (날짜 필터 적용)
//     query: 검색어(비면 목록), limit: 개수, dateFilter: 위 형식
// ------------------------------------------------------------
async function searchMails(query, limit = 50, dateFilter = { mode: '6months' }) {
  const safeQuery = psQuote(query || '');
  const restrictFilter = buildDateFilter(dateFilter);
  // DASL 문자열 안의 큰따옴표(")를 PowerShell 이중따옴표 문자열용으로 이스케이프
  const restrictLine = restrictFilter
    ? `$items = $items.Restrict("${restrictFilter.replace(/"/g, '`"')}")`
    : '# 날짜 필터 없음 (전체)';

  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $inbox = $ns.GetDefaultFolder(6)   # olFolderInbox
  $items = $inbox.Items
  ${restrictLine}
  # ★ Restrict() 는 새 Items 컬렉션을 반환하므로 정렬이 초기화된다.
  #   반드시 Restrict 이후에 Sort 해야 최신순 상위 N건을 얻는다.
  $items.Sort("[ReceivedTime]", $true)

  $q = '${safeQuery}'
  $result = New-Object System.Collections.ArrayList
  $count = 0
  foreach ($m in $items) {
    if ($count -ge ${limit}) { break }
    if ($m.Class -ne 43) { continue }
    $subject = if ($m.Subject) { $m.Subject } else { '' }
    $sender  = if ($m.SenderName) { $m.SenderName } else { '' }
    $to      = if ($m.To) { $m.To } else { '' }
    $bodyPrev = if ($m.Body) { $m.Body.Substring(0, [Math]::Min(400, $m.Body.Length)) } else { '' }
    $match = $true
    if ($q -ne '') {
      $hay = ($subject + ' ' + $sender + ' ' + $to + ' ' + $bodyPrev).ToLower()
      $match = $hay.Contains($q.ToLower())
    }
    if ($match) {
      $obj = [PSCustomObject]@{
        entryId=$m.EntryID; subject=$subject; sender=$sender; to=$to
        received= if ($m.ReceivedTime) { $m.ReceivedTime.ToString("yyyy-MM-dd HH:mm") } else { '' }
        attachCount=$m.Attachments.Count; realAttachCount=$($n=0; foreach ($a in $m.Attachments) { $inl=$false; try { $fl=$a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x37140003'); if ($fl -ne $null -and (($fl -band 4) -ne 0)) { $inl=$true } } catch { }; $e=[System.IO.Path]::GetExtension($a.FileName).TrimStart('.').ToLower(); if (@('pdf','dwg','dxf','dwf','stp','step','igs','iges','sat','x_t','xls','xlsx','xlsm','xlsb','csv','doc','docx','ppt','pptx','hwp','hwpx','zip','rar','7z','alz','egg','tar','gz','txt','rtf','xml','json','eml','msg','vsd','vsdx','mpp','psd','ai') -contains $e) { $inl=$false }; if (-not $inl) { $n++ } }; $n)
        preview=$bodyPrev; unread=$m.UnRead
      }
      [void]$result.Add($obj); $count++
    }
  }
  $result | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  if (parsed.length === 1 && parsed[0] && parsed[0].__error__) {
    throw new Error('Outlook 오류: ' + parsed[0].__error__ + ' (Outlook 실행/로그인 상태를 확인하세요)');
  }
  return parsed;
}

// ------------------------------------------------------------
//  2) 실시간 새 메일 체크
//     sinceIso: 이 시각(ISO) 이후 도착한 메일만 반환
// ------------------------------------------------------------
async function getNewMailsSince(sinceIso, limit = 30) {
  const since = new Date(sinceIso || Date.now() - 3600000);
  // DASL 로케일 독립 형식 (yyyy/MM/dd HH:mm)
  const dasl = daslDate(since);
  const restrict = `@SQL="urn:schemas:httpmail:datereceived" > '${dasl}'`;
  const restrictLine = `$items = $items.Restrict("${restrict.replace(/"/g, '`"')}")`;
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $inbox = $ns.GetDefaultFolder(6)
  $items = $inbox.Items
  ${restrictLine}
  $items.Sort("[ReceivedTime]", $true)   # Restrict 이후 정렬 (정렬 초기화 방지)
  $result = New-Object System.Collections.ArrayList
  $count = 0
  foreach ($m in $items) {
    if ($count -ge ${limit}) { break }
    if ($m.Class -ne 43) { continue }
    $obj = [PSCustomObject]@{
      entryId=$m.EntryID
      subject= if ($m.Subject) { $m.Subject } else { '' }
      sender= if ($m.SenderName) { $m.SenderName } else { '' }
      received= if ($m.ReceivedTime) { $m.ReceivedTime.ToString("yyyy-MM-dd HH:mm") } else { '' }
      attachCount=$m.Attachments.Count; realAttachCount=$($n=0; foreach ($a in $m.Attachments) { $inl=$false; try { $fl=$a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x37140003'); if ($fl -ne $null -and (($fl -band 4) -ne 0)) { $inl=$true } } catch { }; $e=[System.IO.Path]::GetExtension($a.FileName).TrimStart('.').ToLower(); if (@('pdf','dwg','dxf','dwf','stp','step','igs','iges','sat','x_t','xls','xlsx','xlsm','xlsb','csv','doc','docx','ppt','pptx','hwp','hwpx','zip','rar','7z','alz','egg','tar','gz','txt','rtf','xml','json','eml','msg','vsd','vsdx','mpp','psd','ai') -contains $e) { $inl=$false }; if (-not $inl) { $n++ } }; $n)
      preview= if ($m.Body) { $m.Body.Substring(0,[Math]::Min(200,$m.Body.Length)) } else { '' }
      unread=$m.UnRead
    }
    [void]$result.Add($obj); $count++
  }
  $result | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  if (parsed.length === 1 && parsed[0] && parsed[0].__error__) {
    throw new Error('Outlook 오류: ' + parsed[0].__error__);
  }
  return parsed;
}

// ------------------------------------------------------------
//  3) 특정 메일 상세
// ------------------------------------------------------------
async function getMailDetail(entryId) {
  const safeId = psQuote(entryId);
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $m = $ns.GetItemFromID('${safeId}')
  $atts = New-Object System.Collections.ArrayList
  # 본문(HTMLBody)에 cid: 참조가 있는지 봐야 '서명/본문에 박힌 그림'과 진짜 첨부를 가른다
  $htmlBody = ''
  try { $htmlBody = $m.HTMLBody } catch { }
  foreach ($a in $m.Attachments) {
    $cid = ''; $hid = $null; $flags = $null
    try { $cid = $a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x3712001F') } catch { }
    try { $hid = $a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x7FFE000B') } catch { }
    try { $flags = $a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x37140003') } catch { }
    $ref = $false
    if ($cid -and $htmlBody) { $ref = $htmlBody.Contains('cid:' + $cid) }
    [void]$atts.Add([PSCustomObject]@{
      name=$a.FileName; size=$a.Size; cid=$cid; hidden=$hid; flags=$flags; cidReferenced=$ref
    })
  }
  $obj = [PSCustomObject]@{
    entryId=$m.EntryID
    subject= if ($m.Subject) { $m.Subject } else { '' }
    sender= if ($m.SenderName) { $m.SenderName } else { '' }
    senderMail= if ($m.SenderEmailAddress) { $m.SenderEmailAddress } else { '' }
    to= if ($m.To) { $m.To } else { '' }
    cc= if ($m.CC) { $m.CC } else { '' }
    received= if ($m.ReceivedTime) { $m.ReceivedTime.ToString("yyyy-MM-dd HH:mm") } else { '' }
    body= if ($m.Body) { $m.Body } else { '' }
    attachments=$atts
  }
  $obj | ConvertTo-Json -Depth 5 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  const mail = parsed[0];
  if (mail && mail.__error__) throw new Error('Outlook 오류: ' + mail.__error__);
  return mail;
}

// ------------------------------------------------------------
//  4) 첨부파일 임시 저장 → 경로 배열 반환
// ------------------------------------------------------------
async function saveAttachments(entryId) {
  const safeId = psQuote(entryId);
  const tmpDir = path.join(os.tmpdir(), 'outlook-ai-attach', Date.now().toString());
  fs.mkdirSync(tmpDir, { recursive: true });
  const safeDir = tmpDir.replace(/\\/g, '\\\\');
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $m = $ns.GetItemFromID('${safeId}')
  $dir = '${safeDir}'
  $saved = New-Object System.Collections.ArrayList
  foreach ($a in $m.Attachments) {
    if ($a.FileName) {
      $p = Join-Path $dir $a.FileName
      try { $a.SaveAsFile($p); [void]$saved.Add($p) } catch {}
    }
  }
  $saved | ConvertTo-Json -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  if (parsed.length === 1 && parsed[0] && parsed[0].__error__) {
    throw new Error('첨부 저장 오류: ' + parsed[0].__error__);
  }
  return parsed.filter(p => typeof p === 'string');
}

// ------------------------------------------------------------
//  4-b) 첨부파일 일괄 저장 (여러 메일을 PowerShell 1회 호출로 처리)
//  ------------------------------------------------------------
//  ★ 메일 1건마다 powershell.exe 를 새로 띄우면(=Outlook COM 재연결)
//    1건당 1~2초가 들어 동기화가 사실상 멈춘 것처럼 보인다.
//    → 한 프로세스에서 COM 을 한 번만 붙이고 목록을 순회한다.
//  tasks: [{ entryId, dir }]  (dir = 저장할 폴더, 없으면 생성)
//  반환:  [{ entryId, paths: [저장경로...] }]
// ------------------------------------------------------------
// PowerShell 은 둥근 작은따옴표(U+2018~U+201B)도 문자열 종결로 읽으므로 ASCII 따옴표와 함께 이중화한다.
function psQuote(s) { return String(s == null ? '' : s).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&'); }
// @'...'@ 안에서는 줄 맨 앞의 '@ 가 종결자다(CR 단독 줄바꿈 포함). 데이터가 닫지 못하게 공백을 끼운다.
function psHereLiteral(s) { return String(s == null ? '' : s).replace(/(^|[\r\n])(?=['\u2018\u2019\u201A\u201B]@)/g, '$1 '); }

async function saveAttachmentsBatch(tasks) {
  const list = (tasks || []).filter(t => t && t.entryId && t.dir);
  if (!list.length) return [];
  const psTasks = list
    .map(t => `[PSCustomObject]@{ id='${psQuote(t.entryId)}'; dir='${psQuote(t.dir)}' }`)
    .join(',');
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $tasks = @(${psTasks})
  $docExts = @(${DOC_EXTS_PS})
  $out = New-Object System.Collections.ArrayList
  foreach ($t in $tasks) {
    $saved = New-Object System.Collections.ArrayList
    try {
      $m = $ns.GetItemFromID($t.id)
      if (-not (Test-Path -LiteralPath $t.dir)) { New-Item -ItemType Directory -Path $t.dir -Force | Out-Null }
      # ★ 서명 로고·본문 삽입 이미지(cid 인라인)는 저장하지 않는다.
      #   저장하면 첨부 폴더가 image.png 로 뒤덮이고 '진짜 첨부'를 못 찾는다.
      $htmlBody = ''
      try { $htmlBody = $m.HTMLBody } catch { }
      foreach ($a in $m.Attachments) {
        if ($a.FileName) {
          $cid = ''; $flags = $null
          try { $cid = $a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x3712001F') } catch { }
          try { $flags = $a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x37140003') } catch { }
          $isInline = $false
          if ($cid -and $htmlBody -and $htmlBody.Contains('cid:' + $cid)) { $isInline = $true }
          elseif ($flags -ne $null -and (($flags -band 4) -ne 0)) { $isInline = $true }
          # 문서·도면은 어떤 경우에도 진짜 첨부로 취급 (오판 시 업무 파일이 사라진다)
          $ext = [System.IO.Path]::GetExtension($a.FileName).TrimStart('.').ToLower()
          if ($docExts -contains $ext) { $isInline = $false }
          if (-not $isInline) {
            $p = Join-Path $t.dir $a.FileName
            try { $a.SaveAsFile($p); [void]$saved.Add($p) } catch { }
          }
        }
      }
    } catch { }
    [void]$out.Add([PSCustomObject]@{ entryId=$t.id; paths=$saved })
  }
  $out | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  if (parsed.length === 1 && parsed[0] && parsed[0].__error__) {
    throw new Error('첨부 일괄 저장 오류: ' + parsed[0].__error__);
  }
  return parsed
    .filter(r => r && r.entryId)
    .map(r => ({ entryId: r.entryId, paths: [].concat(r.paths || []).filter(p => typeof p === 'string') }));
}

// ------------------------------------------------------------
//  5) Outlook 연결/계정 상태 확인
// ------------------------------------------------------------
async function checkConnection() {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $stores = New-Object System.Collections.ArrayList
  foreach ($s in $ns.Stores) {
    [void]$stores.Add([PSCustomObject]@{ name=$s.DisplayName; path=$s.FilePath })
  }
  [PSCustomObject]@{ ok=$true; stores=$stores } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  return parsed[0] || { ok: false, error: '알 수 없는 오류' };
}

// ------------------------------------------------------------
//  6) 주소록 가져오기 (Outlook 연락처 + GAL 캐시)
//     Outlook 기본 연락처 폴더(olFolderContacts=10) 순회
// ------------------------------------------------------------
async function getContacts(limit = 5000) {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $result = New-Object System.Collections.ArrayList
  $count = 0
  $folder = $ns.GetDefaultFolder(10)   # olFolderContacts
  foreach ($c in $folder.Items) {
    if ($count -ge ${limit}) { break }
    if ($c.Class -ne 40) { continue }   # olContact
    $email = if ($c.Email1Address) { $c.Email1Address } else { '' }
    if ($email -eq '') { continue }
    $obj = [PSCustomObject]@{
      name= if ($c.FullName) { $c.FullName } else { $c.CompanyName }
      email=$email
      company= if ($c.CompanyName) { $c.CompanyName } else { '' }
      phone= if ($c.BusinessTelephoneNumber) { $c.BusinessTelephoneNumber } elseif ($c.MobileTelephoneNumber) { $c.MobileTelephoneNumber } else { '' }
    }
    [void]$result.Add($obj); $count++
  }
  $result | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  if (parsed.length === 1 && parsed[0] && parsed[0].__error__) {
    throw new Error('주소록 오류: ' + parsed[0].__error__);
  }
  return parsed.filter(c => c && c.email);
}

// ------------------------------------------------------------
//  6-b) 주소록 전량 수집 (전 스토어 · 하위폴더 재귀 · 배포목록 포함)
//  ------------------------------------------------------------
//  기존 getContacts() 는 기본 스토어의 연락처 폴더(GetDefaultFolder 10)만,
//  그것도 ContactItem(Class 40)만 읽어 배포목록(그룹)과 다른 스토어·
//  하위 폴더의 연락처가 통째로 누락됐다.
//   → ① 모든 Store 의 연락처 폴더(DefaultItemType=2)를 재귀 탐색
//     ② Class 40(개인) + Class 69(배포목록/그룹) 모두 수집, 그룹은 멤버까지
//     ③ Session.AddressLists 로 보충 대조
// ------------------------------------------------------------
async function getAllContacts(limit = 20000) {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $result = New-Object System.Collections.ArrayList
  $limit = ${limit}
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'

  function Add-Contact($item, $folderName, $storeName) {
    if ($result.Count -ge $limit) { return }
    try {
      $cls = $item.Class
      if ($cls -eq 40) {                     # olContact (개인)
        $email = ''
        try { if ($item.Email1Address) { $email = $item.Email1Address } } catch { }
        $name = ''
        # 이름 후보를 넓게 잡는다: FullName 이 비어 있는 연락처가 실제로 매우 많다
        try { if ($item.FullName) { $name = $item.FullName } } catch { }
        if (-not $name) { try { if ($item.FileAs) { $name = $item.FileAs } } catch { } }
        if (-not $name) { try { if ($item.Email1DisplayName) { $name = $item.Email1DisplayName } } catch { } }
        if (-not $name) { try { if ($item.CompanyName) { $name = $item.CompanyName } } catch { } }
        if (-not $name) { try { $ln=''; $fn=''; if ($item.LastName) { $ln=$item.LastName }; if ($item.FirstName) { $fn=$item.FirstName }; $name = ($ln + ' ' + $fn).Trim() } catch { } }
        if (-not $name) { try { if ($item.Subject) { $name = $item.Subject } } catch { } }
        if (-not $name) { $name = $email }
        if (-not $name -and -not $email) { return }
        $key = 'c|' + $name + '|' + $email
        if ($seen.Contains($key)) { return }
        [void]$seen.Add($key)
        $phone = ''
        try { if ($item.BusinessTelephoneNumber) { $phone = $item.BusinessTelephoneNumber } elseif ($item.MobileTelephoneNumber) { $phone = $item.MobileTelephoneNumber } } catch { }
        $comp = ''
        try { if ($item.CompanyName) { $comp = $item.CompanyName } } catch { }
        $disp = ''
        try { if ($item.Email1DisplayName) { $disp = $item.Email1DisplayName } } catch { }
        [void]$result.Add([PSCustomObject]@{
          kind='contact'; name=$name; email=$email; displayName=$disp
          company=$comp; phone=$phone; folder=$folderName; store=$storeName; members=@()
        })
      }
      elseif ($cls -eq 69) {                 # olDistributionList (그룹/배포목록)
        $gname = ''
        try { if ($item.DLName) { $gname = $item.DLName } elseif ($item.Subject) { $gname = $item.Subject } } catch { }
        if (-not $gname) { return }
        $key = 'g|' + $gname
        if ($seen.Contains($key)) { return }
        [void]$seen.Add($key)
        $members = New-Object System.Collections.ArrayList
        try {
          $cnt = $item.MemberCount
          for ($i = 1; $i -le $cnt; $i++) {
            try {
              $m = $item.GetMember($i)
              [void]$members.Add([PSCustomObject]@{ name=$m.Name; email=$m.Address })
            } catch { }
          }
        } catch { }
        [void]$result.Add([PSCustomObject]@{
          kind='group'; name=$gname; email=''; displayName=''
          company=''; phone=''; folder=$folderName; store=$storeName; members=$members
        })
      }
    } catch { }
  }

  function Walk-Folder($folder, $depth, $storeName) {
    if ($result.Count -ge $limit -or $depth -gt 6) { return }
    try {
      $isContacts = $false
      try { $isContacts = ($folder.DefaultItemType -eq 2) } catch { }
      if ($isContacts) {
        $fname = $folder.Name
        foreach ($it in $folder.Items) {
          if ($result.Count -ge $limit) { break }
          Add-Contact $it $fname $storeName
        }
      }
    } catch { }
    try { foreach ($sub in $folder.Folders) { Walk-Folder $sub ($depth + 1) $storeName } } catch { }
  }

  # ① 모든 스토어의 연락처 폴더 재귀
  foreach ($st in $ns.Stores) {
    try { Walk-Folder $st.GetRootFolder() 0 $st.DisplayName } catch { }
  }

  # ② Outlook 주소록(AddressLists) 보충 — 폴더에서 못 잡은 항목 채우기
  try {
    foreach ($al in $ns.AddressLists) {
      if ($result.Count -ge $limit) { break }
      try {
        if ($al.AddressListType -eq 0) { continue }   # 0=olExchangeGlobalAddressList(GAL) 만 제외, 나머지(Outlook 주소록)는 포함
        foreach ($ae in $al.AddressEntries) {
          if ($result.Count -ge $limit) { break }
          try {
            $nm = $ae.Name
            $ad = ''
            try { $ad = $ae.Address } catch { }
            $key = 'c|' + $nm + '|' + $ad
            $gkey = 'g|' + $nm
            if ($seen.Contains($key) -or $seen.Contains($gkey)) { continue }
            [void]$seen.Add($key)
            [void]$result.Add([PSCustomObject]@{
              kind='contact'; name=$nm; email=$ad; displayName=''
              company=''; phone=''; folder='주소록'; store=$al.Name; members=@()
            })
          } catch { }
        }
      } catch { }
    }
  } catch { }

  $result | ConvertTo-Json -Depth 5 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  if (parsed.length === 1 && parsed[0] && parsed[0].__error__) {
    throw new Error('주소록 오류: ' + parsed[0].__error__);
  }
  return parsed
    .filter(c => c && (c.name || c.email))
    .map(c => ({ ...c, members: [].concat(c.members || []).filter(m => m && (m.name || m.email)) }));
}

// ------------------------------------------------------------
//  7) 계정/설정 정보 가져오기 (계정, 서명, 저장소 목록)
// ------------------------------------------------------------
async function getAccountSettings() {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $accounts = New-Object System.Collections.ArrayList
  foreach ($a in $ns.Accounts) {
    [void]$accounts.Add([PSCustomObject]@{
      displayName=$a.DisplayName
      smtpAddress= if ($a.SmtpAddress) { $a.SmtpAddress } else { '' }
      accountType=$a.AccountType
    })
  }
  $stores = New-Object System.Collections.ArrayList
  foreach ($s in $ns.Stores) {
    [void]$stores.Add([PSCustomObject]@{ name=$s.DisplayName; path=$s.FilePath })
  }
  # 서명 파일(있으면) 목록
  $sigDir = Join-Path $env:APPDATA 'Microsoft\\Signatures'
  $sigs = @()
  if (Test-Path $sigDir) {
    $sigs = Get-ChildItem -Path $sigDir -Filter *.txt -ErrorAction SilentlyContinue | ForEach-Object { $_.BaseName }
  }
  [PSCustomObject]@{ ok=$true; accounts=$accounts; stores=$stores; signatures=$sigs } | ConvertTo-Json -Depth 5 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  return parsed[0] || { ok: false, error: '알 수 없는 오류' };
}

// ------------------------------------------------------------
//  8) 전체 메일 스캔 (여러 폴더 순회) - 동기화용
//     folderType: 6=Inbox, 5=SentItems. dateFilter 적용.
//     반환: 표준 메일 배열 (folder 필드 포함)
// ------------------------------------------------------------
// Outlook 기본 폴더 상수 → 로케일 독립 정규 키
const FOLDER_KEYS = { 6: 'Inbox', 5: 'Sent', 3: 'Deleted', 4: 'Outbox', 16: 'Drafts', 23: 'Junk' };

// ------------------------------------------------------------
//  공통 재귀 스캐너 PowerShell 본문 생성기
//  (기본 폴더 스캔 scanFolder / 아카이브 스토어 스캔 scanStores 가 공유)
//  전제 변수: $result(ArrayList), $limit(int), $storeName(string)
// ------------------------------------------------------------
function buildScanBody(dateFilter, maxDepth) {
  const restrictFilter = buildDateFilter(dateFilter);
  const restrictLine = restrictFilter
    ? `$items = $items.Restrict("${restrictFilter.replace(/"/g, '`"')}")`
    : '# 날짜 필터 없음 (전체)';
  return `
  function Scan-One($folder, $isRoot, $depth) {
    if ($result.Count -ge $limit) { return }
    try {
      $items = $folder.Items
      ${restrictLine}
      $items.Sort("[ReceivedTime]", $true)   # Restrict 이후 정렬 (최신순 상위 N건 보장)
      $folderName = $folder.Name
      foreach ($m in $items) {
        if ($result.Count -ge $limit) { return }
        if ($m.Class -ne 43) { continue }
        $bodyPrev = if ($m.Body) { $m.Body.Substring(0, [Math]::Min(600, $m.Body.Length)) } else { '' }
        $obj = [PSCustomObject]@{
          entryId=$m.EntryID; folderName=$folderName; isRoot=$isRoot; store=$storeName
          subject= if ($m.Subject) { $m.Subject } else { '' }
          sender= if ($m.SenderName) { $m.SenderName } else { '' }
          senderMail= if ($m.SenderEmailAddress) { $m.SenderEmailAddress } else { '' }
          to= if ($m.To) { $m.To } else { '' }
          cc= if ($m.CC) { $m.CC } else { '' }
          received= if ($m.ReceivedTime) { $m.ReceivedTime.ToString("yyyy-MM-dd HH:mm") } else { '' }
          attachCount=$m.Attachments.Count; realAttachCount=$($n=0; foreach ($a in $m.Attachments) { $inl=$false; try { $fl=$a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x37140003'); if ($fl -ne $null -and (($fl -band 4) -ne 0)) { $inl=$true } } catch { }; $e=[System.IO.Path]::GetExtension($a.FileName).TrimStart('.').ToLower(); if (@('pdf','dwg','dxf','dwf','stp','step','igs','iges','sat','x_t','xls','xlsx','xlsm','xlsb','csv','doc','docx','ppt','pptx','hwp','hwpx','zip','rar','7z','alz','egg','tar','gz','txt','rtf','xml','json','eml','msg','vsd','vsdx','mpp','psd','ai') -contains $e) { $inl=$false }; if (-not $inl) { $n++ } }; $n)
          preview=$bodyPrev; body= if ($m.Body) { $m.Body } else { '' }; unread=$m.UnRead
          # ★ 읽기 전용 추가 수집 (마스터: Outlook 원본은 절대 변경 금지 — 전부 get 만 한다)
          categories= $(try { if ($m.Categories) { $m.Categories } else { '' } } catch { '' })
          importance= $(try { [int]$m.Importance } catch { 1 })          # 0=낮음 1=보통 2=높음
          flagStatus= $(try { [int]$m.FlagStatus } catch { 0 })          # 0=없음 1=완료 2=표시됨
          flagRequest= $(try { if ($m.FlagRequest) { $m.FlagRequest } else { '' } } catch { '' })
          taskDue= $(try { if ($m.TaskDueDate -and $m.TaskDueDate.Year -gt 1601) { $m.TaskDueDate.ToString("yyyy-MM-dd") } else { '' } } catch { '' })
          taskStart= $(try { if ($m.TaskStartDate -and $m.TaskStartDate.Year -gt 1601) { $m.TaskStartDate.ToString("yyyy-MM-dd") } else { '' } } catch { '' })
          reminderOn= $(try { if ($m.ReminderSet) { 1 } else { 0 } } catch { 0 })
          reminderAt= $(try { if ($m.ReminderSet -and $m.ReminderTime -and $m.ReminderTime.Year -gt 1601) { $m.ReminderTime.ToString("yyyy-MM-dd HH:mm") } else { '' } } catch { '' })
        }
        [void]$result.Add($obj)
      }
    } catch { }
    if ($depth -lt ${maxDepth}) {
      foreach ($sub in $folder.Folders) {
        if ($result.Count -ge $limit) { return }
        Scan-One $sub $false ($depth + 1)
      }
    }
  }
`;
}

//  opts: { includeSubfolders?: boolean(기본 true), maxDepth?: number(기본 3) }
//  ★ 사용자가 받은편지함 하위 폴더로 메일을 정리해 두면(업무별 분류)
//    기본 폴더만 스캔할 경우 대부분의 메일이 수집되지 않는다.
//    → 하위 폴더를 재귀 순회한다(깊이 제한).
async function scanFolder(folderType, dateFilter = { mode: '6months' }, limit = 2000, opts = {}) {
  const maxDepth = opts.includeSubfolders === false ? 0 : (Number(opts.maxDepth) || 3);
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $root = $ns.GetDefaultFolder(${folderType})
  $result = New-Object System.Collections.ArrayList
  $limit = ${limit}
  $storeName = ''
  try { $storeName = $root.Store.DisplayName } catch { }
${buildScanBody(dateFilter, maxDepth)}
  Scan-One $root $true 0
  $result | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  if (parsed.length === 1 && parsed[0] && parsed[0].__error__) {
    throw new Error('Outlook 폴더 스캔 오류: ' + parsed[0].__error__);
  }
  // ★ folder 는 로케일 독립 정규 키(Inbox/Sent)로 저장한다.
  //   Outlook 이 돌려주는 표시 이름은 로케일별로 다르므로("받은 편지함")
  //   그대로 저장하면 UI 의 folder='Inbox' 필터가 항상 0건이 된다.
  //   표시용 원본 이름은 folderName 에 유지.
  //   하위 폴더 메일은 사용자가 붙인 폴더 이름(업무별 분류)을 그대로 쓴다.
  const folderKey = FOLDER_KEYS[folderType] || 'Inbox';
  return parsed.map(m => ({
    ...m,
    folder: m.isRoot ? folderKey : (m.folderName || folderKey),
    source: 'outlook'
  }));
}

// ------------------------------------------------------------
//  9) 아카이브 스토어(마운트된 PST) 스캔 - 동기화용
//  ------------------------------------------------------------
//  ★ 사용자가 Outlook 에 추가로 붙여 둔 PST(예: F:\MAIL\백업.pst)는
//    GetDefaultFolder() 로는 절대 닿지 않는다(기본 계정 스토어만 반환).
//    → Namespace.Stores 를 순회해 기본 스토어를 제외한 나머지를 재귀 스캔한다.
//  ★ PST 파일 직접 파싱(pst.js) 대신 COM 을 쓰는 이유:
//     - EntryID 가 기본 스토어 메일과 동일 체계 → 중복 적재 없음
//     - 날짜 Restrict/Sort, 첨부 일괄 저장 등 검증된 경로를 그대로 재사용
//  opts: { maxDepth?: number(기본 6), storeNames?: string[](지정 시 해당 스토어만) }
// ------------------------------------------------------------
async function scanStores(dateFilter = { mode: 'all' }, limit = 5000, opts = {}) {
  const maxDepth = Number(opts.maxDepth) || 6;
  const names = Array.isArray(opts.storeNames) ? opts.storeNames.filter(Boolean) : [];
  const nameFilter = names.length
    ? `@(${names.map(n => `'${psQuote(n)}'`).join(',')})`
    : '@()';
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $result = New-Object System.Collections.ArrayList
  $limit = ${limit}
  $storeName = ''
  $wanted = ${nameFilter}
  $defaultStoreId = ''
  try { $defaultStoreId = $ns.GetDefaultFolder(6).Store.StoreID } catch { }
${buildScanBody(dateFilter, maxDepth)}
  foreach ($st in $ns.Stores) {
    if ($result.Count -ge $limit) { break }
    try {
      if ($st.StoreID -eq $defaultStoreId) { continue }   # 기본 스토어는 scanFolder 가 담당
      if ($wanted.Count -gt 0 -and ($wanted -notcontains $st.DisplayName)) { continue }
      $storeName = $st.DisplayName
      Scan-One $st.GetRootFolder() $false 0
    } catch { }
  }
  $result | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  if (parsed.length === 1 && parsed[0] && parsed[0].__error__) {
    throw new Error('아카이브 스토어 스캔 오류: ' + parsed[0].__error__);
  }
  // 아카이브 메일의 folder 는 사용자가 붙인 폴더명 그대로 사용
  return parsed.map(m => ({
    ...m,
    folder: m.folderName || (m.store || 'Archive'),
    source: 'outlook'
  }));
}

// ------------------------------------------------------------
//  10) 스토어 목록 (기본/아카이브 구분 + 메일 총건수)
//      설정 화면에서 "아카이브 PST 포함" 대상 확인용
// ------------------------------------------------------------
async function listStores() {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $defaultStoreId = ''
  try { $defaultStoreId = $ns.GetDefaultFolder(6).Store.StoreID } catch { }
  $r = New-Object System.Collections.ArrayList
  foreach ($st in $ns.Stores) {
    try {
      [void]$r.Add([PSCustomObject]@{
        name=$st.DisplayName
        path=$st.FilePath
        isDefault=($st.StoreID -eq $defaultStoreId)
      })
    } catch { }
  }
  [PSCustomObject]@{ ok=$true; stores=$r } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  return parsed[0] || { ok: false, error: '알 수 없는 오류' };
}

// ------------------------------------------------------------
//  12) 새 메일 / 답장 작성창 열기 (Outlook 브리지)
//  ------------------------------------------------------------
//  ★ 안전 원칙: 절대로 Send() 하지 않는다. Display() 로 Outlook 작성창을
//    띄워 주기만 하고, 실제 발송은 마스터가 Outlook 에서 직접 누른다.
//    (원본 메일함 변경 없음 — 초안조차 자동 저장하지 않는다)
//  mode: 'new' | 'reply' | 'replyAll' | 'forward'
// ------------------------------------------------------------
async function composeMail(opts = {}) {
  const {
    mode = 'new', entryId = '', to = '', cc = '', subject = '', body = '',
    useSignature = true, signatureName = ''
  } = opts;

  const q = (s) => psQuote(s);

  // ★ 본문 글꼴을 Outlook 기본 편지지와 동일하게 감싼다 (맑은 고딕 10pt)
  const BODY_FONT = "font-family:'맑은 고딕','Malgun Gothic',돋움,Dotum,sans-serif;font-size:10.0pt;";
  const bodyInner = String(body || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>');
  const bodyHtml = bodyInner ? `<div style="${BODY_FONT}">${bodyInner}</div>` : '';

  // ★ Outlook 서명 HTML 원본 (서식·색·로고 무손실). 실패 시 텍스트 서명으로 폴백.
  let sigHtml = '', sigName = '', sigFingerprints = [];
  if (useSignature) {
    const sig = getSignatureHtml(signatureName || '');
    if (sig.ok) {
      sigHtml = sig.html; sigName = sig.name; sigFingerprints = sig.fingerprints || [];
    } else {
      try {
        const txt = fs.readFileSync(path.join(SIG_DIR, (signatureName || '') + '.txt'));
        const t = decodeSignature(txt).text;
        if (t.trim()) sigHtml = `<div style="${BODY_FONT}">${t.replace(/\r?\n/g, '<br>')}</div>`;
      } catch (_) {}
    }
  }
  // 이중 삽입 방지용 지문 (Outlook 이 이미 서명을 넣었는지 판단)
  const fpArray = sigFingerprints.length
    ? '@(' + sigFingerprints.map(f => `'${psQuote(f)}'`).join(',') + ')'
    : '@()';

  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $mode = '${q(mode)}'
  $item = $null

  if ($mode -eq 'new') {
    $item = $ol.CreateItem(0)                     # olMailItem
  } else {
    $src = $ns.GetItemFromID('${q(entryId)}')
    if ($mode -eq 'reply') { $item = $src.Reply() }
    elseif ($mode -eq 'replyAll') { $item = $src.ReplyAll() }
    else { $item = $src.Forward() }
  }

  # 수신자/제목 지정 (지정된 경우에만 덮어쓴다)
  if ('${q(to)}' -ne '') { $item.To = '${q(to)}' }
  if ('${q(cc)}' -ne '') { $item.CC = '${q(cc)}' }
  if ('${q(subject)}' -ne '') { $item.Subject = '${q(subject)}' }

  # ------------------------------------------------------------
  #  본문 + 서명 조립
  #   순서 보장: [AI 초안/본문] → [서명 HTML] → [원문 인용]
  #   ★ Outlook 이 이미 서명을 넣었으면(지문 검사) 다시 넣지 않는다(이중 삽입 0)
  # ------------------------------------------------------------
  $insert = @'
${psHereLiteral(bodyHtml)}
'@
  $sig = @'
${psHereLiteral(sigHtml)}
'@
  $fps = ${fpArray}

  $existing = ''
  try { $existing = $item.HTMLBody } catch { }

  # Outlook 이 자동 삽입한 서명이 있는지 지문으로 판정
  $hasSig = $false
  if ($existing -and $fps.Count -gt 0) {
    foreach ($fp in $fps) { if ($existing -like ('*' + $fp + '*')) { $hasSig = $true; break } }
  }

  $sigBlock = ''
  if ($sig.Trim() -ne '' -and -not $hasSig) { $sigBlock = $sig }

  if ($insert.Trim() -ne '' -or $sigBlock -ne '') {
    $head = $insert + $sigBlock
    if ($existing) {
      # 인용문(원문)은 그대로 뒤에 남긴다 → [본문][서명][인용]
      $item.HTMLBody = $head + $existing
    } else {
      $item.HTMLBody = '<html><body>' + $head + '</body></html>'
    }
  }

  # ★ Send() 호출 없음 — 작성창만 띄운다
  $item.Display($false)
  $finalLen = 0
  try { $finalLen = $item.HTMLBody.Length } catch { }
  [PSCustomObject]@{
    ok=$true; mode=$mode; subject=$item.Subject; displayed=$true
    signatureApplied=($sigBlock -ne ''); outlookAlreadyHadSignature=$hasSig
    signatureName='${q(sigName)}'; bodyLength=$finalLen
  } | ConvertTo-Json -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  return parsed[0] || { ok: false, error: '알 수 없는 오류' };
}

// ------------------------------------------------------------
//  12-b) Outlook 서명 HTML 원본 읽기 (서식 무손실)
//  ------------------------------------------------------------
//  ★ 텍스트(.txt) 추출본이 아니라 .htm 원본을 그대로 쓴다.
//    실측(마스터 환경): "a (designsir@seastargo.com).htm" 50,296 bytes
//      charset=ks_c_5601-1987(cp949) · 색 #1F497D/#00B0F0 · 9~18pt
//      이미지 1개(로고)를 "<이름>.files/image001.png" 상대경로로 참조
//  ★ 이미지 상대경로는 절대 file:/// 경로로 바꿔야 작성창에서 깨지지 않는다.
//    (data: URI 는 Outlook 이 차단하는 경우가 있어 사용하지 않는다)
// ------------------------------------------------------------
const SIG_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Signatures');

function decodeSignature(buf) {
  const head = buf.slice(0, 3000).toString('latin1');
  const m = head.match(/charset=["']?([\w-]+)/i);
  const cs = (m ? m[1] : '').toLowerCase();
  const tryList = [];
  if (/ks_c_5601|euc-kr|cp949|windows-949/.test(cs)) tryList.push('euc-kr');
  if (/utf-?8/.test(cs)) tryList.push('utf-8');
  tryList.push('euc-kr', 'utf-8', 'latin1');
  for (const enc of tryList) {
    try {
      const t = new TextDecoder(enc, { fatal: false }).decode(buf);
      if (t && !/�{3,}/.test(t.slice(0, 4000))) return { text: t, encoding: enc };
    } catch (_) {}
  }
  return { text: buf.toString('utf8'), encoding: 'utf-8(fallback)' };
}

// 파일명 → file:/// URL (한글·공백·괄호 안전)
function fileUrl(p) {
  return 'file:///' + String(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace('%3A', ':');
}

function listSignatureFiles() {
  try {
    if (!fs.existsSync(SIG_DIR)) return [];
    return fs.readdirSync(SIG_DIR)
      .filter(f => /\.htm$/i.test(f))
      .map(f => ({ name: f.replace(/\.htm$/i, ''), file: path.join(SIG_DIR, f) }));
  } catch (_) { return []; }
}

function getSignatureHtml(name = '') {
  const all = listSignatureFiles();
  if (!all.length) return { ok: false, error: '저장된 Outlook 서명(.htm)이 없습니다.', list: [] };
  const want = String(name || '').trim().toLowerCase();
  const pick = (want && all.find(x => x.name.toLowerCase() === want))
    || (want && all.find(x => x.name.toLowerCase().startsWith(want)))
    || (want && all.find(x => x.name.toLowerCase().includes(want)))
    || all[0];

  let raw;
  try { raw = fs.readFileSync(pick.file); }
  catch (e) { return { ok: false, error: '서명 파일을 읽을 수 없습니다: ' + e.message, list: all.map(x => x.name) }; }
  const { text, encoding } = decodeSignature(raw);

  // body 안쪽만 사용 (Outlook HTMLBody 에 삽입하기 위함)
  const bm = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let html = bm ? bm[1] : text;

  // 상대 이미지 경로 → 절대 file:/// (URL 인코딩된 경로도 복원해 처리)
  const resDir = pick.file.replace(/\.htm$/i, '') + '_files';
  const resDirAlt = pick.file.replace(/\.htm$/i, '') + '.files';
  const baseDir = fs.existsSync(resDirAlt) ? resDirAlt : (fs.existsSync(resDir) ? resDir : null);
  const images = [];
  html = html.replace(/(src|background)\s*=\s*(["'])(?!https?:|file:|cid:|data:)([^"']+)\2/gi,
    (mm, attr, q, rel) => {
      const decoded = decodeURIComponent(rel).replace(/\//g, path.sep);
      // 서명 폴더 기준 절대경로 (경로에 폴더명이 이미 포함된 형태도 처리)
      let abs = path.isAbsolute(decoded) ? decoded : path.join(SIG_DIR, decoded);
      if (!fs.existsSync(abs) && baseDir) abs = path.join(baseDir, path.basename(decoded));
      if (fs.existsSync(abs)) { images.push(abs); return `${attr}=${q}${fileUrl(abs)}${q}`; }
      return mm;   // 못 찾으면 원형 유지
    });

  // 서명 식별용 지문 (이중 삽입 방지 검사에 사용)
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const fingerprints = [];
  const fpCand = plain.match(/[가-힣A-Za-z0-9@._-]{6,40}/g) || [];
  for (const c of fpCand) { if (c.length >= 8 && !fingerprints.includes(c)) fingerprints.push(c); if (fingerprints.length >= 5) break; }

  return {
    ok: true, name: pick.name, file: pick.file, encoding,
    html, images, imageCount: images.length,
    textPreview: plain.slice(0, 200),
    fingerprints,
    list: all.map(x => x.name)
  };
}

// ------------------------------------------------------------
//  13) 기본 서명 읽기 (미리보기/초안 생성용)
//     Outlook 서명 파일(%APPDATA%\Microsoft\Signatures)의 텍스트본을 반환
// ------------------------------------------------------------
async function getSignature(name = '') {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $dir = Join-Path $env:APPDATA 'Microsoft\\Signatures'
  if (-not (Test-Path $dir)) { [PSCustomObject]@{ ok=$true; name=''; text=''; list=@() } | ConvertTo-Json -Compress; exit }
  $files = @(Get-ChildItem -Path $dir -Filter *.txt -ErrorAction SilentlyContinue)
  $names = @($files | ForEach-Object { $_.BaseName })
  $want = '${psQuote(name)}'
  $pick = $null
  if ($want -ne '') { $pick = $files | Where-Object { $_.BaseName -eq $want } | Select-Object -First 1 }
  if (-not $pick) { $pick = $files | Select-Object -First 1 }
  $text = ''
  if ($pick) {
    try { $text = [System.IO.File]::ReadAllText($pick.FullName, [System.Text.Encoding]::Default) } catch { }
    if (-not $text) { try { $text = Get-Content -Path $pick.FullName -Raw -Encoding UTF8 } catch { } }
  }
  [PSCustomObject]@{ ok=$true; name=$(if ($pick) { $pick.BaseName } else { '' }); text=$text; list=$names } | ConvertTo-Json -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  const r = parsed[0] || { ok: false, error: '알 수 없는 오류' };
  if (r.list && !Array.isArray(r.list)) r.list = [r.list];
  return r;
}

// ------------------------------------------------------------
//  11) 폴더 계층 트리 (스토어 → 폴더 → 하위폴더)
//      UI 폴더 트리를 실제 Outlook 구조대로 그리기 위한 목록.
//      메일 건수는 DB(folder 이름 기준)에서 매칭하므로 여기선 구조만 반환.
// ------------------------------------------------------------
async function listFolderTree(maxDepth = 6) {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $defaultStoreId = ''
  try { $defaultStoreId = $ns.GetDefaultFolder(6).Store.StoreID } catch { }
  $r = New-Object System.Collections.ArrayList

  function Walk($folder, $depth, $parentPath, $store, $isDefault, $sib) {
    if ($depth -gt ${maxDepth}) { return }
    $name = $folder.Name
    $p = if ($parentPath) { "$parentPath/$name" } else { $name }
    try {
      $cnt = 0
      try { $cnt = $folder.Items.Count } catch { }
      # PR_SORT_POSITION (0x30200102) = Outlook 폴더 창의 실제 표시 순서 키.
      #   가변길이 바이너리이며 '바이트열 사전식 오름차순'이 화면 순서다.
      #   (값이 없는 폴더 = 한 번도 수동 이동된 적 없음 → 이름순으로 뒤에 붙인다)
      $sp = ''
      try {
        $spv = $folder.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x30200102')
        if ($spv) { $sp = (($spv | ForEach-Object { $_.ToString('x2') }) -join '') }
      } catch { }
      [void]$r.Add([PSCustomObject]@{
        name=$name; path=$p; parentPath=$parentPath; depth=$depth; store=$store
        isDefault=$isDefault; items=$cnt; sib=$sib; sortPos=$sp
        defaultType=$(if ($folder.DefaultItemType -ne $null) { $folder.DefaultItemType } else { -1 })
      })
    } catch { }
    $i = 0
    foreach ($sub in $folder.Folders) { $i++; Walk $sub ($depth + 1) $p $store $isDefault $i }
  }

  foreach ($st in $ns.Stores) {
    try {
      $isDef = ($st.StoreID -eq $defaultStoreId)
      $k = 0
      foreach ($top in $st.GetRootFolder().Folders) { $k++; Walk $top 0 '' $st.DisplayName $isDef $k }
    } catch { }
  }
  [PSCustomObject]@{ ok=$true; folders=$r } | ConvertTo-Json -Depth 5 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  return parsed[0] || { ok: false, error: '알 수 없는 오류' };
}

// ------------------------------------------------------------
//  Outlook 즐겨찾기(탐색 창) 원본 그대로 읽기 — 읽기 전용
//   Application.ActiveExplorer().NavigationPane.Modules
//     .GetNavigationModule(0)            → 메일 모듈(olModuleMail)
//     .NavigationGroups                  → '즐겨찾기' 그룹(GroupType=4)
//     .NavigationFolders                 → Position(=화면 표시 순서) 그대로
//   ★ 읽기만 한다. 즐겨찾기 추가/삭제/이동을 Outlook 쪽에 쓰지 않는다(마스터 원본 보호).
// ------------------------------------------------------------
async function listNavFavorites() {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ex = $ol.ActiveExplorer()
  if ($null -eq $ex) { throw 'Outlook 창(Explorer)이 열려 있지 않습니다.' }
  $mail = $ex.NavigationPane.Modules.GetNavigationModule(0)
  $groups = $mail.NavigationGroups
  $r = New-Object System.Collections.ArrayList
  for ($g = 1; $g -le $groups.Count; $g++) {
    $grp = $groups.Item($g)
    $gname = $grp.Name
    $gtype = -1
    try { $gtype = $grp.GroupType } catch { }
    $nfs = $null
    try { $nfs = $grp.NavigationFolders } catch { }
    if ($null -eq $nfs) { continue }
    for ($f = 1; $f -le $nfs.Count; $f++) {
      $nf = $nfs.Item($f)
      $pos = $f; $disp = ''; $path = ''; $fname = ''; $store = ''
      try { $pos = $nf.Position } catch { }
      try { $disp = $nf.DisplayName } catch { }
      try {
        $fo = $nf.Folder
        if ($fo) { $path = $fo.FolderPath; $fname = $fo.Name; $store = $fo.Store.DisplayName }
      } catch { }
      [void]$r.Add([PSCustomObject]@{
        group=$gname; groupType=$gtype; pos=$pos; label=$disp
        name=$fname; path=$path; store=$store
      })
    }
  }
  [PSCustomObject]@{ ok=$true; favorites=$r } | ConvertTo-Json -Depth 5 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  return parsed[0] || { ok: false, error: '알 수 없는 오류' };
}

// ------------------------------------------------------------
//  첨부 판정용 속성 배치 조회 (기존 저장분 백필용 — 읽기 전용)
//   entryIds 여러 건을 PowerShell 한 번으로 훑는다.
//   반환: [{ entryId, attachments:[{name,size,cid,flags,hidden,cidReferenced}] }]
// ------------------------------------------------------------
//   light=true 면 HTMLBody 를 읽지 않고 PR_ATTACH_FLAGS 만 본다.
//     실측(38첨부): flags=5(인라인) / 0(진짜)이 cid 참조와 100% 일치했고,
//     HTMLBody 조회가 전체 시간의 대부분이라 대량 백필은 이 모드가 현실적이다.
async function probeAttachments(entryIds, { light = false } = {}) {
  const list = (entryIds || []).filter(Boolean);
  if (!list.length) return [];
  const psIds = list.map(id => `'${psQuote(id)}'`).join(',');
  if (light) {
    const lightScript = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $ids = @(${psIds})
  $out = New-Object System.Collections.ArrayList
  foreach ($id in $ids) {
    $atts = New-Object System.Collections.ArrayList
    try {
      $m = $ns.GetItemFromID($id)
      foreach ($a in $m.Attachments) {
        $flags = $null
        try { $flags = $a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x37140003') } catch { }
        [void]$atts.Add([PSCustomObject]@{ name=$a.FileName; size=$a.Size; flags=$flags })
      }
    } catch { }
    [void]$out.Add([PSCustomObject]@{ entryId=$id; attachments=$atts })
  }
  $out | ConvertTo-Json -Depth 5 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
    const rawL = await runPowerShell(lightScript);
    const parsedL = parseJsonOutput(rawL);
    if (parsedL.length === 1 && parsedL[0] && parsedL[0].__error__) {
      throw new Error('첨부 속성 조회 오류: ' + parsedL[0].__error__);
    }
    return parsedL.filter(r => r && r.entryId)
      .map(r => ({ entryId: r.entryId, attachments: [].concat(r.attachments || []) }));
  }
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $ids = @(${psIds})
  $out = New-Object System.Collections.ArrayList
  foreach ($id in $ids) {
    $atts = New-Object System.Collections.ArrayList
    try {
      $m = $ns.GetItemFromID($id)
      $htmlBody = ''
      try { $htmlBody = $m.HTMLBody } catch { }
      foreach ($a in $m.Attachments) {
        $cid = ''; $hid = $null; $flags = $null
        try { $cid = $a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x3712001F') } catch { }
        try { $hid = $a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x7FFE000B') } catch { }
        try { $flags = $a.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x37140003') } catch { }
        $ref = $false
        if ($cid -and $htmlBody) { $ref = $htmlBody.Contains('cid:' + $cid) }
        [void]$atts.Add([PSCustomObject]@{
          name=$a.FileName; size=$a.Size; cid=$cid; hidden=$hid; flags=$flags; cidReferenced=$ref
        })
      }
    } catch { }
    [void]$out.Add([PSCustomObject]@{ entryId=$id; attachments=$atts })
  }
  $out | ConvertTo-Json -Depth 5 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  if (parsed.length === 1 && parsed[0] && parsed[0].__error__) {
    throw new Error('첨부 속성 조회 오류: ' + parsed[0].__error__);
  }
  return parsed
    .filter(r => r && r.entryId)
    .map(r => ({ entryId: r.entryId, attachments: [].concat(r.attachments || []) }));
}

// ------------------------------------------------------------
//  Outlook 규칙 읽기 (Namespace.DefaultStore.GetRules) — 읽기 전용
//   ★ 규칙을 만들거나 고치거나 지우지 않는다. 마스터가 정의한 분류 의도를 읽기만 한다.
//   반환: [{ name, from:'a@b;c@d', folder:'KSIT', subject:'2710;22K', enabled }]
// ------------------------------------------------------------
async function listRules() {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $rules = $ns.DefaultStore.GetRules()
  $r = New-Object System.Collections.ArrayList
  foreach ($rule in $rules) {
    $froms = @()
    try { if ($rule.Conditions.From.Enabled) { foreach ($rc in $rule.Conditions.From.Recipients) { $froms += $rc.Address } } } catch { }
    $tgt = ''
    try { if ($rule.Actions.MoveToFolder.Enabled) { $tgt = $rule.Actions.MoveToFolder.Folder.Name } } catch { }
    $words = @()
    try { if ($rule.Conditions.Subject.Enabled) { $words = $rule.Conditions.Subject.Text } } catch { }
    [void]$r.Add([PSCustomObject]@{
      name=$rule.Name; from=($froms -join ';'); folder=$tgt; subject=($words -join ';'); enabled=$rule.Enabled
    })
  }
  [PSCustomObject]@{ ok=$true; rules=$r } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  return parsed[0] || { ok: false, error: '알 수 없는 오류' };
}

// ------------------------------------------------------------
//  열려 있는 Outlook 작성창 본문에 HTML 블록 삽입 (대용량 첨부 링크용)
//   ★ 절대 Send() 하지 않는다. 본문에 넣어 주기만 하고 발송은 마스터가 직접 누른다.
//   활성 작성창이 없으면 새 메일 작성창을 띄워서 넣는다.
//   삽입 위치 = 본문 맨 앞(<body> 직후). 서명은 본문 아래에 있으므로 자연히 '서명 위'가 된다.
// ------------------------------------------------------------
async function insertHtmlIntoCompose(html) {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $block = '${psQuote(String(html || '').replace(/\r?\n/g, ' '))}'
  $ol = New-Object -ComObject Outlook.Application
  $item = $null
  $reused = $false
  try {
    $insp = $ol.ActiveInspector()
    if ($insp -ne $null -and $insp.CurrentItem -ne $null -and $insp.CurrentItem.Class -eq 43) {
      $item = $insp.CurrentItem
      $reused = $true
    }
  } catch { }
  if ($item -eq $null) {
    $item = $ol.CreateItem(0)
    $item.Display($false)
  }
  $body = $item.HTMLBody
  if ([string]::IsNullOrEmpty($body)) {
    $item.HTMLBody = '<html><body>' + $block + '</body></html>'
  } else {
    $i = $body.IndexOf('<body', [System.StringComparison]::OrdinalIgnoreCase)
    if ($i -ge 0) {
      $j = $body.IndexOf('>', $i)
      if ($j -ge 0) { $item.HTMLBody = $body.Substring(0, $j + 1) + $block + $body.Substring($j + 1) }
      else { $item.HTMLBody = $block + $body }
    } else {
      $item.HTMLBody = $block + $body
    }
  }
  try { $item.Display($false) } catch { }
  [PSCustomObject]@{ ok=$true; reused=$reused } | ConvertTo-Json -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const raw = await runPowerShell(script);
  const parsed = parseJsonOutput(raw);
  return parsed[0] || { ok: false, error: '알 수 없는 오류' };
}

// ============================================================
//  Outlook 잔여 데이터 수집 — 전부 읽기 전용(get 만 호출)
//  ------------------------------------------------------------
//  🔴 마스터 규율: Outlook 원본 절대 불변.
//     아래 함수들은 Categories.Add/Remove, Items.Add, Save(), Delete() 를
//     단 한 번도 호출하지 않는다. 열거·읽기만 한다.
// ============================================================

// ① 범주 마스터 (이름 + 색). Namespace.Categories 는 읽기 전용으로 열거만 한다.
//    olCategoryColor 정수를 Outlook 실제 표시색(HEX)으로 매핑해 화면 대비를 보장한다.
const OL_CATEGORY_COLORS = {
  0: '', 1: '#e2646e', 2: '#f5a25d', 3: '#f0c419', 4: '#f6e07a', 5: '#88c057',
  6: '#5aab7c', 7: '#4aa9a0', 8: '#5a9bd5', 9: '#4a6fb5', 10: '#8a7fc4',
  11: '#c76fa8', 12: '#b0b0b0', 13: '#8f8f8f', 14: '#8a5a4a', 15: '#c0392b',
  16: '#d35400', 17: '#c9a227', 18: '#b7950b', 19: '#4f8a10', 20: '#2e7d5b',
  21: '#26847c', 22: '#2f6fa8', 23: '#2c4f8a', 24: '#5f4f9c', 25: '#a04a86'
};
async function listCategories() {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $r = New-Object System.Collections.ArrayList
  $cats = $ns.Categories
  for ($i = 1; $i -le $cats.Count; $i++) {
    $c = $cats.Item($i)
    [void]$r.Add([PSCustomObject]@{
      name=$c.Name
      color=$(try { [int]$c.Color } catch { 0 })
      shortcut=$(try { [int]$c.ShortcutKey } catch { 0 })
    })
  }
  [PSCustomObject]@{ ok=$true; categories=$r } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const res = parseJsonOutput(await runPowerShell(script))[0] || { ok: false, error: '알 수 없는 오류' };
  if (res.ok) {
    if (res.categories && !Array.isArray(res.categories)) res.categories = [res.categories];
    (res.categories || []).forEach(c => { c.hex = OL_CATEGORY_COLORS[c.color] || '#8a8886'; });
  }
  return res;
}

// ② 캘린더 일정 — GetDefaultFolder(9). 반복 일정을 실제 발생분으로 펼쳐 읽는다.
//    ★ IncludeRecurrences=true 를 쓰려면 반드시 Sort("[Start]") 를 먼저 해야 한다(COM 규칙).
async function listAppointments({ fromDays = 180, toDays = 180, limit = 3000 } = {}) {
  const from = new Date(Date.now() - fromDays * 864e5);
  const to = new Date(Date.now() + toDays * 864e5);
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $cal = $ns.GetDefaultFolder(9)
  $items = $cal.Items
  $items.IncludeRecurrences = $true
  $items.Sort("[Start]")
  $f = "@SQL=""urn:schemas:calendar:dtend"" >= '${fmt(from)}' AND ""urn:schemas:calendar:dtstart"" <= '${fmt(to)}'"
  $sel = $items.Restrict($f)
  $r = New-Object System.Collections.ArrayList
  $n = 0
  foreach ($a in $sel) {
    if ($n -ge ${limit}) { break }
    if ($a.Class -ne 26) { continue }
    $n++
    [void]$r.Add([PSCustomObject]@{
      entryId=$(try { $a.EntryID } catch { '' })
      subject=$(try { if ($a.Subject) { $a.Subject } else { '' } } catch { '' })
      start=$(try { $a.Start.ToString("yyyy-MM-dd HH:mm") } catch { '' })
      end=$(try { $a.End.ToString("yyyy-MM-dd HH:mm") } catch { '' })
      allDay=$(try { if ($a.AllDayEvent) { 1 } else { 0 } } catch { 0 })
      location=$(try { if ($a.Location) { $a.Location } else { '' } } catch { '' })
      organizer=$(try { if ($a.Organizer) { $a.Organizer } else { '' } } catch { '' })
      required=$(try { if ($a.RequiredAttendees) { $a.RequiredAttendees } else { '' } } catch { '' })
      categories=$(try { if ($a.Categories) { $a.Categories } else { '' } } catch { '' })
      recurring=$(try { if ($a.IsRecurring) { 1 } else { 0 } } catch { 0 })
      busy=$(try { [int]$a.BusyStatus } catch { 2 })
      body=$(try { if ($a.Body) { $a.Body.Substring(0, [Math]::Min(400, $a.Body.Length)) } else { '' } } catch { '' })
    })
  }
  [PSCustomObject]@{ ok=$true; appointments=$r; total=$n } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const res = parseJsonOutput(await runPowerShell(script))[0] || { ok: false, error: '알 수 없는 오류' };
  if (res.ok && res.appointments && !Array.isArray(res.appointments)) res.appointments = [res.appointments];
  return res;
}

// ③ 작업(Tasks) — GetDefaultFolder(13)
async function listTasks({ limit = 2000 } = {}) {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $f = $ns.GetDefaultFolder(13)
  $items = $f.Items
  try { $items.Sort("[DueDate]") } catch { }
  $r = New-Object System.Collections.ArrayList
  $n = 0
  foreach ($t in $items) {
    if ($n -ge ${limit}) { break }
    if ($t.Class -ne 48) { continue }
    $n++
    [void]$r.Add([PSCustomObject]@{
      entryId=$(try { $t.EntryID } catch { '' })
      subject=$(try { if ($t.Subject) { $t.Subject } else { '' } } catch { '' })
      due=$(try { if ($t.DueDate -and $t.DueDate.Year -gt 1601 -and $t.DueDate.Year -lt 4000) { $t.DueDate.ToString("yyyy-MM-dd") } else { '' } } catch { '' })
      start=$(try { if ($t.StartDate -and $t.StartDate.Year -gt 1601 -and $t.StartDate.Year -lt 4000) { $t.StartDate.ToString("yyyy-MM-dd") } else { '' } } catch { '' })
      complete=$(try { if ($t.Complete) { 1 } else { 0 } } catch { 0 })
      percent=$(try { [int]$t.PercentComplete } catch { 0 })
      status=$(try { [int]$t.Status } catch { 0 })
      importance=$(try { [int]$t.Importance } catch { 1 })
      owner=$(try { if ($t.Owner) { $t.Owner } else { '' } } catch { '' })
      categories=$(try { if ($t.Categories) { $t.Categories } else { '' } } catch { '' })
      body=$(try { if ($t.Body) { $t.Body.Substring(0, [Math]::Min(400, $t.Body.Length)) } else { '' } } catch { '' })
    })
  }
  [PSCustomObject]@{ ok=$true; tasks=$r; total=$n } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const res = parseJsonOutput(await runPowerShell(script))[0] || { ok: false, error: '알 수 없는 오류' };
  if (res.ok && res.tasks && !Array.isArray(res.tasks)) res.tasks = [res.tasks];
  return res;
}

// ④ 검색 폴더 목록 + 조건(DASL) — Store.GetSearchFolders(). 열거만 한다.
async function listSearchFolders() {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $r = New-Object System.Collections.ArrayList
  foreach ($st in $ns.Stores) {
    $sfs = $null
    try { $sfs = $st.GetSearchFolders() } catch { }
    if ($null -eq $sfs) { continue }
    for ($i = 1; $i -le $sfs.Count; $i++) {
      $sf = $sfs.Item($i)
      $cnt = 0; $filter = ''; $scope = ''
      try { $cnt = $sf.Items.Count } catch { }
      # PR_EXTENDED_FOLDER_FLAGS 가 아니라 검색 조건은 SearchCriteria 로 노출된다(버전별 상이)
      try { $filter = $sf.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x6837001F') } catch { }
      try { $scope = $sf.FolderPath } catch { }
      [void]$r.Add([PSCustomObject]@{
        store=$st.DisplayName; name=$sf.Name; path=$scope; items=$cnt; filter=$filter
      })
    }
  }
  [PSCustomObject]@{ ok=$true; searchFolders=$r } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const res = parseJsonOutput(await runPowerShell(script))[0] || { ok: false, error: '알 수 없는 오류' };
  if (res.ok && res.searchFolders && !Array.isArray(res.searchFolders)) res.searchFolders = [res.searchFolders];
  return res;
}

// ⑤ 기존 저장분 백필용 — entryId 목록의 범주/플래그/중요도만 배치로 읽는다(읽기 전용).
async function probeMailMeta(entryIds) {
  const list = (entryIds || []).filter(Boolean);
  if (!list.length) return [];
  const psIds = list.map(id => `'${psQuote(id)}'`).join(',');
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $ids = @(${psIds})
  $r = New-Object System.Collections.ArrayList

  # ★ GetItemFromID($id) 단독 호출은 '기본 스토어'만 뒤진다.
  #   Outlook 에 붙여 둔 아카이브 PST(예: '백업') 메일은 전부 실패한다(실측: 9,676건 조회 불가).
  #   → 실패하면 연결된 모든 스토어의 StoreID 를 넣어 다시 시도한다.
  #     한 번 성공한 스토어를 맨 앞으로 올려 다음 건부터는 첫 시도에 맞도록 한다(순차 스캔 비용 제거).
  $storeIds = New-Object System.Collections.ArrayList
  foreach ($st in $ns.Stores) { try { [void]$storeIds.Add($st.StoreID) } catch { } }

  function Resolve-Item($id) {
    try { return $ns.GetItemFromID($id) } catch { }
    for ($i = 0; $i -lt $storeIds.Count; $i++) {
      try {
        $it = $ns.GetItemFromID($id, $storeIds[$i])
        if ($it -ne $null) {
          if ($i -gt 0) { $hit = $storeIds[$i]; $storeIds.RemoveAt($i); $storeIds.Insert(0, $hit) }
          return $it
        }
      } catch { }
    }
    return $null
  }

  foreach ($id in $ids) {
    try {
      $m = Resolve-Item $id
      if ($m -eq $null) { continue }
      [void]$r.Add([PSCustomObject]@{
        entryId=$id
        categories=$(try { if ($m.Categories) { $m.Categories } else { '' } } catch { '' })
        importance=$(try { [int]$m.Importance } catch { 1 })
        flagStatus=$(try { [int]$m.FlagStatus } catch { 0 })
        flagRequest=$(try { if ($m.FlagRequest) { $m.FlagRequest } else { '' } } catch { '' })
        taskDue=$(try { if ($m.TaskDueDate -and $m.TaskDueDate.Year -gt 1601 -and $m.TaskDueDate.Year -lt 4000) { $m.TaskDueDate.ToString("yyyy-MM-dd") } else { '' } } catch { '' })
        taskStart=$(try { if ($m.TaskStartDate -and $m.TaskStartDate.Year -gt 1601 -and $m.TaskStartDate.Year -lt 4000) { $m.TaskStartDate.ToString("yyyy-MM-dd") } else { '' } } catch { '' })
        reminderOn=$(try { if ($m.ReminderSet) { 1 } else { 0 } } catch { 0 })
        reminderAt=$(try { if ($m.ReminderSet -and $m.ReminderTime -and $m.ReminderTime.Year -gt 1601) { $m.ReminderTime.ToString("yyyy-MM-dd HH:mm") } else { '' } } catch { '' })
        unread=$(try { if ($m.UnRead) { 1 } else { 0 } } catch { 0 })
      })
    } catch { }
  }
  $r | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"__error__":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const parsed = parseJsonOutput(await runPowerShell(script));
  if (parsed.length === 1 && parsed[0] && parsed[0].__error__) throw new Error('메타 조회 오류: ' + parsed[0].__error__);
  return parsed.filter(x => x && x.entryId);
}

// ============================================================
//  ⑥ 폴더 지문(fingerprint) — '무엇이 바뀌었는지'를 싸게 알아내는 용도
//  ------------------------------------------------------------
//  각 폴더의 (전체 건수 · 안읽음 수 · 가장 최근 수신시각)만 읽는다.
//  Items 를 열거하지 않고 Count/UnReadItemCount 프로퍼티와 정렬된 첫 항목 1건만 보므로
//  폴더 수백 개라도 1~2초면 끝난다(전량 스캔 금지 제약 충족).
//  → 직전 지문과 다른 폴더만 상세 조회하면 된다.
// ============================================================
async function folderFingerprints({ maxDepth = 6 } = {}) {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $r = New-Object System.Collections.ArrayList

  function Walk($folder, $depth, $parentPath, $store) {
    if ($depth -gt ${maxDepth}) { return }
    $name = $folder.Name
    $p = if ($parentPath) { "$parentPath/$name" } else { $name }
    try {
      # ★ Count / UnReadItemCount 두 프로퍼티만 읽는다.
      #   최신 1건을 보려고 Sort+GetFirst 를 하면 244폴더에 6.7초가 드는데(실측),
      #   실제로 잡아내는 변화는 '건수가 같은데 하나 지우고 하나 받은' 희귀 케이스뿐이다.
      #   새 메일·이동·삭제는 Count 로, 읽음 변화는 UnReadItemCount 로 전부 잡힌다.
      $cnt = 0; $unread = 0
      try { $cnt = $folder.Items.Count } catch { }
      try { $unread = $folder.UnReadItemCount } catch { }
      [void]$r.Add([PSCustomObject]@{ store=$store; path=$p; name=$name; items=$cnt; unread=$unread; last='' })
    } catch { }
    foreach ($sub in $folder.Folders) { Walk $sub ($depth + 1) $p $store }
  }

  foreach ($st in $ns.Stores) {
    try { foreach ($top in $st.GetRootFolder().Folders) { Walk $top 0 '' $st.DisplayName } } catch { }
  }
  [PSCustomObject]@{ ok=$true; folders=$r } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const res = parseJsonOutput(await runPowerShell(script))[0] || { ok: false, error: '알 수 없는 오류' };
  if (res.ok && res.folders && !Array.isArray(res.folders)) res.folders = [res.folders];
  return res;
}

// ⑦ 특정 폴더들의 메일 상태만 다시 읽는다 (읽음/범주/깃발/중요도/현재 폴더).
//    변경이 감지된 폴더에만 쓴다. 본문은 읽지 않아 가볍다.
async function folderItemStates(paths = [], { limit = 400 } = {}) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return { ok: true, items: [] };
  const psPaths = list.map(p => `'${psQuote(p)}'`).join(',');
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $want = @(${psPaths})
  $r = New-Object System.Collections.ArrayList

  function Walk($folder, $depth, $parentPath, $store) {
    if ($depth -gt 6) { return }
    $name = $folder.Name
    $p = if ($parentPath) { "$parentPath/$name" } else { $name }
    if ($want -contains $p) {
      try {
        $it = $folder.Items
        $it.Sort("[ReceivedTime]", $true)
        $n = 0
        foreach ($m in $it) {
          if ($n -ge ${limit}) { break }
          if ($m.Class -ne 43) { continue }
          $n++
          [void]$r.Add([PSCustomObject]@{
            entryId=$(try { $m.EntryID } catch { '' })
            folderPath=$p
            folderName=$name
            unread=$(try { if ($m.UnRead) { 1 } else { 0 } } catch { 0 })
            categories=$(try { if ($m.Categories) { $m.Categories } else { '' } } catch { '' })
            importance=$(try { [int]$m.Importance } catch { 1 })
            flagStatus=$(try { [int]$m.FlagStatus } catch { 0 })
            taskDue=$(try { if ($m.TaskDueDate -and $m.TaskDueDate.Year -gt 1601 -and $m.TaskDueDate.Year -lt 4000) { $m.TaskDueDate.ToString("yyyy-MM-dd") } else { '' } } catch { '' })
          })
        }
      } catch { }
    }
    foreach ($sub in $folder.Folders) { Walk $sub ($depth + 1) $p $store }
  }
  foreach ($st in $ns.Stores) {
    try { foreach ($top in $st.GetRootFolder().Folders) { Walk $top 0 '' $st.DisplayName } } catch { }
  }
  [PSCustomObject]@{ ok=$true; items=$r } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  const res = parseJsonOutput(await runPowerShell(script))[0] || { ok: false, error: '알 수 없는 오류' };
  if (res.ok && res.items && !Array.isArray(res.items)) res.items = [res.items];
  return res;
}

// Outlook 쪽 실제 개수 (검증 대조표용) — 읽기 전용 카운트
async function countOutlookItems() {
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $cats = 0; $appt = 0; $tasks = 0; $sf = 0
  try { $cats = $ns.Categories.Count } catch { }
  try { $appt = $ns.GetDefaultFolder(9).Items.Count } catch { }
  try { $tasks = $ns.GetDefaultFolder(13).Items.Count } catch { }
  try { foreach ($st in $ns.Stores) { try { $sf += $st.GetSearchFolders().Count } catch { } } } catch { }
  [PSCustomObject]@{ ok=$true; categories=$cats; appointments=$appt; tasks=$tasks; searchFolders=$sf } | ConvertTo-Json -Compress
} catch {
  Write-Output ('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','\\"') + '"}')
}
`;
  return parseJsonOutput(await runPowerShell(script))[0] || { ok: false, error: '알 수 없는 오류' };
}

module.exports = {
  searchMails, getNewMailsSince, getMailDetail, saveAttachments, saveAttachmentsBatch,
  listNavFavorites, insertHtmlIntoCompose, probeAttachments, listRules,
  checkConnection, buildDateFilter, runPowerShell, checkReadOnlyScript,
  getContacts, getAllContacts, getAccountSettings, scanFolder, scanStores, listStores, listFolderTree,
  composeMail, getSignature, getSignatureHtml, listSignatureFiles,
  listCategories, listAppointments, listTasks, listSearchFolders, probeMailMeta, countOutlookItems,
  folderFingerprints, folderItemStates,
  OL_CATEGORY_COLORS
};
