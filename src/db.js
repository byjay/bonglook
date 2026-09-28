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
const sched = require('./schedules');   // 일정 추출 엔진(순수 함수)
const attachClassify = require('./attach-classify');  // 진짜 첨부 vs 인라인 이미지 판정

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

    -- ★ 메일별 대화 이력(마스터 지시: "각 메일 안에서 '대화하기'"). 메일 id 를 키로
    --   멀티턴을 저장해 다시 열면 이어볼 수 있게 한다. Outlook 원본과 무관한 로컬 전용 데이터.
    CREATE TABLE IF NOT EXISTS mail_chat (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mail_id     INTEGER NOT NULL,
      role        TEXT NOT NULL,               -- 'user' | 'assistant'
      content     TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(mail_id) REFERENCES mails(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mail_chat_mail ON mail_chat(mail_id, id);

    CREATE TABLE IF NOT EXISTS sync_state (
      key        TEXT PRIMARY KEY,
      value      TEXT
    );

    -- ★ 로컬 가상 폴더 (Outlook 원본 메일함은 절대 건드리지 않는다)
    --   여기서 만든 폴더/이동/삭제는 이 DB 안에서만 유효하다.
    CREATE TABLE IF NOT EXISTS virtual_folders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      parent_id   INTEGER,
      sort_order  INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(parent_id) REFERENCES virtual_folders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_vf_parent ON virtual_folders(parent_id);

    -- 메일 → 가상 폴더 배치 (1메일 1가상폴더). 행을 지우면 원래 폴더 표시로 자동 복귀.
    CREATE TABLE IF NOT EXISTS mail_folder_map (
      mail_id     INTEGER PRIMARY KEY,
      vfolder_id  INTEGER NOT NULL,
      moved_at    TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(mail_id) REFERENCES mails(id) ON DELETE CASCADE,
      FOREIGN KEY(vfolder_id) REFERENCES virtual_folders(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mfm_vf ON mail_folder_map(vfolder_id);

    -- ★ 프로젝트 사전 (업무일지·보낸메일 트리·검색이 공유하는 하나의 사전)
    --   kind: 'prefix'(제목 말머리) | 'contains'(제목/본문 포함) | 'folder'(받은편지함 폴더명)
    CREATE TABLE IF NOT EXISTS project_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern    TEXT NOT NULL,
      project    TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'contains',
      priority   INTEGER DEFAULT 100,
      auto       INTEGER DEFAULT 0,      -- 1 = 수동 지정에서 자동 학습된 규칙
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prules_uq ON project_rules(kind, lower(pattern));

    -- 메일별 수동 프로젝트 지정 (자동 판정을 덮어씀)
    CREATE TABLE IF NOT EXISTS project_map (
      mail_id    INTEGER PRIMARY KEY,
      project    TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(mail_id) REFERENCES mails(id) ON DELETE CASCADE
    );

    -- ★ 상대 조직 사전 (도메인 → 조직명). 자동 구축 + 설정에서 편집 가능
    CREATE TABLE IF NOT EXISTS org_domain_map (
      domain TEXT PRIMARY KEY,
      org    TEXT NOT NULL,
      auto   INTEGER DEFAULT 1,
      cnt    INTEGER DEFAULT 0
    );

    -- 폴더 트리 표시 순서 (로컬)
    --  COM 은 Outlook 사이드바의 사용자 정의 순서를 노출하지 않는다(실측: MAPI 속성에도 없음).
    --  → 마스터가 정한 순서를 여기에 보관해 트리에 그대로 적용한다.
    CREATE TABLE IF NOT EXISTS folder_order (
      store  TEXT NOT NULL,
      path   TEXT NOT NULL,
      ord    INTEGER NOT NULL,
      PRIMARY KEY (store, path)
    );

    -- 즐겨찾기 (실폴더 이름 또는 가상폴더 id, 순서 유지)
    CREATE TABLE IF NOT EXISTS folder_favorites (
      key         TEXT PRIMARY KEY,      -- real:<폴더명> | virtual:<id>
      kind        TEXT NOT NULL,         -- 'real' | 'virtual'
      label       TEXT NOT NULL,
      sort_order  INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );
  `);

  // 로컬 읽음 플래그 컬럼 (Outlook 원본 unread 는 그대로 두고 로컬에서만 덮어씀)
  try {
    const cols = db.prepare('PRAGMA table_info(mails)').all().map(c => c.name);
    if (!cols.includes('read_flag')) db.exec('ALTER TABLE mails ADD COLUMN read_flag INTEGER DEFAULT NULL');
  } catch (_) {}

  // 첨부 분류 — 진짜 첨부 수 / 인라인(서명 로고·본문 삽입 이미지) 표시
  try {
    const mc2 = db.prepare('PRAGMA table_info(mails)').all().map(c => c.name);
    if (!mc2.includes('real_attach_count')) db.exec('ALTER TABLE mails ADD COLUMN real_attach_count INTEGER');
    const ac = db.prepare('PRAGMA table_info(attachments)').all().map(c => c.name);
    if (!ac.includes('is_inline')) db.exec('ALTER TABLE attachments ADD COLUMN is_inline INTEGER DEFAULT 0');
    if (!ac.includes('cid')) db.exec('ALTER TABLE attachments ADD COLUMN cid TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_attach_inline ON attachments(mail_id, is_inline)');
  } catch (_) {}

  // 즐겨찾기 출처 구분 — Outlook 탐색 창에서 가져온 항목(정본) vs 앱에서 수동 추가한 항목
  try {
    const fc = db.prepare('PRAGMA table_info(folder_favorites)').all().map(c => c.name);
    if (!fc.includes('source')) db.exec("ALTER TABLE folder_favorites ADD COLUMN source TEXT DEFAULT 'manual'");
    if (!fc.includes('path')) db.exec('ALTER TABLE folder_favorites ADD COLUMN path TEXT');
  } catch (_) {}

  // 폴더 순서 출처 구분 — Outlook PR_SORT_POSITION 유래(정본) vs 마스터가 손으로 정한 순서
  try {
    const oc = db.prepare('PRAGMA table_info(folder_order)').all().map(c => c.name);
    if (!oc.includes('source')) db.exec("ALTER TABLE folder_order ADD COLUMN source TEXT DEFAULT 'manual'");
    // source 개념 도입 이전의 행 = Outlook 정렬키를 일괄 기록해 둔 값.
    // 'outlook' 으로 표시해 두면 다음 동기화에서 통째로 재계산된다.
    // ★ 컬럼 존재 여부가 아니라 '1회 실행 플래그'로 판단한다.
    //   (ALTER 만 성공하고 프로세스가 죽으면 이 정리가 영원히 건너뛰어진다 — 실제 발생)
    const done = db.prepare("SELECT value FROM sync_state WHERE key = 'folder_order_source_migrated'").get();
    if (!done) {
      db.exec("UPDATE folder_order SET source = 'outlook' WHERE IFNULL(source,'') <> 'outlook'");
      db.prepare("INSERT INTO sync_state(key,value) VALUES('folder_order_source_migrated','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    }
    // 2026-08-04: 폴더 표시 순서의 정본을 'DB 에 미리 계산해 둔 ord' → 'Outlook 이 준 PR_SORT_POSITION
    //   을 렌더러가 직접 정렬' 로 일원화했다. 낡은 outlook 유래 행은 마스터 수동 순서를 방해하므로 제거.
    const done2 = db.prepare("SELECT value FROM sync_state WHERE key = 'folder_order_outlook_dropped'").get();
    if (!done2) {
      db.exec("DELETE FROM folder_order WHERE IFNULL(source,'manual') = 'outlook'");
      db.prepare("INSERT INTO sync_state(key,value) VALUES('folder_order_outlook_dropped','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
    }
  } catch (_) {}

  // 프로젝트·대표수신인 캐시 컬럼 (집계를 SQL GROUP BY 로 처리하기 위한 비정규화)
  try {
    const mc = db.prepare('PRAGMA table_info(mails)').all().map(c => c.name);
    if (!mc.includes('project')) db.exec('ALTER TABLE mails ADD COLUMN project TEXT');
    if (!mc.includes('to_first')) db.exec('ALTER TABLE mails ADD COLUMN to_first TEXT');
    if (!mc.includes('to_count')) db.exec('ALTER TABLE mails ADD COLUMN to_count INTEGER');
    // 내가 직접 수신(To)인지 참조(CC)인지 — 리스트 마커·필터·AI 힌트 공용
    if (!mc.includes('to_me')) db.exec('ALTER TABLE mails ADD COLUMN to_me INTEGER');
    // 상대 조직(2차 분류) · 스레드 키(3차 분류) 캐시
    if (!mc.includes('to_org')) db.exec('ALTER TABLE mails ADD COLUMN to_org TEXT');
    if (!mc.includes('thread_key')) db.exec('ALTER TABLE mails ADD COLUMN thread_key TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mails_toorg ON mails(to_org)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mails_thread ON mails(thread_key)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mails_tome ON mails(to_me)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mails_project ON mails(project)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mails_tofirst ON mails(to_first)');
  } catch (_) {}

  // ★ Outlook 잔여 데이터 (범주·플래그·중요도) — 기존 mails 테이블 확장.
  //   별도 테이블을 새로 파지 않는다(중복 테이블 금지 원칙). 전부 읽기 전용 수집분.
  try {
    const mc3 = db.prepare('PRAGMA table_info(mails)').all().map(c => c.name);
    if (!mc3.includes('categories')) db.exec('ALTER TABLE mails ADD COLUMN categories TEXT');
    if (!mc3.includes('importance')) db.exec('ALTER TABLE mails ADD COLUMN importance INTEGER');
    if (!mc3.includes('flag_status')) db.exec('ALTER TABLE mails ADD COLUMN flag_status INTEGER');
    if (!mc3.includes('flag_request')) db.exec('ALTER TABLE mails ADD COLUMN flag_request TEXT');
    if (!mc3.includes('task_due')) db.exec('ALTER TABLE mails ADD COLUMN task_due TEXT');
    if (!mc3.includes('task_start')) db.exec('ALTER TABLE mails ADD COLUMN task_start TEXT');
    if (!mc3.includes('reminder_on')) db.exec('ALTER TABLE mails ADD COLUMN reminder_on INTEGER');
    if (!mc3.includes('reminder_at')) db.exec('ALTER TABLE mails ADD COLUMN reminder_at TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mails_flag ON mails(flag_status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mails_importance ON mails(importance)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mails_taskdue ON mails(task_due)');
  } catch (_) {}

  // ★ 메일별 '내 처리 상태' (todo/hold/done/fyi) — mails 테이블 확장(신규 테이블 금지).
  //   수동 지정이 정본이며, 자동 제안은 저장하지 않는다(화면에서만 계산해 보여 준다).
  try {
    const mc4 = db.prepare('PRAGMA table_info(mails)').all().map(c => c.name);
    if (!mc4.includes('action_state')) db.exec('ALTER TABLE mails ADD COLUMN action_state TEXT');
    if (!mc4.includes('action_note')) db.exec('ALTER TABLE mails ADD COLUMN action_note TEXT');
    if (!mc4.includes('action_due')) db.exec('ALTER TABLE mails ADD COLUMN action_due TEXT');
    if (!mc4.includes('action_updated_at')) db.exec('ALTER TABLE mails ADD COLUMN action_updated_at TEXT');
    if (!mc4.includes('action_prev')) db.exec('ALTER TABLE mails ADD COLUMN action_prev TEXT');   // 되돌리기용 직전 값
    // 출처: 'manual'(사용자가 직접 지정 · 정본) | 'flag'(Outlook 깃발에서 초기 매핑)
    if (!mc4.includes('action_source')) db.exec('ALTER TABLE mails ADD COLUMN action_source TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mails_action ON mails(action_state)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_mails_action_due ON mails(action_due)');
  } catch (_) {}

  // 범주 마스터(이름·색) — Outlook Namespace.Categories 미러
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      name       TEXT PRIMARY KEY,
      color      INTEGER,
      hex        TEXT,
      shortcut   INTEGER,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Outlook 캘린더 일정 · 작업 — 기존 schedules 테이블을 '출처 구분'으로 확장해 흡수한다.
  //  (schedules 는 원래 AI 분석에서 뽑은 일정용. source_kind 로 outlook 유래를 구분)
  try {
    const sc = db.prepare('PRAGMA table_info(schedules)').all().map(c => c.name);
    if (!sc.includes('end_date')) db.exec('ALTER TABLE schedules ADD COLUMN end_date TEXT');
    if (!sc.includes('location')) db.exec('ALTER TABLE schedules ADD COLUMN location TEXT');
    if (!sc.includes('categories')) db.exec('ALTER TABLE schedules ADD COLUMN categories TEXT');
    if (!sc.includes('entry_id')) db.exec('ALTER TABLE schedules ADD COLUMN entry_id TEXT');
    if (!sc.includes('all_day')) db.exec('ALTER TABLE schedules ADD COLUMN all_day INTEGER DEFAULT 0');
    if (!sc.includes('percent')) db.exec('ALTER TABLE schedules ADD COLUMN percent INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sched_kind ON schedules(source_kind)');
  } catch (_) {}

  // 검색 폴더 목록(조건 표시용) — Outlook 원본을 바꾸지 않고 보여주기만 한다
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_folders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      store      TEXT,
      name       TEXT,
      path       TEXT,
      items      INTEGER,
      filter     TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(store, name)
    );
  `);

  // 주소록 확장: 개인/그룹(배포목록) 구분 + 그룹 멤버 + 출처 폴더/스토어
  try {
    const cc = db.prepare('PRAGMA table_info(contacts)').all().map(c => c.name);
    if (!cc.includes('type')) db.exec("ALTER TABLE contacts ADD COLUMN type TEXT DEFAULT 'person'");
    if (!cc.includes('display_name')) db.exec('ALTER TABLE contacts ADD COLUMN display_name TEXT');
    if (!cc.includes('folder')) db.exec('ALTER TABLE contacts ADD COLUMN folder TEXT');
    if (!cc.includes('store')) db.exec('ALTER TABLE contacts ADD COLUMN store TEXT');
  } catch (_) {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_members (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id    INTEGER NOT NULL,
      name        TEXT,
      email       TEXT,
      FOREIGN KEY(group_id) REFERENCES contacts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_gm_group ON group_members(group_id);

    -- 일정(마감·회의·할 일) 통합 테이블
    --  분석·브리핑·업무일지에서 뽑은 기한과 수동 등록 일정을 한 곳에 모은다.
    --  ★ 별도 '일정' 테이블을 새로 만들지 않고 여기로 통일한다(중복 테이블 금지).
    CREATE TABLE IF NOT EXISTS schedules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT NOT NULL,             -- 'YYYY-MM-DD'
      time        TEXT,                      -- 'HH:MM' (없으면 종일)
      title       TEXT NOT NULL,
      owner       TEXT,
      source_kind TEXT NOT NULL,             -- 'action'|'todo'|'open'|'fact'|'manual'
      source_id   INTEGER,                   -- analyses.id (수동은 NULL)
      mail_id     INTEGER,
      raw_due     TEXT,                      -- 원문 기한 표현(추적용)
      dedupe_key  TEXT NOT NULL,             -- mail|date|정규화제목
      done        INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sched_key ON schedules(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_sched_date ON schedules(date);

    -- 대용량 첨부(bigmail) 전송 이력 — 링크와 만료일을 잃어버리지 않게 남긴다
    CREATE TABLE IF NOT EXISTS bigmail_uploads (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_id    TEXT,
      download_url TEXT NOT NULL,
      file_count   INTEGER DEFAULT 0,
      total_size   INTEGER DEFAULT 0,
      file_names   TEXT,
      subject      TEXT,
      expires_at   TEXT,
      has_password INTEGER DEFAULT 0,
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bmu_created ON bigmail_uploads(created_at);
  `);
  // 구 스키마는 email 에 UNIQUE 가 걸려 있어 (a) 이메일 없는 연락처 다건,
  // (b) 이메일이 없는 그룹(배포목록)을 저장할 수 없다 → 테이블 재작성으로 해소.
  try {
    const t = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contacts'").get();
    if (t && /email\s+TEXT\s+UNIQUE/i.test(t.sql)) {
      db.exec(`
        CREATE TABLE contacts_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT, email TEXT, company TEXT, phone TEXT, source TEXT, json TEXT,
          type TEXT DEFAULT 'person', display_name TEXT, folder TEXT, store TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO contacts_new (id,name,email,company,phone,source,json,type,display_name,folder,store,created_at)
          SELECT id,name,email,company,phone,source,json,
                 COALESCE(type,'person'),display_name,folder,store,created_at FROM contacts;
        DROP TABLE contacts;
        ALTER TABLE contacts_new RENAME TO contacts;
      `);
    }
  } catch (e) { /* 재작성 실패 시 기존 테이블 유지 */ }
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_person_email ON contacts(lower(email)) WHERE type='person' AND email <> ''");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_group_name ON contacts(name) WHERE type='group'");
    db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email)');
  } catch (_) {}

  // 기존 행 폴더명 정규화 (구버전은 로케일 표시 이름을 그대로 저장했음
  // → UI 의 folder='Inbox'/'Sent' 필터가 0건이 되던 문제 복구)
  try {
    const rows = db.prepare('SELECT DISTINCT folder FROM mails').all();
    const upd = db.prepare('UPDATE mails SET folder = ? WHERE folder = ?');
    for (const r of rows) {
      const canon = canonicalFolder(r.folder);
      if (canon !== r.folder) upd.run(canon, r.folder);
    }
  } catch (_) { /* mails 테이블이 아직 없거나 비어있는 경우 무시 */ }

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
//  폴더명 정규화 (로케일 독립)
//  Outlook/PST 는 표시 이름을 로케일별로 돌려준다("받은 편지함", "收件箱").
//  UI 는 folder='Inbox'/'Sent' 로 필터하므로, 저장 시점에 정규 키로 통일한다.
//  (매칭 안 되는 사용자 폴더는 이름 그대로 유지)
// ------------------------------------------------------------
const FOLDER_ALIASES = {
  'inbox': 'Inbox', '받은 편지함': 'Inbox', '받은편지함': 'Inbox',
  '收件箱': 'Inbox', '受信トレイ': 'Inbox', 'posteingang': 'Inbox',
  'sent': 'Sent', 'sent items': 'Sent', '보낸 편지함': 'Sent', '보낸편지함': 'Sent',
  '已发送邮件': 'Sent', '送信済みアイテム': 'Sent', 'gesendete elemente': 'Sent',
  // 특수 폴더 (Outlook 사이드바 1:1)
  'drafts': 'Drafts', '임시 보관함': 'Drafts', '임시보관함': 'Drafts',
  'outbox': 'Outbox', '보낼 편지함': 'Outbox', '보낼편지함': 'Outbox',
  'junk email': 'Junk', 'junk e-mail': 'Junk', '정크 메일': 'Junk', '정크메일': 'Junk',
  'deleted items': 'Deleted', '지운 편지함': 'Deleted', '지운편지함': 'Deleted'
};
function canonicalFolder(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'Inbox';
  // pst.js 는 '/부모/받은 편지함' 형태의 경로를 준다(항상 '/'로 시작) → 마지막 조각만 사용.
  // 반면 Outlook 폴더 '이름' 자체에 '/'가 들어갈 수 있으므로
  // ('6500TEU MUNDRA/HONG' 실존) 경로 형태가 아니면 통째로 보존한다.
  const leaf = raw.startsWith('/') ? raw.split('/').pop().trim() : raw;
  return FOLDER_ALIASES[leaf.toLowerCase()] || leaf;
}

// ------------------------------------------------------------
//  메일 upsert (동기화 시 사용). mail: 표준화된 객체
// ------------------------------------------------------------
const upsertMailStmt = () => db.prepare(`
  INSERT INTO mails
    (entry_id, source, folder, subject, sender_name, sender_email, recipients, cc,
     received_at, received_ts, body, preview, has_attach, attach_count, real_attach_count, unread, lang, json,
     categories, importance, flag_status, flag_request, task_due, task_start, reminder_on, reminder_at)
  VALUES
    (@entry_id, @source, @folder, @subject, @sender_name, @sender_email, @recipients, @cc,
     @received_at, @received_ts, @body, @preview, @has_attach, @attach_count, @real_attach_count, @unread, @lang, @json,
     @categories, @importance, @flag_status, @flag_request, @task_due, @task_start, @reminder_on, @reminder_at)
  ON CONFLICT(entry_id) DO UPDATE SET
    source=excluded.source, folder=excluded.folder,
    subject=excluded.subject, sender_name=excluded.sender_name, sender_email=excluded.sender_email,
    recipients=excluded.recipients, cc=excluded.cc, received_at=excluded.received_at,
    received_ts=excluded.received_ts, body=excluded.body, preview=excluded.preview,
    has_attach=excluded.has_attach, attach_count=excluded.attach_count,
    real_attach_count=excluded.real_attach_count, unread=excluded.unread,
    lang=excluded.lang, json=excluded.json,
    categories=excluded.categories, importance=excluded.importance,
    flag_status=excluded.flag_status, flag_request=excluded.flag_request,
    task_due=excluded.task_due, task_start=excluded.task_start,
    reminder_on=excluded.reminder_on, reminder_at=excluded.reminder_at
`);

function upsertMail(mail) {
  const receivedTs = mail.received ? Date.parse(mail.received) : (mail.receivedTs || null);
  const body = mail.body || mail.preview || '';
  const row = {
    entry_id: mail.entryId,
    source: mail.source || 'outlook',
    folder: canonicalFolder(mail.folder || mail.folderName),
    subject: mail.subject || '',
    sender_name: mail.sender || mail.senderName || '',
    sender_email: mail.senderMail || mail.senderEmail || '',
    recipients: mail.to || '',
    cc: mail.cc || '',
    received_at: mail.received || '',
    received_ts: receivedTs,
    body: body,
    preview: mail.preview || body.slice(0, 400),
    // ★ has_attach 는 '진짜 첨부'(서명 로고·본문 삽입 이미지 제외) 기준이다.
    //   인라인까지 세면 첨부 없는 메일이 첨부 있는 것처럼 보인다(실측: 22,312건 과대).
    has_attach: (Number(mail.realAttachCount) || 0) > 0 ? 1 : 0,
    attach_count: mail.attachCount || 0,
    real_attach_count: Number(mail.realAttachCount) || 0,
    unread: mail.unread ? 1 : 0,
    lang: detectLang((mail.subject || '') + ' ' + body),
    json: JSON.stringify(mail),
    // ★ Outlook 잔여 데이터 (읽기 전용 수집분). 스캔이 값을 안 주면 기존 값을 지우지 않도록
    //   null 을 넣고, 아래 COALESCE 백필(applyMailMeta)로 채운다.
    categories: mail.categories === undefined ? null : String(mail.categories || ''),
    importance: mail.importance === undefined ? null : Number(mail.importance),
    flag_status: mail.flagStatus === undefined ? null : Number(mail.flagStatus),
    flag_request: mail.flagRequest === undefined ? null : String(mail.flagRequest || ''),
    task_due: mail.taskDue === undefined ? null : String(mail.taskDue || ''),
    task_start: mail.taskStart === undefined ? null : String(mail.taskStart || ''),
    reminder_on: mail.reminderOn === undefined ? null : (mail.reminderOn ? 1 : 0),
    reminder_at: mail.reminderAt === undefined ? null : String(mail.reminderAt || '')
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
    INSERT INTO attachments (mail_id, file_name, ext, size_kb, saved_path, extracted, is_inline, cid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const ext = (att.fileName || '').split('.').pop().toLowerCase();
  // 판정 정보가 함께 오면 그대로 쓰고, 없으면 파일명·크기 기반 폴백으로 분류한다.
  const inline = att.isInline !== undefined
    ? (att.isInline ? 1 : 0)
    : (attachClassify.classifyAttachment({
        name: att.fileName, size: (att.sizeKB || 0) * 1024,
        cid: att.cid || '', flags: att.flags, hidden: att.hidden,
        cidReferenced: att.cidReferenced
      }).inline ? 1 : 0);
  return stmt.run(
    mailId, att.fileName || '', ext, att.sizeKB || 0,
    att.savedPath || '', (att.extracted || '').slice(0, 4000), inline, att.cid || ''
  ).lastInsertRowid;
}

// 기본은 '진짜 첨부만'. 인라인까지 필요하면 includeInline: true.
function getAttachmentsByMail(mailId, { includeInline = false } = {}) {
  const sql = includeInline
    ? 'SELECT * FROM attachments WHERE mail_id = ? ORDER BY is_inline, id'
    : 'SELECT * FROM attachments WHERE mail_id = ? AND IFNULL(is_inline,0) = 0 ORDER BY id';
  return db.prepare(sql).all(mailId);
}

// ------------------------------------------------------------
//  첨부 분류 백필
//   1차: 이미 저장된 파일명·크기로 로컬 판정 (COM 접근 없음 → 빠르고 안전)
//   2차: mails.real_attach_count 를 다시 계산해 has_attach 를 진짜 첨부 기준으로 되돌린다.
//   ※ COM 재조회가 필요한 '애매한' 건은 applyAttachmentProbe() 로 따로 반영한다.
// ------------------------------------------------------------
function backfillAttachmentFlags() {
  const rows = db.prepare('SELECT id, file_name, size_kb, cid FROM attachments').all();
  const upd = db.prepare('UPDATE attachments SET is_inline = ? WHERE id = ?');
  let inline = 0;
  const tx = db.transaction(() => {
    for (const r of rows) {
      const c = attachClassify.classifyAttachment({
        name: r.file_name, size: (r.size_kb || 0) * 1024, cid: r.cid || ''
      });
      if (c.inline) inline++;
      upd.run(c.inline ? 1 : 0, r.id);
    }
  });
  tx();
  return { scanned: rows.length, inline, real: rows.length - inline };
}

// COM 으로 읽어 온 첨부 속성을 DB 에 반영 (entryId 기준)
//  probe = [{ entryId, attachments:[{name,size,cid,flags,hidden,cidReferenced}] }]
function applyAttachmentProbe(probe) {
  const getMail = db.prepare('SELECT id FROM mails WHERE entry_id = ?');
  const updMail = db.prepare('UPDATE mails SET real_attach_count = ?, attach_count = ?, has_attach = ? WHERE id = ?');
  const updAtt = db.prepare('UPDATE attachments SET is_inline = ?, cid = ? WHERE mail_id = ? AND file_name = ?');
  let mails = 0, real = 0, inline = 0;
  const tx = db.transaction(() => {
    for (const p of (probe || [])) {
      const m = getMail.get(p.entryId);
      if (!m) continue;
      const list = [].concat(p.attachments || []);
      const c = attachClassify.classifyList(list);
      updMail.run(c.realCount, c.total, c.realCount > 0 ? 1 : 0, m.id);
      for (const it of c.items) updAtt.run(it.inline ? 1 : 0, it.cid || '', m.id, it.name || '');
      mails++; real += c.realCount; inline += (c.total - c.realCount);
    }
  });
  tx();
  return { mails, real, inline };
}

// 아직 판정되지 않은(real_attach_count 가 NULL) '첨부 있다고 표시된' 메일들
function mailsNeedingAttachProbe(limit = 300) {
  return db.prepare(`
    SELECT id, entry_id, subject, attach_count FROM mails
    WHERE real_attach_count IS NULL AND IFNULL(attach_count,0) > 0 AND entry_id IS NOT NULL
    ORDER BY received_ts DESC LIMIT ?
  `).all(limit);
}

// 폴더별 건수를 '스토어까지 구분해' 집계한다.
//  ★ folder 컬럼은 폴더 '이름'만 담고 있어 서로 다른 스토어의 동명 폴더가 합산된다
//    (실측: '방선' 43건 = 김봉정 2 + 백업 PST 41 → 트리 건수가 부풀어 보였다).
//    json.store 는 수집 때부터 저장돼 있으므로 재수집 없이 정확한 집계가 가능하다.
function statsByFolderStore() {
  const out = {};
  db.prepare(`
    SELECT IFNULL(json_extract(json,'$.store'),'') AS store, folder, COUNT(*) AS c
    FROM mails GROUP BY store, folder
  `).all().forEach(r => { out[`${r.store}/${r.folder}`] = r.c; });
  return out;
}

function attachmentStats() {
  const a = db.prepare(`SELECT COUNT(*) total,
      SUM(CASE WHEN IFNULL(is_inline,0)=1 THEN 1 ELSE 0 END) inline FROM attachments`).get();
  const m = db.prepare(`SELECT
      SUM(CASE WHEN IFNULL(attach_count,0) > 0 THEN 1 ELSE 0 END) rawWithAttach,
      SUM(CASE WHEN IFNULL(real_attach_count,0) > 0 THEN 1 ELSE 0 END) realWithAttach,
      SUM(CASE WHEN real_attach_count IS NULL AND IFNULL(attach_count,0) > 0 THEN 1 ELSE 0 END) pending,
      SUM(has_attach) hasAttachFlag FROM mails`).get();
  return {
    attachRows: a.total || 0, attachInline: a.inline || 0, attachReal: (a.total || 0) - (a.inline || 0),
    rawWithAttach: m.rawWithAttach || 0, realWithAttach: m.realWithAttach || 0,
    pending: m.pending || 0, hasAttachFlag: m.hasAttachFlag || 0
  };
}

// ------------------------------------------------------------
//  주소록 upsert
// ------------------------------------------------------------
// ★ contacts 테이블은 그룹(배포목록) 지원을 위해 email UNIQUE 제약을 제거하고
//   부분 유니크 인덱스로 대체했다. 따라서 ON CONFLICT(email) 은 쓸 수 없다
//   (실측 오류: "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint").
//   → 조회 후 INSERT/UPDATE 방식으로 통일한다.
function upsertContact(c) {
  if (!c || !c.email) return null;
  const row = {
    name: c.name || '', email: String(c.email).toLowerCase(),
    company: c.company || '', phone: c.phone || '',
    source: c.source || 'outlook', json: JSON.stringify(c)
  };
  const found = db.prepare("SELECT id FROM contacts WHERE IFNULL(type,'person')='person' AND lower(email)=?").get(row.email);
  if (found) {
    return db.prepare(`UPDATE contacts SET
        name = COALESCE(NULLIF(@name,''), name),
        company = COALESCE(NULLIF(@company,''), company),
        phone = COALESCE(NULLIF(@phone,''), phone),
        source = @source, json = @json
      WHERE id = @id`).run({ ...row, id: found.id });
  }
  return db.prepare(`INSERT INTO contacts (name, email, company, phone, source, json, type)
                     VALUES (@name, @email, @company, @phone, @source, @json, 'person')`).run(row);
}

function upsertContactsBatch(contacts) {
  const tx = db.transaction((list) => {
    let n = 0;
    for (const c of list) { if (upsertContact(c)) n++; }
    return n;
  });
  return tx(contacts || []);
}

// ------------------------------------------------------------
//  주소록 전량 저장 (개인 + 그룹/배포목록 + 그룹 멤버)
//  items: outlook.getAllContacts() 결과
// ------------------------------------------------------------
function upsertAddressBook(items) {
  const list = (items || []).filter(c => c && (c.name || c.email));
  const findPerson = db.prepare("SELECT id FROM contacts WHERE type='person' AND email <> '' AND lower(email) = ?");
  const findPersonNoMail = db.prepare("SELECT id FROM contacts WHERE type='person' AND IFNULL(email,'') = '' AND name = ?");
  const findGroup = db.prepare("SELECT id FROM contacts WHERE type='group' AND name = ?");
  const ins = db.prepare(`INSERT INTO contacts (name,email,company,phone,source,json,type,display_name,folder,store)
                          VALUES (@name,@email,@company,@phone,@source,@json,@type,@display_name,@folder,@store)`);
  const upd = db.prepare(`UPDATE contacts SET
                            name = COALESCE(NULLIF(@name,''), name),
                            company = COALESCE(NULLIF(@company,''), company),
                            phone = COALESCE(NULLIF(@phone,''), phone),
                            display_name = COALESCE(NULLIF(@display_name,''), display_name),
                            folder = @folder, store = @store, source = @source, json = @json, type = @type
                          WHERE id = @id`);
  const delMembers = db.prepare('DELETE FROM group_members WHERE group_id = ?');
  const insMember = db.prepare('INSERT INTO group_members (group_id, name, email) VALUES (?,?,?)');

  let persons = 0, groups = 0, members = 0;
  const tx = db.transaction(() => {
    for (const c of list) {
      const isGroup = c.kind === 'group' || c.type === 'group';
      const row = {
        name: c.name || '', email: (c.email || '').toLowerCase(),
        company: c.company || '', phone: c.phone || '',
        source: c.source || 'outlook', json: JSON.stringify(c),
        type: isGroup ? 'group' : 'person',
        display_name: c.displayName || '', folder: c.folder || '', store: c.store || ''
      };
      let found = isGroup
        ? findGroup.get(row.name)
        : (row.email ? findPerson.get(row.email) : findPersonNoMail.get(row.name));
      let id;
      if (found) { upd.run({ ...row, id: found.id }); id = found.id; }
      else { id = ins.run(row).lastInsertRowid; }
      if (isGroup) {
        groups++;
        delMembers.run(id);
        for (const m of (c.members || [])) {
          if (!m || (!m.name && !m.email)) continue;
          insMember.run(id, m.name || '', (m.email || '').toLowerCase());
          members++;
        }
      } else persons++;
    }
  });
  tx();
  return { persons, groups, members };
}

function getGroupMembers(groupId) {
  return db.prepare('SELECT * FROM group_members WHERE group_id = ? ORDER BY name').all(groupId);
}
function addressBookStats() {
  const persons = db.prepare("SELECT COUNT(*) c FROM contacts WHERE IFNULL(type,'person') = 'person'").get().c;
  const groups = db.prepare("SELECT COUNT(*) c FROM contacts WHERE type = 'group'").get().c;
  const members = db.prepare('SELECT COUNT(*) c FROM group_members').get().c;
  return { persons, groups, members, total: persons + groups };
}

// 주소별 '마지막으로 주고받은 시각' 색인.
//  ★ 상관 서브쿼리로 연락처마다 recipients LIKE 스캔을 돌리면 653명 × 23,708건 = 44초가 걸린다(실측).
//    메일을 딱 한 번만 훑어 주소→최신시각 Map 을 만들면 259ms 다(실측: 발신 101ms + 수신 158ms).
//    동기화로 메일이 늘면 무효화되므로 mails 총건수를 캐시 키로 쓴다.
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
let _contactActivity = { key: '', map: null };
function contactActivityMap() {
  const key = String(db.prepare('SELECT COUNT(*) c, MAX(received_ts) m FROM mails').get().c) + ':' +
              String(db.prepare('SELECT MAX(received_ts) m FROM mails').get().m || 0);
  if (_contactActivity.key === key && _contactActivity.map) return _contactActivity.map;
  const map = new Map();
  const bump = (email, ts) => {
    if (!email || !ts) return;
    const k = email.toLowerCase();
    if ((map.get(k) || 0) < ts) map.set(k, ts);
  };
  for (const r of db.prepare(`SELECT lower(sender_email) e, MAX(received_ts) t FROM mails
      WHERE sender_email IS NOT NULL AND sender_email <> '' GROUP BY 1`).all()) bump(r.e, r.t);
  for (const r of db.prepare(`SELECT received_ts t, recipients, cc FROM mails
      WHERE (recipients IS NOT NULL AND recipients <> '') OR (cc IS NOT NULL AND cc <> '')`).all()) {
    const found = `${r.recipients || ''};${r.cc || ''}`.match(EMAIL_RE);
    if (found) for (const e of found) bump(e, r.t);
  }
  _contactActivity = { key, map };
  return map;
}

// sort: 'recent'(기본 — 마지막 연락일 최신순, 전역 정렬 원칙) | 'name'(이름 가나다순)
function listContacts(limit = 500, query = '', sort = 'recent') {
  const sel = `SELECT c.*, IFNULL(c.type,'person') AS ctype,
      (SELECT COUNT(*) FROM group_members g WHERE g.group_id = c.id) AS member_count
    FROM contacts c`;
  let rows;
  if (query) {
    const q = `%${query.toLowerCase()}%`;
    rows = db.prepare(`${sel}
      WHERE lower(c.name) LIKE ? OR lower(c.email) LIKE ? OR lower(IFNULL(c.company,'')) LIKE ?
         OR lower(IFNULL(c.display_name,'')) LIKE ?
         OR c.id IN (SELECT group_id FROM group_members WHERE lower(name) LIKE ? OR lower(email) LIKE ?)`)
      .all(q, q, q, q, q, q);
  } else {
    rows = db.prepare(sel).all();
  }
  const act = contactActivityMap();
  rows.forEach(r => { r.lastTs = act.get(String(r.email || '').toLowerCase()) || 0; });
  rows.sort((a, b) => {
    if (a.ctype !== b.ctype) return a.ctype < b.ctype ? -1 : 1;   // 그룹 → 개인 (기존 순서 유지)
    if (sort !== 'name' && b.lastTs !== a.lastTs) return b.lastTs - a.lastTs;
    return String(a.name || '').localeCompare(String(b.name || ''), 'ko');
  });
  return rows.slice(0, limit);
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

// 종류별 분석 기록 목록 (업무일지/브리핑 히스토리)
function listAnalyses(kind, limit = 10) {
  return db.prepare('SELECT * FROM analyses WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, limit);
}

// ------------------------------------------------------------
//  일정(달력) — 저장된 분석 결과에서 수집 + 수동 등록
//   ★ 수집은 analyses 테이블만 읽는다. AI 를 다시 호출하지 않는다.
// ------------------------------------------------------------
function schedKey(mailId, date, title) {
  return `${mailId || 0}|${date}|${sched.normalizeTitle(title)}`;
}

// 분석 결과 전량을 훑어 일정을 채운다. 이미 있는 건(dedupe_key 충돌)은 건너뛴다.
//  수동 등록분과 완료 표시는 절대 덮어쓰지 않는다.
function collectSchedules({ limit = 2000 } = {}) {
  const rows = db.prepare(`
    SELECT id, kind, mail_id, content, json, created_at FROM analyses
    WHERE kind IN ('translate','daily','worklog','summary') AND content IS NOT NULL
    ORDER BY id DESC LIMIT ?
  `).all(limit);

  const items = sched.dedupe(rows.flatMap(r => sched.extractFromAnalysis(r)));
  const ins = db.prepare(`
    INSERT INTO schedules (date, time, title, owner, source_kind, source_id, mail_id, raw_due, dedupe_key)
    VALUES (@date, @time, @title, @owner, @source_kind, @source_id, @mail_id, @raw_due, @dedupe_key)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      time = IFNULL(excluded.time, schedules.time)
  `);
  let added = 0;
  const before = db.prepare('SELECT COUNT(*) c FROM schedules').get().c;
  const tx = db.transaction(() => {
    for (const it of items) {
      ins.run({ ...it, owner: it.owner || '', raw_due: it.raw_due || '',
                dedupe_key: schedKey(it.mail_id, it.date, it.title) });
    }
  });
  tx();
  const after = db.prepare('SELECT COUNT(*) c FROM schedules').get().c;
  added = after - before;
  return { ok: true, scanned: rows.length, candidates: items.length, added, total: after };
}

// 달력용: 해당 기간의 일정 (메일 제목까지 붙여 출처를 보여준다)
function schedulesInRange(from, to) {
  return db.prepare(`
    SELECT s.*, m.subject AS mail_subject, m.sender_name AS mail_sender
    FROM schedules s LEFT JOIN mails m ON m.id = s.mail_id
    WHERE s.date >= ? AND s.date <= ?
    ORDER BY s.date, IFNULL(s.time,'99:99'), s.id
  `).all(from, to);
}

// 다가오는 마감 N일 (지난 미완료도 함께 — 놓친 일이 사라지면 안 된다)
function schedulesUpcoming({ days = 7, includeOverdue = true } = {}) {
  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const to = new Date(today.getTime() + days * 864e5);
  const from = includeOverdue ? '0000-00-00' : iso(today);
  return db.prepare(`
    SELECT s.*, m.subject AS mail_subject, m.sender_name AS mail_sender
    FROM schedules s LEFT JOIN mails m ON m.id = s.mail_id
    WHERE s.date >= ? AND s.date <= ? AND (s.done = 0 OR s.date >= ?)
    ORDER BY s.date, IFNULL(s.time,'99:99')
  `).all(from, iso(to), iso(today));
}

function addSchedule({ date, time, title, owner, mailId }) {
  const d = String(date || '').trim();
  const t = String(title || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).');
  if (!t) throw new Error('일정 제목을 입력하세요.');
  const key = schedKey(mailId, d, t);
  const dup = db.prepare('SELECT id FROM schedules WHERE dedupe_key = ?').get(key);
  if (dup) return { ok: true, already: true, id: dup.id };
  const r = db.prepare(`
    INSERT INTO schedules (date, time, title, owner, source_kind, mail_id, dedupe_key)
    VALUES (?,?,?,?, 'manual', ?, ?)
  `).run(d, time || null, t, owner || '', mailId || null, key);
  return { ok: true, id: r.lastInsertRowid };
}

function updateSchedule(id, { date, time, title }) {
  const cur = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
  if (!cur) throw new Error('일정을 찾을 수 없습니다.');
  const d = date || cur.date, t = (title !== undefined ? title : cur.title);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('날짜 형식이 올바르지 않습니다 (YYYY-MM-DD).');
  if (!String(t).trim()) throw new Error('일정 제목을 입력하세요.');
  db.prepare('UPDATE schedules SET date=?, time=?, title=?, dedupe_key=? WHERE id=?')
    .run(d, time !== undefined ? (time || null) : cur.time, t, schedKey(cur.mail_id, d, t), id);
  return { ok: true };
}

function setScheduleDone(id, done) {
  db.prepare('UPDATE schedules SET done = ? WHERE id = ?').run(done ? 1 : 0, id);
  return { ok: true };
}
function deleteSchedule(id) {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  return { ok: true };
}
function scheduleStats() {
  const r = db.prepare(`SELECT COUNT(*) total,
    SUM(CASE WHEN done=1 THEN 1 ELSE 0 END) done,
    SUM(CASE WHEN source_kind='manual' THEN 1 ELSE 0 END) manual FROM schedules`).get();
  return { total: r.total || 0, done: r.done || 0, manual: r.manual || 0 };
}

// ---- 대용량 첨부 전송 이력 ----
function addBigmailUpload(r) {
  const files = Array.isArray(r.files) ? r.files : [];
  return db.prepare(`
    INSERT INTO bigmail_uploads (upload_id, download_url, file_count, total_size, file_names, subject, expires_at, has_password)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(r.id || '', r.downloadUrl || '', files.length, r.totalSize || 0,
         files.map(f => f.name).join(' | '), r.subject || '', r.expiresAt || '', r.hasPassword ? 1 : 0).lastInsertRowid;
}
function listBigmailUploads(limit = 50) {
  return db.prepare('SELECT * FROM bigmail_uploads ORDER BY id DESC LIMIT ?').all(limit);
}
function deleteBigmailUpload(id) {
  db.prepare('DELETE FROM bigmail_uploads WHERE id = ?').run(id);
  return { ok: true };
}

// ------------------------------------------------------------
//  일일 브리핑 캐시 (날짜 키)
//  같은 날짜를 다시 열면 AI 재호출 없이 저장분을 돌려준다.
// ------------------------------------------------------------
function getDailyBriefing(dateStr) {
  try {
    return db.prepare(`SELECT * FROM analyses WHERE kind = 'daily'
                       AND json_extract(json,'$.date') = ? ORDER BY id DESC LIMIT 1`).get(dateStr) || null;
  } catch (_) {
    // JSON1 미지원 환경 폴백
    return db.prepare(`SELECT * FROM analyses WHERE kind = 'daily' AND json LIKE ? ORDER BY id DESC LIMIT 1`)
      .get(`%"date":"${dateStr}"%`) || null;
  }
}
function saveDailyBriefing(dateStr, content, meta = {}) {
  // 같은 날짜의 옛 캐시는 정리해 중복 누적을 막는다
  try {
    db.prepare(`DELETE FROM analyses WHERE kind='daily' AND json_extract(json,'$.date') = ?`).run(dateStr);
  } catch (_) {
    db.prepare(`DELETE FROM analyses WHERE kind='daily' AND json LIKE ?`).run(`%"date":"${dateStr}"%`);
  }
  return addAnalysis(null, 'daily', content, 'ko', { ...meta, date: dateStr });
}
// 브리핑이 이미 있는 날짜 목록 (달력 표시용)
function dailyBriefingDates(limit = 60) {
  try {
    return db.prepare(`SELECT json_extract(json,'$.date') AS d, MAX(created_at) AS at
                       FROM analyses WHERE kind='daily' GROUP BY d ORDER BY d DESC LIMIT ?`).all(limit)
      .filter(r => r.d);
  } catch (_) { return []; }
}
// 특정 날짜의 메일 (하루 범위)
function mailsOnDate(dateStr, limit = 400) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59.999`);
  if (isNaN(start.getTime())) return [];
  return mailsInRange(start.getTime(), end.getTime(), limit);
}

// ------------------------------------------------------------
//  필드별 OR-LIKE 절 생성 헬퍼
//  값이 여러 개(배열)면 그 필드 안에서는 OR, 다른 필드와는 호출부에서 AND 로 묶는다.
//  (마스터 요구: "여러 조건 AND, 같은 필드 여러 값은 OR")
// ------------------------------------------------------------
function likeOrClause(cols, values, paramPrefix, params) {
  const vals = (Array.isArray(values) ? values : [values])
    .map(v => String(v || '').trim()).filter(Boolean);
  if (!vals.length) return '';
  const ors = vals.map((v, i) => {
    const key = `${paramPrefix}${i}`;
    params[key] = `%${v.toLowerCase()}%`;
    return `(${cols.map(c => `lower(IFNULL(${c},'')) LIKE @${key}`).join(' OR ')})`;
  });
  return `(${ors.join(' OR ')})`;
}

// ★ 광고·뉴스레터 판정(랭킹 후순위용) — 발신 주소·제목의 흔한 신호만 본다(휴리스틱).
const NEWSLETTER_RE = /noreply|no-?reply|newsletter|마케팅|수신거부|unsubscribe|광고\)/i;

// 검색 결과 랭킹: 필드 적중(제목>본문) + 최신성 가중 + 광고 후순위.
//  ★ DB 는 limit 만큼만 이미 잘라온 상태이므로, 그 안에서 순서만 재조정한다(추가 조회 없음).
function rankSearchResults(mails, keywords) {
  const kws = (keywords || []).filter(Boolean);
  if (!kws.length) return mails;
  const now = Date.now();
  const scored = mails.map(m => {
    const subj = String(m.subject || '').toLowerCase();
    const body = String(m.preview || m.body || '').toLowerCase();
    let score = 0;
    for (const k of kws) {
      const kl = k.toLowerCase();
      if (subj.includes(kl)) score += 3;
      if (body.includes(kl)) score += 1;
    }
    const ageDays = (now - (m.received_ts || 0)) / 864e5;
    score += Math.max(0, 1.5 - ageDays / 365);
    if (NEWSLETTER_RE.test(m.sender_email || '') || NEWSLETTER_RE.test(m.subject || '')) score -= 5;
    return { m, score };
  });
  scored.sort((a, b) => (b.score - a.score) || ((b.m.received_ts || 0) - (a.m.received_ts || 0)));
  return scored.map(s => s.m);
}

// ------------------------------------------------------------
//  메일 검색 (FTS5 우선, 실패 시 LIKE 폴백) + 날짜/발신자 필터
//  opts: { query, limit, offset, sinceTs, untilTs, sender, folder, hasAttach,
//          subject, cc, to, body, attachExt }
//   · sender/to/cc/subject/body 는 문자열 또는 배열(같은 필드 여러 값 = OR) 모두 허용.
// ------------------------------------------------------------
function searchMails(opts = {}) {
  const {
    query = '', limit = 100, offset = 0,
    sinceTs = null, untilTs = null, sender = '', folder = '', hasAttach = null,
    recipient = '',          // 수신인(To/CC) 부분일치 — 레거시(두 컬럼 다 봄), 하위호환 유지
    to = '',                 // ★ 받는사람(To) 전용 — cc 는 안 봄
    cc = '',                 // ★ 참조(CC) 전용
    subject = '',            // ★ 제목 전용
    body = '',                // ★ 본문 전용
    attachExt = '',           // ★ 첨부 확장자(pdf/xlsx/...) — attachments.ext 대조
    toMe = null,             // 1=내가 직접 수신(To) · 0=참조(CC) · null=전체
    vfolderId = null,        // 로컬 가상 폴더 필터
    unreadOnly = false,      // "읽지 않음" 탭
    actionState = null,      // 'todo'|'hold'|'done'|'fyi'|'none'(미지정) — 처리 상태 탭
    sortBy = 'date',         // date | sender | subject | attach
    sortDir = 'desc'
  } = opts;

  // 🔴 폴더 이름 정규화 — 저장할 때와 '똑같은' 규칙으로 맞춘다.
  //   실측 결함: Outlook 즐겨찾기는 로케일 표시명('받은 편지함')을 주는데 mails.folder 는
  //   정규 키('Inbox')로 저장돼 있어 즐겨찾기 클릭 시 0건이 나왔다(받은/보낸 편지함 전부).
  //   여기 한 곳에서 흡수하면 즐겨찾기·트리·검색 어느 경로로 들어와도 같은 결과가 된다.
  const folderKey = folder ? canonicalFolder(folder) : '';

  const params = {};
  // 정렬 컬럼 화이트리스트 (SQL 주입 차단)
  const SORT_COLS = {
    date: 'received_ts', sender: 'lower(sender_name)',
    subject: 'lower(subject)', attach: 'has_attach'
  };
  const col = SORT_COLS[sortBy] || SORT_COLS.date;
  const dir = String(sortDir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderBy = sortBy === 'date' ? `${col} ${dir}` : `${col} ${dir}, received_ts DESC`;

  // 가상 폴더/원폴더 공통 조건 조각
  const vfJoin = vfolderId ? ' AND {P}id IN (SELECT mail_id FROM mail_folder_map WHERE vfolder_id = @vfolderId)' : '';
  // 실폴더 필터일 때는 가상 폴더로 옮겨간 메일을 제외(Outlook 처럼 한 곳에만 보이게)
  const notMoved = (folder && !vfolderId) ? ' AND {P}id NOT IN (SELECT mail_id FROM mail_folder_map)' : '';
  const unreadCond = unreadOnly ? ` AND ${UNREAD_EXPR.replace(/read_flag/g, '{P}read_flag').replace(/\bunread\b/g, '{P}unread')} = 1` : '';
  // 처리 상태 필터 ('none' = 아직 지정 안 한 것)
  //  ★ 같은 축(처리 상태) 안에서는 OR(합집합), 다른 축(읽음·수신구분)과는 AND.
  //    배열로 여러 상태를 넘기면 합집합으로 조회한다. 'none' = 아직 지정 안 한 것.
  const asList = (Array.isArray(actionState) ? actionState : (actionState ? [actionState] : []))
    .map(v => String(v || '')).filter(v => v === 'none' || ACTION_STATES.includes(v));
  let actionCond = '';
  if (asList.length) {
    const parts = [];
    asList.forEach((v, i) => {
      if (v === 'none') parts.push("IFNULL({P}action_state,'') = ''");
      else { parts.push(`{P}action_state = @as${i}`); params[`as${i}`] = v; }
    });
    actionCond = ` AND (${parts.join(' OR ')})`;
  }
  if (vfolderId) params.vfolderId = vfolderId;

  // CJK(중국어/일본어) 검색어는 unicode61 토크나이저가 분리를 못하므로
  // FTS를 건너뛰고 LIKE 폴백을 사용한다 (한국어/영어는 FTS 정상).
  const hasCJK = /[一-鿿぀-ヿ]/.test(query || '');

  if (query && ftsEnabled && !hasCJK) {
    // FTS MATCH 사용
    const matchQ = ftsQuery(query);
    let sql = `
      SELECT m.*,
        (CASE WHEN m.read_flag IS NULL THEN m.unread ELSE (1 - m.read_flag) END) AS eff_unread,
        (SELECT v.name FROM mail_folder_map mm JOIN virtual_folders v ON v.id = mm.vfolder_id WHERE mm.mail_id = m.id) AS vfolder_name
      FROM mails m
      JOIN mails_fts f ON f.rowid = m.id
      WHERE mails_fts MATCH @match
    `;
    params.match = matchQ;
    if (sinceTs) { sql += ' AND m.received_ts >= @sinceTs'; params.sinceTs = sinceTs; }
    if (untilTs) { sql += ' AND m.received_ts <= @untilTs'; params.untilTs = untilTs; }
    if (sender) { const c = likeOrClause(['m.sender_email', "IFNULL(m.sender_name,'')"], sender, 'sd', params); if (c) sql += ` AND ${c}`; }
    if (folderKey) { sql += ' AND m.folder = @folder'; params.folder = folderKey; }
    if (recipient) { sql += " AND (lower(IFNULL(m.recipients,'')) LIKE @recip OR lower(IFNULL(m.cc,'')) LIKE @recip)"; params.recip = `%${recipient.toLowerCase()}%`; }
    if (to) { const c = likeOrClause(["IFNULL(m.recipients,'')"], to, 'to', params); if (c) sql += ` AND ${c}`; }
    if (cc) { const c = likeOrClause(["IFNULL(m.cc,'')"], cc, 'cc', params); if (c) sql += ` AND ${c}`; }
    if (subject) { const c = likeOrClause(["IFNULL(m.subject,'')"], subject, 'sj', params); if (c) sql += ` AND ${c}`; }
    if (body) { const c = likeOrClause(["IFNULL(m.body,'')"], body, 'bd', params); if (c) sql += ` AND ${c}`; }
    if (hasAttach === true) sql += ' AND m.has_attach = 1'; else if (hasAttach === false) sql += ' AND m.has_attach = 0';
    if (attachExt) {
      const exts = (Array.isArray(attachExt) ? attachExt : [attachExt]).map(e => String(e || '').replace(/^\./, '').toLowerCase()).filter(Boolean);
      if (exts.length) {
        sql += ` AND m.id IN (SELECT mail_id FROM attachments WHERE IFNULL(is_inline,0)=0 AND lower(IFNULL(ext,'')) IN (${exts.map((_, i) => `@ext${i}`).join(',')}))`;
        exts.forEach((e, i) => { params[`ext${i}`] = e; });
      }
    }
    if (toMe === 1 || toMe === 0) { sql += ' AND m.to_me = @toMe'; params.toMe = toMe; }
    sql += vfJoin.replace(/\{P\}/g, 'm.') + notMoved.replace(/\{P\}/g, 'm.') + unreadCond.replace(/\{P\}/g, 'm.') + actionCond.replace(/\{P\}/g, 'm.');
    sql += ` ORDER BY ${orderBy.replace(/\b(received_ts|sender_name|subject|has_attach)\b/g, 'm.$1')} LIMIT @limit OFFSET @offset`;
    params.limit = limit; params.offset = offset;
    try {
      const rows = db.prepare(sql).all(params);
      return rankSearchResults(rows, String(query || '').split(/\s+/));
    } catch (e) {
      // FTS 구문 오류 시 LIKE 폴백
    }
  }

  // LIKE 폴백
  let sql = `SELECT *,
      (CASE WHEN read_flag IS NULL THEN unread ELSE (1 - read_flag) END) AS eff_unread,
      (SELECT v.name FROM mail_folder_map mm JOIN virtual_folders v ON v.id = mm.vfolder_id WHERE mm.mail_id = mails.id) AS vfolder_name
    FROM mails WHERE 1=1`;
  if (query) {
    sql += ` AND (lower(subject) LIKE @q OR lower(sender_name) LIKE @q OR lower(sender_email) LIKE @q OR lower(body) LIKE @q OR lower(recipients) LIKE @q)`;
    params.q = `%${query.toLowerCase()}%`;
  }
  if (sinceTs) { sql += ' AND received_ts >= @sinceTs'; params.sinceTs = sinceTs; }
  if (untilTs) { sql += ' AND received_ts <= @untilTs'; params.untilTs = untilTs; }
  if (sender) { const c = likeOrClause(['sender_email', "IFNULL(sender_name,'')"], sender, 'sd', params); if (c) sql += ` AND ${c}`; }
  if (folderKey) { sql += ' AND folder = @folder'; params.folder = folderKey; }
  if (recipient) { sql += " AND (lower(IFNULL(recipients,'')) LIKE @recip OR lower(IFNULL(cc,'')) LIKE @recip)"; params.recip = `%${recipient.toLowerCase()}%`; }
  if (to) { const c = likeOrClause(["IFNULL(recipients,'')"], to, 'to', params); if (c) sql += ` AND ${c}`; }
  if (cc) { const c = likeOrClause(["IFNULL(cc,'')"], cc, 'cc', params); if (c) sql += ` AND ${c}`; }
  if (subject) { const c = likeOrClause(["IFNULL(subject,'')"], subject, 'sj', params); if (c) sql += ` AND ${c}`; }
  if (body) { const c = likeOrClause(["IFNULL(body,'')"], body, 'bd', params); if (c) sql += ` AND ${c}`; }
  if (hasAttach === true) sql += ' AND has_attach = 1'; else if (hasAttach === false) sql += ' AND has_attach = 0';
  if (attachExt) {
    const exts = (Array.isArray(attachExt) ? attachExt : [attachExt]).map(e => String(e || '').replace(/^\./, '').toLowerCase()).filter(Boolean);
    if (exts.length) {
      sql += ` AND id IN (SELECT mail_id FROM attachments WHERE IFNULL(is_inline,0)=0 AND lower(IFNULL(ext,'')) IN (${exts.map((_, i) => `@lext${i}`).join(',')}))`;
      exts.forEach((e, i) => { params[`lext${i}`] = e; });
    }
  }
  if (toMe === 1 || toMe === 0) { sql += ' AND to_me = @toMe'; params.toMe = toMe; }
  sql += vfJoin.replace(/\{P\}/g, '') + notMoved.replace(/\{P\}/g, '') + unreadCond.replace(/\{P\}/g, '') + actionCond.replace(/\{P\}/g, '');
  sql += ` ORDER BY ${orderBy} LIMIT @limit OFFSET @offset`;
  params.limit = limit; params.offset = offset;
  const rows = db.prepare(sql).all(params);
  return rankSearchResults(rows, String(query || '').split(/\s+/));
}

// ------------------------------------------------------------
//  스레드 맥락 — 같은 대화(thread_key)에서 이 메일보다 앞선 메일 N통(최신순 → 반환은 오래된순)
//  ★ AI 분석에 '이전에 무슨 일이 있었는지'를 함께 넣기 위함(마스터 지시: 스레드 맥락 분석).
// ------------------------------------------------------------
function getThreadContext(mail, limit = 5) {
  if (!mail || !mail.thread_key) return [];
  const rows = db.prepare(`
    SELECT * FROM mails WHERE thread_key = @tk AND id != @id AND received_ts <= @ts
    ORDER BY received_ts DESC LIMIT @limit
  `).all({ tk: mail.thread_key, id: mail.id, ts: mail.received_ts || 0, limit: Math.max(1, Math.min(limit, 20)) });
  return rows.reverse();   // 오래된 순으로 반환(시간순 서술이 자연스럽다)
}

// ------------------------------------------------------------
//  이름 → 연락처 후보 (동명이인 판정용)
//  같은 이름(부분일치)에 서로 다른 이메일이 2개 이상이면 '동명이인'으로 본다.
// ------------------------------------------------------------
// ------------------------------------------------------------
//  메일별 대화 이력 (마스터 지시: 메일 다시 열면 "이전 대화 N턴 이어보기")
// ------------------------------------------------------------
function saveChatTurn(mailId, role, content) {
  if (!mailId || !role) return;
  db.prepare('INSERT INTO mail_chat (mail_id, role, content) VALUES (?, ?, ?)').run(mailId, role, String(content || ''));
}
function getChatHistory(mailId, limit = 40) {
  if (!mailId) return [];
  return db.prepare('SELECT role, content, created_at FROM mail_chat WHERE mail_id = ? ORDER BY id ASC LIMIT ?').all(mailId, limit);
}
function clearChatHistory(mailId) {
  if (!mailId) return { removed: 0 };
  const r = db.prepare('DELETE FROM mail_chat WHERE mail_id = ?').run(mailId);
  return { removed: r.changes || 0 };
}

function findContactCandidates(namePart) {
  const q = String(namePart || '').trim();
  if (!q || q.length < 2) return [];
  const rows = db.prepare(`
    SELECT DISTINCT name, email FROM contacts
    WHERE IFNULL(type,'person') = 'person' AND email <> '' AND lower(name) LIKE ?
    LIMIT 10
  `).all(`%${q.toLowerCase()}%`);
  return rows;
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
//  제목 정규화 (대화 스레드 식별용)
//  "RE: FW: [SPAM] 제목" → "제목"
// ------------------------------------------------------------
function normalizeSubject(s) {
  return String(s || '')
    .replace(/^(\s*(re|fw|fwd|답장|전달)\s*(\[\d+\])?\s*:)+/gi, '')  // 접두사 반복 제거
    .replace(/\[[^\]]{1,20}\]/g, ' ')                                 // [SPAM] 등 말머리
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ============================================================
//  ★ Outlook 잔여 데이터 (범주 / 플래그 / 일정 / 작업 / 검색폴더)
//  ------------------------------------------------------------
//  전부 Outlook 을 '읽어서' 이 DB 에만 기록한다. 역방향 쓰기는 없다.
// ============================================================

// ---- 범주 마스터 ----
function saveCategories(list) {
  const st = db.prepare(`INSERT INTO categories (name, color, hex, shortcut, updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(name) DO UPDATE SET color=excluded.color, hex=excluded.hex,
      shortcut=excluded.shortcut, updated_at=datetime('now')`);
  const tx = db.transaction((arr) => {
    let n = 0;
    for (const c of arr) { if (c && c.name) { st.run(String(c.name), Number(c.color) || 0, String(c.hex || ''), Number(c.shortcut) || 0); n++; } }
    return n;
  });
  return tx(list || []);
}
function listCategoriesDb() {
  // 메일에 실제로 붙어 있는 건수를 함께 돌려준다(사용 현황 파악용)
  const cats = db.prepare('SELECT * FROM categories ORDER BY name').all();
  const rows = db.prepare(`SELECT categories c FROM mails WHERE IFNULL(categories,'') <> ''`).all();
  const cnt = new Map();
  for (const r of rows) for (const one of String(r.c).split(/[;,]/).map(s => s.trim()).filter(Boolean)) {
    cnt.set(one, (cnt.get(one) || 0) + 1);
  }
  cats.forEach(c => { c.mailCount = cnt.get(c.name) || 0; });
  // 범주 마스터에 없는데 메일에만 붙어 있는 이름도 노출(누락 방지)
  for (const [name, n] of cnt) if (!cats.some(c => c.name === name)) cats.push({ name, color: 0, hex: '#8a8886', mailCount: n, orphan: 1 });
  return cats.sort((a, b) => (b.mailCount || 0) - (a.mailCount || 0));
}

// ---- 메일 메타(범주·플래그·중요도) 백필 ----
//  스캔이 못 채운 기존 저장분을 probeMailMeta 결과로 덮어쓴다.
//  ★ importance 의 특수값 -1 = 'Outlook 에서 조회 불가'(원본이 지워졌거나 스토어 미연결).
//    이 표시가 없으면 실패한 건이 매번 대상 목록에 다시 올라와 백필이 영원히 끝나지 않는다(실측 1건).
const META_UNREACHABLE = -1;
function applyMailMeta(list) {
  const st = db.prepare(`UPDATE mails SET
      categories=@categories, importance=@importance, flag_status=@flag_status,
      flag_request=@flag_request, task_due=@task_due, task_start=@task_start,
      reminder_on=@reminder_on, reminder_at=@reminder_at, unread=@unread
    WHERE entry_id=@entry_id`);
  const tx = db.transaction((arr) => {
    let n = 0;
    for (const m of arr) {
      if (!m || !m.entryId) continue;
      st.run({
        entry_id: m.entryId,
        categories: String(m.categories || ''),
        importance: Number(m.importance) || 1,
        flag_status: Number(m.flagStatus) || 0,
        flag_request: String(m.flagRequest || ''),
        task_due: String(m.taskDue || ''),
        task_start: String(m.taskStart || ''),
        reminder_on: m.reminderOn ? 1 : 0,
        reminder_at: String(m.reminderAt || ''),
        unread: m.unread ? 1 : 0
      });
      n++;
    }
    return n;
  });
  return tx(list || []);
}
// 메타가 아직 안 채워진 메일의 entry_id (백필 대상, 최신부터)
function mailsMissingMeta(limit = 500) {
  return db.prepare(`SELECT entry_id FROM mails
    WHERE importance IS NULL AND IFNULL(entry_id,'') <> ''
    ORDER BY received_ts DESC LIMIT ?`).all(limit).map(r => r.entry_id);
}
// '조회 불가' 표시를 전부 되돌린다(재시도 대상으로 복귀).
//  조회 로직을 고쳤을 때(예: 아카이브 스토어 StoreID 지정 추가) 한 번 돌려 준다.
function resetMetaUnreachable() {
  return db.prepare('UPDATE mails SET importance = NULL WHERE importance = ?').run(META_UNREACHABLE).changes;
}
// 요청했는데 Outlook 이 돌려주지 않은 entry_id 를 '조회 불가'로 표시 → 다음 회차에서 제외
function markMetaUnreachable(requestedIds, returnedIds) {
  const got = new Set((returnedIds || []).map(String));
  const miss = (requestedIds || []).filter(id => !got.has(String(id)));
  if (!miss.length) return 0;
  const st = db.prepare('UPDATE mails SET importance = ? WHERE entry_id = ? AND importance IS NULL');
  const tx = db.transaction((arr) => { let n = 0; for (const id of arr) n += st.run(META_UNREACHABLE, id).changes; return n; });
  return tx(miss);
}

// ---- 깃발(후속 작업) 메일 ----
//  flag_status 2 = 표시됨(미완료) · 1 = 완료. 기본은 미완료만, 날짜 최신순.
function flaggedMails({ includeDone = false, limit = 200 } = {}) {
  const cond = includeDone ? 'IFNULL(flag_status,0) > 0' : 'IFNULL(flag_status,0) = 2';
  return db.prepare(`SELECT *, (CASE WHEN read_flag IS NULL THEN unread ELSE (1 - read_flag) END) AS eff_unread
    FROM mails WHERE ${cond} ORDER BY received_ts DESC LIMIT ?`).all(limit);
}

// ---- Outlook 일정/작업을 schedules 로 흡수 (출처 구분 유지) ----
//  source_kind: 'outlook-cal'(캘린더) | 'outlook-task'(작업) | 그 외는 기존 AI 추출분
function saveOutlookSchedules(items, kind) {
  const st = db.prepare(`INSERT INTO schedules
      (date, time, title, owner, source_kind, source_id, mail_id, raw_due, dedupe_key,
       end_date, location, categories, entry_id, all_day, percent)
    VALUES (@date,@time,@title,@owner,@source_kind,NULL,NULL,@raw_due,@dedupe_key,
       @end_date,@location,@categories,@entry_id,@all_day,@percent)
    ON CONFLICT(dedupe_key) DO UPDATE SET
      time=excluded.time, title=excluded.title, end_date=excluded.end_date,
      location=excluded.location, categories=excluded.categories,
      all_day=excluded.all_day, percent=excluded.percent`);
  const tx = db.transaction((arr) => {
    let n = 0;
    for (const it of arr) {
      if (!it) continue;
      const startStr = String(it.start || it.due || '');
      const date = startStr.slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const time = startStr.length > 10 ? startStr.slice(11, 16) : null;
      const title = String(it.subject || '(제목 없음)').trim();
      st.run({
        date, time: it.allDay ? null : (time || null), title,
        owner: String(it.organizer || it.owner || ''),
        source_kind: kind,
        raw_due: startStr,
        dedupe_key: `${kind}|${it.entryId || ''}|${date}|${title}`,
        end_date: String(it.end || '').slice(0, 10) || null,
        location: String(it.location || ''),
        categories: String(it.categories || ''),
        entry_id: String(it.entryId || ''),
        all_day: it.allDay ? 1 : 0,
        percent: it.percent === undefined ? null : Number(it.percent) || 0
      });
      n++;
    }
    return n;
  });
  return tx(items || []);
}

// ---- 검색 폴더 ----
function saveSearchFolders(list) {
  const st = db.prepare(`INSERT INTO search_folders (store, name, path, items, filter, updated_at)
    VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(store, name) DO UPDATE SET path=excluded.path, items=excluded.items,
      filter=excluded.filter, updated_at=datetime('now')`);
  const tx = db.transaction((arr) => {
    let n = 0;
    for (const f of arr) { if (f && f.name) { st.run(String(f.store || ''), String(f.name), String(f.path || ''), Number(f.items) || 0, String(f.filter || '')); n++; } }
    return n;
  });
  return tx(list || []);
}
// MS-OLK-* 는 Outlook 이 인덱싱용으로 자동 생성하는 내부 폴더다(사용자가 만든 검색 폴더가 아님).
//  실측: 23개 전부 MS-OLK-* / 항목 0건. 화면에 그대로 뿌리면 의미 없는 소음이라 구분해 준다.
const OUTLOOK_INTERNAL_SF = /^MS-OLK-/i;
function listSearchFoldersDb({ includeInternal = false } = {}) {
  const all = db.prepare('SELECT * FROM search_folders ORDER BY store, name').all();
  all.forEach(f => { f.internal = OUTLOOK_INTERNAL_SF.test(String(f.name || '')) ? 1 : 0; });
  return includeInternal ? all : all.filter(f => !f.internal);
}
function searchFolderCounts() {
  const all = listSearchFoldersDb({ includeInternal: true });
  return { total: all.length, internal: all.filter(f => f.internal).length, user: all.filter(f => !f.internal).length };
}

// ============================================================
//  실시간 갱신 — Outlook 쪽 변경분을 로컬에 반영 (읽기 전용 수집분의 반영)
//  ------------------------------------------------------------
//  Outlook 에 쓰지 않는다. Outlook 에서 읽은 상태를 여기 DB 에 맞춰 줄 뿐이다.
// ============================================================
//  items: outlook.folderItemStates() 결과
//  반환: 실제로 바뀐 건수만 (변경 없으면 UPDATE 자체를 안 한다 → 디스크·CPU 절약)
function applyItemStates(items, { markMissingAsRemoved = false, scannedFolders = [] } = {}) {
  const list = items || [];
  const res = { seen: 0, readChanged: 0, movedChanged: 0, metaChanged: 0, removed: 0 };
  if (!list.length && !markMissingAsRemoved) return res;

  const cur = db.prepare(`SELECT id, folder, unread, read_flag, categories, importance, flag_status, task_due
                          FROM mails WHERE entry_id = ?`);
  const updRead = db.prepare('UPDATE mails SET unread = ? WHERE id = ?');
  const updFolder = db.prepare('UPDATE mails SET folder = ? WHERE id = ?');
  const updMeta = db.prepare('UPDATE mails SET categories = ?, importance = ?, flag_status = ?, task_due = ? WHERE id = ?');

  const tx = db.transaction((arr) => {
    for (const it of arr) {
      if (!it || !it.entryId) continue;
      const m = cur.get(it.entryId);
      if (!m) continue;                       // 아직 수집 안 된 메일 — 폴링이 따로 가져온다
      res.seen++;
      const nextUnread = it.unread ? 1 : 0;
      if ((m.unread ? 1 : 0) !== nextUnread) { updRead.run(nextUnread, m.id); res.readChanged++; }
      // Outlook 에서 다른 폴더로 옮겼으면 로컬 폴더도 따라간다
      const nextFolder = canonicalFolder(it.folderName || it.folderPath);
      if (nextFolder && nextFolder !== m.folder) { updFolder.run(nextFolder, m.id); res.movedChanged++; }
      const nc = String(it.categories || ''), ni = Number(it.importance) || 1;
      const nf = Number(it.flagStatus) || 0, nd = String(it.taskDue || '');
      if (String(m.categories || '') !== nc || Number(m.importance) !== ni ||
          Number(m.flag_status || 0) !== nf || String(m.task_due || '') !== nd) {
        updMeta.run(nc, ni, nf, nd, m.id);
        res.metaChanged++;
      }
    }
  });
  tx(list);

  // Outlook 에서 지워진 메일: 스캔한 폴더 안에 있었는데 이번에 안 보이면 로컬에서 숨긴다.
  //  ★ 로컬 표시 처리일 뿐이며 Outlook 원본을 지우는 게 아니다.
  if (markMissingAsRemoved && scannedFolders.length && list.length) {
    const seen = new Set(list.map(x => String(x.entryId)));
    const folders = [...new Set(scannedFolders.map(f => canonicalFolder(f)).filter(Boolean))];
    const q = folders.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, entry_id FROM mails WHERE folder IN (${q}) AND IFNULL(entry_id,'') <> ''`).all(...folders);
    const del = db.prepare("UPDATE mails SET folder = '__removed' WHERE id = ?");
    const tx2 = db.transaction((rs) => {
      for (const r of rs) if (!seen.has(String(r.entry_id))) { del.run(r.id); res.removed++; }
    });
    tx2(rows);
  }
  return res;
}

// 폴더 지문 저장/비교 — 바뀐 폴더 경로만 돌려준다(전량 스캔 금지의 핵심)
function diffFolderFingerprints(fps) {
  const prev = (() => { try { return JSON.parse(getState('folderFingerprints') || '{}'); } catch { return {}; } })();
  const next = {};
  const changed = [];
  for (const f of (fps || [])) {
    const key = `${f.store}/${f.path}`;
    const sig = `${f.items}|${f.unread}|${f.last}`;
    next[key] = sig;
    if (prev[key] !== sig) changed.push({ store: f.store, path: f.path, name: f.name, items: f.items, unread: f.unread, was: prev[key] || null });
  }
  // 사라진 폴더도 변경으로 본다(폴더 트리 갱신 필요)
  const gone = Object.keys(prev).filter(k => !(k in next));
  setState('folderFingerprints', JSON.stringify(next));
  return { changed, gone, total: Object.keys(next).length, firstRun: Object.keys(prev).length === 0 };
}

// ============================================================
//  메일별 '내 처리 상태' (todo 할일 / hold 보류 / done 처리 / fyi 확인)
//  ------------------------------------------------------------
//  · 수동 지정이 정본. 자동 제안은 저장하지 않는다(화면에서 계산).
//  · 되돌리기: 직전 값을 action_prev 에 남겨 한 번은 무조건 되돌릴 수 있다.
//  · Outlook 원본은 건드리지 않는다 — 전부 이 DB 안의 로컬 표시다.
// ============================================================
const ACTION_STATES = ['todo', 'hold', 'done', 'fyi'];
const normAction = (s) => (ACTION_STATES.includes(String(s || '')) ? String(s) : null);

//  ids: 메일 id 배열 · state: 4상태 또는 null(해제)
//  propagateThread=true 면 같은 스레드의 이전 메일까지 함께 지정(기본 OFF)
function setActionState(ids, state, { note, due, propagateThread = false } = {}) {
  const list = (ids || []).map(n => parseInt(n, 10)).filter(Number.isFinite);
  if (!list.length) return { ok: true, changed: 0 };
  const st = normAction(state);
  const now = new Date().toISOString();

  let targets = list;
  if (propagateThread) {
    // 같은 스레드(정규화 제목)의 '이 메일보다 오래된' 메일까지 함께 처리한다.
    //  ★ 최신 메일을 처리했다고 이후에 올 메일까지 미리 닫아 버리면 안 되므로 과거분만 대상으로 한다.
    const q = list.map(() => '?').join(',');
    const seeds = db.prepare(`SELECT thread_key, received_ts FROM mails WHERE id IN (${q})`).all(...list);
    const extra = new Set(list);
    for (const s of seeds) {
      if (!s.thread_key) continue;
      for (const r of db.prepare('SELECT id FROM mails WHERE thread_key = ? AND received_ts <= ?').all(s.thread_key, s.received_ts || 0)) {
        extra.add(r.id);
      }
    }
    targets = [...extra];
  }

  const upd = db.prepare(`UPDATE mails SET
      action_prev = action_state,
      action_state = @state,
      action_source = 'manual',
      action_note = COALESCE(@note, action_note),
      action_due = COALESCE(@due, action_due),
      action_updated_at = @now
    WHERE id = @id`);
  const tx = db.transaction((arr) => {
    let n = 0;
    for (const id of arr) n += upd.run({ id, state: st, note: note === undefined ? null : String(note || ''), due: due === undefined ? null : String(due || ''), now }).changes;
    return n;
  });
  const changed = tx(targets);
  return { ok: true, changed, state: st, targets: targets.length, propagated: targets.length - list.length };
}

// 되돌리기 — 직전 값으로 한 번 복원 (현재 값은 다시 prev 로 넣어 토글처럼 동작)
function undoActionState(ids) {
  const list = (ids || []).map(n => parseInt(n, 10)).filter(Number.isFinite);
  if (!list.length) return { ok: true, changed: 0 };
  const now = new Date().toISOString();
  const upd = db.prepare(`UPDATE mails SET
      action_state = action_prev, action_prev = action_state, action_updated_at = ?
    WHERE id = ?`);
  const tx = db.transaction((arr) => { let n = 0; for (const id of arr) n += upd.run(now, id).changes; return n; });
  return { ok: true, changed: tx(list) };
}

// 상태별 건수 (필터 탭 배지 · 대시보드 집계 공용)
function actionStateCounts({ folder = null } = {}) {
  const where = folder ? ' WHERE folder = ?' : '';
  const rows = folder
    ? db.prepare(`SELECT IFNULL(action_state,'none') s, COUNT(*) c FROM mails${where} GROUP BY 1`).all(canonicalFolder(folder))
    : db.prepare(`SELECT IFNULL(action_state,'none') s, COUNT(*) c FROM mails GROUP BY 1`).all();
  const out = { todo: 0, hold: 0, done: 0, fyi: 0, none: 0, total: 0 };
  for (const r of rows) {
    const k = ACTION_STATES.includes(r.s) ? r.s : 'none';
    out[k] += r.c;
    out.total += r.c;
  }
  return out;
}

// 출처별 집계 (수동 지정 vs Outlook 깃발 자동 매핑) — 마스터 확인용
function actionSourceCounts() {
  const rows = db.prepare(`SELECT IFNULL(action_source,'(미상)') src, IFNULL(action_state,'none') st, COUNT(*) c
    FROM mails WHERE action_state IS NOT NULL GROUP BY 1,2`).all();
  const out = { manual: 0, flag: 0, unknown: 0, detail: rows };
  for (const r of rows) {
    if (r.src === 'manual') out.manual += r.c;
    else if (r.src === 'flag') out.flag += r.c;
    else out.unknown += r.c;
  }
  return out;
}

// 깃발에서 자동 매핑된 것만 초기화 (사용자가 직접 지정한 건 절대 건드리지 않는다)
function clearAutoActionStates() {
  const n = db.prepare(`UPDATE mails SET action_state = NULL, action_prev = NULL, action_source = NULL,
      action_note = NULL, action_updated_at = NULL
    WHERE action_source = 'flag'`).run().changes;
  db.prepare("DELETE FROM sync_state WHERE key = 'action_seeded_from_flags'").run();
  return { ok: true, cleared: n };
}

// '할 일' 뷰용 — 상태별 목록 (날짜 최신순, 전역 정렬 원칙)
function actionMails({ state = 'todo', limit = 300, includeSent = true } = {}) {
  const st = normAction(state);
  const cond = st ? 'IFNULL(action_state,\'\') = @st' : 'IFNULL(action_state,\'\') = \'\'';
  const sentCond = includeSent ? '' : " AND folder <> 'Sent'";
  return db.prepare(`SELECT *, (CASE WHEN read_flag IS NULL THEN unread ELSE (1 - read_flag) END) AS eff_unread
    FROM mails WHERE ${cond}${sentCond}
    ORDER BY (CASE WHEN IFNULL(action_due,'') = '' THEN 1 ELSE 0 END), action_due,
             received_ts DESC LIMIT @limit`).all({ st, limit });
}

// 자동 제안 근거 보강용 — 해당 메일의 저장된 분석에서 '해야 할 일' 개수
function actionHintCounts(mailIds) {
  const list = (mailIds || []).map(n => parseInt(n, 10)).filter(Number.isFinite);
  if (!list.length) return {};
  const q = list.map(() => '?').join(',');
  const rows = db.prepare(`SELECT mail_id, json FROM analyses
    WHERE mail_id IN (${q}) AND kind = 'translate'`).all(...list);
  const out = {};
  for (const r of rows) {
    if (out[r.mail_id] !== undefined) continue;
    try {
      const j = JSON.parse(r.json || '{}');
      const n = Array.isArray(j.actions) ? j.actions.length : 0;
      out[r.mail_id] = n;
    } catch (_) { out[r.mail_id] = 0; }
  }
  return out;
}

// Outlook 깃발 수집분을 최초 1회 todo 로 매핑 (이미 사용자가 지정한 건 건드리지 않는다)
function seedActionFromFlags() {
  const done = getState('action_seeded_from_flags');
  if (done) return { ok: true, skipped: true, seeded: 0 };
  const now = new Date().toISOString();
  const a = db.prepare(`UPDATE mails SET action_state='todo', action_source='flag', action_updated_at=?, action_note=COALESCE(NULLIF(action_note,''),'Outlook 깃발에서 자동 지정')
                        WHERE flag_status = 2 AND IFNULL(action_state,'') = ''`).run(now).changes;
  const b = db.prepare(`UPDATE mails SET action_state='done', action_source='flag', action_updated_at=?, action_note=COALESCE(NULLIF(action_note,''),'Outlook 깃발 완료에서 자동 지정')
                        WHERE flag_status = 1 AND IFNULL(action_state,'') = ''`).run(now).changes;
  setState('action_seeded_from_flags', now);
  return { ok: true, seeded: a + b, todo: a, done: b };
}

// ---- 정리(cleanup)용 조회 ----
//  저장 경로가 남아 있는 첨부 행. 파일이 사라진 '껍데기 행'을 찾는 데 쓴다.
function attachmentRowsWithPath(limit = 100000) {
  return db.prepare(`SELECT id, file_name, saved_path FROM attachments
    WHERE IFNULL(saved_path,'') <> '' LIMIT ?`).all(limit);
}
// 파일이 사라진 행의 경로만 비운다(행 자체와 추출 텍스트는 남긴다 — 정보 손실 금지).
function clearAttachmentPath(id) {
  return db.prepare('UPDATE attachments SET saved_path = NULL WHERE id = ?').run(id).changes;
}

// ---- 회신 여부 주석 달기 (내보내기 '회신여부' 컬럼용) ----
//  내가 보낸편지함에 '같은 대화(정규화 제목)'로 더 늦게 보낸 메일이 있으면 회신한 것으로 본다.
//  ★ 메일마다 쿼리를 돌리면 O(n) 왕복이라, 보낸편지함을 한 번만 훑어 색인을 만든다.
//    (unansweredMails 와 같은 판정 기준을 쓴다 — 화면과 엑셀이 어긋나면 안 된다)
function annotateReplied(mails) {
  const list = mails || [];
  if (!list.length) return list;
  const sentIndex = new Map();      // 정규화 제목 → 내가 마지막으로 보낸 시각
  for (const s of db.prepare("SELECT subject, received_ts FROM mails WHERE folder = 'Sent'").all()) {
    const k = normalizeSubject(s.subject);
    if (!k) continue;
    if ((sentIndex.get(k) || 0) < (s.received_ts || 0)) sentIndex.set(k, s.received_ts || 0);
  }
  for (const m of list) {
    if (String(m.folder || '') === 'Sent') { m.replied = null; continue; }   // 내가 보낸 건 해당 없음
    const k = normalizeSubject(m.subject);
    m.replied = k ? (sentIndex.get(k) || 0) > (m.received_ts || 0) : false;
  }
  return list;
}

// ---- 잔여 데이터 수집 현황 (Outlook 개수 대조표용) ----
function outlookExtrasStats() {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  return {
    categories: one('SELECT COUNT(*) c FROM categories').c,
    mailsWithCategory: one(`SELECT COUNT(*) c FROM mails WHERE IFNULL(categories,'') <> ''`).c,
    flagged: one('SELECT COUNT(*) c FROM mails WHERE IFNULL(flag_status,0) = 2').c,
    flagDone: one('SELECT COUNT(*) c FROM mails WHERE IFNULL(flag_status,0) = 1').c,
    taskDue: one(`SELECT COUNT(*) c FROM mails WHERE IFNULL(task_due,'') <> ''`).c,
    highImportance: one('SELECT COUNT(*) c FROM mails WHERE importance = 2').c,
    lowImportance: one('SELECT COUNT(*) c FROM mails WHERE importance = 0').c,
    metaFilled: one('SELECT COUNT(*) c FROM mails WHERE importance >= 0').c,
    metaMissing: one('SELECT COUNT(*) c FROM mails WHERE importance IS NULL').c,
    metaUnreachable: one('SELECT COUNT(*) c FROM mails WHERE importance = -1').c,
    appointments: one("SELECT COUNT(*) c FROM schedules WHERE source_kind = 'outlook-cal'").c,
    tasks: one("SELECT COUNT(*) c FROM schedules WHERE source_kind = 'outlook-task'").c,
    aiSchedules: one("SELECT COUNT(*) c FROM schedules WHERE IFNULL(source_kind,'') NOT LIKE 'outlook-%'").c,
    searchFolders: one('SELECT COUNT(*) c FROM search_folders').c,
    searchFoldersUser: searchFolderCounts().user,
    totalMails: one('SELECT COUNT(*) c FROM mails').c
  };
}

// 내 메일 주소 추정 (보낸편지함의 최빈 발신자)
function myAddresses(limit = 3) {
  return db.prepare(`
    SELECT sender_email, COUNT(*) c FROM mails
    WHERE folder = 'Sent' AND sender_email != ''
    GROUP BY lower(sender_email) ORDER BY c DESC LIMIT ?
  `).all(limit).map(r => String(r.sender_email).toLowerCase());
}

// ------------------------------------------------------------
//  내 표시이름 추정 (보낸편지함의 최빈 sender_name)
// ------------------------------------------------------------
function myDisplayNames(limit = 2) {
  return db.prepare(`
    SELECT sender_name n, COUNT(*) c FROM mails
    WHERE folder = 'Sent' AND IFNULL(sender_name,'') <> ''
    GROUP BY sender_name ORDER BY c DESC LIMIT ?
  `).all(limit).map(r => r.n);
}

// ------------------------------------------------------------
//  To/CC 역할 백필 (경량)
//   1 = 내가 직접 수신(To) · 0 = 참조(CC) · NULL = 판단 불가/내가 보낸 메일
//   ★ 저장 형식이 표시이름인 경우가 많아(실측) 이메일+이름 양쪽으로 매칭한다.
// ------------------------------------------------------------
function backfillToMe({ force = false } = {}) {
  const ids = [...myAddresses(3), ...myDisplayNames(2)].filter(Boolean);
  if (!ids.length) return { ok: false, error: '내 주소/이름을 찾지 못했습니다.' };
  const toParams = ids.map(x => `%${String(x).toLowerCase()}%`);

  const where = force ? '' : ' AND to_me IS NULL';
  // ① To 에 내가 있으면 1
  const q1 = `UPDATE mails SET to_me = 1 WHERE folder <> 'Sent'${where}
    AND (${ids.map(() => "lower(IFNULL(recipients,'')) LIKE ?").join(' OR ')})`;
  const n1 = db.prepare(q1).run(...toParams).changes;
  // ② To 에 없고 CC 에 있으면 0
  const q0 = `UPDATE mails SET to_me = 0 WHERE folder <> 'Sent' AND to_me IS NULL
    AND (${ids.map(() => "lower(IFNULL(cc,'')) LIKE ?").join(' OR ')})`;
  const n0 = db.prepare(q0).run(...toParams).changes;
  return { ok: true, direct: n1, cc: n0, identifiers: ids };
}
function toMeStats() {
  const r = db.prepare(`SELECT
      SUM(CASE WHEN to_me = 1 THEN 1 ELSE 0 END) direct,
      SUM(CASE WHEN to_me = 0 THEN 1 ELSE 0 END) cc,
      SUM(CASE WHEN to_me IS NULL AND folder <> 'Sent' THEN 1 ELSE 0 END) unknown
    FROM mails`).get();
  return { direct: r.direct || 0, cc: r.cc || 0, unknown: r.unknown || 0 };
}

// ------------------------------------------------------------
//  미회신 감지: 받았지만 내가 아직 답장하지 않은 메일
//  같은 대화(정규화 제목)로 '수신 이후에' 보낸 메일이 없으면 미회신으로 본다.
//  ponytail: 정규화 제목 기반 휴리스틱(Message-ID/References 미저장).
//            오탐 방지를 위해 내 주소 발신분·Sent 폴더는 제외한다.
// ------------------------------------------------------------
//  sort: 'date'(기본 — 받은 날짜 최신순, 전역 정렬 원칙) | 'waiting'(오래 기다린 순)
//  excludeClosed: 내가 '처리'·'확인'으로 표시한 메일을 목록에서 뺀다(기본 ON).
//    ★ 답장을 안 했어도 내가 끝났다고 표시했으면 더 보여 줄 이유가 없다(중복 UI 방지).
function unansweredMails({ days = 14, limit = 30, minDays = 1, senderQuery = '', sort = 'date', excludeClosed = true } = {}) {
  const now = Date.now();
  const sinceTs = now - days * 864e5;
  const mine = new Set(myAddresses(3));

  const received = db.prepare(`
    SELECT id, subject, sender_name, sender_email, received_at, received_ts, folder, has_attach, preview,
           action_state, action_note, action_due, categories, importance, flag_status, task_due, to_me
    FROM mails
    WHERE folder != 'Sent' AND received_ts >= ?
    ORDER BY received_ts DESC
  `).all(sinceTs);

  const sent = db.prepare(`
    SELECT subject, received_ts FROM mails
    WHERE folder = 'Sent' AND received_ts >= ?
  `).all(sinceTs - 7 * 864e5);

  const sentIndex = new Map();   // 정규화제목 → 내가 마지막으로 보낸 시각
  for (const s of sent) {
    const k = normalizeSubject(s.subject);
    if (!k) continue;
    const prev = sentIndex.get(k) || 0;
    if (s.received_ts > prev) sentIndex.set(k, s.received_ts);
  }

  const seen = new Set();
  const out = [];
  const sq = String(senderQuery || '').trim().toLowerCase();
  for (const m of received) {
    if (!m.received_ts) continue;
    if (mine.has(String(m.sender_email || '').toLowerCase())) continue;   // 내가 보낸 것
    // ★ 내가 '처리'·'확인'으로 표시한 메일은 뺀다 — 답장을 안 했어도 내 손을 떠났기 때문이다.
    //   (할 일 상태 기능과 회신대기가 같은 메일을 두 번 요구하는 중복 UI 방지)
    if (excludeClosed && (m.action_state === 'done' || m.action_state === 'fyi')) continue;
    if (sq && !(`${m.sender_name || ''} ${m.sender_email || ''}`.toLowerCase().includes(sq))) continue;
    const waited = Math.floor((now - m.received_ts) / 864e5);
    if (waited < minDays) continue;                                        // 갓 온 메일 제외
    const k = normalizeSubject(m.subject);
    if (!k || seen.has(k)) continue;                                       // 대화당 1건
    const repliedAt = sentIndex.get(k) || 0;
    if (repliedAt > m.received_ts) continue;                               // 이미 답장함
    seen.add(k);
    out.push({ ...m, daysWaiting: waited });
  }
  // ★ 전역 정렬 원칙: 기본은 받은 날짜 최신순. 'waiting' 을 고르면 오래 방치된 것부터.
  //   (limit 을 걸기 전에 정렬해야 '상한에 걸려 최신 건이 잘리는' 역전이 생기지 않는다)
  if (sort === 'waiting') out.sort((a, b) => (a.received_ts || 0) - (b.received_ts || 0));
  else out.sort((a, b) => (b.received_ts || 0) - (a.received_ts || 0));
  return out.slice(0, limit);
}

// ============================================================
//  ★ 로컬 가상 폴더 / 즐겨찾기 / 읽음 상태
//  ------------------------------------------------------------
//  전부 이 DB 안에서만 동작한다. Outlook COM 으로 원본 메일함을
//  변경하는 코드는 이 파일 어디에도 없다(마스터 실메일함 보호).
// ============================================================

// 유효 안읽음 판정식: 로컬 read_flag 가 있으면 그것을, 없으면 Outlook 원본 unread 를 따른다
const UNREAD_EXPR = '(CASE WHEN read_flag IS NULL THEN unread ELSE (1 - read_flag) END)';

// ---- 가상 폴더 ----
function listVirtualFolders() {
  return db.prepare(`
    SELECT v.*, (SELECT COUNT(*) FROM mail_folder_map m WHERE m.vfolder_id = v.id) AS mailCount
    FROM virtual_folders v ORDER BY v.sort_order, v.name
  `).all();
}
function createVirtualFolder(name, parentId = null) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('폴더 이름을 입력하세요.');
  const dup = db.prepare('SELECT id FROM virtual_folders WHERE name = ? AND IFNULL(parent_id,-1) = IFNULL(?,-1)').get(nm, parentId);
  if (dup) throw new Error('같은 이름의 폴더가 이미 있습니다.');
  const maxOrder = db.prepare('SELECT IFNULL(MAX(sort_order),0) m FROM virtual_folders WHERE IFNULL(parent_id,-1) = IFNULL(?,-1)').get(parentId).m;
  const id = db.prepare('INSERT INTO virtual_folders (name, parent_id, sort_order) VALUES (?,?,?)')
    .run(nm, parentId, maxOrder + 1).lastInsertRowid;
  return db.prepare('SELECT * FROM virtual_folders WHERE id = ?').get(id);
}
function renameVirtualFolder(id, name) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('폴더 이름을 입력하세요.');
  const row = db.prepare('SELECT * FROM virtual_folders WHERE id = ?').get(id);
  if (!row) throw new Error('가상 폴더를 찾을 수 없습니다.');
  db.prepare('UPDATE virtual_folders SET name = ? WHERE id = ?').run(nm, id);
  // 즐겨찾기 라벨도 함께 갱신
  db.prepare("UPDATE folder_favorites SET label = ? WHERE key = 'virtual:' || ?").run(nm, id);
  return db.prepare('SELECT * FROM virtual_folders WHERE id = ?').get(id);
}
// 삭제: 매핑만 지워지므로 안의 메일은 원래(Outlook) 폴더 표시로 자동 복귀
function deleteVirtualFolder(id) {
  const restored = db.prepare('SELECT COUNT(*) c FROM mail_folder_map WHERE vfolder_id = ?').get(id).c;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM mail_folder_map WHERE vfolder_id = ?').run(id);
    db.prepare("DELETE FROM folder_favorites WHERE key = 'virtual:' || ?").run(id);
    db.prepare('DELETE FROM virtual_folders WHERE id = ?').run(id);
  });
  tx();
  return { ok: true, restored };
}
function sortVirtualChildren(parentId = null) {
  const rows = db.prepare('SELECT id, name FROM virtual_folders WHERE IFNULL(parent_id,-1) = IFNULL(?,-1)').all(parentId);
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
  const upd = db.prepare('UPDATE virtual_folders SET sort_order = ? WHERE id = ?');
  const tx = db.transaction(() => rows.forEach((r, i) => upd.run(i + 1, r.id)));
  tx();
  return rows.length;
}
// 메일 이동 (vfolderId 가 null 이면 원래 폴더로 되돌림)
function moveMailsToVirtual(mailIds, vfolderId) {
  const ids = (mailIds || []).map(Number).filter(Boolean);
  if (!ids.length) return 0;
  const del = db.prepare('DELETE FROM mail_folder_map WHERE mail_id = ?');
  const ins = db.prepare('INSERT INTO mail_folder_map (mail_id, vfolder_id) VALUES (?,?)');
  const tx = db.transaction(() => {
    for (const id of ids) { del.run(id); if (vfolderId) ins.run(id, vfolderId); }
  });
  tx();
  return ids.length;
}

// ---- 즐겨찾기 ----
// ---- 폴더 표시 순서 (로컬) ----
// 마스터가 직접 정한 순서만 반환한다.
//  Outlook 원래 순서는 PR_SORT_POSITION(트리 payload 의 sortPos)으로 렌더러가 직접 정렬하므로
//  DB 에 중복 보관하지 않는다(정본 1곳).
function getFolderOrder() {
  const out = {};
  db.prepare("SELECT store, path, ord FROM folder_order WHERE IFNULL(source,'manual') <> 'outlook'").all()
    .forEach(r => { out[`${r.store}/${r.path}`] = r.ord; });
  return out;
}
function setFolderOrder(list, source = 'manual') {
  const rows = (list || []).filter(x => x && x.store && x.path);
  const up = db.prepare(`INSERT INTO folder_order (store, path, ord, source) VALUES (?,?,?,?)
    ON CONFLICT(store, path) DO UPDATE SET ord=excluded.ord, source=excluded.source`);
  const tx = db.transaction(() => rows.forEach((x, i) => up.run(x.store, x.path, x.ord === undefined ? i : x.ord, source)));
  tx();
  return rows.length;
}

function listFavorites() {
  return db.prepare('SELECT * FROM folder_favorites ORDER BY sort_order, label').all();
}
function addFavorite(key, kind, label) {
  const exists = db.prepare('SELECT key FROM folder_favorites WHERE key = ?').get(key);
  if (exists) return { ok: true, already: true };
  const m = db.prepare('SELECT IFNULL(MAX(sort_order),0) m FROM folder_favorites').get().m;
  db.prepare("INSERT INTO folder_favorites (key, kind, label, sort_order, source) VALUES (?,?,?,?,'manual')")
    .run(key, kind, label, Math.max(m + 1, MANUAL_FAV_BASE));
  return { ok: true };
}

// Outlook 즐겨찾기가 항상 위(1..n), 앱에서 수동 추가한 것은 그 아래(1000+)
const MANUAL_FAV_BASE = 1000;

// ------------------------------------------------------------
//  Outlook 탐색 창 즐겨찾기 → 앱 즐겨찾기 동기화
//   정책(마스터 지시): Outlook 이 정본. 목록도 순서도 Outlook 그대로 가져온다.
//                     앱에서 수동 추가한 항목은 지우지 않고 Outlook 항목 아래에 유지.
//   ★ 반대 방향(앱→Outlook) 쓰기는 하지 않는다.
// ------------------------------------------------------------
function syncOutlookFavorites(list) {
  const rows = (list || []).filter(f => f && (f.name || f.label));
  const seen = new Set();
  const items = [];
  rows.forEach((f, i) => {
    const name = String(f.name || f.label).trim();
    const key = `real:${name}`;
    if (!name || seen.has(key)) return;      // 같은 이름이 두 번이면 위쪽(먼저 나온) 것만
    seen.add(key);
    items.push({
      key, label: String(f.label || name).trim(), path: f.path || '',
      ord: Number.isFinite(f.pos) ? f.pos : i + 1
    });
  });

  const before = db.prepare("SELECT COUNT(*) c FROM folder_favorites WHERE source = 'outlook'").get().c;
  const ins = db.prepare(`
    INSERT INTO folder_favorites (key, kind, label, sort_order, source, path)
    VALUES (?, 'real', ?, ?, 'outlook', ?)
    ON CONFLICT(key) DO UPDATE SET
      label = excluded.label, sort_order = excluded.sort_order,
      source = 'outlook', path = excluded.path
  `);
  const tx = db.transaction(() => {
    // Outlook 에서 빠진 항목은 제거(정본 반영), 수동 항목은 건드리지 않는다
    const keep = items.map(x => x.key);
    const ph = keep.length ? keep.map(() => '?').join(',') : "''";
    db.prepare(`DELETE FROM folder_favorites WHERE source = 'outlook' AND key NOT IN (${ph})`).run(...keep);
    // 같은 폴더를 앱에서 미리 수동 추가해 뒀다면 Outlook 정본과 중복 표시된다.
    // key 형식이 달라도(예: real:Inbox vs real:받은 편지함) 라벨이 같으면 수동 쪽을 지운다.
    if (items.length) {
      const lp = items.map(() => '?').join(',');
      db.prepare(`DELETE FROM folder_favorites
                  WHERE source <> 'outlook' AND kind = 'real' AND label IN (${lp})`)
        .run(...items.map(x => x.label));
    }
    items.forEach(x => ins.run(x.key, x.label, x.ord, x.path));
    // 수동 항목이 Outlook 항목 위로 올라오지 않도록 뒤로 정렬
    db.prepare(`UPDATE folder_favorites SET sort_order = sort_order + ?
                WHERE source <> 'outlook' AND sort_order < ?`).run(MANUAL_FAV_BASE, MANUAL_FAV_BASE);
  });
  tx();
  const manual = db.prepare("SELECT COUNT(*) c FROM folder_favorites WHERE source <> 'outlook'").get().c;
  return { ok: true, imported: items.length, before, manual };
}

function removeFavorite(key) {
  db.prepare('DELETE FROM folder_favorites WHERE key = ?').run(key);
  return { ok: true };
}
function moveFavorite(key, dir) {
  const list = listFavorites();
  const i = list.findIndex(f => f.key === key);
  if (i < 0) return { ok: false, error: '즐겨찾기에 없습니다.' };
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= list.length) return { ok: true, moved: false };
  const upd = db.prepare('UPDATE folder_favorites SET sort_order = ? WHERE key = ?');
  const tx = db.transaction(() => { upd.run(j + 1, list[i].key); upd.run(i + 1, list[j].key); });
  tx();
  return { ok: true, moved: true };
}

// ---- 읽음 상태 (로컬 전용) ----
function setReadFlag(mailIds, read) {
  const ids = (mailIds || []).map(Number).filter(Boolean);
  if (!ids.length) return 0;
  const stmt = db.prepare('UPDATE mails SET read_flag = ? WHERE id = ?');
  const tx = db.transaction(() => ids.forEach(id => stmt.run(read ? 1 : 0, id)));
  tx();
  return ids.length;
}
function markFolderRead(opts = {}) {
  const { folder = '', vfolderId = null } = opts;
  if (vfolderId) {
    return db.prepare(`UPDATE mails SET read_flag = 1 WHERE id IN (SELECT mail_id FROM mail_folder_map WHERE vfolder_id = ?)`).run(vfolderId).changes;
  }
  if (folder) {
    // 저장 규칙과 동일하게 정규화 (즐겨찾기의 '받은 편지함' → 'Inbox')
    return db.prepare(`UPDATE mails SET read_flag = 1 WHERE folder = ? AND id NOT IN (SELECT mail_id FROM mail_folder_map)`).run(canonicalFolder(folder)).changes;
  }
  return db.prepare('UPDATE mails SET read_flag = 1').run().changes;
}
// 폴더별 안읽음 수 (사이드바 배지) — 가상 폴더로 옮겨간 메일은 원폴더에서 제외
function unreadCounts() {
  const byFolder = {};
  db.prepare(`
    SELECT folder, COUNT(*) c FROM mails
    WHERE ${UNREAD_EXPR} = 1 AND id NOT IN (SELECT mail_id FROM mail_folder_map)
    GROUP BY folder
  `).all().forEach(r => { byFolder[r.folder || 'Inbox'] = r.c; });
  const byVirtual = {};
  db.prepare(`
    SELECT m.vfolder_id id, COUNT(*) c FROM mail_folder_map m
    JOIN mails x ON x.id = m.mail_id
    WHERE ${UNREAD_EXPR.replace(/read_flag/g, 'x.read_flag').replace(/unread/g, 'x.unread')} = 1
    GROUP BY m.vfolder_id
  `).all().forEach(r => { byVirtual[r.id] = r.c; });
  const total = db.prepare(`SELECT COUNT(*) c FROM mails WHERE ${UNREAD_EXPR} = 1`).get().c;
  return { byFolder, byVirtual, total };
}

// ============================================================
//  ★ 프로젝트 사전 + 보낸메일 트리 (프로젝트 → 수신인 → 메일)
//  ------------------------------------------------------------
//  판정 우선순위
//   ① project_map (마스터가 수동 지정한 건)
//   ② project_rules (사용자/학습 규칙: prefix > folder > contains)
//   ③ 제목 말머리 자동 패턴 ([CGO NURIBARAM], (22FD), H2710 등)
//   ④ 같은 대화(정규화 제목)로 받은 메일의 폴더명 — 받은편지함 분류를 역이용
//   ⑤ '기타'
//  성능: 판정을 1회 수행해 mails.project/to_first 에 캐시하고,
//        이후 트리 집계는 전부 SQL GROUP BY 로 처리한다(렌더러 전건 루프 금지).
// ============================================================

// 프로젝트로 보지 않는 일반 업무 문구 (파편화 주원인 — 실측: "확인 요청","참고 자료 송부" 등)
const GENERIC_TOKENS = /^(확인|요청|회신|송부|제출|검토|협조|공지|안내|보고|전달|답변|문의|승인|수정|추가|변경|취소|긴급|중요|참조|재송부|자료|첨부|도면|견적|계약|회의|일정|주간|월간|결과|현황|완료|진행|의뢰|통보|알림|공유|정리|목록|리스트|기타|외|건|관련|사항|내용|파일|메일|이메일|샘플|초안|최종|버전|수정본|원본|사본)([\s·의]|$)/;
function isGenericToken(t) {
  const x = String(t || '').trim();
  if (x.length < 2) return true;
  if (/^\d+$/.test(x)) return true;                       // 순번
  if (GENERIC_TOKENS.test(x)) return true;
  // '~의 건', '~요청', '~송부' 로 끝나는 서술형 말머리
  if (/(의\s*건|요청|송부|발송|제출|검토|안내|보고|문의|공지|회신|전달|답변|공유|첨부)$/.test(x)) return true;
  return false;
}
// 말머리 토큰 다듬기 — 짝 안 맞는 괄호·법인 표기 제거
//  '[(주)세아]' → '세아',  '(주)' 단독 → 버림
function cleanProjectToken(raw) {
  let t = String(raw || '').trim();
  // ① 법인 표기를 '먼저' 지운다. 괄호 트리밍을 먼저 하면 '(주)' 가 '주)' 로 깨져 살아남는다(실측 결함).
  t = t.replace(/[（(]\s*(주|유|재|사|명)\s*[)）]/g, '').replace(/㈜|㈐/g, '')
       .replace(/주식회사|유한회사|유한책임회사/g, '').trim();
  // ② 그 다음 짝 안 맞는 바깥 괄호·따옴표 정리
  t = t.replace(/^[\[\(\{"'`\s]+/, '').replace(/[\]\)\}"'`\s]+$/, '');
  // ③ 그래도 남은 법인 표기 잔재('주)…', '…(주')
  t = t.replace(/^\s*(주|유)\s*[)）]\s*/, '').replace(/\s*[（(]\s*(주|유)\s*$/, '').trim();
  t = t.replace(/^[\s\-–—·,.:;]+/, '').replace(/[\s\-–—·,.:;]+$/, '');
  return t.length >= 2 ? t : '';
}

// 프로젝트 키 정규화 (대소문자·공백·하이픈·전각 통일) → 유사 말머리 병합
function normalizeProjectKey(name) {
  return String(name || '')
    .replace(/[\s\-_/]+/g, '')
    .replace(/[（）()]/g, '')
    .toUpperCase();
}

// 제목 말머리에서 프로젝트 후보 추출
function extractProjectTokens(subject) {
  const s = String(subject || '');
  const out = [];
  // [대괄호] · (소괄호) 말머리
  //  ★ 두 괄호를 하나의 문자클래스로 묶으면 '[(주)세아]' 가 '(주' 로 잘린다(실측 결함).
  //    대괄호/소괄호를 각각 짝지어 매칭한 뒤 cleanProjectToken 으로 다듬는다.
  for (const re of [/\[\s*([^\[\]]{2,40}?)\s*\]/g, /\(\s*([^\(\)]{2,40}?)\s*\)/g]) {
    for (const m of s.matchAll(re)) {
      const t = cleanProjectToken(m[1]);
      if (!t) continue;
      if (/^(re|fw|fwd|답장|전달|spam|외부메일|중요|긴급|공지)$/i.test(t)) continue;
      if (isGenericToken(t)) continue;                  // 일반 업무 문구·순번 제외
      out.push(t);
    }
  }
  // 호선번호 계열: H2710, KYTS-1037, 22K FD, 4300TEU, N282 등
  for (const re of [
    /\b(H\s?\d{3,4}(?:\/\d{1,4})?)\b/gi,
    /\b([A-Z]{2,5}-\d{3,5})\b/g,
    /\b(\d{1,3}\s?K\s?(?:FD|COT|MPC|BULK))\b/gi,
    /\b(\d{3,5}\s?TEU)\b/gi,
    /\b(N\d{3}\s?PMU?)\b/gi
  ]) {
    for (const m of s.matchAll(re)) out.push(m[1].replace(/\s+/g, ' ').trim());
  }
  return [...new Set(out)];
}

function listProjectRules() {
  return db.prepare('SELECT * FROM project_rules ORDER BY priority, id').all();
}
function addProjectRule(pattern, project, kind = 'contains', priority = 100, auto = 0) {
  const pat = String(pattern || '').trim();
  const prj = String(project || '').trim();
  if (!pat || !prj) throw new Error('패턴과 프로젝트명을 입력하세요.');
  db.prepare(`INSERT INTO project_rules (pattern, project, kind, priority, auto) VALUES (?,?,?,?,?)
              ON CONFLICT(kind, lower(pattern)) DO UPDATE SET project=excluded.project, priority=excluded.priority`)
    .run(pat, prj, kind, priority, auto ? 1 : 0);
  return { ok: true };
}
function removeProjectRule(id) {
  db.prepare('DELETE FROM project_rules WHERE id = ?').run(id);
  return { ok: true };
}

// ============================================================
//  ★ 상대 조직 사전 (2차 분류)
//  ------------------------------------------------------------
//  개별 수신인이 아니라 '상대 조직' 단위로 묶는다.
//  판정 우선순위: ① 사전(org_domain_map) ② 주소록 company ③ 도메인 라벨
//  사전은 주소록 company·도메인 빈도로 자동 구축하고 설정에서 편집한다.
// ============================================================
const ORG_SEED = {
  'seastargo.com': 'SEASTAR(자사)',
  'smsolution.co.kr': 'SM솔루션',
  'yuilship.com': '유일',
  'krsit.co.kr': 'KSIT',
  'kmsemec.co.kr': 'KMSEMEC',
  'hjsc.co.kr': '한진중공업',
  'mmce.co.kr': 'MMCE',
  'kyship.co.kr': '한국야나세',
  'kkthebest.com': '금강',
  'yg-tms.com': 'YG TMS'
};
// 공용 메일 도메인은 조직으로 묶지 않는다(개인 계정)
const PUBLIC_DOMAINS = /^(gmail|naver|daum|hanmail|nate|kakao|outlook|hotmail|yahoo|icloud|qq|163|126)\./i;

function emailDomain(v) {
  const m = String(v || '').match(/[\w.+-]+@([\w.-]+\.\w+)/);
  return m ? m[1].toLowerCase() : '';
}
function domainLabel(domain) {
  const d = String(domain || '').toLowerCase();
  if (!d) return '';
  const parts = d.split('.');
  // co.kr / com 등 접미사 앞의 라벨을 조직명으로
  const idx = parts.length >= 3 && /^(co|or|ne|go|ac)$/.test(parts[parts.length - 2]) ? parts.length - 3 : parts.length - 2;
  return (parts[Math.max(0, idx)] || d).toUpperCase();
}

function listOrgMap() {
  return db.prepare('SELECT * FROM org_domain_map ORDER BY cnt DESC, domain').all();
}
function setOrgMap(domain, org, auto = 0) {
  const d = String(domain || '').trim().toLowerCase();
  const o = String(org || '').trim();
  if (!d || !o) throw new Error('도메인과 조직명을 입력하세요.');
  db.prepare(`INSERT INTO org_domain_map (domain, org, auto) VALUES (?,?,?)
              ON CONFLICT(domain) DO UPDATE SET org=excluded.org, auto=excluded.auto`).run(d, o, auto ? 1 : 0);
  return { ok: true };
}
function removeOrgMap(domain) {
  db.prepare('DELETE FROM org_domain_map WHERE domain = ?').run(String(domain || '').toLowerCase());
  return { ok: true };
}

// 주소록 company + 도메인 빈도로 사전 자동 구축 (수동 편집분은 보존)
function buildOrgDictionary() {
  const manual = new Set(db.prepare('SELECT domain FROM org_domain_map WHERE auto = 0').all().map(r => r.domain));
  // 도메인별 등장 횟수 (보낸메일 수신인 기준)
  const freq = new Map();
  for (const r of db.prepare("SELECT recipients, cc FROM mails WHERE folder = 'Sent'").all()) {
    for (const part of `${r.recipients || ''};${r.cc || ''}`.split(/[;,]/)) {
      const d = emailDomain(part);
      if (!d || PUBLIC_DOMAINS.test(d)) continue;
      freq.set(d, (freq.get(d) || 0) + 1);
    }
  }
  // 주소록 company 최빈값
  const compByDomain = new Map();
  for (const c of db.prepare("SELECT email, company FROM contacts WHERE IFNULL(email,'') <> '' AND IFNULL(company,'') <> ''").all()) {
    const d = emailDomain(c.email);
    if (!d) continue;
    if (!compByDomain.has(d)) compByDomain.set(d, new Map());
    const m = compByDomain.get(d);
    m.set(c.company, (m.get(c.company) || 0) + 1);
  }
  const up = db.prepare(`INSERT INTO org_domain_map (domain, org, auto, cnt) VALUES (?,?,1,?)
                         ON CONFLICT(domain) DO UPDATE SET org=excluded.org, cnt=excluded.cnt WHERE auto = 1`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const [d, cnt] of freq) {
      if (manual.has(d)) continue;
      let org = ORG_SEED[d];
      if (!org && compByDomain.has(d)) {
        org = [...compByDomain.get(d).entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
      if (!org) org = domainLabel(d);
      up.run(d, org, cnt);
      n++;
    }
  });
  tx();
  return { ok: true, domains: n, manual: manual.size };
}

// 메일 1건의 상대 조직 판정
function resolveOrg(mail, dict) {
  const pool = `${mail.recipients || ''};${mail.cc || ''}`;
  for (const part of pool.split(/[;,]/)) {
    const d = emailDomain(part);
    if (!d || PUBLIC_DOMAINS.test(d)) continue;
    const hit = dict.get(d);
    if (hit) return hit;
    return domainLabel(d);
  }
  // 이메일이 없으면 주소록 이름 매칭 시도
  const first = cleanRecipientName(String(mail.recipients || '').split(/[;,]/)[0] || '');
  if (first) {
    const row = db.prepare("SELECT company, email FROM contacts WHERE name = ? AND IFNULL(company,'') <> '' LIMIT 1").get(first);
    if (row && row.company) return row.company;
    const row2 = db.prepare('SELECT email FROM contacts WHERE name = ? LIMIT 1').get(first);
    const d2 = row2 ? emailDomain(row2.email) : '';
    if (d2 && !PUBLIC_DOMAINS.test(d2)) return dict.get(d2) || domainLabel(d2);
  }
  return '(미분류 상대)';
}

// 수신인 표시명 정규화
//  실측 오염 사례: "'kohyk@seastargo.com'"(따옴표) · "공문정 (kmj@seastargo.com)"(이름+주소)
//                 "'우성일(WOO SUNG IL)'"(따옴표+영문명)
function cleanRecipientName(v) {
  let t = String(v || '').trim();
  if (!t) return '';
  t = t.replace(/^['"<\s]+|['">\s]+$/g, '');          // 감싼 따옴표·꺾쇠 제거
  t = t.replace(/\s*<[^>]*@[^>]*>\s*/g, ' ');          // <a@b.com> 제거
  t = t.replace(/\s*\(\s*[\w.+-]+@[\w.-]+\s*\)\s*/g, ' ');   // (a@b.com) 제거
  t = t.replace(/\s{2,}/g, ' ').trim();
  // 이름 없이 이메일만 남았으면 로컬파트를 표시명으로
  const onlyMail = t.match(/^([\w.+-]+)@[\w.-]+$/);
  if (onlyMail) return onlyMail[1];
  // "홍길동(HONG GILDONG)" → 앞부분만 (한글 이름이 있을 때)
  const koParen = t.match(/^([가-힣][가-힣\s]{1,15})\s*\([^)]*\)$/);
  if (koParen) return koParen[1].trim();
  return t;
}

// 수신인 문자열 → 대표 1명 + 인원수
function parseRecipients(rec) {
  const raw = String(rec || '').trim();
  if (!raw) return { first: '', count: 0 };
  const parts = raw.split(/[;,]/).map(x => cleanRecipientName(x)).filter(Boolean);
  return { first: parts[0] || '', count: parts.length };
}

// ---- 프로젝트/수신인 캐시 재계산 ----
//  folderOnly: 'Sent' 처럼 특정 폴더만 대상으로 (기본 Sent)
// ------------------------------------------------------------
//  Outlook 규칙 → 프로젝트 판정 사전 반영 (읽기 전용으로 가져온 규칙을 로컬 규칙으로 등록)
//   rules = [{ name, from:'a@b;c@d', folder:'KSIT', subject:'2710;22K' }]
//   · 제목 키워드 → kind 'contains'
//   · 발신/수신 이메일 → kind 'sender' (보낸메일에서는 '받는 사람'과 대조한다)
//   마스터가 Outlook 에 이미 정의해 둔 분류 의도를 그대로 쓰는 것이 가장 정확하다.
// ------------------------------------------------------------
function importOutlookRules(rules) {
  const list = (rules || []).filter(r => r && r.folder);
  const ins = db.prepare(`INSERT INTO project_rules (pattern, project, kind, priority, auto)
    VALUES (?,?,?,?,1) ON CONFLICT(kind, lower(pattern)) DO UPDATE SET project=excluded.project`);
  let contains = 0, senders = 0;
  const tx = db.transaction(() => {
    for (const r of list) {
      const project = String(r.folder).trim();
      if (!project) continue;
      String(r.subject || '').split(';').map(s => s.trim()).filter(s => s.length >= 2)
        .forEach(w => { ins.run(w, project, 'contains', 60); contains++; });
      String(r.from || '').split(';').map(s => s.trim().toLowerCase()).filter(s => s.includes('@'))
        .forEach(a => { ins.run(a, project, 'sender', 55); senders++; });
    }
  });
  tx();
  return { ok: true, rules: list.length, contains, senders };
}

// Outlook 기본 폴더(=업무 프로젝트가 아닌 시스템 폴더) 판정. 한 곳에서만 정의한다.
const BASE_FOLDER_RE = /^(Inbox|Sent|Deleted|Drafts|Outbox|Junk|받은 ?편지함|보낸 ?편지함|지운 ?편지함|임시 ?보관함|보낼 ?편지함|정크 ?메일)$/i;

//  folder: 'Sent'(기본) | '*'(전 폴더 — 받은메일까지 분류)
function recomputeProjects({ folder = 'Sent' } = {}) {
  const rules = listProjectRules();
  const byKind = (k) => rules.filter(r => r.kind === k);
  const prefixRules = byKind('prefix');
  const folderRules = byKind('folder');
  const containsRules = byKind('contains');
  const senderRules = byKind('sender');

  const manual = new Map(db.prepare('SELECT mail_id, project FROM project_map').all().map(r => [r.mail_id, r.project]));

  // 받은 메일의 (정규화 제목 → 폴더) 색인: 스레드 역추적용
  const threadFolder = new Map();
  for (const r of db.prepare(`SELECT subject, folder FROM mails WHERE folder != 'Sent' AND folder != '' `).all()) {
    const k = normalizeSubject(r.subject);
    if (!k || threadFolder.has(k)) continue;
    if (BASE_FOLDER_RE.test(r.folder)) continue;   // 기본 폴더는 프로젝트가 아님
    threadFolder.set(k, r.folder);
  }

  // 상대 조직 사전 준비 (2차 분류)
  buildOrgDictionary();
  const orgDict = new Map(db.prepare('SELECT domain, org FROM org_domain_map').all().map(r => [r.domain, r.org]));

  // folder='*' 면 전 폴더(받은메일 포함)를 대상으로 한다.
  //  ★ 받은메일을 빼두면 대시보드 프로젝트 축이 '기타' 85%(20,101/23,727)로 사실상 무의미해진다(실측).
  const ALL = String(folder) === '*';
  const rows = ALL
    ? db.prepare('SELECT id, subject, recipients, cc, folder, sender_email FROM mails').all()
    : db.prepare('SELECT id, subject, recipients, cc, folder, sender_email FROM mails WHERE folder = ?').all(folder);
  const upd = db.prepare('UPDATE mails SET project = ?, to_first = ?, to_count = ?, to_org = ?, thread_key = ? WHERE id = ?');
  const dist = new Map();
  const orgDist = new Map();
  // 프로젝트 정규화 키 → 대표 표기 (유사 말머리 병합: 대소문자·공백·하이픈 무시)
  const canonProject = new Map();

  const tx = db.transaction(() => {
    for (const m of rows) {
      const subj = String(m.subject || '');
      const low = subj.toLowerCase();
      let project = null;

      // ① 수동 지정
      if (manual.has(m.id)) project = manual.get(m.id);

      // ② 사용자/학습 규칙 (prefix → folder → contains)
      if (!project) {
        for (const r of prefixRules) {
          if (low.startsWith(String(r.pattern).toLowerCase())) { project = r.project; break; }
        }
      }
      if (!project) {
        for (const r of containsRules) {
          if (low.includes(String(r.pattern).toLowerCase())) { project = r.project; break; }
        }
      }
      // ②-b Outlook 규칙의 '발신자' 조건
      //   보낸메일이면 상대(받는사람/참조)와, 받은메일이면 실제 발신자와 대조해야 맞는다.
      if (!project && senderRules.length) {
        const isSent = String(m.folder || '') === 'Sent';
        const who = (isSent ? `${m.recipients || ''} ${m.cc || ''}` : `${m.sender_email || ''}`).toLowerCase();
        if (who.trim()) {
          for (const r of senderRules) {
            if (who.includes(String(r.pattern).toLowerCase())) { project = r.project; break; }
          }
        }
      }

      // ②-c 받은메일은 '들어 있는 폴더' 자체가 프로젝트다(사용자가 업무별로 분류해 둔 결과).
      //   말머리 추정(③)보다 확실한 근거이므로 그보다 먼저 본다.
      if (!project && !BASE_FOLDER_RE.test(String(m.folder || '')) && String(m.folder || '').trim()) {
        const fr = folderRules.find(r => String(r.pattern).toLowerCase() === String(m.folder).toLowerCase());
        project = fr ? fr.project : m.folder;
      }

      // ③ 제목 말머리 자동 패턴
      if (!project) {
        const toks = extractProjectTokens(subj);
        if (toks.length) project = toks[0];
      }

      // ④ 대화 역추적: 같은 제목으로 받은 메일이 들어있던 폴더
      if (!project) {
        const k = normalizeSubject(subj);
        const f = k ? threadFolder.get(k) : null;
        if (f) {
          const fr = folderRules.find(r => String(r.pattern).toLowerCase() === String(f).toLowerCase());
          project = fr ? fr.project : f;
        }
      }

      // ⑤ 기타
      if (!project) project = '기타';

      // 유사 말머리 병합: 정규화 키가 같으면 먼저 등장한 표기로 통일
      const ck = normalizeProjectKey(project);
      if (ck) {
        if (canonProject.has(ck)) project = canonProject.get(ck);
        else canonProject.set(ck, project);
      }

      const { first, count } = parseRecipients(m.recipients);
      const org = resolveOrg(m, orgDict);
      const tkey = normalizeSubject(subj) || `id${m.id}`;
      upd.run(project, first, count, org, tkey, m.id);
      dist.set(project, (dist.get(project) || 0) + 1);
      orgDist.set(org, (orgDist.get(org) || 0) + 1);
    }
  });
  tx();

  const total = rows.length;
  const etc = dist.get('기타') || 0;
  const unknownOrg = orgDist.get('(미분류 상대)') || 0;
  return {
    total,
    projects: dist.size,
    etc,
    etcRatio: total ? Math.round((etc / total) * 1000) / 10 : 0,
    top: [...dist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([project, count]) => ({ project, count })),
    orgs: orgDist.size,
    orgUnknown: unknownOrg,
    orgCoverage: total ? Math.round(((total - unknownOrg) / total) * 1000) / 10 : 0,
    topOrgs: [...orgDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([org, count]) => ({ org, count }))
  };
}

// ---- 트리 집계 (전부 SQL GROUP BY) ----
//  ★ 정렬 기준 = '최근 활동 순'(MAX(received_ts) DESC).
//    건수순으로 두면 몇 년 전 대형 프로젝트가 계속 최상단을 차지한다(마스터 지적).
function sentProjectTree({ folder = 'Sent', minCount = 1 } = {}) {
  return db.prepare(`
    SELECT IFNULL(project,'기타') AS project, COUNT(*) AS cnt,
           MAX(received_ts) AS lastTs, MIN(received_ts) AS firstTs,
           COUNT(DISTINCT IFNULL(to_org,'(미분류 상대)')) AS orgCnt
    FROM mails WHERE folder = ?
    GROUP BY IFNULL(project,'기타')
    HAVING cnt >= ?
    ORDER BY lastTs DESC, cnt DESC
  `).all(folder, minCount);
}

// 2차: 프로젝트 안의 '상대 조직' (최근 활동순)
function sentOrgs({ project, folder = 'Sent' } = {}) {
  return db.prepare(`
    SELECT IFNULL(to_org,'(미분류 상대)') AS org, COUNT(*) AS cnt,
           MAX(received_ts) AS lastTs,
           COUNT(DISTINCT IFNULL(thread_key,'')) AS threadCnt
    FROM mails WHERE folder = ? AND IFNULL(project,'기타') = ?
    GROUP BY IFNULL(to_org,'(미분류 상대)')
    ORDER BY lastTs DESC, cnt DESC
  `).all(folder, project);
}

// 3차: 조직 안의 '스레드'(제목 단위) — RE:/FW: 왕복이 한 줄
function sentThreads({ project, org, folder = 'Sent', limit = 200 } = {}) {
  const params = [folder, project];
  let sql = `SELECT IFNULL(thread_key,'') AS tkey, COUNT(*) AS cnt,
                    MAX(received_ts) AS lastTs,
                    MAX(subject) AS subject, MAX(to_first) AS toFirst,
                    MAX(has_attach) AS hasAttach
             FROM mails WHERE folder = ? AND IFNULL(project,'기타') = ?`;
  if (org) { sql += " AND IFNULL(to_org,'(미분류 상대)') = ?"; params.push(org); }
  sql += " GROUP BY IFNULL(thread_key,'') ORDER BY lastTs DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// 4차: 스레드 안의 개별 메일
function sentThreadMails({ tkey, project, org, folder = 'Sent', limit = 100 } = {}) {
  const params = [folder, tkey];
  let sql = `SELECT * FROM mails WHERE folder = ? AND IFNULL(thread_key,'') = ?`;
  if (project) { sql += " AND IFNULL(project,'기타') = ?"; params.push(project); }
  if (org) { sql += " AND IFNULL(to_org,'(미분류 상대)') = ?"; params.push(org); }
  sql += ' ORDER BY received_ts DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// ------------------------------------------------------------
//  분류 축 ②③ 용 원본 행 (날짜별 / 이벤트·테마별)
//   집계는 순수 모듈 src/sent-axis.js 가 한다(연·월 트리, 제목 키워드 분류).
//   본문·HTML 은 빼고 목록에 필요한 컬럼만 읽어 4천 건이어도 가볍다(실측 아래 참조).
// ------------------------------------------------------------
function sentAxisRows({ folder = 'Sent', limit = 20000 } = {}) {
  return db.prepare(`
    SELECT id, subject, received_at, received_ts, to_first, to_org, project,
           IFNULL(has_attach,0) AS has_attach, IFNULL(thread_key,'') AS thread_key,
           action_state
    FROM mails WHERE folder = ?
    ORDER BY received_ts DESC LIMIT ?
  `).all(folder, limit);
}

// 조직 사전 커버리지 조회 (재분류 실행 없이 현재 DB 상태만 집계)
//  main.js `org:dict` IPC 가 이 값으로 설정 화면의 커버리지 배지를 그린다.
function orgCoverage({ folder = 'Sent' } = {}) {
  const r = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN IFNULL(to_org,'(미분류 상대)') = '(미분류 상대)' THEN 1 ELSE 0 END) AS unknown,
           COUNT(DISTINCT IFNULL(to_org,'(미분류 상대)')) AS orgs
    FROM mails WHERE folder = ?
  `).get(folder);
  const total = r?.total || 0;
  const unknown = r?.unknown || 0;
  const top = db.prepare(`
    SELECT IFNULL(to_org,'(미분류 상대)') AS org, COUNT(*) AS cnt
    FROM mails WHERE folder = ?
    GROUP BY IFNULL(to_org,'(미분류 상대)')
    ORDER BY cnt DESC LIMIT 10
  `).all(folder);
  return {
    total, unknown, orgs: r?.orgs || 0,
    coverage: total ? Math.round(((total - unknown) / total) * 1000) / 10 : 0,
    top
  };
}

function sentMails({ project, toFirst = null, folder = 'Sent', limit = 300 } = {}) {
  const params = [folder, project];
  let sql = `SELECT *, (CASE WHEN read_flag IS NULL THEN unread ELSE (1 - read_flag) END) AS eff_unread
             FROM mails WHERE folder = ? AND IFNULL(project,'기타') = ?`;
  if (toFirst !== null) { sql += ' AND IFNULL(to_first,\'(수신인 없음)\') = ?'; params.push(toFirst); }
  sql += ' ORDER BY received_ts DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

// ---- 수동 지정 + 규칙 학습 ----
function setMailProject(mailId, project, learn = true) {
  const prj = String(project || '').trim();
  if (!prj) throw new Error('프로젝트명을 입력하세요.');
  const m = db.prepare('SELECT id, subject FROM mails WHERE id = ?').get(mailId);
  if (!m) throw new Error('메일을 찾을 수 없습니다.');
  db.prepare(`INSERT INTO project_map (mail_id, project) VALUES (?,?)
              ON CONFLICT(mail_id) DO UPDATE SET project=excluded.project`).run(mailId, prj);
  db.prepare('UPDATE mails SET project = ? WHERE id = ?').run(prj, mailId);

  // 같은 말머리 패턴을 규칙으로 학습 → 이후 자동 적용
  let learned = null;
  if (learn) {
    const toks = extractProjectTokens(m.subject);
    if (toks.length) {
      addProjectRule(toks[0], prj, 'contains', 50, 1);
      learned = toks[0];
    }
  }
  return { ok: true, learned };
}
function projectList({ folder = 'Sent' } = {}) {
  const a = db.prepare(`SELECT DISTINCT IFNULL(project,'기타') AS p FROM mails WHERE folder = ? ORDER BY p`).all(folder).map(r => r.p);
  const b = db.prepare('SELECT DISTINCT project AS p FROM project_rules ORDER BY p').all().map(r => r.p);
  return [...new Set([...a, ...b])].filter(Boolean);
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
  // 폴더별 카운트
  const byFolder = {};
  db.prepare('SELECT folder, COUNT(*) c FROM mails GROUP BY folder').all().forEach(r => {
    byFolder[r.folder || 'Inbox'] = r.c;
  });
  return { total, unread, withAttach, contacts, attachments: attach, byLang, topSenders, byFolder, ftsEnabled };
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
  init, close,
  upsertMailsBatch,
  addAttachment, getAttachmentsByMail,
  upsertContactsBatch, listContacts, upsertAddressBook, getGroupMembers, addressBookStats,
  addAnalysis, getAnalyses, listAnalyses,
  getDailyBriefing, saveDailyBriefing, dailyBriefingDates, mailsOnDate,
  searchMails, getMailById, getMailByEntryId, mailsInRange,
  getThreadContext, findContactCandidates, saveChatTurn, getChatHistory, clearChatHistory,
  myAddresses, myDisplayNames, backfillToMe, toMeStats, unansweredMails,
  // 프로젝트 사전 / 보낸메일 트리
  listProjectRules, addProjectRule, removeProjectRule, recomputeProjects,
  sentProjectTree, sentAxisRows, sentMails, setMailProject, projectList,
  sentOrgs, sentThreads, sentThreadMails, orgCoverage,
  collectSchedules, schedulesInRange, schedulesUpcoming,
  addBigmailUpload, listBigmailUploads, deleteBigmailUpload,
  backfillAttachmentFlags, applyAttachmentProbe, mailsNeedingAttachProbe, attachmentStats,
  statsByFolderStore, importOutlookRules,
  // Outlook 잔여 데이터 (범주/플래그/일정/작업/검색폴더) — 읽기 전용 수집분
  saveCategories, listCategoriesDb, applyMailMeta, mailsMissingMeta, markMetaUnreachable, resetMetaUnreachable, flaggedMails,
  saveOutlookSchedules, saveSearchFolders, listSearchFoldersDb, outlookExtrasStats, annotateReplied,
  attachmentRowsWithPath, clearAttachmentPath,
  applyItemStates, diffFolderFingerprints,
  // 메일별 내 처리 상태 (할일/보류/처리/확인)
  setActionState, undoActionState, actionStateCounts, actionMails, actionHintCounts, seedActionFromFlags,
  actionSourceCounts, clearAutoActionStates,
  addSchedule, updateSchedule, setScheduleDone, deleteSchedule, scheduleStats,
  syncOutlookFavorites,
  listOrgMap, setOrgMap, removeOrgMap, buildOrgDictionary,
  // 로컬 가상 폴더 / 즐겨찾기 / 읽음 상태 (Outlook 원본 불변)
  listVirtualFolders, createVirtualFolder, renameVirtualFolder, deleteVirtualFolder,
  sortVirtualChildren, moveMailsToVirtual,
  listFavorites, addFavorite, removeFavorite, moveFavorite,
  getFolderOrder, setFolderOrder,
  setReadFlag, markFolderRead, unreadCounts,
  stats, setState, getState,
  get dbPath() { return dbPath; },
  get ftsEnabled() { return ftsEnabled; }
};
