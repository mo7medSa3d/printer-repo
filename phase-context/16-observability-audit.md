# Phase 16 Context
Implemented: durable audit_events table + sanitized writeAuditEvent helper; login and key/printer/admin paths can emit durable events.
Metrics remain tenant-global for platform operations; tenant-scoped application authorization is separate.
