// ============================================================
//  install-dir.mjs — Bmail 설치 폴더 해석 (install-silent · post-install-verify 공용 SoT)
//  ------------------------------------------------------------
//  기본 설치 경로는 NSIS per-user 기본값 %LOCALAPPDATA%\Programs\outlook-ai-assistant.
//  설치본을 다른 드라이브로 옮기고 기본 경로에 NTFS 정션을 둔 PC(2026-09-29 마스터 PC)에서는
//  정션 대상이 실제 설치 폴더다. 정션이 없으면 기본 경로 그대로(타 사용자 영향 0).
// ============================================================
import { lstatSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_INSTALL_DIR = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
  'Programs', 'outlook-ai-assistant');

// p 가 정션(재분석 지점)이면 그 대상 폴더, 아니면 null. Node 는 정션도 isSymbolicLink()=true 로 본다.
export const junctionTarget = (p) => {
  try {
    if (!lstatSync(p).isSymbolicLink()) return null;
    return resolve(readlinkSync(p).replace(/^\\\\\?\\/, ''));
  } catch { return null; }
};

export const samePath = (a, b) => !!a && !!b && resolve(a).toLowerCase() === resolve(b).toLowerCase();
