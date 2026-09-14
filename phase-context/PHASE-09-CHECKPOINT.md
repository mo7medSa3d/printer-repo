# Phase 09 - WebSocket / Delivery Fabric

## Verification
- Investigated `src/server/ws.ts` for WebSocket implementation details.
- Verified connections cap to avoid memory exhaustion (max 8 connections per agent).
- Verified memory shedding (when cap is hit, older sockets are shed/terminated, allowing the newest valid connection to stay open).
- Validated backpressure controls via buffer size limitation (`MAX_WS_BUFFERED_BYTES`).
- Evaluated WebSocket routing payload tracking bounds. Multi-instance scaling relies on the DB for queuing so cross-node delivery conflicts are correctly gated by Postgres locks/fencing.

## Findings
- WebSocket delivery fabric is robust, handles concurrency correctly, correctly respects caps and limits.
- The `ws-socket-cap.test.ts` test was successful during Phase 02/08 verification runs.
