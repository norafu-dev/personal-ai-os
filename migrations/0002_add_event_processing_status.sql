ALTER TABLE webhook_events
ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE webhook_events
ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE webhook_events
ADD COLUMN last_error TEXT;

ALTER TABLE webhook_events
ADD COLUMN processed_at TEXT;