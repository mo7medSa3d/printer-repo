# Deployment Stamps

A deployment stamp is a logical runtime/data-plane placement. The control plane maps `tenant_id -> deployment_id`.

### Standard
Shared stamp, shared PostgreSQL/runtime capacity, per-tenant quotas.

### Business
Shared stamp with stricter quotas/fairness and stronger observability.

### Enterprise
Dedicated runtime/database/storage can be assigned through the same mapping.

This repository currently establishes the domain/session isolation needed for that routing model but does not provision cloud stamps automatically. That automation belongs in infrastructure/provisioning work, not inside printer routing code.
