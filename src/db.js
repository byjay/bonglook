// ============================================================
//  db.js - 로컬 SQLite DB (better-sqlite3)
//  ------------------------------------------------------------
//  ★ 모든 메일/첨부/주소록/분석결과를 로컬 DB에 저장 + 색인(FTS5 전문검색)
//  ★ 백엔드 데이터는 JSON 컬럼 + 관계형 테이블로 이중 저장 (요구사항: json화 + db화)
//  ★ better-sqlite3: 동기 API라 Electron 메인 프로세스에서 가장 안정적
//  ★ DB 파일 위치: userData/mailstore.db (앱별 격리)
// ============================================================
const path = require('path');
const fs = require('fs');

let Database = null;
let db = null;
let dbPath = '';
let ftsEnabled = false;

// ------------------------------------------------------------
//  초기화: userDataPath 아래에 DB 생성/오픈 + 스키마 마이그레이션
// ------------------------------------------------------------
function init(userDataPath) {
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    throw new Error(
      'better-sqlite3 로드 실패. `npm run rebuild`(electron-builder install-app-deps) 실행 필요: ' + e.message
    );
  }

  const dir = path.join(userDataPath, 'data');
  fs.mkdirSync(dir, { recursive: true });
  dbPath = path.join(dir, 'mailstore.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');   // 동시성/안정성
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  migrate();
  return { dbPath };
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mails (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id      TEXT UNIQUE,              -- Outlook EntryID 또는 pst:해시
      source        TEXT,                     -- 'outlook' | 'pst'
      folder        TEXT,                     -- 폴더명
      subject       TEXT,
      sender_name   TEXT,
      sender_email  TEXT,
      recipients    TEXT,                     -- To
      cc            TEXT,
      received_at   TEXT,                     -- ISO8601
      received_ts   INTEGER,                  -- epoch ms (정렬/필터용)
      body          TEXT,
      preview       TEXT,
      has_attach    INTEGER DEFAULT 0,
      attach_count  INTEGER DEFAULT 0,
      unread        INTEGER DEFAULT 0,
      lang          TEXT,                     -- 감지 언어 (ko/en/zh 등)
      json          TEXT,                     -- 원본 전체 JSON
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mails_received_ts ON mails(received_ts DESC);
    CREATE INDEX IF NOT EXISTS idx_mails_sender ON mails(sender_email);
    CREATE INDEX IF NOT EXISTS idx_mails_folder ON mails(folder);

    CREATE TABLE IF NOT EXISTS attachments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mail_id     INTEGER,
      file_name   TEXT,
      ext         TEXT,
      size_kb     INTEGER,
      saved_path  TEXT,                       -- 로컬 저장 경로 (도면 등)
      extracted   TEXT,                       -- 추출 텍스트(요약)
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(mail_id) REFERENCES mails(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_attach_mail ON attachments(mail_id);

    CREATE TABLE IF NOT EXISTS contacts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT,
      email       TEXT UNIQUE,
      company     TEXT,
      phone       TEXT,
      source      TEXT,                       -- 'outlook' | 'derived'(메일에서 추출)
      json        TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);

    CREATE TABLE IF NOT EXISTS analyses (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mail_id     INTEGER,
      kind        TEXT,                       -- 'summary'|'translate'|'reply'|'briefing'
      lang        TEXT,
      content     TEXT,                       -- AI 결과
      json        TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(mail_id) REFERENCES mails(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_analyses_mail ON analyses(mail_id);

    CREATE TABLE IF NOT EXISTS sync_state (
      key        TEXT PRIMARY KEY,
      value      TEXT
    );
  `);

  // FTS5 전문검색 (제목/발신자/본문). 실패해도 앱은 동작(LIKE 폴백).
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS mails_fts USING fts5(
        subject, sender_name, sender_email, recipients, body,
        content='mails', content_rowid='id',
        tokenize='unicode61'
      );
    `);
    // 트리거로 mails ↔ mails_fts 동기화
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS mails_ai AFTER INSERT ON mails BEGIN
        INSERT INTO mails_fts(rowid, subject, sender_name, sender_email, recipients, body)
        VALUES (new.id, new.subject, new.sender_name, new.sender_email, new.recipients, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS mails_ad AFTER DELETE ON mails BEGIN
        INSERT INTO mails_fts(mails_fts, rowid, subject, sender_name, sender_email, recipients, body)
        VALUES ('delete', old.id, old.subject, old.sender_name, old.sender_email, old.recipients, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS mails_au AFTER UPDATE ON mails BEGIN
        INSERT INTO mails_fts(mails_fts, rowid, subject, sender_name, sender_email, recipients, body)
        VALUES ('delete', old.id, old.subject, old.sender_name, old.sender_email, old.recipients, old.body);
        INSERT INTO mails_fts(rowid, subject, sender_name, sender_email, recipients, body)
        VALUES (new.id, new.subject, new.sender_name, new.sender_email, new.recipients, new.body);
      END;
    `);
    ftsEnabled = true;
  } catch (e) {
    ftsEnabled = false;
  }
}

// ------------------------------------------------------------
//  간단 언어 감지 (ko/zh/ja/en) - AI 호출 없이 문자셋 기반
// ------------------------------------------------------------
function detectLang(text) {
  if (!text) return 'unknown';
  const s = String(text).slice(0, 2000);
  const hangul = (s.match(/[\uac00-\ud7a3]/g) || []).length;
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const kana = (s.match(/[\u3040-\u30ff]/g) || []).length;
  const latin = (s.match(/[a-zA-Z]/g) || []).length;
  const max = Math.max(hangul, cjk, kana, latin);
  if (max === 0) return 'unknown';
  if (max === hangul) return 'ko';
  if (max === kana) return 'ja';
  if (max === cjk) return 'zh';
  return 'en';
}

// ------------------------------------------------------------
//  메일 upsert (동기화 시 사용). mail: 표준화된 객체
// ------------------------------------------------------------
const upsertMailStmt = () => db.prepare(`
  INSERT INTO mails
    (entry_id, source, folder, subject, sender_name, sender_email, recipients, cc,
     received_at, received_ts, body, preview, has_attach, attach_count, unread, lang, json)
  VALUES
    (@entry_id, @source, @folder, @subject, @sender_name, @sender_email, @recipients, @cc,
     @received_at, @received_ts, @body, @preview, @has_attach, @attach_count, @unread, @lang, @json)
  ON CONFLICT(entry_id) DO UPDATE SET
    subject=excluded.subject, sender_name=excluded.sender_name, sender_email=excluded.sender_email,
    recipients=excluded.recipients, cc=excluded.cc, received_at=excluded.received_at,
    received_ts=excluded.received_ts, body=excluded.body, preview=excluded.preview,
    has_attach=excluded.has_attach, attach_count=excluded.attach_count, unread=excluded.unread,
    lang=excluded.lang, json=excluded.json
`);

function upsertMail(mail) {
  const receivedTs = mail.received ? Date.parse(mail.received) : (mail.receivedTs || null);
  const body = mail.body || mail.preview || '';
  const row = {
    entry_id: mail.entryId,
    source: mail.source || 'outlook',
    folder: mail.folder || 'Inbox',
    subject: mail.subject || '',
    sender_name: mail.sender || mail.senderName || '',
    sender_email: mail.senderMail || mail.senderEmail || '',
    recipients: mail.to || '',
    cc: mail.cc || '',
    received_at: mail.received || '',
    received_ts: receivedTs,
    body: body,
    preview: mail.preview || body.slice(0, 400),
    has_attach: mail.hasAttach ? 1 : 0,
    attach_count: mail.attachCount || 0,
    unread: mail.unread ? 1 : 0,
    lang: detectLang((mail.subject || '') + ' ' + body),
    json: JSON.stringify(mail)
  };
  const info = upsertMailStmt().run(row);
  // upsert 후 실제 id 조회
  const idRow = db.prepare('SELECT id FROM mails WHERE entry_id = ?').get(mail.entryId);
  return idRow ? idRow.id : info.lastInsertRowid;
}

function upsertMailsBatch(mails) {
  const tx = db.transaction((list) => {
    let n = 0;
    for (const m of list) { upsertMail(m); n++; }
    return n;
  });
  return tx(mails || []);
}

// ------------------------------------------------------------
//  첨부 저장 기록
// ------------------------------------------------------------
function addAttachment(mailId, att) {
  const stmt = db.prepare(`
    INSERT INTO attachments (mail_id, file_name, ext, size_kb, saved_path, extracted)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const ext = (att.fileName || '').split('.').pop().toLowerCase();
  return stmt.run(
    mailId, att.fileName || '', ext, att.sizeKB || 0,
    att.savedPath || '', (att.extracted || '').slice(0, 4000)
  ).lastInsertRowid;
}

function getAttachmentsByMail(mailId) {
  return db.prepare('SELECT * FROM attachments WHERE mail_id = ? ORDER BY id').all(mailId);
}

// ------------------------------------------------------------
//  주소록 upsert
// ------------------------------------------------------------
function upsertContact(c) {
  if (!c.email) return null;
  const stmt = db.prepare(`
    INSERT INTO contacts (name, email, company, phone, source, json)
    VALUES (@name, @email, @company, @phone, @source, @json)
    ON CONFLICT(email) DO UPDATE SET
      name=COALESCE(NULLIF(excluded.name,''), contacts.name),
      company=COALESCE(NULLIF(excluded.company,''), contacts.company),
      phone=COALESCE(NULLIF(excluded.phone,''), contacts.phone),
      source=excluded.source, json=excluded.json
  `);
  return stmt.run({
    name: c.name || '', email: (c.email || '').toLowerCase(),
    company: c.company || '', phone: c.phone || '',
    source: c.source || 'outlook', json: JSON.stringify(c)
  });
}

function upsertContactsBatch(contacts) {
  const tx = db.transaction((list) => {
    let n = 0;
    for (const c of list) { if (upsertContact(c)) n++; }
    return n;
  });
  return tx(contacts || []);
}

function listContacts(limit = 500, query = '') {
  if (query) {
    const q = `%${query.toLowerCase()}%`;
    return db.prepare(`
      SELECT * FROM contacts
      WHERE lower(name) LIKE ? OR lower(email) LIKE ? OR lower(company) LIKE ?
      ORDER BY name LIMIT ?
    `).all(q, q, q, limit);
  }
  return db.prepare('SELECT * FROM contacts ORDER BY name LIMIT ?').all(limit);
}

// ------------------------------------------------------------
//  분석결과 저장/조회
// ------------------------------------------------------------
function addAnalysis(mailId, kind, content, lang = '', extra = {}) {
  return db.prepare(`
    INSERT INTO analyses (mail_id, kind, lang, content, json)
    VALUES (?, ?, ?, ?, ?)
  `).run(mailId || null, kind, lang, content, JSON.stringify(extra)).lastInsertRowid;
}

function getAnalyses(mailId) {
  return db.prepare('SELECT * FROM analyses WHERE mail_id = ? ORDER BY id DESC').all(mailId);
}

// ------------------------------------------------------------
//  메일 검색 (FTS5 우선, 실패 시 LIKE 폴백) + 날짜/발신자 필터
//  opts: { query, limit, offset, sinceTs, untilTs, sender, folder, hasAttach }
// ------------------------------------------------------------
function searchMails(opts = {}) {
  const {
    query = '', limit = 100, offset = 0,
    sinceTs = null, untilTs = null, sender = '', folder = '', hasAttach = null
  } = opts;

  const where = [];
  const params = {};

  // CJK(중국어/일본어) 검색어는 unicode61 토크나이저가 분리를 못하므로
  // FTS를 건너뛰고 LIKE 폴백을 사용한다 (한국어/영어는 FTS 정상).
  const hasCJK = /[\u4e00-\u9fff\u3040-\u30ff]/.test(query || '');

  if (query && ftsEnabled && !hasCJK) {
    // FTS MATCH 사용
    const matchQ = ftsQuery(query);
    let sql = `
      SELECT m.* FROM mails m
      JOIN mails_fts f ON f.rowid = m.id
      WHERE mails_fts MATCH @match
    `;
    params.match = matchQ;
    if (sinceTs) { sql += ' AND m.received_ts >= @sinceTs'; params.sinceTs = sinceTs; }
    if (untilTs) { sql += ' AND m.received_ts <= @untilTs'; params.untilTs = untilTs; }
    if (sender) { sql += ' AND lower(m.sender_email) LIKE @sender'; params.sender = `%${sender.toLowerCase()}%`; }
    if (folder) { sql += ' AND m.folder = @folder'; params.folder = folder; }
    if (hasAttach === true) sql += ' AND m.has_attach = 1';
    sql += ' ORDER BY m.received_ts DESC LIMIT @limit OFFSET @offset';
    params.limit = limit; params.offset = offset;
    try {
      return db.prepare(sql).all(params);
    } catch (e) {
      // FTS 구문 오류 시 LIKE 폴백
    }
  }

  // LIKE 폴백
  let sql = 'SELECT * FROM mails WHERE 1=1';
  if (query) {
    sql += ` AND (lower(subject) LIKE @q OR lower(sender_name) LIKE @q OR lower(sender_email) LIKE @q OR lower(body) LIKE @q OR lower(recipients) LIKE @q)`;
    params.q = `%${query.toLowerCase()}%`;
  }
  if (sinceTs) { sql += ' AND received_ts >= @sinceTs'; params.sinceTs = sinceTs; }
  if (untilTs) { sql += ' AND received_ts <= @untilTs'; params.untilTs = untilTs; }
  if (sender) { sql += ' AND lower(sender_email) LIKE @sender'; params.sender = `%${sender.toLowerCase()}%`; }
  if (folder) { sql += ' AND folder = @folder'; params.folder = folder; }
  if (hasAttach === true) sql += ' AND has_attach = 1';
  sql += ' ORDER BY received_ts DESC LIMIT @limit OFFSET @offset';
  params.limit = limit; params.offset = offset;
  return db.prepare(sql).all(params);
}

// FTS 검색어 안전 변환 (특수문자 제거, 토큰별 접두검색)
function ftsQuery(q) {
  const tokens = String(q).replace(/["*^:(){}\[\]]/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return '""';
  return tokens.map(t => `"${t}"*`).join(' OR ');
}

function getMailById(id) {
  return db.prepare('SELECT * FROM mails WHERE id = ?').get(id);
}
function getMailByEntryId(entryId) {
  return db.prepare('SELECT * FROM mails WHERE entry_id = ?').get(entryId);
}

function recentMails(limit = 100, offset = 0) {
  return db.prepare('SELECT * FROM mails ORDER BY received_ts DESC LIMIT ? OFFSET ?').all(limit, offset);
}

// 기간 내 메일 (브리핑/분석용)
function mailsInRange(sinceTs, untilTs = null, limit = 500) {
  let sql = 'SELECT * FROM mails WHERE received_ts >= ?';
  const params = [sinceTs];
  if (untilTs) { sql += ' AND received_ts <= ?'; params.push(untilTs); }
  sql += ' ORDER BY received_ts DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// ------------------------------------------------------------
//  통계 (대시보드)
// ------------------------------------------------------------
function stats() {
  const total = db.prepare('SELECT COUNT(*) c FROM mails').get().c;
  const unread = db.prepare('SELECT COUNT(*) c FROM mails WHERE unread = 1').get().c;
  const withAttach = db.prepare('SELECT COUNT(*) c FROM mails WHERE has_attach = 1').get().c;
  const contacts = db.prepare('SELECT COUNT(*) c FROM contacts').get().c;
  const attach = db.prepare('SELECT COUNT(*) c FROM attachments').get().c;
  const byLang = db.prepare('SELECT lang, COUNT(*) c FROM mails GROUP BY lang').all();
  const topSenders = db.prepare(`
    SELECT sender_name, sender_email, COUNT(*) c
    FROM mails WHERE sender_email != ''
    GROUP BY sender_email ORDER BY c DESC LIMIT 10
  `).all();
  return { total, unread, withAttach, contacts, attachments: attach, byLang, topSenders, ftsEnabled };
}

// ------------------------------------------------------------
//  동기화 상태 저장 (마지막 동기화 시각 등)
// ------------------------------------------------------------
function setState(key, value) {
  db.prepare('INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, typeof value === 'string' ? value : JSON.stringify(value));
}
function getState(key) {
  const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key);
  return r ? r.value : null;
}

function close() {
  if (db) { try { db.close(); } catch (_) {} db = null; }
}

module.exports = {
  init, close, detectLang,
  upsertMail, upsertMailsBatch,
  addAttachment, getAttachmentsByMail,
  upsertContact, upsertContactsBatch, listContacts,
  addAnalysis, getAnalyses,
  searchMails, getMailById, getMailByEntryId, recentMails, mailsInRange,
  stats, setState, getState,
  get dbPath() { return dbPath; },
  get ftsEnabled() { return ftsEnabled; }
};
