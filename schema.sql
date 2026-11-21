-- Squawk D1 schema
DROP TABLE IF EXISTS work_orders;
DROP TABLE IF EXISTS flights;
DROP TABLE IF EXISTS aircraft;

CREATE TABLE aircraft (
  id TEXT PRIMARY KEY,           -- e.g. "SQK-04"
  name TEXT NOT NULL,            -- display name / tail
  model TEXT NOT NULL,
  role TEXT,                     -- "repair-case" | "healthy" | "customer"
  source_note TEXT,              -- where the data came from (e.g. NGAFID event + label)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE flights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aircraft_id TEXT NOT NULL REFERENCES aircraft(id),
  seq INTEGER NOT NULL,           -- order of the flight in this aircraft's history
  flown_at TEXT,                  -- label shown in UI
  features TEXT NOT NULL,         -- JSON from engine.computeFeatures
  is_future INTEGER DEFAULT 0,    -- 1 = flight after the real repair (hidden from scoring, shown with "what happened next")
  source TEXT,                    -- "ngafid" | "upload" | "sample"
  ngafid_index INTEGER,           -- NGAFID Master Index
  ngafid_before_after TEXT,       -- before | same | after
  ngafid_date_diff INTEGER,       -- days relative to the maintenance event
  ngafid_label TEXT,              -- real maintenance issue recorded for this event
  r2_key TEXT,                    -- raw CSV in R2 (uploads)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_flights_aircraft ON flights(aircraft_id, seq);

CREATE TABLE work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aircraft_id TEXT NOT NULL REFERENCES aircraft(id),
  status TEXT DEFAULT 'open',     -- open | in_progress | done
  risk_status TEXT,               -- red | yellow | green at creation
  risk_score REAL,
  diagnosis TEXT NOT NULL,        -- JSON from ai.diagnose
  findings TEXT NOT NULL,         -- JSON snapshot of findings used
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_wo_aircraft ON work_orders(aircraft_id, created_at);
