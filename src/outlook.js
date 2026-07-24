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

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script
    ], { windowsHide: true });
    let stdout = '', stderr = '';
    ps.stdout.on('data', d => stdout += d.toString('utf8'));
    ps.stderr.on('data', d => stderr += d.toString('utf8'));
    ps.on('error', err => reject(err));
    ps.on('close', code => {
      if (code !== 0 && !stdout) return reject(new Error(stderr || `PowerShell 종료 코드 ${code}`));
      resolve(stdout);
    });
  });
}

function parseJsonOutput(raw) {
  const text = (raw || '').trim();
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
function daslDate(dt) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}/${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
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
  const safeQuery = String(query || '').replace(/'/g, "''");
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
  $items.Sort("[ReceivedTime]", $true)
  ${restrictLine}

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
        hasAttach=($m.Attachments.Count -gt 0); attachCount=$m.Attachments.Count
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
  $items.Sort("[ReceivedTime]", $true)
  ${restrictLine}
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
      hasAttach=($m.Attachments.Count -gt 0); attachCount=$m.Attachments.Count
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
  const safeId = String(entryId).replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $m = $ns.GetItemFromID('${safeId}')
  $atts = New-Object System.Collections.ArrayList
  foreach ($a in $m.Attachments) { [void]$atts.Add([PSCustomObject]@{ name=$a.FileName; size=$a.Size }) }
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
  const safeId = String(entryId).replace(/'/g, "''");
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
async function scanFolder(folderType, dateFilter = { mode: '6months' }, limit = 2000) {
  const restrictFilter = buildDateFilter(dateFilter);
  const restrictLine = restrictFilter
    ? `$items = $items.Restrict("${restrictFilter.replace(/"/g, '`"')}")`
    : '# 날짜 필터 없음 (전체)';
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $folder = $ns.GetDefaultFolder(${folderType})
  $items = $folder.Items
  $items.Sort("[ReceivedTime]", $true)
  ${restrictLine}
  $folderName = $folder.Name
  $result = New-Object System.Collections.ArrayList
  $count = 0
  foreach ($m in $items) {
    if ($count -ge ${limit}) { break }
    if ($m.Class -ne 43) { continue }
    $bodyPrev = if ($m.Body) { $m.Body.Substring(0, [Math]::Min(600, $m.Body.Length)) } else { '' }
    $obj = [PSCustomObject]@{
      entryId=$m.EntryID; folder=$folderName
      subject= if ($m.Subject) { $m.Subject } else { '' }
      sender= if ($m.SenderName) { $m.SenderName } else { '' }
      senderMail= if ($m.SenderEmailAddress) { $m.SenderEmailAddress } else { '' }
      to= if ($m.To) { $m.To } else { '' }
      cc= if ($m.CC) { $m.CC } else { '' }
      received= if ($m.ReceivedTime) { $m.ReceivedTime.ToString("yyyy-MM-dd HH:mm") } else { '' }
      hasAttach=($m.Attachments.Count -gt 0); attachCount=$m.Attachments.Count
      preview=$bodyPrev; body= if ($m.Body) { $m.Body } else { '' }; unread=$m.UnRead
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
    throw new Error('Outlook 폴더 스캔 오류: ' + parsed[0].__error__);
  }
  return parsed.map(m => ({ ...m, source: 'outlook' }));
}

module.exports = {
  searchMails, getNewMailsSince, getMailDetail, saveAttachments,
  checkConnection, buildDateFilter,
  getContacts, getAccountSettings, scanFolder
};
