-- ============================================
-- Sound Capsule LAN - 精简数据库 Schema
-- 仅保留本地胶囊 + 局域网点对点收发所需字段
-- ============================================

CREATE TABLE IF NOT EXISTS capsules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    project_name TEXT,
    capsule_type TEXT DEFAULT 'reaper',
    file_path TEXT NOT NULL,         -- 胶囊根目录（相对 data/capsules/<uuid>/）
    preview_audio TEXT,              -- 预览音频相对路径
    rpp_file TEXT,                   -- Reaper 工程相对路径
    keywords TEXT,
    description TEXT,
    source_peer TEXT,                -- 接收来源（NULL = 本机生成）
    size_bytes INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_capsules_created_at ON capsules(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_capsules_name ON capsules(name);

-- 语义标签（可选，先建表，UI 可不展示）
CREATE TABLE IF NOT EXISTS capsule_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capsule_id INTEGER NOT NULL,
    lens TEXT NOT NULL,
    word_id TEXT,
    word_cn TEXT,
    word_en TEXT,
    x REAL,
    y REAL,
    FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_capsule_tags_cid ON capsule_tags(capsule_id);

-- 技术元信息
CREATE TABLE IF NOT EXISTS capsule_metadata (
    capsule_id INTEGER PRIMARY KEY,
    bpm REAL,
    duration REAL,
    sample_rate INTEGER,
    plugin_count INTEGER,
    plugin_list TEXT,
    has_sends INTEGER,
    has_folder_bus INTEGER,
    tracks_included INTEGER,
    FOREIGN KEY (capsule_id) REFERENCES capsules(id) ON DELETE CASCADE
);

-- 联系人（局域网内别的设备）
CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 5005,
    note TEXT,
    last_seen TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ip, port)
);

CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

-- 传输历史（可选，便于 UI 展示发送/接收记录）
CREATE TABLE IF NOT EXISTS transfers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capsule_id INTEGER,
    direction TEXT NOT NULL,          -- 'send' | 'receive'
    peer_ip TEXT,
    peer_port INTEGER,
    peer_name TEXT,
    capsule_name TEXT,
    status TEXT NOT NULL,             -- 'pending' | 'success' | 'failed'
    error TEXT,
    bytes_total INTEGER DEFAULT 0,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transfers_started ON transfers(started_at DESC);
