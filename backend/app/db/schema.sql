PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. 系统设置
CREATE TABLE IF NOT EXISTS sys_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 改密记录
CREATE TABLE IF NOT EXISTS password_reset_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action     TEXT NOT NULL,
  result     TEXT NOT NULL,
  detail     TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. 项目档案
CREATE TABLE IF NOT EXISTS project (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  client_name   TEXT,
  location      TEXT,
  manager       TEXT,
  start_date    TEXT,
  status        TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing','finished')),
  client_budget NUMERIC(14,2) NOT NULL DEFAULT 0,
  cost_budget   NUMERIC(14,2) NOT NULL DEFAULT 0,
  members       TEXT,
  remark        TEXT,
  unlocked_at   TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_project_deleted ON project(deleted);
CREATE INDEX IF NOT EXISTS idx_project_status  ON project(status);

-- 4. 成本主表（五类）
CREATE TABLE IF NOT EXISTS cost (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id),
  type       TEXT NOT NULL CHECK (type IN ('labor','material','machine','misc','advance')),
  category   TEXT,                       -- 仅杂费使用：杂费小类
  amount     NUMERIC(14,2) NOT NULL,
  biz_date   TEXT NOT NULL,
  partner    TEXT,
  remark     TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cost_project ON cost(project_id, biz_date);
CREATE INDEX IF NOT EXISTS idx_cost_type    ON cost(type);
CREATE INDEX IF NOT EXISTS idx_cost_deleted ON cost(deleted);

-- 5. 工天明细
CREATE TABLE IF NOT EXISTS labor_work (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  cost_id     INTEGER NOT NULL UNIQUE REFERENCES cost(id),
  worker_name TEXT NOT NULL,
  work_days   NUMERIC(8,2) NOT NULL,
  day_rate    NUMERIC(14,2) NOT NULL,
  remark      TEXT
);
CREATE INDEX IF NOT EXISTS idx_labor_worker ON labor_work(worker_name);

-- 6. 材料采购明细
CREATE TABLE IF NOT EXISTS material_item (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cost_id           INTEGER NOT NULL UNIQUE REFERENCES cost(id),
  material_name     TEXT NOT NULL,
  unit              TEXT NOT NULL,
  quantity          NUMERIC(12,3) NOT NULL,
  unit_price        NUMERIC(14,2) NOT NULL,
  supplier          TEXT,
  inventory_txn_id  INTEGER REFERENCES inventory_txn(id)
);

-- 7. 机械明细
CREATE TABLE IF NOT EXISTS machine_item (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cost_id      INTEGER NOT NULL UNIQUE REFERENCES cost(id),
  machine_name TEXT NOT NULL,
  measure      TEXT NOT NULL CHECK (measure IN ('shift','hour')),
  quantity     NUMERIC(12,2) NOT NULL,
  unit_price   NUMERIC(14,2) NOT NULL,
  lessor       TEXT
);

-- 8. 垫付明细
CREATE TABLE IF NOT EXISTS advance_item (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  cost_id  INTEGER NOT NULL UNIQUE REFERENCES cost(id),
  payer    TEXT,
  purpose  TEXT
);

-- 9. 资金流水
CREATE TABLE IF NOT EXISTS funds_flow (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id),
  direction  TEXT NOT NULL CHECK (direction IN ('in','out')),
  biz_type   TEXT NOT NULL CHECK (biz_type IN
               ('progress','settle','advance','material','labor','machine','misc','advance_pay','other')),
  amount     NUMERIC(14,2) NOT NULL,
  biz_date   TEXT NOT NULL,
  partner    TEXT,
  pay_method TEXT CHECK (pay_method IN ('cash','wechat','bank_card','transfer')),
  remark     TEXT,
  deleted    INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_funds_project ON funds_flow(project_id, biz_date);
CREATE INDEX IF NOT EXISTS idx_funds_dir     ON funds_flow(direction);

-- 10. 应收应付单
CREATE TABLE IF NOT EXISTS ar_ap (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES project(id),
  type           TEXT NOT NULL CHECK (type IN ('receivable','payable')),
  biz_type       TEXT NOT NULL,
  amount         NUMERIC(14,2) NOT NULL,
  settled_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','closed')),
  biz_date       TEXT NOT NULL,
  partner        TEXT,
  cost_id        INTEGER REFERENCES cost(id),
  remark         TEXT,
  deleted        INTEGER NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_arap_project ON ar_ap(project_id, type, status);
CREATE INDEX IF NOT EXISTS idx_arap_date    ON ar_ap(biz_date);

-- 11. 冲销记录
CREATE TABLE IF NOT EXISTS ar_ap_offset (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ar_ap_id       INTEGER NOT NULL REFERENCES ar_ap(id),
  funds_flow_id  INTEGER NOT NULL REFERENCES funds_flow(id),
  amount         NUMERIC(14,2) NOT NULL,
  offset_date    TEXT NOT NULL,
  remark         TEXT,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_offset_arap ON ar_ap_offset(ar_ap_id);
CREATE INDEX IF NOT EXISTS idx_offset_flow ON ar_ap_offset(funds_flow_id);

-- 12. 库存余量
CREATE TABLE IF NOT EXISTS inventory (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES project(id),
  material_name TEXT NOT NULL,
  unit          TEXT NOT NULL,
  in_qty        NUMERIC(12,3) NOT NULL DEFAULT 0,
  out_qty       NUMERIC(12,3) NOT NULL DEFAULT 0,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_inv ON inventory(project_id, material_name, unit);

-- 13. 库存流水
CREATE TABLE IF NOT EXISTS inventory_txn (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES project(id),
  material_name TEXT NOT NULL,
  unit          TEXT NOT NULL,
  txn_type      TEXT NOT NULL CHECK (txn_type IN ('in','out')),
  quantity      NUMERIC(12,3) NOT NULL,
  unit_price    NUMERIC(14,2),
  supplier      TEXT,
  cost_id       INTEGER REFERENCES cost(id),
  biz_date      TEXT NOT NULL,
  remark        TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invtxn_project ON inventory_txn(project_id, material_name, biz_date);

-- 14. 结算单（原「人工结算单」，2026-10-16 起支持五类成本结算）
--     cost_type：labor / material / machine / misc / advance（旧数据迁移为 labor）
--     partner  ：该类别的汇总依据值——人工=姓名、材料=供应商、机械=出租方、杂费=小类、垫付=垫付人；
--                对方没填时统一存 '（未填对方）'
CREATE TABLE IF NOT EXISTS labor_settle (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES project(id),
  worker_name TEXT NOT NULL,
  cost_type   TEXT NOT NULL DEFAULT 'labor',
  partner     TEXT,
  total_days  NUMERIC(8,2) NOT NULL,
  amount_due  NUMERIC(14,2) NOT NULL,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','partial','paid')),
  settle_date TEXT,
  pay_date    TEXT,
  pay_method  TEXT,
  remark      TEXT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- 旧库已有 uk_settle(project_id, worker_name)，这里补一个按「类别 + 对方」的唯一索引：
-- 同一项目下，同一类别、同一个对象只允许一张结算单（重复生成时覆盖未发放部分）
CREATE UNIQUE INDEX IF NOT EXISTS uk_settle_type_partner ON labor_settle(project_id, cost_type, partner);
CREATE UNIQUE INDEX IF NOT EXISTS uk_settle ON labor_settle(project_id, worker_name);

-- 15. 数据字典
CREATE TABLE IF NOT EXISTS dict_item (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  dict_type TEXT NOT NULL CHECK (dict_type IN ('misc_category','material','unit','partner')),
  name      TEXT NOT NULL,
  sort_no   INTEGER NOT NULL DEFAULT 0,
  enabled   INTEGER NOT NULL DEFAULT 1,
  remark    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_dict ON dict_item(dict_type, name);

-- 16. 变更日志
CREATE TABLE IF NOT EXISTS change_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name  TEXT NOT NULL,
  record_id   INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('create','update','delete')),
  before_json TEXT,
  after_json  TEXT,
  operator    TEXT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_log ON change_log(table_name, record_id);
