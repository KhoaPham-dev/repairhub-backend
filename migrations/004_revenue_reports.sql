CREATE TABLE IF NOT EXISTS revenue_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  file_path     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  error         TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL
);
