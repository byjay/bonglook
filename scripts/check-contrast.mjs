#!/usr/bin/env node
// ============================================================
//  check-contrast.mjs — CSS 색 대비 기계 검사 (WCAG AA · 의존성 0)
//  ------------------------------------------------------------
//  대상: src/renderer/style.css · src/renderer/link-popup.html(<style> 블록)
//  판정: 같은 규칙(selector{…}) 안에서 color 와 background(-color) 가 **둘 다 확정**되는 쌍만
//        대비비 계산. 확정 = hex / rgb() / 이름색(white·black 등) / var(--x) 가 :root 에서 hex 로 풀림.
//        불확정(transparent · inherit · 그라데이션 · 알파<1 · 미정의 변수 · 한쪽만 선언) = SKIP 으로 집계.
//  기준: 본문 4.5:1 · 큰 글자(≥24px 또는 ≥18.66px+bold≥700) 3:1 (WCAG 1.4.3)
//  한계(정직 표기): 상속·캐스케이드(부모 배경 위의 자식 글자)·런타임 테마 변수 재정의는 보지 않는다.
//        창고 05-scripts-build/check-contrast.mjs(tsx 휴리스틱)를 참고해 CSS 전용으로 새로 썼다.
//
//  사용: node scripts/check-contrast.mjs                 # baseline 대비 신규 위반 있으면 exit 1
//        node scripts/check-contrast.mjs --report        # 전체 위반 나열(항상 exit 0)
//        node scripts/check-contrast.mjs --write-baseline # 현재 위반을 scripts/contrast-baseline.json 에 기록
//        node scripts/check-contrast.mjs --selftest      # 내장 self-test
//  baseline 방식: 기존 위반은 UI 변경 결정 전까지 보류(목록만 보고), **신규 위반 0** 을 selfcheck 가 강제한다.
// ============================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'contrast-baseline.json');
const TARGETS = [
  { file: 'src/renderer/style.css', kind: 'css' },
  { file: 'src/renderer/link-popup.html', kind: 'html' }
];
const MIN_TEXT = 4.5, MIN_LARGE = 3.0;

// ---------- 색 파싱 ----------
const NAMED = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', gray: '#808080', grey: '#808080', yellow: '#ffff00', orange: '#ffa500' };
/** 색 문자열 → [r,g,b] (불확정/반투명이면 null) */
export function parseColor(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (NAMED[s]) return parseColor(NAMED[s]);
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 4 || h.length === 8) { // 알파 채널 — ff 가 아니면 반투명 → 불확정
      const a = h.length === 4 ? h[3] + h[3] : h.slice(6, 8);
      if (a !== 'ff') return null;
      h = h.length === 4 ? h.slice(0, 3) : h.slice(0, 6);
    }
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (h.length !== 6) return null;
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  }
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) < 1) return null;
    return [m[1], m[2], m[3]].map(Number);
  }
  return null;
}
function luminance(rgb) {
  const [r, g, b] = rgb.map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG 대비비 (max+0.05)/(min+0.05) */
export function contrastRatio(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ---------- CSS 파싱 (최소 토크나이저 — @media 등 블록은 안쪽 규칙만 평탄화) ----------
function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, '')); }   // 줄 번호 보존
/** CSS 텍스트 → [{selector, decls:[{prop,value,important}], line}] */
export function parseRules(css) {
  const src = stripComments(css);
  const rules = [];
  let i = 0, depth = 0, selStart = 0;
  const atStack = [];
  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      const sel = src.slice(selStart, i).trim();
      // 다음 '{' 보다 '}' 가 먼저 오면 선언 블록, 아니면 중첩 블록(@media 등)
      const nextOpen = src.indexOf('{', i + 1), nextClose = src.indexOf('}', i + 1);
      if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) {
        const body = src.slice(i + 1, nextClose);
        if (!sel.startsWith('@') || atStack.length === 0 && /^@(font-face|page)/.test(sel)) {
          const lead = (src.slice(selStart, i).match(/^\s*/) || [''])[0].length;
          const line = src.slice(0, selStart + lead).split('\n').length;
          rules.push({ selector: (atStack.length ? atStack.join(' ') + ' ' : '') + sel, decls: parseDecls(body), line });
        }
        i = nextClose + 1; selStart = i;
      } else { atStack.push(sel); depth++; i++; selStart = i; }
    } else if (ch === '}') { atStack.pop(); depth--; i++; selStart = i; }
    else i++;
  }
  return rules;
}
function parseDecls(body) {
  return body.split(';').map(d => d.trim()).filter(Boolean).map(d => {
    const k = d.indexOf(':'); if (k === -1) return null;
    const prop = d.slice(0, k).trim().toLowerCase();
    let value = d.slice(k + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    value = value.replace(/!\s*important\s*$/i, '').trim();
    return { prop, value, important };
  }).filter(Boolean);
}
/** 같은 규칙 안에서 prop 의 최종값: !important 우선, 그 다음 마지막 선언 */
function finalDecl(decls, props) {
  const hits = decls.filter(d => props.includes(d.prop));
  if (!hits.length) return null;
  const imp = hits.filter(d => d.important);
  return (imp.length ? imp[imp.length - 1] : hits[hits.length - 1]).value;
}
/** var(--x[, fallback]) 를 :root 맵으로 치환 (규칙 자체의 --x 선언이 있으면 그것이 우선) */
export function resolveVars(value, vars) {
  let v = String(value), guard = 0;
  while (/var\(/.test(v) && guard++ < 10) {
    v = v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_, name, fb) => (name in vars ? vars[name] : (fb !== undefined ? fb : '__UNDEF__')));
  }
  return v;
}
/** background 축약값에서 단색만 추출 (그라데이션·url·transparent → null) */
function bgColorOf(value) {
  const v = value.trim().toLowerCase();
  if (/gradient\(|url\(|__undef__|transparent|inherit|none|currentcolor|initial|unset/.test(v)) return null;
  const m = v.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black|red|green|blue|gray|grey|yellow|orange)\b/);
  return m ? m[0] : null;
}
function isLargeText(decls, vars) {
  const fs = finalDecl(decls, ['font-size']), fw = finalDecl(decls, ['font-weight']);
  const px = fs ? parseFloat(resolveVars(fs, vars)) : NaN;
  if (!fs || !/px/.test(fs) || Number.isNaN(px)) return false;
  const bold = fw && (fw === 'bold' || parseInt(fw, 10) >= 700);
  return px >= 24 || (px >= 18.66 && bold);
}

/** CSS 텍스트 검사 → { violations, checked, skipped } */
export function checkCss(css, file) {
  const rules = parseRules(css);
  const vars = {};
  for (const r of rules) if (r.selector === ':root') for (const d of r.decls) if (d.prop.startsWith('--')) vars[d.prop] = d.value;
  const out = { violations: [], checked: 0, skipped: 0 };
  for (const r of rules) {
    const local = { ...vars };
    for (const d of r.decls) if (d.prop.startsWith('--')) local[d.prop] = d.value;
    const colorRaw = finalDecl(r.decls, ['color']);
    const bgRaw = finalDecl(r.decls, ['background-color', 'background']);
    if (!colorRaw || !bgRaw) continue;   // 한쪽만 선언 — 상속/캐스케이드 영역, 판정 대상 아님
    const fg = parseColor(resolveVars(colorRaw, local));
    const bgTok = bgColorOf(resolveVars(bgRaw, local));
    const bg = bgTok ? parseColor(bgTok) : null;
    if (!fg || !bg) { out.skipped++; continue; }
    out.checked++;
    const ratio = contrastRatio(fg, bg);
    const min = isLargeText(r.decls, local) ? MIN_LARGE : MIN_TEXT;
    if (ratio < min) out.violations.push({ file, line: r.line, selector: r.selector, color: colorRaw, background: bgRaw, ratio: Number(ratio.toFixed(2)), min });
  }
  return out;
}
function extractStyleBlocks(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
}
const keyOf = v => `${v.file}|${v.selector}|${v.color}|${v.background}`;

// ---------- self-test ----------
function selftest() {
  assert.strictEqual(contrastRatio(parseColor('#fff'), parseColor('#000')).toFixed(0), '21');
  assert.strictEqual(contrastRatio(parseColor('#777777'), parseColor('#ffffff')).toFixed(2), '4.48');
  assert.strictEqual(contrastRatio(parseColor('#0078d4'), parseColor('#e5f1fb')).toFixed(2), '3.95', '채널 가중치(0.2126/0.7152/0.0722) 훼손 감지');
  assert.strictEqual(contrastRatio(parseColor('#0078d4'), parseColor('#ffffff')).toFixed(2), '4.53', 'Outlook 파랑/흰 배경 = 4.53');
  assert.strictEqual(parseColor('rgba(0,0,0,.5)'), null, '반투명은 불확정');
  assert.strictEqual(parseColor('#ffffff80'), null, '8자리 알파는 불확정');
  assert.deepStrictEqual(parseColor('white'), [255, 255, 255]);
  const r = checkCss(':root{--bg:#fff; --fg:#777;} .a{color:var(--fg); background:var(--bg);} .b{color:#000; background:#fff;} .c{color:#fff; background:linear-gradient(#000,#fff);} .d{color:#000;} .e{color:#777;background:#fff;font-size:24px;}', 't.css');
  assert.strictEqual(r.violations.length, 1, '위반 1건(.a 4.48:1) 만 잡혀야 함: ' + JSON.stringify(r.violations));
  assert.strictEqual(r.violations[0].selector, '.a');
  assert.strictEqual(r.checked, 3, '.a .b .e 3건 판정');
  assert.strictEqual(r.skipped, 1, '.c 그라데이션 SKIP 1건');
  const imp = checkCss('.x{color:#000!important; background:#fff; color:#fff;}', 't.css');
  assert.strictEqual(imp.violations.length, 0, '!important 가 뒤 선언을 이겨야 함');
  const med = checkCss('@media (max-width:900px){ .m{color:#fff; background:#fff;} }', 't.css');
  assert.strictEqual(med.violations.length, 1, '@media 안 규칙도 검사');
  assert.strictEqual(med.violations[0].selector, '@media (max-width:900px) .m');
  const undef = checkCss('.u{color:var(--nope); background:#fff;}', 't.css');
  assert.strictEqual(undef.skipped, 1, '미정의 변수는 SKIP');
  const html = checkCss(extractStyleBlocks('<html><style>.h{color:#eee;background:#fff;}</style></html>'), 't.html');
  assert.strictEqual(html.violations.length, 1, 'html <style> 블록 검사');
  console.log('check-contrast self-test OK — 대비비·알파불확정·변수해석·!important·@media·그라데이션SKIP·큰글자3:1·html');
}

// ---------- main ----------
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) { selftest(); process.exit(0); }
let all = [], checked = 0, skipped = 0;
for (const t of TARGETS) {
  const p = join(ROOT, t.file);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  const r = checkCss(t.kind === 'html' ? extractStyleBlocks(text) : text, t.file);
  all.push(...r.violations); checked += r.checked; skipped += r.skipped;
}
if (argv.includes('--write-baseline')) {
  writeFileSync(BASELINE, JSON.stringify({ note: '기존 위반 보류 목록 — UI 변경 결정 전까지 유지. 신규 위반은 selfcheck 에서 차단.', keys: all.map(keyOf) }, null, 2) + '\n');
  console.log(`baseline 기록: ${all.length}건 → ${BASELINE}`);
  process.exit(0);
}
const base = existsSync(BASELINE) ? new Set(JSON.parse(readFileSync(BASELINE, 'utf8')).keys) : new Set();
const fresh = all.filter(v => !base.has(keyOf(v)));
const report = argv.includes('--report');
console.log(`대비 검사: 판정 ${checked}쌍 · SKIP(불확정) ${skipped}쌍 · 위반 ${all.length}건(기존 ${all.length - fresh.length} · 신규 ${fresh.length})`);
for (const v of (report ? all : fresh)) console.log(`  ${base.has(keyOf(v)) ? '[기존]' : '[신규]'} ${v.file}:${v.line} ${v.selector} — color:${v.color} / bg:${v.background} → ${v.ratio}:1 (기준 ${v.min})`);
if (report) process.exit(0);
process.exit(fresh.length ? 1 : 0);
