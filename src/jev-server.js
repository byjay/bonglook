// ============================================================
//  jev-server.js — JevK5 로컬 온디맨드 서버 수명주기 (VRAM 확인 · 유휴 자동종료)
//  ------------------------------------------------------------
//  jev.js(callLocal) 가 요청 직전에 ensureServer() 를 부른다.
//  두 프로세스를 순서대로 기동한다:
//    1) llama-server.exe (llama.cpp, GGUF 를 GPU/CPU 에 적재, 8080)
//    2) systemone_gguf_server.py (jevk5.gguf.JevK5GGUF 래퍼, /v1/systemone, 8090)
//       — E:\models\jevk5\systemone_gguf_server.py (③-a 스모크 산출물 재사용)
//
//  🔴 기동 전 여유 VRAM 확인(nvidia-smi) — 기준 미만이면 GPU 기동 금지(config.local.vramFreeMinMb
//     기본 4000MB). 마스터가 CAD(AutoCAD 등) 상시 사용 → JevK5 GPU 상시 점유 금지.
//  🔴 마지막 요청 후 유휴 config.local.idleTimeoutMs(기본 5분) 지나면 자동 종료. 앱/스크립트 종료 시
//     process 'exit' 훅에서도 강제 종료(좀비 프로세스 0).
// ============================================================

'use strict';
const { spawn, execFile } = require('child_process');

const state = {
  llamaProc: null,
  wrapperProc: null,
  starting: null,
  lastRequestAt: 0,
  idleTimer: null,
  mode: null,      // 'gpu' | 'cpu'
};

function log(...args) {
  console.log('[jev-server]', new Date().toISOString(), ...args);
}

function freeVramMb() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const n = parseInt(String(stdout).trim().split('\n')[0], 10);
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

async function waitHealthy(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (resp.ok) return true;
    } catch (e) { /* 아직 안 뜸 — 계속 폴링 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function killProc(proc) {
  return new Promise((resolve) => {
    if (!proc) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    proc.once('exit', finish);
    try { proc.kill(); } catch (e) { /* 이미 죽었을 수 있음 */ }
    setTimeout(finish, 3000);
  });
}

async function shutdown() {
  if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
  const l = state.llamaProc; const w = state.wrapperProc;
  state.llamaProc = null; state.wrapperProc = null;
  await Promise.all([killProc(w), killProc(l)]);
  const hadMode = state.mode;
  state.mode = null;
  if (hadMode) log('종료 완료(좀비 방지)');
}

function scheduleIdleShutdown(localCfg) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  const idleMs = localCfg.idleTimeoutMs || 5 * 60 * 1000;
  state.idleTimer = setTimeout(async () => {
    const idle = Date.now() - state.lastRequestAt;
    if (idle >= idleMs - 500) {
      log(`유휴 ${Math.round(idle / 1000)}s 경과(기준 ${Math.round(idleMs / 1000)}s) — 자동 종료`);
      await shutdown();
    }
  }, idleMs);
  if (state.idleTimer.unref) state.idleTimer.unref();
}

async function ensureServer(cfg) {
  const c = cfg.local;
  if (!c.base) return { ok: false, error: 'JevK5 base 경로 없음' };
  if (state.llamaProc && state.wrapperProc) {
    return { ok: true, alreadyRunning: true, mode: state.mode };
  }
  if (state.starting) return state.starting;

  state.starting = (async () => {
    try {
      const free = await freeVramMb();
      let ngl = c.gpuLayers;
      let mode = 'gpu';
      if (free == null) {
        log('VRAM 확인 실패(nvidia-smi 없음/오류) — CPU 모드로 진행');
        ngl = 0; mode = 'cpu';
      } else if (free < c.vramFreeMinMb) {
        log(`VRAM 부족: 여유 ${free}MB < 기준 ${c.vramFreeMinMb}MB`);
        if (c.gpuFallback === 'skip') {
          return { ok: false, error: `VRAM 부족(여유 ${free}MB < ${c.vramFreeMinMb}MB) — 설정상 기동 건너뜀` };
        }
        ngl = 0; mode = 'cpu';
        log('CPU 모드(-ngl 0)로 대체 기동');
      } else {
        log(`VRAM 여유 ${free}MB — GPU 기동 진행(ngl=${ngl})`);
      }

      const t0 = Date.now();
      const llamaArgs = [
        '-m', c.modelPath,
        '-c', String(c.ctxSize),
        '-ngl', String(ngl),
        '--parallel', String(c.parallelSlots),
        '--host', c.llamaHost,
        '--port', String(c.llamaPort),
      ];
      log('llama-server 기동:', c.llamaServerExe, llamaArgs.join(' '));
      state.llamaProc = spawn(c.llamaServerExe, llamaArgs, { stdio: 'ignore', windowsHide: true });
      state.llamaProc.on('exit', (code) => { log('llama-server 프로세스 종료됨 code=', code); state.llamaProc = null; });
      state.llamaProc.on('error', (e) => log('llama-server 기동 오류:', e.message));

      const llamaOk = await waitHealthy(`http://${c.llamaHost}:${c.llamaPort}/health`, c.startupTimeoutMs);
      if (!llamaOk) { await shutdown(); return { ok: false, error: 'llama-server 기동 타임아웃' }; }

      log('systemone wrapper 기동:', c.pythonExe, c.wrapperScript);
      state.wrapperProc = spawn(c.pythonExe, [c.wrapperScript], { stdio: 'ignore', windowsHide: true, cwd: c.base });
      state.wrapperProc.on('exit', (code) => { log('systemone wrapper 프로세스 종료됨 code=', code); state.wrapperProc = null; });
      state.wrapperProc.on('error', (e) => log('systemone wrapper 기동 오류:', e.message));

      const wrapperOk = await waitHealthy(`http://${c.systemoneHost}:${c.systemonePort}/health`, c.startupTimeoutMs);
      if (!wrapperOk) { await shutdown(); return { ok: false, error: 'systemone wrapper 기동 타임아웃' }; }

      state.mode = mode;
      const coldStartMs = Date.now() - t0;
      log(`기동 완료: mode=${mode} coldStartMs=${coldStartMs} freeVramMb=${free}`);
      scheduleIdleShutdown(c);
      return { ok: true, mode, coldStartMs, freeVramMb: free };
    } finally {
      state.starting = null;
    }
  })();

  return state.starting;
}

function noteRequest(cfg) {
  state.lastRequestAt = Date.now();
  if (cfg && cfg.local) scheduleIdleShutdown(cfg.local);
}

function status() {
  return { running: !!(state.llamaProc && state.wrapperProc), mode: state.mode, lastRequestAt: state.lastRequestAt };
}

// 앱/스크립트 종료 시 좀비 프로세스 0 보장
process.on('exit', () => {
  try { if (state.llamaProc) state.llamaProc.kill(); } catch (e) { /* noop */ }
  try { if (state.wrapperProc) state.wrapperProc.kill(); } catch (e) { /* noop */ }
});

module.exports = { ensureServer, noteRequest, shutdown, status, freeVramMb };
