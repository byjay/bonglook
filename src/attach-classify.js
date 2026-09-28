// ============================================================
//  첨부 분류 (단일 책임: '진짜 첨부' vs '본문/서명에 박힌 인라인 이미지')
//   ※ 첨부 '내용 추출'은 attachments.js 담당. 여기는 '분류'만 한다.
//
//   ★ 판정은 MAPI 속성이 1순위. 크기·파일명 휴리스틱은 속성이 없을 때만 쓴다.
//     실측(2026-07-30, 메일 6통·38개 첨부)에서 84KB·98KB·113KB png 도 전부
//     cid 참조가 붙은 인라인이었다 → 크기만으로 자르면 오판한다.
//
//   실측한 신호:
//     PR_ATTACH_CONTENT_ID (0x3712001F) : 인라인이면 'xxxx@lw00000N' 형태로 존재
//     HTMLBody 에 'cid:<그 값>' 참조가 실제로 있는지
//     PR_ATTACH_FLAGS (0x37140003) : 인라인 = 5 (ATT_MHTML_REF 4 | ATT_INVISIBLE_IN_HTML 1)
//                                    일반 첨부 = 0
//     PR_ATTACHMENT_HIDDEN (0x7FFE000B) : true 면 숨김
// ============================================================

// 이 확장자는 크기·플래그와 무관하게 '항상 진짜 첨부'로 본다.
// (도면·문서를 인라인으로 오판해 숨기면 업무 파일이 사라진 것처럼 보인다 — 절대 금지)
const ALWAYS_REAL_EXT = new Set([
  'pdf', 'dwg', 'dxf', 'dwf', 'stp', 'step', 'igs', 'iges', 'sat', 'x_t',
  'xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'doc', 'docx', 'ppt', 'pptx', 'hwp', 'hwpx',
  'zip', 'rar', '7z', 'alz', 'egg', 'tar', 'gz',
  'txt', 'rtf', 'xml', 'json', 'eml', 'msg', 'vsd', 'vsdx', 'mpp', 'psd', 'ai'
]);

const IMAGE_EXT = new Set(['png', 'gif', 'jpg', 'jpeg', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'ico', 'emf', 'wmf']);

const ATT_INVISIBLE_IN_HTML = 0x1;
const ATT_MHTML_REF = 0x4;

// 인라인 이미지가 흔히 갖는 이름: image001.png / 해시 8~40자 / 로고·서명·배너류
const NAMEY_INLINE = [
  /^image\d*\.(png|gif|jpe?g|bmp)$/i,
  /^[0-9a-f]{8,40}\.(png|gif|jpe?g|bmp)$/i,
  /^(logo|signature|sign|banner|footer|header|icon|spacer|blank|line|bar)[-_ ]?\d*\.(png|gif|jpe?g|bmp)$/i,
  /로고|서명|배너|구분선|파일\s*다운로드/
];

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9_]+)$/);
  return m ? m[1] : '';
}

// ------------------------------------------------------------
//  단일 첨부 판정
//   a = { name, size, cid, flags, hidden, cidReferenced }
//   반환 { inline: boolean, reason: string }
// ------------------------------------------------------------
function classifyAttachment(a = {}) {
  const name = String(a.name || '');
  const ext = extOf(name);
  const size = Number(a.size) || 0;
  const cid = String(a.cid == null ? '' : a.cid).trim();
  const rawFlags = a.flags;
  const flags = (rawFlags === null || rawFlags === undefined || rawFlags === '' || rawFlags === '(none)')
    ? null : Number(rawFlags);
  const hidden = a.hidden === true || a.hidden === 'True' || a.hidden === 1;

  // ① 문서·도면·압축은 무조건 진짜 첨부 (오판 방지 최우선)
  if (ALWAYS_REAL_EXT.has(ext)) return { inline: false, reason: 'doc-ext' };

  // ② cid 가 있고 본문이 실제로 그것을 참조 → 확실한 인라인
  if (cid && a.cidReferenced === true) return { inline: true, reason: 'cid-ref' };

  // ③ MHTML 참조 플래그 (Outlook 이 인라인에 붙이는 값)
  if (flags !== null && !isNaN(flags) && (flags & ATT_MHTML_REF)) return { inline: true, reason: 'flags-mhtml' };

  // ④ 숨김 속성
  if (hidden) return { inline: true, reason: 'hidden' };

  // ⑤ HTML 에서 안 보이게 표시된 첨부
  if (flags !== null && !isNaN(flags) && (flags & ATT_INVISIBLE_IN_HTML)) return { inline: true, reason: 'flags-invisible' };

  // ⑥ cid 는 있는데 본문 참조를 못 찾은 이미지
  //    (본문에서 지워졌거나 HTMLBody 를 못 읽은 경우) — 이미지일 때만 인라인으로 본다
  if (cid && IMAGE_EXT.has(ext)) return { inline: true, reason: 'cid-orphan' };

  // ⑦ MAPI 속성을 전혀 못 읽은 경우에만 쓰는 폴백 휴리스틱
  //    이미지 + 150KB 미만 + 인라인스러운 이름, 세 조건을 모두 만족할 때만.
  if ((flags === null || isNaN(flags)) && !cid && IMAGE_EXT.has(ext) && size > 0 && size < 150 * 1024) {
    if (NAMEY_INLINE.some(re => re.test(name))) return { inline: true, reason: 'heuristic-name' };
  }

  return { inline: false, reason: 'real' };
}

// 목록 판정 + 요약
function classifyList(list = []) {
  const items = (list || []).map(a => {
    const c = classifyAttachment(a);
    return { ...a, inline: c.inline, reason: c.reason };
  });
  const real = items.filter(x => !x.inline);
  return { items, real, inline: items.filter(x => x.inline), realCount: real.length, total: items.length };
}

// --- 셀프체크: 실측 데이터로 회귀를 막는다 ---
function selfTest() {
  const chk = (a, want, label) => {
    const got = classifyAttachment(a).inline;
    if (got !== want) throw new Error(`첨부 판정 회귀: ${label} → inline=${got} (기대 ${want})`);
  };
  // 실측 표본 (메일 #4489)
  chk({ name: 'image.png', size: 32924, cid: 'x@lw000000', flags: 5, cidReferenced: true }, true, '서명 이미지');
  chk({ name: 'a92d79260b3b.png', size: 113051, cid: 'y@lw000006', flags: 5, cidReferenced: true }, true, '113KB 인라인');
  chk({ name: '파일 다운로드.png', size: 1531, cid: 'z@lw000009', flags: 5, cidReferenced: true }, true, '다운로드 아이콘');
  chk({ name: '260716-FOR APPROVAL_09 2710 LS-WC(260723).pdf', size: 621109, cid: '', flags: 0, cidReferenced: false }, false, '진짜 PDF');
  // 오판 금지 케이스
  chk({ name: '도면_배치도.png', size: 2400000, cid: '', flags: 0, cidReferenced: false }, false, '큰 도면 png');
  chk({ name: 'SCAN_0001.jpg', size: 900000, cid: '', flags: 0, cidReferenced: false }, false, '스캔 이미지');
  chk({ name: '견적서.xlsx', size: 5000, cid: 'a@b', flags: 5, cidReferenced: true }, false, '문서는 항상 진짜');
  chk({ name: 'photo.png', size: 40000, cid: '', flags: null, cidReferenced: false }, false, '속성없음+평범한 이름');
  chk({ name: 'image001.png', size: 4000, cid: '', flags: null, cidReferenced: false }, true, '속성없음+인라인 이름');
  return true;
}

module.exports = { classifyAttachment, classifyList, selfTest, ALWAYS_REAL_EXT, IMAGE_EXT, extOf };
