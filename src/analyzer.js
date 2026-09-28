// ============================================================
//  analyzer.js - AI 기반 메일 분석 (Cerebras 사용)
//  ------------------------------------------------------------
//  기능:
//   1) briefing()   : 기간 내 전체 메일을 종합 → 내 스케줄/한 일/놓친 일/
//                     누가 언제 무엇을 보냈는지 요약 (한국어)
//   2) translateAnalyze() : 영어/중국어 등 외국어 메일 번역 + 요점 분석
//   3) draftReply() : 메일에 대한 답장 초안 작성 (원문 언어에 맞춰)
//   4) chatOverMails() : DB 검색결과를 컨텍스트로 대화형 질의응답
//  ------------------------------------------------------------
//  모든 결과는 main.js 에서 db.addAnalysis()로 저장됨.
// ============================================================
const cerebras = require('./cerebras');

// ------------------------------------------------------------
//  프롬프트 토큰 상한 방어 (마스터 지시: Groq 무료 티어 8K TPM 대응)
//  ------------------------------------------------------------
//  요청 전 문자수/3 근사로 토큰을 추정해 상한(기본 6,000)을 넘으면 자동 축소하고,
//  413/toolarge 응답이 와도 다음 축소 단계로 1회 더 재시도한다. 조용한 실패 금지 —
//  축소가 일어나면 promptReduced:true 를 결과에 남겨 화면에 배지로 보여준다.
//  buildFn(step) => messages 배열. steps[0] = 원본(무축소), 이후는 점점 강한 축소.
// ------------------------------------------------------------
const DEFAULT_TOKEN_LIMIT = 6000;
async function chatWithBudget({ keys, model, buildFn, steps, temperature = 0.2, maxTokens = 3000, tokenLimit = DEFAULT_TOKEN_LIMIT }) {
  let reduced = false;
  let lastRes = null;
  for (let i = 0; i < steps.length; i++) {
    const messages = buildFn(steps[i]);
    const est = cerebras.messagesTokens(messages);
    // 원본 단계인데 이미 상한 초과 + 축소 단계가 더 있으면 호출 없이 곧장 축소본으로 넘어간다
    if (i === 0 && est > tokenLimit && steps.length > 1) { reduced = true; continue; }
    if (i > 0) reduced = true;
    const res = await cerebras.chat({ keys, model, messages, temperature, maxTokens });
    if (res.ok) return Object.assign({}, res, { promptReduced: reduced, reduceStep: i, estTokens: est });
    lastRes = res;
    // 413(toolarge) 이면 다음 축소 단계로 1회 더 재시도, 그 외 실패는 즉시 반환(체인 폴백은 chat() 내부에서 이미 시도됨)
    if (res.errorKind === 'toolarge' && i < steps.length - 1) { reduced = true; continue; }
    return Object.assign({}, res, { promptReduced: reduced });
  }
  return lastRes ? Object.assign({}, lastRes, { promptReduced: reduced }) : { ok: false, error: '요청을 생성하지 못했습니다.' };
}

const LANG_NAME = { ko: '한국어', en: '영어', zh: '중국어', ja: '일본어', unknown: '알 수 없음' };

// ------------------------------------------------------------
//  페이로드 감량: 메일 전문 대신 필요한 필드만 요약 1줄+본문 발췌
//  (전문을 보내면 분당 토큰 한도(429)에 즉시 걸린다)
// ------------------------------------------------------------
function mailDigest(m, myEmails = new Set(), bodyChars = 300) {
  const sent = myEmails.has(String(m.sender_email || '').toLowerCase());
  // ★ 받은 메일은 '직접 수신(To)'과 '참조(CC)'를 구분해 알려준다.
  //   참조는 통보 성격이 많아 AI 가 할 일 우선순위를 판단할 때 중요하다.
  const role = m.to_me === 1 ? '받음(직접)' : (m.to_me === 0 ? '받음(참조)' : '받음');
  const dir = sent ? '보냄' : role;
  const body = (m.body || m.preview || '').replace(/\s+/g, ' ').slice(0, bodyChars);
  // 첨부 수는 '진짜 첨부'(서명 로고·본문 삽입 이미지 제외) 기준으로 알려 준다.
  const realCnt = (m.real_attach_count !== undefined && m.real_attach_count !== null)
    ? m.real_attach_count : (m.attach_count || m.attachCount || '');
  const att = (m.has_attach || m.hasAttach) ? ` |첨부${realCnt}` : '';
  return `${m.received_at || m.received || ''}|${dir}|${m.sender_name || m.sender || ''}|${m.folder || ''}|${m.subject || ''}${att}\n  ${body}`;
}

// 메일 목록을 프롬프트용 텍스트로 압축
function mailsToContext(mails, maxBody = 500) {
  return mails.map((m, i) => {
    const body = (m.body || m.preview || '').replace(/\s+/g, ' ').slice(0, maxBody);
    return `[${i + 1}] 날짜:${m.received_at || m.received || ''} | 발신:${m.sender_name || m.sender || ''} <${m.sender_email || m.senderMail || ''}> | 제목:${m.subject || ''}${m.has_attach || m.hasAttach ? ' (첨부있음)' : ''}\n   내용: ${body}`;
  }).join('\n\n');
}

// ------------------------------------------------------------
//  1) 종합 브리핑
// ------------------------------------------------------------
async function briefing({ keys, model, mails, periodLabel = '최근 기간', onProgress = () => {}, concurrency = 3 }) {
  if (!mails || mails.length === 0) {
    return { ok: false, error: '분석할 메일이 없습니다. 먼저 동기화(가져오기)를 실행하세요.' };
  }
  // 대량 호출 공용 엔진 사용 (분당 토큰 한도 429 방지)
  const texts = mails.map(m => mailDigest(m, new Set(), 300));
  const SECTIONS = [
    '## 핵심 요약 (3~5줄)',
    '## 내 스케줄·일정 (메일에 언급된 회의·마감·약속을 날짜와 함께)',
    '## 최근 처리·진행된 일',
    '## 내가 놓치고 있을 수 있는 것 (미회신·마감임박·중요요청)',
    '## 주요 발신자별 요약 (누가 언제 무엇을 보냈는지)',
    '## 첨부·도면 관련 (있으면)'
  ].join('\n');

  return cerebras.mapReduce({
    keys, model, texts, onProgress, mode: 'batch',   // 배치·자동 작업 — Groq 우선(마스터 지시)
    chunkChars: 14000, temperature: 0.3, mapMaxTokens: 1400, reduceMaxTokens: 4096, concurrency,
    mapSystem: [
      '당신은 개인 이메일 비서입니다. 아래 메일 목록(날짜|보냄/받음|발신자|폴더|제목 + 본문발췌)의 요점을',
      '한국어 불릿으로 간결히 정리하세요. 일정·마감·요청·첨부는 반드시 남기세요.',
      '추측 금지. 근거 없는 내용은 쓰지 마세요.'
    ].join('\n'),
    mapHeader: `분석 기간: ${periodLabel}`,
    reduceSystem: [
      '당신은 개인 이메일 비서입니다. 아래 부분 정리들을 종합해 한국어 브리핑을 작성하세요.',
      '다음 섹션을 반드시 마크다운으로 구성하세요:',
      SECTIONS,
      '중복은 합치고, 부분 정리에 없는 내용은 만들지 마세요.'
    ].join('\n'),
    reduceHeader: `분석 기간: ${periodLabel} · 총 ${mails.length}건`
  });
}

// ------------------------------------------------------------
//  2) 외국어 메일 번역 + 분석
// ------------------------------------------------------------
// 응답에서 JSON 객체만 안전하게 추출 (모델이 앞뒤에 설명을 붙여도 복구)
function extractJson(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(s);
  const first = s.indexOf('{'), last = s.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const o = JSON.parse(c.trim());
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch (_) {}
  }
  return null;
}

// ------------------------------------------------------------
//  도면번호·호선번호·프로젝트코드 자동 추출 (규칙기반 — AI 호출 없음, 원문 정규식 매칭이라
//  '문자열 대조 검증'이 구조적으로 항상 성립한다. 마스터 예시: 2710/11, M-011, 22K FD, KYTS-1037)
//  ponytail: 조선 실무 표기 관행에 맞춘 휴리스틱 정규식이다. 완벽한 문법 파서가 아니며,
//    새 표기 패턴이 나오면 이 정규식 목록에 추가하는 방식으로 확장한다(과설계 방지).
// ------------------------------------------------------------
const CODE_PATTERNS = [
  { re: /\b\d{3,5}\s?\/\s?\d{1,3}\b/g, kind: '호선번호' },              // 2710/11
  { re: /\b\d{1,3}\s?K\s?F\s?\/?\s?D\b/gi, kind: '프로젝트코드' },       // 22K FD
  { re: /\b[A-Z]{2,6}-\d{3,6}\b/g, kind: '프로젝트코드' },               // KYTS-1037
  { re: /\b[A-Z]{1,3}-\d{2,4}(?:-\d{1,3})?\b/g, kind: '도면번호' },      // M-011
  { re: /\bHull\s?No\.?\s?\d{3,5}\b/gi, kind: '호선번호' }
];
function extractProjectCodes(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();
  for (const { re, kind } of CODE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      const v = m[0].trim();
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value: v, kind });
      if (out.length >= 30) return out;   // 과도한 오탐 방지 상한
    }
  }
  return out;
}

// ------------------------------------------------------------
//  AI 가 뽑은 값(기한·핵심정보)이 실제로 원문에 있는지 대조한다(환각 방지).
//  ★ 마스터 지시: "추출된 도면번호·기한은 원문에 실제로 존재하는지 문자열 대조 검증 후
//    표시(없으면 제외)". 완전 동일 문자열이 아니어도(모델이 포맷을 바꿀 수 있음) 숫자만
//    뽑아 순서대로 원문에 나타나면 grounded 로 인정한다(느슨하지만 결정적인 검증).
// ------------------------------------------------------------
function isGrounded(value, haystack) {
  const v = String(value || '').trim();
  if (!v) return true;                      // 빈 값은 애초에 지어낼 게 없다
  const hay = String(haystack || '');
  if (hay.toLowerCase().includes(v.toLowerCase())) return true;
  const digits = v.replace(/[^0-9]/g, '');
  if (digits.length >= 2) {
    const pattern = digits.split('').join('[^0-9]{0,2}');
    try { if (new RegExp(pattern).test(hay)) return true; } catch (_) { /* 무시 */ }
  }
  return false;
}

// 구조화 결과 정규화 (모델이 필드를 빠뜨려도 UI 가 안전하게 렌더되도록)
//  groundHaystack — actions[].due / keyFacts[].value 를 대조할 원문(본문+제목+스레드 맥락 포함).
function normalizeAnalysis(o, mail, isKo, groundHaystack) {
  const arr = (v) => Array.isArray(v) ? v.filter(x => x !== null && x !== undefined && String(x).trim() !== '') : [];
  const hay = groundHaystack || `${mail.subject || ''} ${mail.body || mail.preview || ''}`;
  const actions = arr(o.actions).map(a => (typeof a === 'string'
    ? { task: a, owner: '', due: '' }
    : { task: String(a.task || a.what || ''), owner: String(a.owner || a.who || ''), due: String(a.due || a.deadline || '') }))
    .filter(a => a.task)
    // ★ 기한이 원문에서 확인 안 되면 기한만 비운다(할 일 자체는 남긴다 — 과삭제 방지)
    .map(a => (a.due && !isGrounded(a.due, hay)) ? { ...a, due: '' } : a);
  const keyFacts = arr(o.keyFacts).map(k => (typeof k === 'string'
    ? { label: '', value: k }
    : { label: String(k.label || ''), value: String(k.value || '') }))
    .filter(k => k.value)
    // ★ 값이 원문에 없으면 근거 없는 핵심정보이므로 통째로 제외
    .filter(k => isGrounded(k.value, hay));
  return {
    lang: o.lang || mail.lang || 'unknown',
    translationSkipped: !!isKo,
    // ★ 이중 방어: 모델이 번역을 채워 보내도 한국어 메일이면 버린다
    translated: isKo ? '' : String(o.translated || o.translation || ''),
    summary: arr(o.summary).map(String),
    actions,
    keyFacts,
    replyTips: arr(o.replyTips).map(String),
    // ★ 마스터 지시(임무B): 결정/합의 사항 · 미결/리스크 · 도면·호선·프로젝트 코드
    decisions: arr(o.decisions).map(String),
    risks: arr(o.risks).map(String),
    codes: extractProjectCodes(hay)   // 규칙기반 — LLM 출력과 무관, 항상 원문 대조됨
  };
}

// 한국어 메일 판정 보정
//  db.detectLang 은 '문자 종류별 최대 개수'로 판정하므로, 영문 서명·헤더·인용문이
//  긴 한국어 메일이 en 으로 오판된다(실측: 본문이 한국어인데 en → 불필요한 번역 2,777자 생성).
//  → 한글이 일정 분량 이상이면 한국어 메일로 보고 번역을 생략한다.
// 인용(이전 메일) 구간을 잘라내고 '새로 쓴 본문'만 남긴다.
//  실무 메일은 영문 인용 스레드가 본문보다 훨씬 길어, 전체로 판정하면 한국어 메일이
//  영어로 오판된다(실측: 본문 "수신: …" 한국어인데 번역 생성됨).
function stripQuoted(text) {
  const s = String(text || '');
  const markers = [
    /-{2,}\s*(?:Original Message|원본 메시지|이전 메시지|아래 원문)\s*-{2,}/i,
    /_{10,}/,
    /^\s*(?:From|Sent|To|Subject)\s*:\s.+$/m,
    /^\s*(?:보낸 사람|보낸사람|보낸 날짜|받는 사람|받는사람|제목)\s*:\s.+$/m,
    /^\s*>{1,}\s?\S/m,
    /^\s*On .{5,60}\bwrote:\s*$/m,
    // 중국어/일본어 메일 클라이언트 인용 머리말 (실측 id=57: "---- 回复的原邮件 ----" 미인식으로
    // 인용 스레드가 새 본문으로 계산돼 언어 판정이 뒤집혔다)
    /-{2,}\s*(?:回复的原邮件|原始邮件|轉寄郵件|元のメッセージ)\s*-{2,}/,
    /^\s*(?:发件人|發件人|差出人|送信者)\s*[:：]\s*\S/m
  ];
  let cut = s.length;
  for (const re of markers) {
    const m = s.match(re);
    if (m && typeof m.index === 'number' && m.index > 0 && m.index < cut) cut = m.index;
  }
  return s.slice(0, cut);
}

// 한국어 문장 종결 신호 — 한국어로 '쓴' 메일에는 거의 반드시 나타난다.
//  영문 메일에 딸린 한글 서명(회사명·직함·주소)에는 나타나지 않아 둘을 가르는 결정적 신호다.
const KO_ENDINGS = /(습니다|입니다|합니다|십니다|드립니다|하세요|주세요|바랍니다|였습|겠습|니까|드림|올림)/g;

// 새 본문의 언어 지표 (한글수·라틴수·한국어 종결어미수)
function langScore(text) {
  const full = String(text || '').slice(0, 20000);
  const head = stripQuoted(full);
  // 인용 마커가 첫 줄 근처에 걸려 새 본문이 통째로 잘렸을 때만 전체로 되돌린다.
  //  ★ 기준을 '40자'로 두면 "hi Danny got it"(15자) 같은 짧은 회신이 인용문까지 합쳐 판정돼
  //    언어가 뒤집혔다(실측 id=57). 글자(한글+라틴)가 5자 이상이면 그 자체로 판정 가능하다.
  const letters = (head.match(/[가-힣A-Za-z]/g) || []).length;
  const target = letters >= 5 ? head : full;
  return {
    hangul: (target.match(/[가-힣]/g) || []).length,
    latin: (target.match(/[A-Za-z]/g) || []).length,
    koEnd: (target.match(KO_ENDINGS) || []).length
  };
}

// 한국어 메일 판정 (번역 생략 · 답장 언어 공용 기준) — 새 본문 기준
//  실측 근거(최근 600건 표본):
//   · 구 규칙 "한글 30자 이상이면 한국어" 는 영문 본문 1,023자 + 한글 서명 33자 메일을
//     한국어로 오판했다(id=15103 → 영어 메일에 한국어 답장·번역 생략).
//   · 반대로 "업무에 수고 많습니다 … 감사합니다"(한글 29자) + 영문 서명 357자 메일은
//     비율만 보면 영어로 오판됐다(id=1194/573/578/580/620).
//   → 종결어미 신호를 1순위, 비율을 2순위로 둔다. 표본 600건 중 판정 뒤집힘 14건 전부 개선 확인.
function looksKorean(text) {
  const { hangul, latin, koEnd } = langScore(text);
  if (hangul === 0) return false;
  if (latin === 0) return true;                      // 짧은 순한글 회신("확인했습니다.")
  if (koEnd >= 2) return true;                       // 한국어로 쓴 문장이 둘 이상 → 한국어
  if (koEnd >= 1 && hangul >= 15) return true;       // 짧은 한국어 본문 + 긴 영문 서명
  if (hangul * 3 >= latin) return true;              // 예: "PDF 검토 바랍니다."(한글6/라틴3, 실측 id=15112)
  return false;                                       // 종결어미 없고 라틴이 압도 → 한글 서명뿐인 영문 메일
}

// 메일 객체 단위 판정 — 본문이 있으면 '이번에 쓴 새 본문'만 보고 판정한다.
//  mails.lang 은 인용 스레드까지 합쳐 계산한 값이라 그대로 믿으면 안 된다(실측 오판 3,301건).
function isKoreanMail(mail) {
  if (!mail) return false;
  const body = String(mail.body || mail.preview || '');
  if (!body.trim()) return String(mail.lang || '') === 'ko';
  return looksKorean(body);
}

// 내가 보낸 메일인지 (보낸 편지함) — 분석 관점을 바꿔야 한다
function isSentMail(mail) {
  return String((mail && (mail.folder || mail.folderName)) || '') === 'Sent';
}

//  refine: { instruction, previous } — 대화로 분석을 고칠 때 쓴다(마스터 요구: 분석 후 계속 대화).
//  threadContext: 같은 대화(thread_key)의 이전 메일들(오래된순, 최대 N통) — mailDigest 로 압축해 넣는다.
//  attachments: 진짜 첨부 파일명 목록([{name}]) — "무슨 도면/문서가 왔는지" 핵심정보 반영용.
async function translateAnalyze({ keys, model, mail, refine = null, providerOverride = null, threadContext = [], attachments = [], attachmentContext = '' }) {
  const lang = mail.lang || 'unknown';
  const fullBody = mail.body || mail.preview || '';
  const isKo = isKoreanMail(mail);   // lang + 새 본문 기준 통합 판정
  // ★ 보낸 메일은 '내가 쓴 글'이라 "내가 해야 할 일"을 뽑는 기본 관점이 맞지 않는다.
  //   → 내가 상대에게 요청한 사항 + 내가 후속으로 확인할 것으로 관점을 바꾼다(마스터 실사용 지적).
  const sent = isSentMail(mail);
  //  ★ 그라운딩 대조용 원문(기한·핵심정보·도면번호는 이 범위 안에 실제로 있어야 인정) — 항상 전체 기준.
  const groundHaystack = [mail.subject, fullBody, threadContext.map(m => `${m.subject || ''} ${m.body || m.preview || ''}`).join(' ')].join(' ');
  //  대화로 받은 수정 지시 — 스키마는 유지한 채 내용만 다시 만든다.
  const refineNote = refine && refine.instruction
    ? [
        '',
        '[수정 요청] 아래 이전 분석 결과를 사용자의 지시에 맞게 고쳐서 다시 출력하세요.',
        '지시에 없는 항목은 이전 값을 그대로 유지하고, 형식(JSON 스키마)은 바꾸지 마세요.',
        `사용자 지시: ${String(refine.instruction).slice(0, 500)}`,
        `이전 분석 결과: ${JSON.stringify(refine.previous || {}).slice(0, 4000)}`
      ].join(String.fromCharCode(10))
    : '';

  //  ★ 프롬프트 축소 재시도용 빌더 — step 마다 스레드 통수/본문 길이/첨부 개수를 줄여 재구성한다.
  function buildMessages(step) {
    const tc = threadContext.slice(-step.threadN);
    const body = fullBody.slice(0, step.bodyChars);
    const attList = attachments.slice(0, step.attMax);
    const threadBlock = tc.length
      ? ['', '[이전 대화 맥락(오래된순, 이 메일 이전)]',
         tc.map((m, i) => `${i + 1}. ${mailDigest(m, new Set(), step.threadBodyChars)}`).join('\n')].join('\n')
      : '';
    const attLine = attList.length
      ? `첨부(${attachments.length}건 중 ${attList.length}건 표시): ${attList.map(a => a.name || a.file_name || '').filter(Boolean).join(', ')}`
      : (attachments.length ? `첨부(${attachments.length}건, 목록 생략)` : '첨부: 없음');
    // ★ 첨부 '내용'(PDF·XLSX/CSV·DOCX·TXT, attach-content.js 가 캐시 우선으로 만든 텍스트) —
    //   토큰 상한 축소 단계(step.attContent===false)에서는 가장 무거운 이 블록을 먼저 빼서 재시도한다.
    const attContentBlock = (step.attContent !== false) ? (attachmentContext || '') : '';
    return [
      {
        role: 'system',
        content: [
          '당신은 비즈니스 이메일 분석가입니다. 결과를 아래 JSON 형식으로만 출력하세요.',
          '설명 문장, 마크다운, 코드펜스 없이 JSON 객체 하나만 출력합니다.',
          sent
            ? '★ 이 메일은 "사용자가 직접 상대에게 보낸 메일"입니다. 받은 메일처럼 다루지 마세요.'
            : '★ 이 메일은 사용자가 받은 메일입니다.',
          '{',
          '  "lang": "원문 언어 코드(ko/en/zh/ja/기타)",',
          isKo
            ? '  "translated": "",   // 원문이 한국어이므로 반드시 빈 문자열로 두세요(번역하지 마세요)'
            : '  "translated": "본문 전체를 자연스러운 한국어로 번역한 텍스트",',
          sent
            ? '  "summary": ["내가 상대에게 무엇을 보내고 무엇을 알렸는지 한국어 문장으로 3~6개"],'
            : '  "summary": ["핵심 요점을 한국어 문장으로 3~6개"],',
          sent
            ? '  "actions": [{"task":"내가 상대에게 요청한 사항 또는 내가 후속으로 확인해야 할 항목","owner":"이행 주체(상대 이름 또는 나)","due":"기한(없으면 빈 문자열)"}],'
            : '  "actions": [{"task":"해야 할 일","owner":"담당(없으면 빈 문자열)","due":"기한(없으면 빈 문자열)"}],',
          '  "keyFacts": [{"label":"항목명(호선/도면번호/금액/수량 등)","value":"값"}],',
          sent
            ? '  "replyTips": ["상대 회신이 늦을 때 후속으로 확인·독촉할 점 1~3개"]'
            : '  "replyTips": ["답장 시 참고할 점 1~3개"]',
          '  ,"decisions": ["이 메일(또는 스레드)에서 이미 결정·합의된 사항들"]',
          '  ,"risks": ["미결 사항·리스크: 회신이 없거나 기한이 임박했거나 지시가 서로 상충하는 것들"]',
          '}',
          isKo
            ? '★ 원문이 한국어입니다. 번역은 생략하고(translated는 빈 문자열) 요약·액션·핵심정보에 집중하세요.'
            : '★ 원문이 외국어입니다. translated 에 전문 번역을 반드시 채우세요.',
          threadBlock ? '★ [이전 대화 맥락]이 함께 주어집니다. 무엇이 언제 요청됐고 어디까지 진행됐는지 흐름을 반영해 요약·미결 판단에 활용하세요.' : '',
          attContentBlock ? '★ [첨부 내용]이 함께 주어집니다. 그 내용을 근거로 요약·keyFacts·actions 를 채우고, 첨부에 없는 사실을 지어내지 마세요. 첨부 내용을 인용할 때는 반드시 첨부 파일명을 함께 밝히세요.' : '',
          '근거가 없는 내용은 지어내지 말고, 해당 항목을 빈 배열로 두세요. 도면번호·호선번호·기한은 본문(또는 이전 맥락)에 실제로 적힌 것만 쓰세요.'
        ].filter(Boolean).join('\n')
      },
      {
        role: 'user',
        content: refineNote + String.fromCharCode(10) + (sent
          ? `[내가 보낸 메일]\n받는사람: ${mail.recipients || mail.to || ''}\n참조: ${mail.cc || ''}\n`
          : `발신: ${mail.sender_name || mail.sender || ''} <${mail.sender_email || mail.senderMail || ''}>\n`) +
          `제목: ${mail.subject || ''}\n감지언어: ${LANG_NAME[lang] || lang}\n${attLine}${threadBlock}${attContentBlock}\n\n본문:\n${body}`
      }
    ];
  }

  //  축소 단계: 0=원본 → 1=스레드3통/본문300자(첨부 내용은 마스터가 원한 신호라 우선 유지) →
  //  2=스레드1통/본문300자/첨부5개 + 첨부내용도 최후에 제거(그래도 넘치면).
  //  ★ 실측(2026-09-28, 실DB #4): 첨부내용을 1단계에서 먼저 빼면 본문이 큰 메일은 LLM 이 첨부
  //    내용을 전혀 못 보고도 promptReduced 배지 없이 지나갈 뻔했다 — 본문/스레드를 먼저 줄이고
  //    첨부 내용은 최후 수단으로 미룬다(스킬 §4: 형식 보장≠정답 보장, 조용히 빠지면 안 됨).
  const steps = [
    { threadN: threadContext.length, bodyChars: fullBody.length, threadBodyChars: 200, attMax: attachments.length, attContent: true },
    { threadN: Math.min(3, threadContext.length), bodyChars: 300, threadBodyChars: 150, attMax: Math.min(10, attachments.length), attContent: true },
    { threadN: Math.min(1, threadContext.length), bodyChars: 300, threadBodyChars: 150, attMax: Math.min(5, attachments.length), attContent: false }
  ];

  //  providerOverride — 교차검증 2차 호출에서 '다른 제공자'로 고정 호출할 때 쓴다.
  //  (main.js 의 활성 체인 항목 하나를 그대로 넘긴다: {chatUrl, provider, model, keys})
  let res;
  if (providerOverride) {
    // 교차검증은 단발 호출 — 상한 초과 시에만 1단계 축소해 재시도한다.
    let messages = buildMessages(steps[0]);
    let reduced = false;
    if (cerebras.messagesTokens(messages) > DEFAULT_TOKEN_LIMIT && steps.length > 1) {
      messages = buildMessages(steps[1]); reduced = true;
    }
    res = await cerebras.chatOnce({
      keys: providerOverride.keys || keys, model: providerOverride.model || model, messages,
      temperature: 0.2, maxTokens: 3500, url: providerOverride.chatUrl, provider: providerOverride.provider
    });
    if (!res.ok && res.errorKind === 'toolarge' && !reduced && steps.length > 1) {
      messages = buildMessages(steps[1]);
      res = await cerebras.chatOnce({
        keys: providerOverride.keys || keys, model: providerOverride.model || model, messages,
        temperature: 0.2, maxTokens: 3500, url: providerOverride.chatUrl, provider: providerOverride.provider
      });
      reduced = true;
    }
    res = Object.assign({}, res, { promptReduced: reduced });
  } else {
    res = await chatWithBudget({ keys, model, buildFn: buildMessages, steps, temperature: 0.2, maxTokens: 3500 });
  }
  if (!res.ok) return res;
  const raw = extractJson(res.content);
  if (!raw) return { ...res, structured: null };   // 파싱 실패 시 원문 텍스트로 폴백 렌더
  return { ...res, structured: normalizeAnalysis(raw, mail, isKo, groundHaystack) };
}

// ------------------------------------------------------------
//  교차 검증 — 두 결과(서로 다른 제공자)의 핵심 필드만 대조한다.
//  전체 텍스트 비교는 토큰·시간 낭비이므로 하지 않는다.
//   · 기한(actions[].due 집합) · 요청 유무(actions.length>0) ·
//     할 일 항목 수 · 발신자 의도(휴리스틱 분류) 4가지만 본다.
// ------------------------------------------------------------
//  발신자 의도 — 추가 AI 호출 없이 actions/keyFacts 로 판정하는 가벼운 휴리스틱.
//  ponytail: 정교한 분류가 필요하면 이후 별도 분류 프롬프트로 승격 가능(현재는 과설계 방지).
function classifyIntent(structured) {
  const s = structured || {};
  const actions = Array.isArray(s.actions) ? s.actions : [];
  if (!actions.length) return 'info';                          // 요청 없음 — 정보 전달/공지
  const hasDue = actions.some(a => String(a.due || '').trim());
  return hasDue ? 'request-due' : 'request';                    // 기한 있는 요청 / 기한 없는 요청
}

function compareAnalysis(a, b) {
  const A = a || {}, B = b || {};
  const actionsA = Array.isArray(A.actions) ? A.actions : [];
  const actionsB = Array.isArray(B.actions) ? B.actions : [];
  const dueA = new Set(actionsA.map(x => String(x.due || '').trim()).filter(Boolean));
  const dueB = new Set(actionsB.map(x => String(x.due || '').trim()).filter(Boolean));
  const dueMatch = dueA.size === dueB.size && [...dueA].every(d => dueB.has(d));
  const reqA = actionsA.length > 0, reqB = actionsB.length > 0;
  const reqMatch = reqA === reqB;
  const cntMatch = actionsA.length === actionsB.length;
  const intentA = classifyIntent(A), intentB = classifyIntent(B);
  const intentMatch = intentA === intentB;

  const diffs = [];
  if (!dueMatch) diffs.push({ field: '기한', a: [...dueA].join(', ') || '(없음)', b: [...dueB].join(', ') || '(없음)' });
  if (!reqMatch) diffs.push({ field: '요청 유무', a: reqA ? '있음' : '없음', b: reqB ? '있음' : '없음' });
  if (!cntMatch) diffs.push({ field: '할 일 항목 수', a: String(actionsA.length), b: String(actionsB.length) });
  if (!intentMatch) diffs.push({ field: '발신자 의도', a: intentA, b: intentB });

  return { match: dueMatch && reqMatch && cntMatch && intentMatch, diffs };
}

// ------------------------------------------------------------
//  3) 답장 초안 작성
//     tone: 'formal'|'friendly'|'concise', replyLang: 'auto'|'ko'|'en'|'zh'
// ------------------------------------------------------------
//  previousDraft 가 있으면 '새로 쓰기'가 아니라 '그 초안을 지시대로 고치기'가 된다.
async function draftReply({ keys, model, mail, instruction = '', tone = 'formal', replyLang = 'auto', previousDraft = '' }) {
  const body = mail.body || mail.preview || '';
  // ★ mail.lang 은 인용 스레드까지 합쳐 판정한 값이라, 영문 스레드에 한국어로 회신한 메일이
  //   'en' 으로 잡혀 답장이 영어로 나갔다(실측 결함). 상대가 '이번에 쓴 새 본문'만 보고 다시 판정한다.
  const isKo = isKoreanMail(mail);
  const lang = isKo ? 'ko' : (mail.lang || 'unknown');

  // 사용자가 지시사항에 언어를 지정하면 그것이 최우선
  const instr = String(instruction || '');
  const forcedByUser = /영어로|영문으로|in english|english로/i.test(instr) ? 'en'
    : (/한국어로|한글로|국문으로|in korean/i.test(instr) ? 'ko' : null);

  const effLang = forcedByUser || (replyLang === 'auto' ? lang : replyLang);
  const langInstruction = effLang === 'ko'
    ? '반드시 한국어로 작성하세요. 영어로 쓰지 마세요. 원문이 한국어이므로 답장도 한국어여야 합니다.'
    : (effLang === 'auto' || effLang === 'unknown'
      ? '원문과 같은 언어로 작성하세요.'
      : `반드시 ${LANG_NAME[effLang] || effLang}로 작성하세요.`);
  // 형식도 언어에 맞춘다 — 한국어인데 'Dear ~' 로 시작하는 영문 서식이 나오면 안 된다
  const formatHint = effLang === 'ko'
    ? '한국 비즈니스 메일 형식을 따르세요. 예: "수신: OOO 님" 으로 시작하고 "표제와 관련하여 ~" 처럼 이어 쓰며, "감사합니다." 로 맺습니다. "Dear" 같은 영문 인사말을 쓰지 마세요.'
    : 'Use the standard business letter format for that language (e.g. "Dear ~," ... "Best regards,").';
  const toneMap = {
    formal: '정중하고 격식있는 비즈니스 어조',
    friendly: '친근하지만 전문적인 어조',
    concise: '간결하고 요점만 명확한 어조'
  };
  // ★ 보낸 메일에서 누르면 '답장'이 아니라 '후속·독촉 메일'이 필요하다(내가 이미 보낸 글이므로).
  const sent = isSentMail(mail);
  //  대화로 초안을 다듬는 경로 — 이전 초안을 그대로 주고 '고쳐 쓰기'를 시킨다.
  //  ★ 실측 버그: 이 선언이 messages 배열 뒤에 있어 TDZ(Temporal Dead Zone)로 매번
  //    "Cannot access 'prevNote' before initialization" 예외가 났다(draftReply 100% 실패).
  //    messages 가 참조하기 전으로 끌어올려 수정.
  const prevNote = previousDraft
    ? ['', '', '[이전 초안] 아래 초안을 사용자의 지시대로 고쳐서, 완성된 초안 전체를 다시 출력하세요(설명 없이 초안만).',
       String(previousDraft).slice(0, 4000)].join(String.fromCharCode(10))
    : '';
  const messages = [
    {
      role: 'system',
      content: [
        sent
          ? '당신은 사용자를 대신해 "이미 보낸 메일의 후속(follow-up) 메일" 초안을 작성하는 비서입니다.'
          : '당신은 사용자를 대신해 이메일 답장 초안을 작성하는 비서입니다.',
        sent
          ? '사용자가 앞서 보낸 메일에 대해 상대의 회신·처리가 아직 없어 정중하게 확인·요청하는 메일을 씁니다. 앞서 보낸 내용을 짧게 상기시키고, 필요한 조치와 기한을 명확히 하세요. 재촉이 무례해지지 않게 합니다.'
          : '',
        `어조: ${toneMap[tone] || toneMap.formal}.`,
        langInstruction,
        formatHint,
        sent
          ? '실제 보낼 수 있는 완성된 후속 메일 본문만 작성하세요(제목 제안 1줄 포함). 설명이나 메타코멘트는 넣지 마세요.'
          : '실제 보낼 수 있는 완성된 답장 본문만 작성하세요(제목 제안 1줄 포함). 설명이나 메타코멘트는 넣지 마세요.',
        '형식:\n제목: <제안 제목>\n---\n<본문>'
      ].filter(Boolean).join('\n')
    },
    {
      role: 'user',
      //  ★ 실측 버그: `a + b + sent ? X : Y` 는 연산자 우선순위 때문에 (a+b+sent)가 조건이 되어
      //    sent 값과 무관하게 항상 X(후속메일 문구)가 나갔다. 괄호로 조건을 명시해 수정.
      content: prevNote + String.fromCharCode(10) + (sent
        ? `아래는 제가 이미 보낸 메일입니다. 이에 대한 후속 메일을 써 주세요.${instruction ? '\n\n[사용자 지시]: ' + instruction : ''}\n\n--- 내가 보낸 메일 ---\n받는사람: ${mail.recipients || mail.to || ''}\n제목: ${mail.subject || ''}\n본문:\n${body}`
        : `아래 메일에 답장하려 합니다.${instruction ? '\n\n[사용자 지시]: ' + instruction : ''}\n\n--- 원본 메일 ---\n발신: ${mail.sender_name || mail.sender || ''}\n제목: ${mail.subject || ''}\n본문:\n${body}`)
    }
  ];

  return cerebras.chat({ keys, model, messages, temperature: 0.4, maxTokens: 2500 });
}

// ------------------------------------------------------------
//  4) 대화형 질의응답 (DB 검색결과를 근거로)
//     history: [{role, content}], contextMails: 관련 메일 배열
// ------------------------------------------------------------
async function chatOverMails({ keys, model, question, contextMails = [], history = [] }) {
  const context = contextMails.length
    ? mailsToContext(contextMails, 500)
    : '(관련 메일을 찾지 못했습니다. 일반 지식으로 답하되, 메일 데이터가 필요하면 동기화를 안내하세요.)';
  const messages = [
    {
      role: 'system',
      content: [
        '당신은 사용자의 이메일 데이터베이스에 접근하는 AI 비서입니다.',
        '아래 "관련 메일" 컨텍스트를 근거로 한국어로 답하세요.',
        '메일에 근거가 있으면 [번호]로 인용하세요. 외국어 메일 내용은 한국어로 번역해 설명하세요.',
        '날짜·발신자·요청사항 질문에는 구체적으로 답하세요.',
        '',
        '[반드시 지킬 규칙 - 환각 금지]',
        '1. 컨텍스트에 없는 메일·발신자·날짜·첨부를 지어내지 마세요. 근거가 없으면 "해당 내용은 저장된 메일에서 찾지 못했습니다"라고 답하세요.',
        '2. 이 앱이 할 수 없는 일을 할 수 있다고 말하지 마세요. 이 앱은 "저장된 메일 검색·요약·번역·답장 초안 작성"만 가능합니다.',
        '   메일 발송/전달/삭제, 일정 등록, 파일 전송, 외부 시스템 연동은 불가능합니다. 요청받으면 불가능하다고 분명히 답하세요.',
        '3. "찾아줄게요/검색해 드리겠습니다" 같은 예고만 하지 말고, 컨텍스트에 있는 실제 메일을 즉시 요약해 제시하세요.',
        '4. 검색 결과가 0건이면 그 사실을 먼저 알리고, 다른 검색어나 동기화를 제안하세요.',
        '5. ★ 아래 컨텍스트에 실제로 들어 있는 메일만 언급하세요. 컨텍스트에 없는 제목·발신자를 답변에 쓰면 안 됩니다',
        '   (실측 사고: 근거 목록에 없는 메일을 근거인 것처럼 서술해 신뢰가 깨졌습니다).',
        '6. 광고·뉴스레터는 업무 근거가 아니므로 답변에서 다루지 마세요.'
      ].join('\n')
    },
    ...history.slice(-6),
    {
      role: 'user',
      content: `[관련 메일 컨텍스트]\n${context}\n\n[질문] ${question}`
    }
  ];
  return cerebras.chat({ keys, model, messages, temperature: 0.3, maxTokens: 3000 });
}

// ------------------------------------------------------------
//  4-a) 검색 결과 날짜별 요약 (마스터 지시: 복합 조건 검색 → 날짜별 한 줄 + 전체 종합)
//  ------------------------------------------------------------
//  ★ 토큰 절약: mailDigest 재사용, 한 번의 호출로 날짜별 한 줄 + 전체 종합을 함께 받는다
//    (건수가 많으면 main.js 가 maxMails 로 먼저 캡을 씌워 넘긴다).
// ------------------------------------------------------------
async function summarizeByDate({ keys, model, mails, queryLabel = '', maxMails = 60 }) {
  if (!mails || !mails.length) return { ok: false, error: '요약할 메일이 없습니다.' };
  const total = mails.length;

  function buildMessages(step) {
    const capped = mails.slice(0, step.maxMails);
    const groups = new Map();
    for (const m of capped) {
      const d = String(m.received_at || m.received || '').slice(0, 10) || '(날짜미상)';
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d).push(m);
    }
    const dateList = [...groups.keys()].sort((a, b) => b.localeCompare(a));
    const body = dateList.map(d => {
      const ms = groups.get(d);
      const lines = ms.map(m => mailDigest(m, new Set(), step.digestChars));
      return `[${d}] (${ms.length}건)\n${lines.join('\n')}`;
    }).join('\n\n');
    const cappedNote = capped.length < total ? ` (전체 ${total}건 중 ${capped.length}건 요약)` : '';
    return [
      {
        role: 'system',
        content: [
          '당신은 이메일 검색 결과를 날짜별로 요약하는 비서입니다.',
          '아래 JSON 형식으로만 출력하세요. 설명·마크다운·코드펜스 금지.',
          '{"perDate":[{"date":"YYYY-MM-DD","summary":"그날 오간 내용을 한국어 한 줄로"}],"overall":["전체 종합 문장 2~3개"]}',
          '입력에 없는 내용은 만들지 마세요. date 는 입력에 실제로 나온 날짜만 쓰세요.'
        ].join('\n')
      },
      { role: 'user', content: `검색 조건: ${queryLabel || '(없음)'}${cappedNote}\n\n${body}` }
    ];
  }

  //  축소 단계: 0=원본(최대 maxMails) → 1=30건/100자 → 2=15건/80자
  const steps = [
    { maxMails: Math.min(maxMails, total), digestChars: 150 },
    { maxMails: Math.min(30, total), digestChars: 100 },
    { maxMails: Math.min(15, total), digestChars: 80 }
  ];
  const res = await chatWithBudget({ keys, model, buildFn: buildMessages, steps, temperature: 0.2, maxTokens: 2200 });
  if (!res.ok) return res;
  const arr = (v) => Array.isArray(v) ? v.filter(x => x !== null && String(x).trim() !== '') : [];
  const raw = extractJson(res.content);
  if (!raw) {
    return { ...res, structured: { perDate: [], overall: [String(res.content || '').slice(0, 600)] } };
  }
  return {
    ...res,
    structured: {
      perDate: arr(raw.perDate).map(x => (typeof x === 'string' ? { date: '', summary: x } : { date: String(x.date || ''), summary: String(x.summary || '') })).filter(x => x.summary),
      overall: arr(raw.overall).map(String)
    }
  };
}

// ------------------------------------------------------------
//  4-b) 일일 메일 브리핑 (특정 하루 → 서술형 4섹션)
//     요약 / 받은 것 / 보낸 것 / 할 일
//     ★ 한국어 규칙: 브리핑은 항상 한국어로만 서술한다(번역 섹션 없음).
//     ★ 병렬 엔진(mapReduce, 동시성 N) 사용.
// ------------------------------------------------------------
async function dailyBriefing({ keys, model, mails, dateLabel = '', myEmails = [], onProgress = () => {}, concurrency = 3 }) {
  if (!mails || mails.length === 0) {
    return { ok: false, error: `${dateLabel} 에는 저장된 메일이 없습니다. 동기화 후 다시 시도하세요.` };
  }
  const mine = new Set(myEmails.map(e => String(e).toLowerCase()));
  const texts = mails.map(m => mailDigest(m, mine, 320));

  const SPEC = [
    '{',
    '  "summary": ["그날 전체를 아우르는 서술형 문장 2~4개"],',
    '  "received": ["받은 메일의 핵심을 서술형 문장으로. 누가 무엇을 요청/보고했는지"],',
    '  "sent": ["내가 보낸 메일의 핵심을 서술형 문장으로. 무엇을 처리/회신했는지"],',
    '  "todos": [{"task":"이어서 해야 할 일","owner":"담당(없으면 빈 문자열)","due":"기한(없으면 빈 문자열)"}]',
    '}'
  ].join('\n');

  const res = await cerebras.mapReduce({
    keys, model, texts, onProgress, concurrency, mode: 'batch',   // 배치·자동 작업 — Groq 우선(마스터 지시)
    chunkChars: 14000, temperature: 0.3, mapMaxTokens: 1400, reduceMaxTokens: 3000, forceReduce: true,
    mapSystem: [
      '당신은 조선·해양 설계 실무자의 하루 메일을 정리하는 비서입니다.',
      '아래 메일 기록(날짜|보냄·받음(직접/참조)|발신자|폴더|제목 + 본문발췌)을 읽고',
      "'받음(참조)'는 참조 통보이므로 요약에만 넣고 할 일로는 올리지 마세요.",
      '"받음"과 "보냄"을 구분해 각각의 핵심을 한국어 서술형 문장으로 정리하세요.',
      '형식: "받음: ..." / "보냄: ..." / "할일: ..." 로 시작하는 줄들만 출력.',
      '항목 나열이 아니라 사람이 읽는 문장으로 쓰세요. 근거 없는 내용은 만들지 마세요.'
    ].join('\n'),
    mapHeader: `대상 날짜: ${dateLabel} · 내 주소: ${[...mine].join(', ') || '(미확인)'}`,
    reduceSystem: [
      '당신은 하루 업무 브리핑을 작성하는 비서입니다.',
      '아래 부분 정리들을 종합해 아래 JSON 형식으로만 출력하세요. 설명·마크다운·코드펜스 금지.',
      SPEC,
      '모든 문장은 한국어 서술형으로 씁니다(불릿 기호 없이 완결된 문장).',
      '중복은 합치고, 부분 정리에 없는 내용은 만들지 마세요. 해당 항목이 없으면 빈 배열로 두세요.'
    ].join('\n'),
    reduceHeader: `대상 날짜: ${dateLabel} · 총 ${mails.length}건`
  });
  if (!res.ok) return res;

  const arr = (v) => Array.isArray(v) ? v.filter(x => x !== null && String(x).trim() !== '') : [];
  const raw = extractJson(res.content);
  if (!raw) {
    // JSON 파싱 실패 시 평문이라도 요약 자리에 넣어 결과를 버리지 않는다
    return {
      ...res,
      structured: {
        date: dateLabel, mailCount: mails.length,
        summary: [String(res.content || '').slice(0, 1200)], received: [], sent: [], todos: []
      }
    };
  }
  return {
    ...res,
    structured: {
      date: dateLabel,
      mailCount: mails.length,
      summary: arr(raw.summary).map(String),
      received: arr(raw.received).map(String),
      sent: arr(raw.sent).map(String),
      todos: arr(raw.todos).map(t => (typeof t === 'string'
        ? { task: t, owner: '', due: '' }
        : { task: String(t.task || ''), owner: String(t.owner || ''), due: String(t.due || '') })).filter(t => t.task)
    }
  };
}

// ------------------------------------------------------------
//  5) 업무일지 (기간 내 메일 → 날짜별 업무 기록)
//     내가 보낸 메일 = 내가 한 일, 받은 메일 = 요청/진행 건
// ------------------------------------------------------------
async function workLog({ keys, model, mails, myEmails = [], periodLabel = '기간', onProgress = () => {}, concurrency = 3 }) {
  if (!mails || mails.length === 0) {
    return { ok: false, error: '해당 기간에 메일이 없습니다. 기간을 넓히거나 동기화를 실행하세요.' };
  }
  const mine = new Set(myEmails.map(e => String(e).toLowerCase()));
  const texts = mails.map(m => mailDigest(m, mine, 300));


  // ---- map: 청크별 날짜 블록 생성 (reduce 는 AI 대신 코드로 병합) ----
  const res = await cerebras.mapReduce({
    keys, model, texts, onProgress, mode: 'batch',   // 배치·자동 작업 — Groq 우선(마스터 지시)
    chunkChars: 14000, temperature: 0.2, mapMaxTokens: 1600, concurrency,
    mapSystem: [
      '당신은 조선·해양 설계 실무자의 업무일지를 작성하는 비서입니다.',
      '아래 메일 기록(형식: 날짜|보냄·받음(직접/참조)|발신자|폴더|제목 + 본문발췌)을 날짜별로 정리하세요.',
      "'받음(참조)'는 참조로만 받은 통보성 메일이니 내 할 일로 올리지 말고, '받음(직접)'을 우선하세요.",
      '출력은 반드시 아래 한 줄 형식만 사용합니다. 날짜별로 한 줄씩, 다른 문장·머리말 금지.',
      '[YYYY-MM-DD] 한일: 항목1; 항목2 | 접수: 항목1; 항목2 | 프로젝트: 이름1; 이름2 | 미결: 항목1',
      '해당 항목이 없으면 그 구획(예: "미결: ...")을 생략하세요.',
      '메일에 근거가 없는 내용은 절대 만들지 마세요.'
    ].join('\n'),
    mapHeader: `기간: ${periodLabel} · 내 주소: ${[...mine].join(', ') || '(미확인)'}`,
    reduceSystem: null   // ★ 코드로 병합 → JSON 파싱 실패 위험 제거 + 토큰 절약
  });
  if (!res.ok) return res;

  // ---- reduce(코드): 날짜 블록 파싱·병합 (결정론적) ----
  const dayMap = new Map();
  const pushUniq = (arr, v) => { const s = String(v || '').trim(); if (s && !arr.includes(s)) arr.push(s); };
  const SEC = { '한일': 'done', '한 일': 'done', '접수': 'received', '프로젝트': 'projects', '미결': 'pending' };
  for (const part of (res.partials || [])) {
    for (const line of String(part).split(/\r?\n/)) {
      const m = line.match(/^\s*[\[\(]?(\d{4}-\d{2}-\d{2})[\]\)]?\s*(.*)$/);
      if (!m) continue;
      const date = m[1];
      if (!dayMap.has(date)) dayMap.set(date, { date, done: [], received: [], projects: [], pending: [] });
      const d = dayMap.get(date);
      for (const seg of m[2].split('|')) {
        const sm = seg.match(/^\s*([^:]{1,12})\s*:\s*(.+)$/);
        if (!sm) continue;
        const key = SEC[sm[1].trim()];
        if (!key) continue;
        sm[2].split(/[;·]/).forEach(v => pushUniq(d[key], v));
      }
    }
  }
  const days = [...dayMap.values()].sort((a, b) => b.date.localeCompare(a.date));

  // ---- 총평·미결만 소량 입력으로 1회 요약 (토큰 최소) ----
  let summary = [], openItems = [];
  if (days.length) {
    const brief = days.slice(0, 31).map(d =>
      `${d.date} 한일:${d.done.slice(0, 4).join('; ')} 미결:${d.pending.slice(0, 3).join('; ')}`).join('\n').slice(0, 8000);
    onProgress('reduce', days.length, days.length, '총평·미결 정리 중...');
    const sres = await cerebras.chat({
      keys, model, temperature: 0.2, maxTokens: 1200,
      messages: [
        { role: 'system', content: [
          '아래 업무일지 요약 줄들을 보고 JSON 만 출력하세요. 설명·마크다운 금지.',
          '{"summary":["기간 총평 2~4줄"],"openItems":[{"task":"미결 업무","owner":"담당(없으면 빈 문자열)","due":"기한(없으면 빈 문자열)"}]}',
          '입력에 없는 내용은 만들지 마세요.'
        ].join('\n') },
        { role: 'user', content: `기간: ${periodLabel}\n\n${brief}` }
      ],
      onRetry: (r) => onProgress('wait', days.length, days.length,
        `분당 토큰 한도로 ${Math.round(r.waitMs / 1000)}초 대기 후 재시도`)
    });
    if (sres.ok) {
      const j = extractJson(sres.content);
      if (j) {
        const arr = (v) => Array.isArray(v) ? v.filter(x => x !== null && String(x).trim() !== '') : [];
        summary = arr(j.summary).map(String);
        openItems = arr(j.openItems).map(o => (typeof o === 'string'
          ? { task: o, owner: '', due: '' }
          : { task: String(o.task || ''), owner: String(o.owner || ''), due: String(o.due || '') })).filter(o => o.task);
      }
    }
    // 총평 실패해도 날짜별 일지는 그대로 제공 (전부 버리지 않음)
    if (!openItems.length) {
      openItems = days.flatMap(d => d.pending.map(p => ({ task: p, owner: '', due: d.date }))).slice(0, 12);
    }
  }

  onProgress('done', days.length, days.length, '업무일지 완료');
  return {
    ok: true,
    chunks: res.chunks, failedChunks: res.failedChunks,
    content: days.map(d => `[${d.date}] 한일: ${d.done.join('; ')}`).join('\n'),
    structured: { period: periodLabel, days, summary, openItems }
  };
}

module.exports = { briefing, dailyBriefing, translateAnalyze, draftReply, chatOverMails, workLog, summarizeByDate, mailsToContext, mailDigest, isKoreanMail, stripQuoted, looksKorean, langScore, classifyIntent, compareAnalysis, extractProjectCodes, isGrounded };

// ------------------------------------------------------------
//  셀프체크 — `node src/analyzer.js` 로 직접 실행할 때만 동작
//  실측 메일에서 뽑은 회귀 케이스. 깨지면 즉시 실패한다.
// ------------------------------------------------------------
if (require.main === module) {
  const assert = require('assert');
  const cases = [
    // [설명, 본문, 기대값]
    ['한국어 본문 + 영문 인용 스레드 (id=79000)',
      '수신: 한국야나세 하만종 수석님,\n\n업무에 수고 많으십니다.\n표제와 관련, 하기 코멘트 사항을 회신드립니다.\n감사합니다.\n\n-----Original Message-----\nFrom: Kim\nSubject: RE: KOREA YANASE 22K F/D PROJECT\nDear Sir, we would like to confirm the deck machinery specification and the remote control system as per your comment. Please review the attached drawings.', true],
    ['영문 본문 + 한글 서명뿐 (id=15103 오판 케이스)',
      'YOUR REF. ; EAT4400-2053-2026 OF DATE 20260709\nDear Sirs,\nWe hereby reply to your electrical comment as follows. Please kindly review the attached documents and revert with your confirmation at your earliest convenience. Thank you for your continued cooperation on this project.\nBest regards,\n박규진 전무 / 씨스타 주식회사 설계부', false],
    ['짧은 한국어 본문 + 긴 영문 서명 (id=1194 오판 케이스)',
      '업무에 수고 많습니다.\n코멘트 없습니다.\n감사합니다.\n\nBong Jeong Kim / General Manager\nElectrical Design Department, ST OCEAN Co., Ltd.\nAddress: 123 Nakdong-daero, Sasang-gu, Busan, Republic of Korea\nTel +82 51 000 0000 Fax +82 51 000 0001 Mobile +82 10 0000 0000', true],
    ['영문 짧은 회신 + 중국어 인용 (id=57)',
      'hi Danny got it\n---- 回复的原邮件 ----\n发件人: 안종서 상무\n업무에 수고 많으십니다. 하기와 같이 확인 부탁드립니다. 감사합니다.', false],
    ['순수 영문', 'Dear Mr. Kim, please find attached the revised drawing. Best regards, John', false],
    ['아주 짧은 한국어 지시문 (id=15112)', 'PDF 검토 바랍니다.', true],
    ['빈 본문', '', false]
  ];
  let pass = 0;
  for (const [name, body, want] of cases) {
    const got = looksKorean(body);
    assert.strictEqual(got, want, `looksKorean 실패: ${name} → ${got} (기대 ${want}) / ${JSON.stringify(langScore(body))}`);
    pass++;
  }
  // mails.lang 이 en 이어도 본문이 한국어면 한국어로 판정해야 한다(답장 언어 결함의 근본 원인)
  assert.strictEqual(isKoreanMail({ lang: 'en', body: cases[0][1] }), true, 'isKoreanMail: DB lang=en 우선순위 결함');
  assert.strictEqual(isKoreanMail({ lang: 'ko', body: cases[1][1] }), false, 'isKoreanMail: DB lang=ko 오버라이드 잔재');
  assert.strictEqual(isKoreanMail({ lang: 'ko', body: '' }), true, 'isKoreanMail: 본문 없을 때 lang 폴백');
  // ---- 임무B: 코드 추출·그라운딩 회귀 케이스 ----
  const codes = extractProjectCodes('2710/11 호선 M-011 도면 관련, 22K FD 프로젝트, KYTS-1037 코드 참고');
  const codeVals = codes.map(c => c.value);
  assert.ok(codeVals.includes('2710/11') || codeVals.some(v => v.replace(/\s/g, '') === '2710/11'), '호선번호 추출 실패: ' + JSON.stringify(codeVals));
  assert.ok(codeVals.includes('M-011'), '도면번호 추출 실패: ' + JSON.stringify(codeVals));
  assert.ok(codeVals.some(v => v.replace(/\s/g, '').toUpperCase() === '22KFD'), '프로젝트코드(22K FD) 추출 실패: ' + JSON.stringify(codeVals));
  assert.ok(codeVals.includes('KYTS-1037'), '프로젝트코드(KYTS-1037) 추출 실패: ' + JSON.stringify(codeVals));
  assert.strictEqual(isGrounded('9/10까지', '검토 후 9/10까지 회신 바랍니다.'), true, '그라운딩: 원문에 있는 기한이 탈락함');
  assert.strictEqual(isGrounded('2026-12-25', '검토 후 9/10까지 회신 바랍니다.'), false, '그라운딩: 원문에 없는 기한이 통과함(환각 미차단)');
  console.log('analyzer 셀프체크 OK — 코드추출 4종 + 그라운딩 2종 통과');

  // ---- 임무1: 프롬프트 토큰 상한 방어 회귀 ----
  assert.strictEqual(cerebras.estimateTokens('가나다'), 1, 'estimateTokens: 문자수/3 근사 결함');
  assert.strictEqual(cerebras.estimateTokens('a'.repeat(3000)), 1000, 'estimateTokens: 3000자→1000토큰 결함');
  assert.strictEqual(cerebras.messagesTokens([{ content: 'a'.repeat(30) }, { content: 'b'.repeat(60) }]), 30, 'messagesTokens: 합산 결함');

  console.log(`analyzer 셀프체크 OK — looksKorean ${pass}건 + isKoreanMail 3건 통과`);

  // ---- 임무1(비동기): 스레드 145통짜리 대형 컨텍스트가 실제로 축소되어 재시도되는지 ----
  (async () => {
    const bigThread = Array.from({ length: 145 }, (_, i) => ({ subject: `RE:${i}`, body: 'x'.repeat(400), received_at: '2026-08-01', sender_name: 'A' }));
    const bigMail = { subject: '테스트', body: 'y'.repeat(20000), folder: 'Inbox' };
    let calls = 0;
    const seenTokens = [];
    const origChat = cerebras.chat;
    cerebras.chat = async ({ messages }) => { calls++; seenTokens.push(cerebras.messagesTokens(messages)); return { ok: false, errorKind: 'toolarge' }; };
    let res;
    try {
      res = await translateAnalyze({ keys: ['x'], model: 'm', mail: bigMail, threadContext: bigThread });
    } finally { cerebras.chat = origChat; }
    assert.ok(calls >= 2, `chatWithBudget: 축소 재시도가 일어나지 않음(호출 ${calls}회)`);
    assert.ok(seenTokens[seenTokens.length - 1] < seenTokens[0], `chatWithBudget: 마지막 호출 토큰(${seenTokens[seenTokens.length - 1]})이 첫 호출(${seenTokens[0]})보다 작지 않음`);
    assert.strictEqual(res.promptReduced, true, 'chatWithBudget: promptReduced 플래그 누락');

    // summarizeByDate 도 동일 경로로 축소되는지
    const bigMails = Array.from({ length: 145 }, (_, i) => ({ subject: `건${i}`, body: 'z'.repeat(400), received_at: '2026-08-01' }));
    let calls2 = 0;
    cerebras.chat = async ({ messages }) => { calls2++; return { ok: false, errorKind: 'toolarge' }; };
    let res2;
    try {
      res2 = await summarizeByDate({ keys: ['x'], model: 'm', mails: bigMails, queryLabel: 't' });
    } finally { cerebras.chat = origChat; }
    assert.ok(calls2 >= 2, `summarizeByDate: 축소 재시도가 일어나지 않음(호출 ${calls2}회)`);
    assert.strictEqual(res2.promptReduced, true, 'summarizeByDate: promptReduced 플래그 누락');

    console.log('analyzer 셀프체크 OK — 임무1 토큰상한 축소재시도 회귀(translateAnalyze/summarizeByDate) 통과');
  })().catch(e => { console.error('analyzer 셀프체크 실패(임무1):', e); process.exitCode = 1; });
}
