// ============================================================
//  attach-organize.js — "대화로 첨부 정리" 단일 책임 모듈
//  ------------------------------------------------------------
//  책임 범위
//   ① 자연어 지시에서 '정리 액션' 부분만 파싱한다
//      (목적지 경로 / 정리 구조 / 첨부 종류 / 파일명 규칙).
//      메일 검색조건(발신자·기간·키워드)은 main.js 의 parseSearchQuery 가 이미 한다 —
//      여기서 다시 만들지 않는다(중복 금지). 이 모듈은 남은 문장을 searchText 로 돌려준다.
//   ② 목적지 경로 안전성 판정 (시스템 폴더·드라이브 루트 차단).
//   ③ 구조별 하위 폴더·파일명 계산(순수 함수).
//   ④ 실행 엔진 — '복사만' 한다. 원본 메일·Outlook·기존 파일을 절대 건드리지 않는다.
//      첨부 추출은 주입받은 saver(outlook.saveAttachmentsBatch)가 하고,
//      이 모듈은 임시 폴더 → 목적지 복사·중복 회피·멱등 판정만 담당한다.
//
//  절대 규칙 (깨면 사고)
//   · 삭제·이동 없음. copyFileSync 만 쓴다.
//   · 덮어쓰기 없음. 같은 이름이 있으면 -1, -2 …
//   · 같은 이름 + 같은 크기가 이미 있으면 '이미 저장됨'으로 건너뛴다(재실행 중복 0).
//   · destRoot 밖으로는 단 1바이트도 쓰지 않는다(경로 조작 방어).
//
//  셀프체크: node src/attach-organize.js
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');

// ------------------------------------------------------------
//  첨부 종류 (사용자가 말하는 낱말 → 확장자 집합)
// ------------------------------------------------------------
const KIND_DEFS = {
  // 도면은 CAD 원본과 PDF 도면을 함께 본다(조선 업무 실측: 승인도면 대부분이 PDF).
  drawing: { label: '도면(CAD·PDF)', exts: ['dwg', 'dxf', 'dwf', 'stp', 'step', 'igs', 'iges', 'sat', 'x_t', 'pdf'] },
  pdf: { label: 'PDF', exts: ['pdf'] },
  excel: { label: '엑셀', exts: ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv'] },
  word: { label: '워드', exts: ['doc', 'docx'] },
  hwp: { label: '한글', exts: ['hwp', 'hwpx'] },
  ppt: { label: '파워포인트', exts: ['ppt', 'pptx'] },
  image: { label: '이미지', exts: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp'] },
  zip: { label: '압축', exts: ['zip', 'rar', '7z', 'alz', 'egg', 'tar', 'gz'] },
  doc: { label: '문서', exts: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'hwp', 'hwpx', 'txt', 'rtf'] }
};

// 종류별 폴더 이름 (structure='kind')
const KIND_FOLDER = [
  { label: '도면', exts: ['dwg', 'dxf', 'dwf', 'stp', 'step', 'igs', 'iges', 'sat', 'x_t'] },
  { label: 'PDF', exts: ['pdf'] },
  { label: '엑셀', exts: ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv'] },
  { label: '문서', exts: ['doc', 'docx', 'hwp', 'hwpx', 'txt', 'rtf', 'ppt', 'pptx'] },
  { label: '이미지', exts: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp'] },
  { label: '압축', exts: ['zip', 'rar', '7z', 'alz', 'egg', 'tar', 'gz'] }
];

const STRUCTURE_LABEL = {
  flat: '한 폴더에 모두',
  date: '날짜별 폴더(YYYY-MM-DD)',
  month: '월별 폴더(YYYY-MM)',
  project: '프로젝트별 폴더',
  sender: '보낸사람별 폴더',
  kind: '파일 종류별 폴더'
};
const NAMERULE_LABEL = {
  orig: '원본 파일명 그대로',
  date: '날짜_원본파일명',
  sender: '보낸사람_원본파일명'
};

const extOf = (name) => {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9_]+)$/);
  return m ? m[1] : '';
};

function matchesKind(fileName, kinds) {
  if (!kinds || !kinds.length) return true;          // 종류 지정 없음 = 전부
  const e = extOf(fileName);
  return kinds.some(k => (KIND_DEFS[k] ? KIND_DEFS[k].exts.includes(e) : false));
}
function kindsLabel(kinds) {
  if (!kinds || !kinds.length) return '첨부 전체';
  return kinds.map(k => (KIND_DEFS[k] ? KIND_DEFS[k].label : k)).join(' · ');
}

// ------------------------------------------------------------
//  경로 안전성 — 시스템 폴더·드라이브 루트에는 절대 쓰지 않는다
// ------------------------------------------------------------
const BLOCKED_ROOTS = [
  'c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata',
  'c:\\$recycle.bin', 'c:\\system volume information', 'c:\\recovery', 'c:\\perflogs',
  'c:\\users\\default', 'c:\\users\\public\\desktop'
];
const norm = (p) => path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
// a 가 b 와 같거나 b 아래인가
function isInside(a, b) {
  const A = norm(a), B = norm(b);
  return A === B || A.startsWith(B.endsWith('\\') ? B : B + '\\');
}

//  extraBlocked: 앱 설치폴더·userData 등 런타임에만 알 수 있는 경로(main 이 넘긴다)
function checkDest(dest, { extraBlocked = [] } = {}) {
  const raw = String(dest || '').trim();
  if (!raw) return { ok: false, error: '저장할 폴더 경로를 찾지 못했습니다. 예: D:\\작업\\22KFD' };
  if (/[<>"|?*]/.test(raw.replace(/^[A-Za-z]:/, ''))) return { ok: false, error: `경로에 쓸 수 없는 문자가 있습니다: ${raw}` };
  const isDrive = /^[A-Za-z]:[\\/]/.test(raw);
  const isUnc = /^\\\\[^\\/]+[\\/][^\\/]+/.test(raw);
  if (!isDrive && !isUnc) return { ok: false, error: `절대 경로만 허용합니다(드라이브 문자 또는 네트워크 경로). 받은 값: ${raw}` };

  const abs = path.resolve(raw);
  const parsed = path.parse(abs);
  if (norm(abs) === norm(parsed.root)) {
    return { ok: false, error: `드라이브 루트(${parsed.root})에는 저장하지 않습니다. 하위 폴더를 지정하세요.` };
  }
  for (const b of BLOCKED_ROOTS) {
    if (isInside(abs, b)) return { ok: false, error: `시스템 폴더에는 저장할 수 없습니다: ${b}` };
  }
  for (const b of (extraBlocked || [])) {
    if (b && isInside(abs, b)) return { ok: false, error: `프로그램 내부 폴더에는 저장할 수 없습니다: ${b}` };
  }
  return { ok: true, dest: abs, exists: fs.existsSync(abs) };
}

// ------------------------------------------------------------
//  자연어에서 '정리 액션' 파싱
//   roots = { documents, desktop, downloads, home } (main 이 주입 — 사용자별 경로 하드코딩 금지)
//   prev  = 직전 계획(후속 대화로 수정할 때)
// ------------------------------------------------------------
const ACTION_RE = /정리|저장|모아|모아서|내려받|다운로드\s*해|추출|복사|백업|빼\s*줘|빼줘|뽑아/;

const KIND_WORDS = [
  [/도면/, 'drawing'],
  [/\bpdf\b|피디에프/i, 'pdf'],
  [/엑셀|스프레드시트|xlsx?\b/i, 'excel'],
  [/워드|docx?\b/i, 'word'],
  [/한글\s*파일|hwpx?\b/i, 'hwp'],
  [/피피티|파워포인트|pptx?\b/i, 'ppt'],
  [/이미지|사진|그림/, 'image'],
  [/압축|zip\b/i, 'zip'],
  [/문서\s*(?:파일|만|들)/, 'doc']
];

function parseOrganizeIntent(text, { prev = null, roots = {} } = {}) {
  const original = String(text || '').trim();
  let q = ' ' + original + ' ';
  const R = {
    documents: roots.documents || path.join(os.homedir(), 'Documents'),
    desktop: roots.desktop || path.join(os.homedir(), 'Desktop'),
    downloads: roots.downloads || path.join(os.homedir(), 'Downloads'),
    home: roots.home || os.homedir()
  };

  // ---- 목적지 경로 ----
  let dest = '';
  const cutFromQ = (s) => { q = q.split(s).join(' '); };
  // ① 드라이브 절대경로: D:\작업\22KFD  ·  C:/work/x
  let m = q.match(/([A-Za-z]:[\\/][^\s,]*)/);
  if (m) { dest = m[1]; cutFromQ(m[1]); }
  // ② 네트워크 경로
  if (!dest && (m = q.match(/(\\\\[^\s,]+)/))) { dest = m[1]; cutFromQ(m[1]); }
  // ③ 특수 폴더 시작: 문서\도면정리\KSIT · 바탕화면/AA · 다운로드\BB
  if (!dest && (m = q.match(/((?:내\s*)?(?:문서|바탕\s*화면|바탕화면|다운로드|Documents|Desktop|Downloads)[\\/][^\s,]*)/i))) {
    const rel = m[1];
    cutFromQ(rel);
    const seg = rel.replace(/^내\s*/, '').replace(/\s+/g, '');
    const head = seg.split(/[\\/]/)[0].toLowerCase();
    const rest = seg.split(/[\\/]/).slice(1).join(path.sep);
    const base = /문서|documents/.test(head) ? R.documents
      : (/바탕화면|desktop/.test(head) ? R.desktop
        : (/다운로드|downloads/.test(head) ? R.downloads : R.home));
    dest = path.join(base, rest);
  }
  // 경로 뒤에 붙은 조사 제거: "...\KSIT에" "...\22KFD로" "...\x 안에"
  if (dest) {
    const stripped = dest.replace(/(?:에다가|에다|으로|안에|밑에|아래에|에|로)$/, '');
    if (stripped) dest = stripped;
  }

  // ---- 첨부 종류 ----
  const kinds = [];
  for (const [re, k] of KIND_WORDS) if (re.test(q) && !kinds.includes(k)) kinds.push(k);

  // ---- 정리 구조 ----
  let structure = '';
  if (/날짜\s*별|일자\s*별|날짜\s*폴더/.test(q)) structure = 'date';
  else if (/월\s*별|달\s*별/.test(q)) structure = 'month';
  else if (/프로젝트\s*별|호선\s*별/.test(q)) structure = 'project';
  else if (/보낸\s*사람\s*별|발신자\s*별|거래처\s*별|업체\s*별/.test(q)) structure = 'sender';
  else if (/종류\s*별|형식\s*별|확장자\s*별|파일\s*종류/.test(q)) structure = 'kind';
  else if (/한\s*폴더|평면|그냥\s*다|모두\s*한/.test(q)) structure = 'flat';

  // ---- 파일명 규칙 ----
  let nameRule = '';
  if (/파일\s*이름\s*(?:에)?\s*날짜|날짜\s*(?:를)?\s*붙|날짜\s*접두/.test(q)) nameRule = 'date';
  else if (/보낸\s*사람\s*(?:을|를)?\s*붙|발신자\s*접두/.test(q)) nameRule = 'sender';

  const hasAction = ACTION_RE.test(q);
  // 후속 수정인가 — 직전 계획이 있고, 경로 없이 구조·종류·파일명만 바꾸는 문장
  const isFollowUp = !!prev && !dest && (!!structure || kinds.length > 0 || !!nameRule);

  if (!isFollowUp && !(hasAction && dest)) {
    return { isOrganize: false, reason: dest ? '정리 동사가 없습니다' : '저장 폴더가 지정되지 않았습니다' };
  }

  // 검색 문구 — 액션 관련 낱말을 걷어낸 나머지(= 메일 검색조건)
  const searchText = (isFollowUp ? String(prev.searchText || '') : q)
    .replace(/정리해\s*줘|정리해줘|정리\s*해|정리|저장해\s*줘|저장해줘|저장\s*해|저장|모아\s*줘|모아줘|모아서|모아|복사해\s*줘|복사해줘|복사|백업|추출해\s*줘|추출|내려받아\s*줘|내려받아|다운로드\s*해줘|빼\s*줘|빼줘|뽑아\s*줘|뽑아/g, ' ')
    .replace(/날짜\s*별로?|월\s*별로?|프로젝트\s*별로?|보낸\s*사람\s*별로?|발신자\s*별로?|종류\s*별로?|확장자\s*별로?|폴더로?|한\s*폴더/g, ' ')
    .replace(/\s+/g, ' ').trim();

  return {
    isOrganize: true,
    followUp: isFollowUp,
    dest: dest || (prev ? prev.dest : ''),
    kinds: kinds.length ? kinds : (isFollowUp ? (prev.kinds || []) : []),
    structure: structure || (isFollowUp ? (prev.structure || 'flat') : 'flat'),
    nameRule: nameRule || (isFollowUp ? (prev.nameRule || 'orig') : 'orig'),
    searchText,
    rawText: original
  };
}

// ------------------------------------------------------------
//  구조별 하위 폴더 · 파일명 (순수)
// ------------------------------------------------------------
// 폴더/파일 이름으로 못 쓰는 문자 제거. 윈도우 예약어·끝 점/공백까지 처리.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function sanitizeSeg(s, fallback = '기타') {
  let v = String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!v || RESERVED.test(v)) v = fallback;
  return v.slice(0, 80);
}
function sanitizeFileName(name) {
  const raw = String(name || '').trim();
  const ext = extOf(raw);
  const base = ext ? raw.slice(0, raw.length - ext.length - 1) : raw;
  const b = sanitizeSeg(base, '첨부');
  return ext ? `${b.slice(0, 120)}.${ext}` : b.slice(0, 120);
}

const p2 = (n) => String(n).padStart(2, '0');
function ymd(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime()) || !ts) return '날짜미상';
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function kindFolderOf(fileName) {
  const e = extOf(fileName);
  const hit = KIND_FOLDER.find(k => k.exts.includes(e));
  return hit ? hit.label : '기타';
}
function senderOf(mail) {
  return sanitizeSeg(mail.sender_name || (mail.sender_email || '').split('@')[0] || '보낸사람미상', '보낸사람미상');
}

//  메일 1건 + 파일 1개 → destRoot 기준 상대 하위 폴더
function subdirFor(mail, fileName, structure) {
  switch (structure) {
    case 'date': return ymd(mail.received_ts);
    case 'month': return ymd(mail.received_ts).slice(0, 7);
    case 'project': return sanitizeSeg(mail.project || '기타');
    case 'sender': return senderOf(mail);
    case 'kind': return kindFolderOf(fileName);
    default: return '';
  }
}
function fileNameFor(mail, fileName, nameRule) {
  const safe = sanitizeFileName(fileName);
  if (nameRule === 'date') return `${ymd(mail.received_ts)}_${safe}`;
  if (nameRule === 'sender') return `${senderOf(mail)}_${safe}`;
  return safe;
}

//  중복 회피: 같은 이름이 있으면 name-1.ext, name-2.ext …
//  existsFn 을 주입받아 순수 테스트가 가능하게 한다.
function uniqueName(dir, name, existsFn) {
  const exists = existsFn || ((p) => fs.existsSync(p));
  if (!exists(path.join(dir, name))) return name;
  const e = extOf(name);
  const base = e ? name.slice(0, name.length - e.length - 1) : name;
  for (let i = 1; i < 1000; i++) {
    const cand = e ? `${base}-${i}.${e}` : `${base}-${i}`;
    if (!exists(path.join(dir, cand))) return cand;
  }
  return `${base}-${Date.now()}${e ? '.' + e : ''}`;
}

// ------------------------------------------------------------
//  멱등 매니페스트 — destRoot 1곳당 1개. mail_id+원본파일명+크기 로 "이미 정리됨"을 기억한다.
//  경로 기반(같은 이름+크기가 그 자리에 있나) 검사는 정리 '구조'가 바뀌면 계산되는
//  하위 폴더가 달라져 못 잡는다(예: 날짜별 → 종류별로 재실행). 매니페스트는 구조와
//  무관하게 "이 메일의 이 첨부를 이 destRoot 에 이미 저장했는가"를 직접 기억해
//  구조를 바꿔 재실행해도 같은 파일을 중복으로 만들지 않는다.
//  ponytail: 동시 실행(같은 destRoot 를 두 프로세스가 동시에 씀) 락은 걸지 않는다 —
//  이 앱은 단일 창·단일 실행 흐름이라 실사용 위험이 낮다(업그레이드 경로: 파일 락).
// ------------------------------------------------------------
function manifestKeyOf(mailId, origName, size) {
  return `${mailId}::${String(origName || '').toLowerCase()}::${Number(size) || 0}`;
}
function loadManifest(manifestPath) {
  if (!manifestPath) return {};
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) || {}; }
  catch { return {}; }
}
function saveManifest(manifestPath, obj) {
  if (!manifestPath) return;
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(obj), 'utf8');
  } catch (e) { /* 매니페스트 저장 실패는 치명적이지 않다(다음 실행이 경로검사로 폴백) */ }
}

// ------------------------------------------------------------
//  실행 엔진
//   plan = { dest, structure, nameRule, kinds, mails:[{ id, entryId, subject, received_ts, project, sender_name, sender_email, files:[{name,size}] }] }
//   deps = { saveBatch(tasks)->[{entryId,paths}], onProgress(p), tmpDir, manifestPath }
//   반환 { ok, saved, skipped, failed, bytes, dest, files:[...], errors:[...] }
// ------------------------------------------------------------
async function execute(plan, deps = {}) {
  const saveBatch = deps.saveBatch;
  if (typeof saveBatch !== 'function') throw new Error('saveBatch 주입이 필요합니다');
  const onProgress = deps.onProgress || (() => {});
  const chk = checkDest(plan.dest, { extraBlocked: deps.extraBlocked || [] });
  if (!chk.ok) return { ok: false, error: chk.error };
  const destRoot = chk.dest;
  fs.mkdirSync(destRoot, { recursive: true });
  const manifest = loadManifest(deps.manifestPath);
  let manifestDirty = false;

  const mails = (plan.mails || []).filter(m => m && m.entryId);
  const kinds = plan.kinds || [];
  const structure = plan.structure || 'flat';
  const nameRule = plan.nameRule || 'orig';
  const stageRoot = deps.tmpDir || path.join(os.tmpdir(), 'bmail-organize', String(Date.now()));

  const out = { ok: true, dest: destRoot, saved: 0, skipped: 0, failed: 0, bytes: 0, files: [], errors: [] };
  const CHUNK = 10;
  for (let i = 0; i < mails.length; i += CHUNK) {
    const group = mails.slice(i, i + CHUNK);
    const tasks = group.map(m => ({ entryId: m.entryId, dir: path.join(stageRoot, String(m.id)) }));
    let results = [];
    try {
      results = await saveBatch(tasks);
    } catch (e) {
      out.errors.push(`첨부 추출 실패(메일 ${group.length}건): ${e.message || e}`);
      out.failed += group.length;
      onProgress({ done: Math.min(i + CHUNK, mails.length), total: mails.length, saved: out.saved, skipped: out.skipped });
      continue;
    }
    const byId = new Map(results.map(r => [String(r.entryId), r.paths || []]));

    for (const m of group) {
      const paths = byId.get(String(m.entryId)) || [];
      for (const src of paths) {
        try {
          if (!fs.existsSync(src)) continue;
          const origName = path.basename(src);
          if (!matchesKind(origName, kinds)) continue;
          const srcSize = fs.statSync(src).size;

          // 멱등 1순위: 매니페스트(mail_id+원본파일명+크기) — 구조를 바꿔 재실행해도
          // 이미 이 destRoot 어딘가에 저장했던 첨부라면 다른 경로로 또 만들지 않는다.
          const mkey = manifestKeyOf(m.id, origName, srcSize);
          const prior = manifest[mkey];
          if (prior && fs.existsSync(prior.path)) {
            out.skipped++;
            continue;
          }

          const sub = subdirFor(m, origName, structure);
          const dir = sub ? path.join(destRoot, sub) : destRoot;
          // 경로 조작 방어 — 계산 결과가 destRoot 밖이면 절대 쓰지 않는다
          if (!isInside(dir, destRoot)) { out.errors.push(`경로 이탈 차단: ${dir}`); continue; }
          fs.mkdirSync(dir, { recursive: true });

          const wanted = fileNameFor(m, origName, nameRule);
          // 멱등 2순위(매니페스트가 없던 과거 실행분·경로 기반 방어): 같은 이름+같은 크기가
          // 이 경로에 이미 있으면 다시 쓰지 않는다.
          const already = path.join(dir, wanted);
          if (fs.existsSync(already) && fs.statSync(already).size === srcSize) {
            out.skipped++;
            manifest[mkey] = { path: already, at: new Date().toISOString() };
            manifestDirty = true;
            continue;
          }
          const finalName = uniqueName(dir, wanted);
          const target = path.join(dir, finalName);
          fs.copyFileSync(src, target, fs.constants.COPYFILE_EXCL);   // 덮어쓰기 금지
          out.saved++;
          out.bytes += srcSize;
          out.files.push({ mailId: m.id, name: finalName, dir, sizeKB: Math.round(srcSize / 1024) });
          manifest[mkey] = { path: target, at: new Date().toISOString() };
          manifestDirty = true;
        } catch (e) {
          out.failed++;
          out.errors.push(`${path.basename(src)}: ${e.message || e}`);
        }
      }
    }
    onProgress({ done: Math.min(i + CHUNK, mails.length), total: mails.length, saved: out.saved, skipped: out.skipped });
  }

  // 임시 추출 폴더 정리 (원본 메일이 아니라 임시본만 지운다)
  try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch { /* 남아도 무해 */ }
  if (manifestDirty) saveManifest(deps.manifestPath, manifest);
  return out;
}

//  destRoot 1곳당 매니페스트 파일 1개 경로를 결정한다(userData 안, 대상 폴더는 오염시키지 않음).
//  crypto 는 node 표준(신규 의존성 0).
function manifestPathFor(userDataDir, destRoot) {
  const crypto = require('crypto');
  const key = path.resolve(String(destRoot || '')).replace(/[\\/]+$/, '').toLowerCase();
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
  return path.join(userDataDir, 'organize-manifests', `${hash}.json`);
}

module.exports = {
  KIND_DEFS, STRUCTURE_LABEL, NAMERULE_LABEL,
  parseOrganizeIntent, checkDest, matchesKind, kindsLabel,
  subdirFor, fileNameFor, sanitizeSeg, sanitizeFileName, uniqueName, kindFolderOf, extOf, ymd,
  manifestKeyOf, loadManifest, saveManifest, manifestPathFor,
  execute
};

// ============================================================
//  셀프체크 — node src/attach-organize.js
// ============================================================
if (require.main === module) {
  const assert = require('assert');
  const ROOTS = { documents: 'D:\\Docs', desktop: 'D:\\Desk', downloads: 'D:\\Down', home: 'D:\\Home' };

  // ① 마스터 예시 문장 1 — 발신자·종류·경로
  const i1 = parseOrganizeIntent('KSIT에서 온 메일 중 도면 첨부만 문서\\도면정리\\KSIT에 정리해줘', { roots: ROOTS });
  assert.strictEqual(i1.isOrganize, true, '정리 의도를 못 잡음');
  assert.strictEqual(i1.dest, path.join('D:\\Docs', '도면정리', 'KSIT'), `목적지 오파싱: ${i1.dest}`);
  assert.deepStrictEqual(i1.kinds, ['drawing'], `종류 오파싱: ${i1.kinds}`);
  assert.strictEqual(i1.structure, 'flat');
  assert.ok(i1.searchText.includes('KSIT'), '검색 문구에서 KSIT 가 사라짐');
  assert.ok(!/정리/.test(i1.searchText), '검색 문구에 액션 낱말이 남음');

  // ② 마스터 예시 문장 2 — 드라이브 경로 + 날짜별
  const i2 = parseOrganizeIntent('지난달 22K FD 첨부 전부 D:\\작업\\22KFD에 날짜별로 저장해', { roots: ROOTS });
  assert.strictEqual(i2.isOrganize, true);
  assert.strictEqual(i2.dest, 'D:\\작업\\22KFD', `경로 조사 제거 실패: ${i2.dest}`);
  assert.strictEqual(i2.structure, 'date');
  assert.deepStrictEqual(i2.kinds, []);

  // ③ 후속 대화 — "PDF만" / "날짜별로" 는 직전 계획을 수정한다
  const f1 = parseOrganizeIntent('PDF만', { prev: i1, roots: ROOTS });
  assert.strictEqual(f1.isOrganize, true, '후속 수정 인식 실패');
  assert.strictEqual(f1.dest, i1.dest, '후속 수정에서 경로가 바뀜');
  assert.deepStrictEqual(f1.kinds, ['pdf']);
  const f2 = parseOrganizeIntent('날짜별 폴더로', { prev: f1, roots: ROOTS });
  assert.strictEqual(f2.structure, 'date');
  assert.deepStrictEqual(f2.kinds, ['pdf'], '후속 수정에서 종류가 유실됨');
  assert.strictEqual(f2.searchText, i1.searchText, '후속 수정에서 검색조건이 유실됨');

  // ④ 정리 의도가 아닌 일반 질문은 통과시키지 않는다(오작동 방지)
  assert.strictEqual(parseOrganizeIntent('KSIT 메일 뭐 왔어?', { roots: ROOTS }).isOrganize, false);
  assert.strictEqual(parseOrganizeIntent('첨부 정리해줘', { roots: ROOTS }).isOrganize, false, '경로 없이 실행되면 안 된다');

  // ⑤ 경로 안전장치
  assert.strictEqual(checkDest('C:\\Windows\\System32').ok, false, '시스템 폴더가 뚫림');
  assert.strictEqual(checkDest('C:\\Program Files\\x').ok, false, 'Program Files 가 뚫림');
  assert.strictEqual(checkDest('c:\\programdata\\y').ok, false, 'ProgramData 가 뚫림');
  assert.strictEqual(checkDest('C:\\').ok, false, '드라이브 루트가 뚫림');
  assert.strictEqual(checkDest('상대경로\\x').ok, false, '상대경로가 통과됨');
  assert.strictEqual(checkDest('').ok, false);
  assert.strictEqual(checkDest('D:\\작업\\22KFD').ok, true, '정상 경로가 막힘');
  assert.strictEqual(checkDest('D:\\앱\\내부', { extraBlocked: ['D:\\앱'] }).ok, false, '추가 차단 목록이 안 먹음');

  // ⑥ 종류 필터
  assert.strictEqual(matchesKind('도면.dwg', ['drawing']), true);
  assert.strictEqual(matchesKind('사진.png', ['drawing']), false);
  assert.strictEqual(matchesKind('보고서.pdf', ['pdf']), true);
  assert.strictEqual(matchesKind('보고서.pdf', []), true, '종류 미지정이면 전부여야 한다');

  // ⑦ 구조·파일명 계산
  const M = { id: 1, received_ts: Date.parse('2026-07-02T10:00:00'), project: 'KSIT/2710', sender_name: '설병헌 상무' };
  assert.strictEqual(subdirFor(M, 'a.pdf', 'date'), '2026-07-02');
  assert.strictEqual(subdirFor(M, 'a.pdf', 'month'), '2026-07');
  assert.strictEqual(subdirFor(M, 'a.pdf', 'project'), 'KSIT 2710', '경로 금지문자가 안 걸러짐');
  assert.strictEqual(subdirFor(M, 'a.dwg', 'kind'), '도면');
  assert.strictEqual(subdirFor(M, 'a.pdf', 'flat'), '');
  assert.strictEqual(fileNameFor(M, '야나세조선(승인용 도면).pdf', 'orig'), '야나세조선(승인용 도면).pdf', '한글 파일명 손상');
  assert.strictEqual(fileNameFor(M, 'a.pdf', 'date'), '2026-07-02_a.pdf');
  assert.strictEqual(sanitizeFileName('a:b?c.pdf'), 'a b c.pdf');
  assert.strictEqual(sanitizeSeg('   '), '기타');

  // ⑧ 중복 회피
  const fake = new Set(['X\\a.pdf', 'X\\a-1.pdf']);
  assert.strictEqual(uniqueName('X', 'a.pdf', (p) => fake.has(p)), 'a-2.pdf');
  assert.strictEqual(uniqueName('X', 'b.pdf', (p) => fake.has(p)), 'b.pdf');

  // ⑨ 실행 엔진 — 실제 파일로 복사·멱등·덮어쓰기 금지 검증
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmail-org-'));
  const dest = path.join(tmp, 'out');
  const mails = [
    { id: 11, entryId: 'E1', received_ts: Date.parse('2026-07-02T10:00:00'), project: 'KSIT', sender_name: '설병헌' },
    { id: 12, entryId: 'E2', received_ts: Date.parse('2026-07-03T10:00:00'), project: 'KSIT', sender_name: '이창희' }
  ];
  // 가짜 saver: 요청받은 임시 폴더에 파일을 만들어 준다(= Outlook COM 대역)
  const saveBatch = async (tasks) => tasks.map(t => {
    fs.mkdirSync(t.dir, { recursive: true });
    const names = t.entryId === 'E1'
      ? ['야나세조선(승인용 도면).pdf', '서명로고.png']
      : ['도면_배치도.dwg', '견적서.xlsx'];
    const paths = names.map(n => {
      const p = path.join(t.dir, n);
      fs.writeFileSync(p, 'x'.repeat(1024));
      return p;
    });
    return { entryId: t.entryId, paths };
  });

  const plan = { dest, structure: 'date', nameRule: 'orig', kinds: ['drawing'], mails };
  const prog = [];
  execute(plan, { saveBatch, onProgress: (p) => prog.push(p) }).then(async (r1) => {
    assert.strictEqual(r1.ok, true, r1.error);
    assert.strictEqual(r1.saved, 2, `도면 필터 후 저장 수 불일치: ${r1.saved}`);   // pdf + dwg, png/xlsx 제외
    assert.ok(prog.length > 0, '진행률 콜백이 안 옴');
    const d1 = path.join(dest, '2026-07-02', '야나세조선(승인용 도면).pdf');
    const d2 = path.join(dest, '2026-07-03', '도면_배치도.dwg');
    assert.ok(fs.existsSync(d1), '날짜별 폴더/한글 파일명 저장 실패');
    assert.ok(fs.existsSync(d2), '두번째 메일 저장 실패');
    assert.ok(!fs.existsSync(path.join(dest, '2026-07-02', '서명로고.png')), '종류 필터가 안 먹었다');

    // 재실행 = 멱등 (중복 0)
    const r2 = await execute(plan, { saveBatch });
    assert.strictEqual(r2.saved, 0, `재실행에서 중복 저장됨: ${r2.saved}`);
    assert.strictEqual(r2.skipped, 2, `건너뜀 수 불일치: ${r2.skipped}`);

    // 같은 이름 · 다른 크기 → 덮어쓰지 않고 -1 로 붙는다
    fs.writeFileSync(d1, 'y'.repeat(2048));
    const r3 = await execute(plan, { saveBatch });
    assert.strictEqual(fs.readFileSync(d1, 'utf8').length, 2048, '기존 파일이 덮어써졌다');
    assert.ok(fs.existsSync(path.join(dest, '2026-07-02', '야나세조선(승인용 도면)-1.pdf')), '중복 접미(-1) 실패');
    assert.strictEqual(r3.saved, 1);

    // 시스템 경로는 실행 자체가 거부돼야 한다
    const r4 = await execute({ ...plan, dest: 'C:\\Windows\\Temp2' }, { saveBatch });
    assert.strictEqual(r4.ok, false, '시스템 경로 실행이 막히지 않았다');

    fs.rmSync(tmp, { recursive: true, force: true });

    // ⑩ 매니페스트 멱등 — 정리 '구조'를 바꿔 재실행해도(경로 기반 검사로는 못 잡는 케이스)
    //    mail_id+원본파일명+크기 매니페스트가 중복 생성을 막는다.
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'bmail-org2-'));
    const dest2 = path.join(tmp2, 'out');
    const manifestPath = path.join(tmp2, 'manifests', 'x.json');
    const mails2 = [{ id: 21, entryId: 'E1', received_ts: Date.parse('2026-07-02T10:00:00'), project: 'KSIT', sender_name: '설병헌' }];
    const saveBatch2 = async (tasks) => tasks.map(t => {
      fs.mkdirSync(t.dir, { recursive: true });
      const p = path.join(t.dir, '도면.dwg');
      fs.writeFileSync(p, 'z'.repeat(512));
      return { entryId: t.entryId, paths: [p] };
    });
    const planA = { dest: dest2, structure: 'date', nameRule: 'orig', kinds: [], mails: mails2 };
    const rA = await execute(planA, { saveBatch: saveBatch2, manifestPath });
    assert.strictEqual(rA.saved, 1, '매니페스트 1차 실행 저장 실패');
    assert.ok(fs.existsSync(manifestPath), '매니페스트 파일이 저장되지 않음');

    const planB = { ...planA, structure: 'kind' };   // 날짜별 -> 종류별로 구조 변경
    const rB = await execute(planB, { saveBatch: saveBatch2, manifestPath });
    assert.strictEqual(rB.saved, 0, `구조 변경 재실행에서 매니페스트가 중복을 못 막음: ${rB.saved}`);
    assert.strictEqual(rB.skipped, 1, `구조 변경 재실행 건너뜀 수 불일치: ${rB.skipped}`);
    assert.ok(!fs.existsSync(path.join(dest2, '도면')), '구조 변경으로 새 폴더가 또 생겼다(중복 생성)');

    assert.strictEqual(manifestPathFor('U', 'D:\\작업\\22KFD'), manifestPathFor('U', 'D:\\작업\\22KFD\\'), '경로 정규화가 매니페스트 파일명에 안 먹음');
    fs.rmSync(tmp2, { recursive: true, force: true });

    console.log('attach-organize 셀프체크 OK — 의도파싱(예시2건·후속수정·오작동방지) + 경로안전(시스템/루트/상대/추가차단) + 종류필터 + 구조·한글파일명 + 중복회피 + 매니페스트 멱등(구조변경 재실행 차단) + 실행(복사·멱등·덮어쓰기금지) 통과');
  }).catch((e) => {
    console.error('attach-organize 셀프체크 실패:', e.message);
    process.exit(1);
  });
}
