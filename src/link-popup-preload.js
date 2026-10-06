// ============================================================
//  link-popup-preload.js — 다운로드 팝업 상단 띠(로컬 페이지) 전용 다리
//  서비스 페이지(WebContentsView)에는 preload 를 붙이지 않는다 — 이 다리는 띠에만 있다.
//  link-download.js 가 BrowserWindow 의 preload 로 지정한다.
// ============================================================
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ldp', {
  ready: (barH) => ipcRenderer.send('ldp:ready', barH),
  act: (name) => ipcRenderer.send('ldp:act', String(name)),
  onState: (cb) => ipcRenderer.on('ldp:state', (_e, s) => cb(s))
});
