# Network Printer Discovery

Agent-side discovery that respects `Branch → Agent → Printer` ownership.

## Architecture
```
Manager → POST /api/agents/:id/discovery → discovery_sessions (branch via agent)
Agent poll → GET /api/agent/discovery → Discover (spooler, network, IPP, mDNS, SNMP, LPR, WSD, USB)
Agent report → POST /api/agent/discovery {discoveryId, devices[]}
Manager list → GET /api/agents/:id/discovery/:discoveryId
Manager provision → POST /api/agents/:id/discovered-printers/:deviceId/provision → printers (via agentId)
```
Ownership never bypasses Agent; `discovered_devices.branch_id` is derived from `agents.branch_id`.

## Protocol matrix

| Discovery | Implemented | Verified meaning | Platform | Notes |
|---|---|---|---|---|
| mDNS/DNS-SD `_ipp._tcp,_ipps._tcp,_printer._tcp` | yes | TXT+SRV+ A present | all (UDP 224.0.0.251:5353) | Verified only if TXT contains printer hints; candidate otherwise |
| IPP/IPPS | yes | `Get-Printer-Attributes` succeeds (IPP 0x0000) | all | TCP 631 scan + verification; IPPS validates TLS (no InsecureSkipVerify) |
| RAW 9100 | yes | TCP connect → open | all | Candidate (low confidence) unless IPP/SNMP also matches; never sends bytes |
| LPR/LPD 515 | yes | `\x04queue\n` → `\x00` ack | all | Verified only on LPD ack |
| SNMP | yes | `sysDescr` contains printer tokens (read-only public community) | all | Verified if sysDescr matches printer heuristic; no credentials guessed |
| WSD | yes | SOAP Probe to 239.255.255.250:3702 returns PrintDeviceType | all (best on Windows) | Verified only on printer device type |
| Windows Spooler | yes | `EnumPrintersW` + `IsValidSpoolerPrinter` | Windows | Verified queue; virtual/redirected filtered via classifier |
| USB | yes | `SetupDi` enumeration (vid/pid/serial) | Windows (stub elsewhere) | Agent-local, never network |
| Subnet scan | yes | private /16-/30 derived from local interfaces | all | Bounded 32 workers, 500ms per host, 8s global; no public scan |

PCL is **not** a discovery protocol — never advertised.

## Safety
- Private CIDR only (`10/8`, `172.16/12`, `192.168/16`), /16-/30, no loopback/public.
- No test-page printing during discovery.
- SNMP read-only `public` only, no brute-force.
- Bounded concurrency (32), per-host 500-1500ms, global 30s, cancellation via `cancel` endpoint.
- Deduplication deterministic: UUID → serial+model → MAC → IP:port → spooler name.

## Confidence
- HIGH: verified IPP/IPPS/spooler + model, or ≥2 sources + model
- MEDIUM: verified or ≥2 sources or model
- LOW: single open port candidate

## Lifecycle
`running → completed|partial|failed|cancelled` (partial = some detectors failed but results exist). Candidates TTL via `discovered_devices.candidate_status` (`discovered|verified|provisioned|ignored|expired`), provisioned history preserved.

## Rate limiting
One active discovery per Agent; concurrent start returns 409 with existing `discoveryId`.

## Limitations (honest)
- mDNS parser is heuristic without `grandcat/zeroconf` (no TXT SRV full decode) — finds candidates but may miss some TXT fields.
- SNMP uses only `public` v1/v2c read-only; v3 not implemented (requires credential management).
- WSD parser is minimal SOAP Probe; full WSD metadata not decoded.
- USB on non-Windows is stub (requires SetupDi).
- IPv6 link-local scope handling minimal; primary path is IPv4 private.

See `agent/internal/printer/discovery*.go` for orchestrator and per-protocol detectors.
