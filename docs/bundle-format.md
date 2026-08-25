# Repro Bundle Format Specification

**Version:** 1
**Status:** Stable

This document describes the `.repro` portable bundle format. A bundle packages a complete reproduction — trace, metadata, assertions, and blobs — into a single file that can be transferred between machines, repositories, and CI systems.

## File Format

A `.repro` file is a **gzip-compressed JSON** document.

```
file.repro = gzip(JSON.stringify(bundle))
```

The JSON payload uses deterministic key ordering (sorted lexicographically at every nesting level) so that the same logical content always produces the same JSON string.

## Schema

```json
{
  "version": 1,
  "generator": "repro-md",
  "generatorVersion": "0.1.2",
  "id": "r-a1b2c3",
  "created": "2026-08-25T10:00:00.000Z",
  "checksum": "<sha256>",
  "meta": { ... },
  "trace": [ ... ],
  "assertions": [ ... ] | null,
  "blobs": { "<sha256>": "<content>" },
  "integrity": { "<component>": "<sha256>" }
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | `number` | Bundle format version. Must be `1`. |
| `generator` | `string` | Tool that created the bundle. `"repro-md"` for this project. |
| `generatorVersion` | `string` | Semver of the generator. |
| `id` | `string` | Reproduction ID. Format: `r-` followed by 6 hex characters. |
| `created` | `string` | ISO 8601 timestamp of bundle creation. |
| `checksum` | `string` | SHA-256 of the canonical JSON with `checksum` set to `""`. |
| `meta` | `object` | Reproduction metadata (see below). |
| `trace` | `array` | Ordered array of trace events (see below). |
| `assertions` | `array\|null` | Array of assertion definitions, or `null` if none. |
| `blobs` | `object` | Map of SHA-256 hash → string content for externalized data. |
| `integrity` | `object` | Map of component name → SHA-256 hash for integrity verification. |

### Meta Object

The meta object describes the recorded session:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Reproduction ID |
| `command` | `string[]` | yes | The command that was recorded |
| `startTime` | `string` | yes | ISO 8601 start timestamp |
| `endTime` | `string` | no | ISO 8601 end timestamp |
| `eventCount` | `number` | yes | Number of trace events |
| `commit` | `string` | no | Git commit SHA at recording time |
| `env` | `object` | no | Environment variables (REPRO_* only) |
| `model` | `string` | no | Model name used during recording |
| `auth` | `string` | no | Auth mode: `"plan"` or `"credits"` |

The `cwd` field from the original recording is **stripped** during export — absolute filesystem paths are machine-specific and should not be included in portable bundles.

### Trace Events

Each event in the `trace` array has this structure:

```json
{
  "seq": 0,
  "type": "model.request",
  "timestamp": "2026-08-25T10:00:00.000Z",
  "data": { ... }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `seq` | `number` | Sequence number, starting at 0 |
| `type` | `string` | Event type (see below) |
| `timestamp` | `string` | ISO 8601 timestamp |
| `data` | `object` | Event-specific payload |

#### Event Types

| Type | Description |
|------|-------------|
| `process.start` | Agent process started |
| `process.exit` | Agent process exited |
| `model.request` | API request to the model |
| `model.response` | API response from the model |

### Assertions

Each assertion has:

```json
{
  "type": "forbidden_path",
  "args": { "pattern": "src/gen/**" }
}
```

| Type | Args | Description |
|------|------|-------------|
| `forbidden_path` | `{ pattern: string }` | Fail if any tool call touches a matching path |
| `no_repeat` | `{ max: number }` | Fail if same tool call repeats more than N times |
| `max_calls` | `{ max: number }` | Fail if total model API calls exceed N |
| `command` | `{ command: string }` | Run shell command after replay; non-zero = failure |

### Blob Addressing

Large data (>10KB by default) is externalized into the blob store during recording. In the trace JSON, a blob reference looks like:

```
"blob:sha256-<64-char-hex-hash>"
```

In the bundle, blobs are stored in the `blobs` object keyed by their SHA-256 hash:

```json
{
  "blobs": {
    "a1b2c3...": "content string"
  }
}
```

**Invariant:** The key of each blob entry MUST equal the SHA-256 hash of its content string. This is verified on import.

## Integrity

### Component Hashes

The `integrity` object maps component names to SHA-256 hashes of their canonical JSON representation:

| Key | Value |
|-----|-------|
| `meta` | `sha256(stableStringify(meta))` |
| `trace` | `sha256(stableStringify(trace))` |
| `assertions` | `sha256(stableStringify(assertions))` (omitted when null) |
| `blob:<hash>` | `sha256(blobContent)` (one entry per blob) |

### Bundle Checksum

The top-level `checksum` is computed as:

1. Set `checksum` to `""` (empty string)
2. Compute `sha256(stableStringify(bundle))`
3. Store the result as `checksum`

Where `stableStringify` sorts object keys lexicographically at every depth.

### Verification Order

On import, verification proceeds:

1. Decompress gzip
2. Parse JSON
3. Validate version
4. Verify checksum (tamper detection)
5. Verify component integrity hashes (corruption detection)
6. Verify blob content-addressing (key == sha256(content))
7. Verify all blob references in trace have corresponding entries
8. Run security scan on content

If any step fails, the bundle is rejected with a specific error code.

## Error Codes

| Code | Meaning |
|------|---------|
| `INVALID_STRUCTURE` | Not a JSON object |
| `MISSING_VERSION` | No `version` field |
| `VERSION_MISMATCH` | Unsupported version number |
| `MISSING_ID` | No `id` field |
| `MISSING_CHECKSUM` | No `checksum` field |
| `MISSING_META` | No `meta` field |
| `MISSING_TRACE` | No `trace` field |
| `MISSING_INTEGRITY` | No `integrity` field |
| `CHECKSUM_MISMATCH` | Checksum verification failed |
| `INTEGRITY_META` | Meta hash mismatch |
| `INTEGRITY_TRACE` | Trace hash mismatch |
| `INTEGRITY_ASSERTIONS` | Assertions hash mismatch |
| `INTEGRITY_BLOB` | Blob integrity hash mismatch |
| `BLOB_HASH_MISMATCH` | Blob content doesn't match its content-address key |
| `MISSING_BLOB` | Trace references a blob not present in the bundle |

## Security

Bundles may contain sensitive information from the recorded session. The security model:

1. **Recording-time redaction:** Secrets are redacted when the trace is first recorded (API keys, env vars, auth headers, PEM blocks).

2. **Export-time scanning:** The export process scans all content for:
   - Unredacted secret patterns (high severity)
   - Absolute filesystem paths (medium severity)
   - Existing redaction markers (low severity, informational)

3. **Import-time validation:** Imported bundles go through the same structural and integrity checks.

4. **Path sanitization:** The `meta.cwd` field is removed during export.

Use `repro export <id> --check` to run the security scan without creating a bundle.

## ID Collision Policy

On import:
- If no reproduction with the same ID exists, the original ID is preserved.
- If a collision exists, a new random ID is generated (`r-` + 6 hex chars).
- Existing reproductions are never overwritten.

## Versioning

The `version` field follows integer versioning:
- **Version 1:** Current and only version.
- Future versions will increment the number.
- A tool should reject bundles with a version higher than it supports.
- Backwards compatibility: future tools may accept version 1 bundles.

## Generating Bundles Without repro

Another tool can generate a compatible `.repro` bundle by:

1. Constructing the JSON object per this schema
2. Computing integrity hashes with `stableStringify` (sorted keys at every depth)
3. Computing the checksum with `checksum` set to `""`
4. Serializing with `stableStringify`
5. Gzip compressing the result

The `generator` field should be set to identify the producing tool. The `generatorVersion` field tracks its version. The `version` field must be `1`.

Blob content-addressing uses SHA-256 of the raw string content (`createHash("sha256").update(content).digest("hex")`).
