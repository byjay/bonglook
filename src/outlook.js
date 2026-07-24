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
//  날짜 필터 → Outlook Restrict 용 조건 문자열 생성
//  dateFilter: { mode: '6months'|'all'|'range', start?, end? }
//  반환: PowerShell 에서 Items.Restrict() 에 넣을 DASL/필터 문자열 (없으면 null)
// ------------------------------------------------------------
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

  // Outlook Restrict 형식: "[ReceivedTime] >= '2024/01/01 00:00'"
  const fmt = (dt) => `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()} ${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`;
  const parts = [];
  if (startDate) parts.push(`[ReceivedTime] >= '${fmt(startDate)}'`);
  if (endDate) parts.push(`[ReceivedTime] <= '${fmt(endDate)}'`);
  return parts.length ? parts.join(' AND ') : null;
}

// ------------------------------------------------------------
//  1) 메일 검색 (날짜 필터 적용)
//     query: 검색어(비면 목록), limit: 개수, dateFilter: 위 형식
// ------------------------------------------------------------
async function searchMails(query, limit = 50, dateFilter = { mode: '6months' }) {
  const safeQuery = String(query || '').replace(/'/g, "''");
  const restrictFilter = buildDateFilter(dateFilter);
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
  const fmt = `${since.getMonth() + 1}/${since.getDate()}/${since.getFullYear()} ${String(since.getHours()).padStart(2,'0')}:${String(since.getMinutes()).padStart(2,'0')}`;
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace("MAPI")
  $inbox = $ns.GetDefaultFolder(6)
  $items = $inbox.Items
  $items.Sort("[ReceivedTime]", $true)
  $items = $items.Restrict("[ReceivedTime] > '${fmt}'")
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

module.exports = {
  searchMails, getNewMailsSince, getMailDetail, saveAttachments,
  checkConnection, buildDateFilter
};
