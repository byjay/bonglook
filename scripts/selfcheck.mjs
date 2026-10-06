#!/usr/bin/env node
// ============================================================
//  selfcheck.mjs — Bmail 순수 로직 셀프체크 (의존성 0, 프레임워크 없음)
//  ------------------------------------------------------------
//  깨지면 즉시 실패하는 최소 실행 체크만 모은다. 빌드(prebuild)에 물려 회귀를 막는다.
//
//  검사 항목
//   1) analyzer.js 셀프체크 (한국어 판정 회귀 케이스)
//   2) analyzer.looksKorean  ↔  renderer.isKoreanMailClient  판정 일치 (복제 드리프트 차단)
//   3) dashboard-agg.js 셀프체크 (집계 순수 함수)
//
//  사용: node scripts/selfcheck.mjs
// ============================================================
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let failed = 0;
const ok = (m) => console.log('  PASS ' + m);
const bad = (m) => { failed++; console.log('  FAIL ' + m); };

// ---- 1) analyzer 셀프체크 ----
console.log('[1] analyzer.js 셀프체크');
try {
  const out = execFileSync(process.execPath, [join(ROOT, 'src', 'analyzer.js')], { encoding: 'utf8' });
  ok(out.trim());
} catch (e) { bad('analyzer 셀프체크 실패: ' + String(e.stdout || e.message).slice(0, 400)); }

// ---- 2) 렌더러 복제 함수 판정 일치 ----
console.log('[2] looksKorean ↔ isKoreanMailClient 판정 일치');
try {
  const analyzer = require(join(ROOT, 'src', 'analyzer.js'));
  // 줄바꿈이 CRLF 로 저장돼도 조각을 찾을 수 있게 정규화한다(편집 도구에 따라 바뀔 수 있음)
  const rsrc = readFileSync(join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
  // 렌더러에서 판정에 필요한 조각만 떼어내 독립 실행한다(브라우저 전역 의존 없음)
  const pick = (re, name) => { const m = rsrc.match(re); if (!m) throw new Error(`${name} 를 renderer.js 에서 찾지 못함`); return m[0]; };
  const snippet = [
    pick(/function stripQuotedClient\(text\)[\s\S]*?\n}\n/, 'stripQuotedClient'),
    pick(/const KO_ENDINGS_CLIENT = [\s\S]*?\n/, 'KO_ENDINGS_CLIENT'),
    pick(/function isKoreanMailClient\(mail\)[\s\S]*?\n}\n/, 'isKoreanMailClient'),
    'module.exports = isKoreanMailClient;'
  ].join('\n');
  const mod = { exports: {} };
  new Function('module', 'exports', snippet)(mod, mod.exports);
  const clientFn = mod.exports;

  const CASES = [
    '수신: 하만종 수석님\n업무에 수고 많으십니다. 회신드립니다. 감사합니다.\n-----Original Message-----\nFrom: Kim\nDear Sir, please confirm the deck machinery specification and remote control system.',
    'Dear Sirs,\nWe hereby reply to your electrical comment. Please kindly review the attached documents and revert with your confirmation.\nBest regards,\n박규진 전무 / 씨스타 주식회사 설계부',
    '업무에 수고 많습니다.\n코멘트 없습니다.\n감사합니다.\n\nBong Jeong Kim / General Manager, Electrical Design Department, ST OCEAN Co., Ltd. Busan Republic of Korea',
    'hi Danny got it\n---- 回复的原邮件 ----\n发件人: 안종서\n업무에 수고 많으십니다. 확인 부탁드립니다. 감사합니다.',
    'PDF 검토 바랍니다.',
    'Dear Mr. Kim, please find attached the revised drawing. Best regards, John',
    ''
  ];
  let diff = 0;
  CASES.forEach((body, i) => {
    const a = analyzer.looksKorean(body) && !!body.trim();
    const b = clientFn({ body, lang: 'en' });
    if (a !== b) { diff++; console.log(`    불일치 #${i}: analyzer=${a} renderer=${b}`); }
  });
  diff === 0 ? ok(`판정 ${CASES.length}건 전부 일치`) : bad(`복제 드리프트 ${diff}건`);
} catch (e) { bad('복제 일치 검사 실패: ' + e.message); }

// ---- 3) 모듈별 셀프체크 (파일이 있을 때만) ----
let n = 3;
for (const mod of ['action-state.js', 'dashboard-agg.js', 'exporter.js', 'sent-axis.js', 'attach-organize.js', 'ai-errors.js', 'ai-providers.js', 'jev.js', 'attachments.js', 'attach-vision.js', 'attach-content.js', 'reply-needed.js', 'link-download.js']) {
  const p = join(ROOT, 'src', mod);
  if (!existsSync(p)) continue;
  console.log(`[${n++}] ${mod} 셀프체크`);
  try { ok(execFileSync(process.execPath, [p], { encoding: 'utf8' }).trim()); }
  catch (e) { bad(`${mod} 셀프체크 실패: ` + String(e.stdout || e.message).slice(0, 400)); }
}

// ---- N) AI 박스 조회 회귀 테스트 (답장 초안 TypeError, 2026-09-28) ----
//   revealAiBox()가 메일 뷰에서 돌려주는 박스(#rs-ai-body)는 rpq()가 보는 영역(rpTargets.content=#rp-content)
//   밖에 있다. box 안에 그린 요소를 rpq()로 찾으면 null 이 되어 addEventListener 가 TypeError 로 죽는다
//   (renderer.js:6267/6271 실사고). aiBoxEl()/aiq()/box.querySelector 가 이 패턴을 막는지 실행으로 검증한다.
console.log(`[${n++}] AI 박스 조회 회귀 테스트 (aiBoxEl/aiq vs rpq)`);
try {
  const rsrc = readFileSync(join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
  const pick = (re, name) => { const m = rsrc.match(re); if (!m) throw new Error(`${name} 를 renderer.js 에서 찾지 못함`); return m[0]; };
  const snippet = [
    pick(/let rpTargets = \{[\s\S]*?\};\n/, 'rpTargets'),
    pick(/const RP_PANES = \{[\s\S]*?\n\};\n/, 'RP_PANES'),
    pick(/function rpq\(sel\)[\s\S]*?\n}\n/, 'rpq'),
    pick(/function aiBoxEl\(\)[\s\S]*?\n}\n/, 'aiBoxEl'),
    pick(/function aiq\(sel\)[\s\S]*?\n}\n/, 'aiq'),
    pick(/function revealAiBox\(\)[\s\S]*?\n}\n/, 'revealAiBox'),
    'return { rpTargets, RP_PANES, rpq, aiBoxEl, aiq, revealAiBox };'
  ].join('\n');

  // 최소 가짜 DOM: id 기반 querySelector 만 흉내낸다(의존성 0 유지 — jsdom 미사용).
  class FakeEl {
    constructor(id) { this.id = id; this.children = []; this._html = ''; }
    set innerHTML(html) {
      this._html = html;
      this.children = (html.match(/id="([^"]+)"/g) || []).map(s => new FakeEl(s.slice(4, -1)));
    }
    get innerHTML() { return this._html; }
    querySelector(sel) {
      const id = sel.replace('#', '');
      const stack = [...this.children];
      while (stack.length) { const el = stack.shift(); if (el.id === id) return el; stack.push(...el.children); }
      return null;
    }
    closest() { return null; }
    addEventListener() {}
    get scrollTop() { return 0; }
    set scrollTop(_) {}
  }
  const rpContentEl = new FakeEl('rp-content');
  const rsAiBodyEl = new FakeEl('rs-ai-body');
  global.document = { querySelector: (sel) => (sel === '#rp-content' ? rpContentEl : sel === '#rs-ai-body' ? rsAiBodyEl : null) };
  global.toggleRsSection = () => {};
  global.rpPanelCollapsed = false;
  global.toggleRpPanel = () => {};

  // rpTargets 는 원본에서 함수 스코프 let 이라 밖에서 못 건드린다 → 스위치용 setter 를 하나 더 붙여
  // 같은 클로저 안에서 rpq/aiBoxEl/revealAiBox 가 보는 rpTargets 를 useReadingPane('mail') 처럼 바꾼다.
  const runner = new Function(snippet.replace(
    'return { rpTargets, RP_PANES, rpq, aiBoxEl, aiq, revealAiBox };',
    'function __setRpTargets(t) { rpTargets = t; }\nreturn { RP_PANES, rpq, aiBoxEl, aiq, revealAiBox, __setRpTargets };'
  ));
  const api = runner() || {};

  let diff = 0;
  if (!api.aiBoxEl || !api.aiq || !api.revealAiBox || !api.rpq || !api.__setRpTargets) { diff++; console.log('    추출 실패: aiBoxEl/aiq/revealAiBox/rpq 중 일부가 export 안 됨'); }
  else {
    api.__setRpTargets(api.RP_PANES.mail);   // useReadingPane('mail') 과 동일 효과
    rsAiBodyEl.innerHTML = '<div class="reply-draft"><button id="copy-reply">복사</button></div>';
    const box = api.revealAiBox();
    if (box !== rsAiBodyEl) { diff++; console.log('    revealAiBox() 가 메일뷰 AI 칸(#rs-ai-body)을 못 돌려줌'); }
    if (api.rpq('#copy-reply') !== null) { diff++; console.log('    rpq()가 AI 칸 안 요소를 찾아버림 — 테스트 전제 자체가 깨짐'); }
    if (!box || !box.querySelector('#copy-reply')) { diff++; console.log('    box.querySelector(\'#copy-reply\') 실패 — TypeError 재발'); }
    if (!api.aiq('#copy-reply')) { diff++; console.log('    aiq(\'#copy-reply\') 실패 — TypeError 재발'); }
  }

  delete global.document; delete global.toggleRsSection; delete global.rpPanelCollapsed; delete global.toggleRpPanel;
  diff === 0 ? ok('AI 박스(#rs-ai-body) 안 요소를 aiq/box.querySelector 로 정상 조회, rpq 는 못 찾음(회귀 재현 확인)') : bad(`AI 박스 조회 회귀 ${diff}건`);
} catch (e) { bad('AI 박스 조회 회귀 테스트 실패: ' + e.message); }

// ---- N) 회신 필요성 자동 판정 트리거 존재 확인 (2026-09-29, HANDOFF 7-1) ----
//   loadFollowup() 진입 시(초기/뷰전환/동기화 후 전부 이 함수를 거침 — renderer.js 624·2151·2494·2499·
//   3166-3167) 미분류 후보(replyUnclassified)가 있으면 reply:classifyBatch 를 자동 호출해야 한다.
//   이 블록이 없어지면(=141건이 앱에서 영영 미분류로 남는 결함) 반드시 FAIL 해야 한다.
console.log(`[${n++}] 회신 필요성 자동 판정 트리거 존재 확인`);
try {
  const rsrc = readFileSync(join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
  const loadFollowupSrc = (() => {
    const m = rsrc.match(/async function loadFollowup\(\)[\s\S]*?\n}\n/);
    if (!m) throw new Error('loadFollowup() 함수를 renderer.js 에서 찾지 못함');
    return m[0];
  })();
  const hasGuard = /if\s*\(\s*mails\.some\(m => m\.replyUnclassified\)\s*\)/.test(loadFollowupSrc);
  const hasCall = /window\.api\.replyClassifyBatch\(/.test(loadFollowupSrc);
  if (hasGuard && hasCall) ok('loadFollowup() 안에 미분류 후보 → replyClassifyBatch 자동 호출 트리거 존재');
  else bad(`자동 판정 트리거 누락(guard=${hasGuard}, call=${hasCall}) — 141건이 앱에서 영영 미분류로 남을 위험`);

  // main.js 쪽 1회 상한(과도한 동시 배치 방지) 존재 확인
  const msrc = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  if (/maxBatch/.test(msrc) && /reply:classifyBatch/.test(msrc)) ok('reply:classifyBatch 1회 상한(maxBatch) 존재');
  else bad('reply:classifyBatch 1회 상한(maxBatch) 누락');

  // 전체화면 로딩(.loading) 오버레이를 replyNeeded 배치에 쓰지 않는지 확인(사용자 조작 방해 없음)
  const hp = (() => {
    const m = rsrc.match(/function handleAiProgress\([^)]*\)\s*\{[\s\S]*?\n}\n/);
    if (!m) throw new Error('handleAiProgress() 를 renderer.js 에서 찾지 못함');
    return m[0];
  })();
  const guardsShowLoading = /kind === 'replyNeeded'[\s\S]*?return;/.test(hp) && hp.indexOf("kind === 'replyNeeded'") < hp.indexOf('showLoading(label)');
  guardsShowLoading ? ok('replyNeeded 진행상황은 전체화면 로딩을 띄우지 않음(비침습 표시로 분리)')
    : bad('replyNeeded 진행상황이 전체화면 로딩(.loading)을 침범할 위험');
} catch (e) { bad('자동 판정 트리거 확인 실패: ' + e.message); }

// ---- N) 본문 링크화 + 링크 다운로드 배선 (2026-10, 마스터: "링크 클릭하면 바로 다운로드") ----
//   본문은 평문 → linkifyText 가 http(s) 만 <a> 로 바꾼다. 주입(XSS)·끝 문장부호·한글 경계 회귀 차단.
console.log(`[${n++}] 본문 링크화(linkifyText) · 링크 다운로드 배선`);
try {
  const rsrc = readFileSync(join(ROOT, 'src', 'renderer', 'renderer.js'), 'utf8').replace(/\r\n/g, '\n');
  const pick = (re, name) => { const m = rsrc.match(re); if (!m) throw new Error(`${name} 를 renderer.js 에서 찾지 못함`); return m[0]; };
  const snippet = [
    pick(/const LINK_RE_CLIENT = [^\n]*\n/, 'LINK_RE_CLIENT'),
    pick(/function linkifyText\(raw\)[\s\S]*?\n}\n/, 'linkifyText'),
    pick(/function escapeHtml\(str\)[\s\S]*?\n}\n/, 'escapeHtml'),
    'module.exports = linkifyText;'
  ].join('\n');
  const mod = { exports: {} };
  new Function('module', 'exports', snippet)(mod, mod.exports);
  const lk = mod.exports;
  const CASES = [
    ['보세요 https://a.com/x.pdf.', '보세요 <a class="rp-link" href="https://a.com/x.pdf" title="https://a.com/x.pdf">https://a.com/x.pdf</a>.'],
    ['<https://a.com/d?x=1&y=2>', '&lt;<a class="rp-link" href="https://a.com/d?x=1&amp;y=2" title="https://a.com/d?x=1&amp;y=2">https://a.com/d?x=1&amp;y=2</a>&gt;'],
    ['https://a.com/p에서 받기', '<a class="rp-link" href="https://a.com/p" title="https://a.com/p">https://a.com/p</a>에서 받기'],
    ['https://a.com/"onmouseover="alert(1)', '<a class="rp-link" href="https://a.com/" title="https://a.com/">https://a.com/</a>&quot;onmouseover=&quot;alert(1)'],
    ['<script>x</script> javascript:alert(1)', '&lt;script&gt;x&lt;/script&gt; javascript:alert(1)'],
    ['(https://a.com/b)', '(<a class="rp-link" href="https://a.com/b" title="https://a.com/b">https://a.com/b</a>)'],
    // 실측 결함(2026-10-06): /iu 플래그에서 K·S·k·s 가 비ASCII 로 접혀 naver 링크가 잘렸다
    ['https://n.com/d?fid=B+KmKs+SkS==', '<a class="rp-link" href="https://n.com/d?fid=B+KmKs+SkS==" title="https://n.com/d?fid=B+KmKs+SkS==">https://n.com/d?fid=B+KmKs+SkS==</a>'],
    ['HTTPS://A.COM/KS', '<a class="rp-link" href="HTTPS://A.COM/KS" title="HTTPS://A.COM/KS">HTTPS://A.COM/KS</a>']
  ];
  //  실DB 형태(합성 fid — 실제 링크는 커밋 금지): naver bigfile 링크 전체가 끝까지 링크화되는가
  const longUrl = 'https://bigfile.mail.naver.com/download?fid=AB+cdEF+GHKsKSkskAbCdKSKSefGhKSksXyZ+KsKS/KoKsaBcSKsk==';
  CASES.push([`첨부: ${longUrl}  \t`, `첨부: <a class="rp-link" href="${longUrl}" title="${longUrl}">${longUrl}</a>  \t`]);
  let diff = 0;
  CASES.forEach(([inp, want], i) => { const got = lk(inp); if (got !== want) { diff++; console.log(`    불일치 #${i}: ${got}`); } });
  diff === 0 ? ok(`linkifyText ${CASES.length}건 일치(주입 차단·문장부호·한글 경계)`) : bad(`linkifyText 불일치 ${diff}건`);
  // 배선: 본문이 linkifyText 로 그려지고, 클릭 위임 → openLink → link:open → link-download 가 이어져야 한다
  const pre = readFileSync(join(ROOT, 'src', 'preload.js'), 'utf8');
  const mainSrc = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
  const wires = [
    ['본문 렌더가 linkifyText 사용', /class="rp-body">\$\{linkifyText\(/.test(rsrc)],
    ['읽기창 링크 클릭 위임(.rp-body a[href]) → openLink', /closest\('\.rp-body a\[href\]'\)[\s\S]{0,200}window\.api\.openLink\(/.test(rsrc)],
    ['preload openLink → link:open', /openLink:\s*\(url\)\s*=>\s*ipcRenderer\.invoke\('link:open'/.test(pre)],
    ['main link:open → openLink(link-download)', /ipcMain\.handle\('link:open'/.test(mainSrc) && /linkDownload\.createLinkDownloader\(/.test(mainSrc)],
    ['새 창 요청도 openLink 경유(외부 openExternal 직행 없음)', /setWindowOpenHandler\(\(\{ url \}\) => \{ openLink\(url\);/.test(mainSrc)]
  ];
  // 다운로드 팝업 띠 ↔ main 채널 정합(scan-orphans 는 main preload 만 보므로 여기서 잡는다)
  const ldSrc = readFileSync(join(ROOT, 'src', 'link-download.js'), 'utf8');
  const lpPre = readFileSync(join(ROOT, 'src', 'link-popup-preload.js'), 'utf8');
  const lpHtml = readFileSync(join(ROOT, 'src', 'renderer', 'link-popup.html'), 'utf8');
  for (const ch of ['ldp:ready', 'ldp:act']) wires.push([`팝업 채널 ${ch} (preload send ↔ main on)`, lpPre.includes(`send('${ch}'`) && ldSrc.includes(`ipcMain.on('${ch}'`)]);
  wires.push(['팝업 채널 ldp:state (main send ↔ preload on)', ldSrc.includes(`send('ldp:state'`) && lpPre.includes(`on('ldp:state'`)]);
  wires.push(['팝업 html → link-popup.js', /<script src="link-popup\.js"><\/script>/.test(lpHtml) && existsSync(join(ROOT, 'src', 'renderer', 'link-popup.js'))]);
  wires.push(['main 이 팝업 html·preload 경로 주입', /link-popup\.html/.test(mainSrc) && /link-popup-preload\.js/.test(mainSrc)]);
  for (const [name, pass] of wires) pass ? ok(name) : bad('배선 끊김: ' + name);
} catch (e) { bad('링크 다운로드 검사 실패: ' + e.message); }

console.log(failed ? `\n셀프체크 실패 ${failed}건` : '\n셀프체크 전부 통과');
process.exit(failed ? 1 : 0);
