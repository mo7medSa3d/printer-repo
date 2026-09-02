import { z } from "zod";

/**
 * Input size limits for API boundaries.
 *
 * Every one of these fields is written to a PostgreSQL `text` column, which has
 * no inherent length limit. Without an explicit cap, any authenticated (or, for
 * pairing, unauthenticated) caller can store megabyte-long strings as an
 * identifier or a name — a cheap way to bloat the table, the indexes and every
 * subsequent query plan. The caps below are far above any legitimate value
 * while making that abuse impossible.
 *
 * They are deliberately generous so existing valid clients are unaffected:
 * ids and document types are machine-generated and short, names are
 * human-entered, and the payload cap is unchanged (5 MiB, enforced in
 * `payload.ts` and mirrored in the Go agent).
 */

/** Machine-generated identifiers: `printer_...`, `agt_...`, branch ids, etc. */
export const MAX_ID_LENGTH = 128;

/** Human-entered display names. */
export const MAX_NAME_LENGTH = 200;

/** Document type discriminators (`receipt`, `invoice`, …). */
export const MAX_DOCUMENT_TYPE_LENGTH = 64;

/**
 * Idempotency keys. Odoo sends a `uuid4().hex` (32 chars); the cap allows a
 * comfortably longer opaque key without permitting an unbounded one. Note this
 * value is used as part of a UNIQUE index, and PostgreSQL btree entries are
 * limited to ~2704 bytes — an oversized key would fail at INSERT time with an
 * opaque index error instead of a clear 400.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/** Free-form metadata blobs (hostname/os/version reported by an agent). */
export const MAX_METADATA_BYTES = 8 * 1024;

/** A required machine identifier. */
export const idField = () => z.string().min(1).max(MAX_ID_LENGTH);

/** A required human-facing name. */
export const nameField = () => z.string().min(1).max(MAX_NAME_LENGTH);

/** A required document-type discriminator. */
export const documentTypeField = () => z.string().min(1).max(MAX_DOCUMENT_TYPE_LENGTH);

/** An optional idempotency key. */
export const idempotencyKeyField = () =>
  z.string().min(1).max(MAX_IDEMPOTENCY_KEY_LENGTH).optional();

/**
 * A bounded metadata object. Rejects blobs whose serialized form exceeds
 * `MAX_METADATA_BYTES`, checked after parsing so the limit applies to what
 * actually gets stored rather than to the raw request encoding.
 */
export const metadataField = () =>
  z
    .record(z.string(), z.unknown())
    .refine(
      (v) => Buffer.byteLength(JSON.stringify(v), "utf8") <= MAX_METADATA_BYTES,
      { message: `metadata must serialize to at most ${MAX_METADATA_BYTES} bytes` }
    )
    .optional();
