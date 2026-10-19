CREATE TABLE mcp_event_subscriptions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    event_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    callback_url TEXT NOT NULL,
    signing_secret TEXT NOT NULL,
    previous_signing_secret TEXT,
    previous_secret_until TEXT,
    expires_at TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    verified_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX mcp_event_subscriptions_active
ON mcp_event_subscriptions (event_name, active, expires_at);

CREATE TABLE mcp_event_deliveries (
    subscription_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_http_status INTEGER,
    last_error TEXT,
    claimed_at TEXT,
    accepted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (subscription_id, event_id)
);

CREATE INDEX mcp_event_deliveries_due
ON mcp_event_deliveries (status, next_attempt_at);
