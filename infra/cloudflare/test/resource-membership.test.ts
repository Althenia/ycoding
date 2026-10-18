import { expect, test } from "bun:test"
import path from "node:path"
import { defaultBudgets } from "../../../packages/protocol/src/v5/connection"
import { RelayLimits, RemoteLimits } from "../../../packages/remote/src/index"

const root = path.resolve(import.meta.dir, "../../..")
const protocol = "rust/crates/protocol/tests/"
const store = "rust/crates/store/"
const boundary = (file: string, name: string) => ({ file, name })
const wireBytes = boundary(protocol + "wire_conformance.rs", "byte_count_and_frame_budgets")
const wireHeaders = boundary(protocol + "wire_conformance.rs", "early_class_budgets_and_bulk_headers")
const handshake = boundary(protocol + "wire_conformance.rs", "handshake_identity_windows_and_timeout")
const collection = boundary(protocol + "wire_conformance.rs", "canonical_control_collection_limits")
const tiny = boundary(protocol + "connection.rs", "ac_wire_008_tiny_rate_count_byte_and_ordinal_violations_close")
const occupancy = boundary(
  protocol + "connection.rs",
  "reviewed_tiny_byte_occupancy_and_relay_peer_union_bounds_reject_one_past",
)
const rates = boundary(protocol + "connection.rs", "reviewed_normal_rates_enforce_sender_role_and_exact_rolling_window")
const queue = boundary(
  protocol + "connection.rs",
  "parity_oversize_invalidation_closes_with_limit_when_normal_admission_cannot_fit",
)
const hydration = boundary(
  protocol + "connection.rs",
  "ac_wire_011_hydration_overflow_requires_canonical_reload_before_live_delivery",
)
const windows = boundary(
  protocol + "connection.rs",
  "ac_wire_008_negotiated_window_reserves_headers_before_exact_handoff_charge",
)
const disposal = boundary(
  protocol + "connection.rs",
  "every_handed_ledger_class_stays_charged_until_terminal_disposal_without_refunding_other_owners",
)
const coalescing = boundary(
  protocol + "connection.rs",
  "ac_wire_008_event_coalescing_has_caller_timed_interactive_and_background_bounds",
)
const uploads = "rust/crates/runtime/src/session_attachment_upload.rs"
const uploadSize = boundary(uploads, "connections_hold_at_most_sixty_four_uploads_and_forty_mebibytes")
const uploadTime = boundary(uploads, "idle_uploads_expire_after_ten_minutes_and_resolution_renews_them")
const native = boundary(
  store + "src/analytics/tests.rs",
  "native_configuration_locks_selected_bounds_and_rejects_one_past",
)
const report = boundary(
  store + "tests/analytics.rs",
  "reviewed_report_count_sql_parameter_row_column_and_output_bounds",
)
const sourceConfiguration = boundary(
  store + "tests/analytics.rs",
  "reviewed_analytics_source_column_and_identifier_configuration_bounds",
)
const push = boundary(
  "infra/cloudflare/test/relay-core.test.ts",
  "reviewed push count window and asynchronous reservation ownership remain bounded",
)
const peerCount = boundary(
  "infra/cloudflare/test/relay-core.test.ts",
  "reviewed relay peer count and metadata reservations reject the sixty-fifth browser",
)
const ownerOptions = boundary(
  "rust/crates/core/tests/resource_bounds.rs",
  "canonical_owner_limits_match_the_selected_core_and_meeting_budgets",
)
const writer = boundary(
  store + "tests/durable_store.rs",
  "selected_writer_queue_and_snapshot_bounds_reject_one_past_capacity",
)
const aggregate = boundary(
  "infra/cloudflare/test/relay-core.test.ts",
  "aggregate reservation caps retained input and every socket-handed fanout frame before per-peer windows exhaust",
)
const http = boundary("infra/cloudflare/test/integration/binary-flow.ts", "nativeHttpConsumers")

const wireCoverage = {
  CLIENT_FRAME_BYTES: wireBytes,
  SERVER_FRAME_BYTES: wireBytes,
  HANDSHAKE_BYTES: wireHeaders,
  HANDSHAKE_RETAINED_BYTES: boundary(
    "packages/protocol/test/connection.test.ts",
    "retained handshake reservation is bounded across concurrent pre-decode admissions",
  ),
  HANDSHAKE_TIMEOUT_MS: handshake,
  TINY_FRAME_BYTES: wireHeaders,
  INLINE_BODY_BYTES: wireBytes,
  BULK_PIECE_BYTES: wireBytes,
  BULK_MESSAGE_BYTES: wireHeaders,
  BULK_PIECES: wireHeaders,
  BULK_TRANSFERS: boundary(
    protocol + "connection.rs",
    "bulk_cancel_releases_a_slot_before_the_next_start_and_preserves_the_two_transfer_cap",
  ),
  EVENT_BATCH_COUNT: boundary(
    protocol + "connection.rs",
    "coalescing_individual_event_64_boundary_flushes_and_matches_generated_size",
  ),
  EVENT_BATCH_BYTES: boundary(
    protocol + "connection.rs",
    "coalescing_complete_256_kib_boundary_splits_without_splitting_one_event",
  ),
  VALUE_DEPTH: boundary(protocol + "wire_conformance.rs", "depth_64_decodes_depth_65_rejects_and_field_limit_is_exact"),
  TOTAL_FIELDS: boundary(
    protocol + "wire_conformance.rs",
    "depth_64_decodes_depth_65_rejects_and_field_limit_is_exact",
  ),
  EVENT_QUEUE_COUNT: hydration,
  EVENT_QUEUE_BYTES: boundary(
    protocol + "connection.rs",
    "parity_hydration_byte_overflow_resyncs_or_native_admission_closes_with_limit",
  ),
  EVENT_WINDOW_BYTES: disposal,
  BULK_WINDOW_BYTES: http,
  NORMAL_WINDOW_BYTES: windows,
  NORMAL_QUEUE_BYTES: queue,
  TINY_QUEUE_COUNT: tiny,
  TINY_QUEUE_BYTES: occupancy,
  DELIVERY_TIMEOUT_MS: boundary(
    protocol + "connection.rs",
    "ac_wire_008_ledger_timeout_is_class_local_and_other_connection_progresses",
  ),
  RELAY_PEER_BYTES: boundary(
    protocol + "connection.rs",
    "ac_wire_007_relay_recipient_budget_survives_handoff_and_rejects_overrun",
  ),
  RELAY_RETAINED_BYTES: aggregate,
  RELAY_PEERS: occupancy,
  HTTP_STREAMS: boundary(
    "packages/protocol/test/connection-bulk.test.ts",
    "a new transfer can start after cancelled ownership without exceeding the transfer cap",
  ),
  PENDING_REQUESTS: boundary(
    protocol + "connection.rs",
    "ac_wire_007_pending_cap_is_bounded_without_dropping_existing_work",
  ),
  SUBSCRIPTIONS: occupancy,
  CLIENT_RATE: rates,
  AGENT_RATE: rates,
  RATE_WINDOW_MS: rates,
  TINY_RATE: tiny,
  TINY_RATE_BYTES: tiny,
  UPLOAD_BYTES: uploadSize,
  UPLOAD_RETAINED_BYTES: uploadSize,
  UPLOAD_COUNT: uploadSize,
  UPLOAD_TIMEOUT_MS: uploadTime,
}

const budgetCoverage = {
  clientFrameBytes: wireBytes,
  serverFrameBytes: wireBytes,
  handshakeBytes: wireHeaders,
  handshakeRetainedBytes: wireCoverage.HANDSHAKE_RETAINED_BYTES,
  handshakeTimeoutMs: handshake,
  inlineBytes: wireBytes,
  pieceBytes: wireBytes,
  messageBytes: wireHeaders,
  pieces: wireHeaders,
  transfers: wireCoverage.BULK_TRANSFERS,
  eventBatchCount: wireCoverage.EVENT_BATCH_COUNT,
  eventBatchBytes: wireCoverage.EVENT_BATCH_BYTES,
  eventQueueCount: hydration,
  eventQueueBytes: wireCoverage.EVENT_QUEUE_BYTES,
  eventWindowBytes: disposal,
  bulkWindowBytes: http,
  normalWindowBytes: windows,
  normalQueueBytes: queue,
  tinyFrameBytes: wireHeaders,
  tinyCount: tiny,
  tinyBytes: occupancy,
  deliveryTimeoutMs: wireCoverage.DELIVERY_TIMEOUT_MS,
  relayPeerBytes: wireCoverage.RELAY_PEER_BYTES,
  pendingRequests: wireCoverage.PENDING_REQUESTS,
  subscriptions: occupancy,
  clientRate: rates,
  agentRate: rates,
  rateWindowMs: rates,
  tinyRate: tiny,
  tinyRateBytes: tiny,
  creditBytes: boundary(protocol + "connection.rs", "reviewed_consumption_credit_obeys_byte_threshold_or_exact_delay"),
  creditDelayMs: boundary(
    protocol + "connection.rs",
    "reviewed_consumption_credit_obeys_byte_threshold_or_exact_delay",
  ),
  pingIntervalMs: boundary(
    protocol + "connection.rs",
    "ac_wire_008_responder_idle_heartbeat_confirms_receipts_without_ack_loop",
  ),
  interactiveCoalesceMs: coalescing,
  backgroundCoalesceMs: coalescing,
  eventToBulkRatio: boundary(
    protocol + "connection.rs",
    "ac_wire_008_two_event_batches_to_one_bulk_piece_when_both_wait",
  ),
}

const storeCoverage = {
  "rust/crates/store/src/engine.rs::TRANSACTION_WORK": boundary(
    store + "tests/durable_store.rs",
    "transaction_work_limit_is_atomic_for_point_and_range_operations",
  ),
  "rust/crates/store/src/session/cleanup.rs::CLEANUP_BATCH": boundary(
    store + "tests/session_tables.rs",
    "cleanup_keyset_is_bounded_and_uses_sqlite_binary_tiebreaks",
  ),
  "rust/crates/store/src/backup.rs::BYTE_BUDGET": boundary(
    store + "src/backup.rs",
    "byte_budget_admits_a_row_that_reaches_exactly_the_limit",
  ),
  "rust/crates/store/src/session/cleanup.rs::CLEANUP_ROWS": boundary(
    store + "tests/session_tables.rs",
    "cleanup_rolls_back_and_resumes_from_committed_pages_without_touching_history",
  ),
  "rust/crates/store/src/model_incident/mod.rs::CLEANUP_ROWS": boundary(
    store + "tests/model_incident_tables.rs",
    "expiry_deletes_bounded_batches_strictly_before_the_cutoff_with_their_index_entries",
  ),
  "rust/crates/store/src/upgrade.rs::BATCH": boundary(
    store + "tests/core_upgrade.rs",
    "the_head_predecessor_rewrites_four_layouts_and_preserves_every_other_row",
  ),
  "rust/crates/store/src/backup.rs::HEADROOM_BYTES": boundary(
    store + "tests/history_backup.rs",
    "space_gate_exact_threshold_retry_marker_restore_and_reopen",
  ),
  "rust/crates/store/src/analytics/mod.rs::INTENT_LIMIT": boundary(
    store + "tests/analytics.rs",
    "outage_does_not_block_canonical_and_overflow_recovers_retained_state",
  ),
  "rust/crates/store/src/analytics/mod.rs::INTENT_BYTES": boundary(
    store + "tests/analytics.rs",
    "encoded_intent_budget_accepts_exact_bytes_and_invalidates_one_byte_past",
  ),
  "rust/crates/store/src/analytics/mod.rs::BATCH_SIZE": boundary(
    store + "tests/analytics.rs",
    "watermarked_rebuild_catches_up_delete_and_new_changes",
  ),
  "rust/crates/store/src/analytics/mod.rs::REPORT_DEADLINE": boundary(
    store + "tests/analytics.rs",
    "report_deadline_is_explicit_and_native_work_releases_its_connection",
  ),
  "rust/crates/store/src/analytics/mod.rs::REPORT_STACK_BYTES": boundary(
    store + "tests/report_stack.rs",
    "engine_returns_typed_outcomes_at_the_selected_expression_depth",
  ),
  "rust/crates/store/src/analytics/mod.rs::ROW_BYTES": report,
  "rust/crates/store/src/analytics/mod.rs::REPORT_ROWS": report,
  "rust/crates/store/src/analytics/mod.rs::REPORT_BYTES": report,
}

test("predecessor upgrade bounds both rewrite and backfill before retaining rows", async () => {
  const source = await Bun.file(path.join(root, store + "src/upgrade.rs")).text()
  expect(source).toMatch(/^const\s+BATCH:\s*usize\s*=\s*256\s*;/m)
  // The Rust upgrade suite verifies migration and backup preservation across pages;
  // this source boundary also rejects removing the cap without changing results.
  for (const [name, table] of [
    ["rewrite", "table"],
    ["backfill", "requests"],
  ]) {
    const body = source.match(new RegExp(`^fn ${name}\\([\\s\\S]*?^\\}`, "m"))?.[0]
    expect(body, name).toBeDefined()
    const batch = body?.match(/let\s+batch\s*=\s*([\s\S]*?)\.collect::<Result<Vec<_>,\s*Error>>\(\)\?;/)?.[1]
    expect(batch, `${name}: retained batch`).toBeDefined()
    expect(
      batch?.replace(/\s+/g, "").startsWith(
        `${table}.range::<&[u8]>((after.as_deref().map_or(Bound::Unbounded,Bound::Excluded),Bound::Unbounded,))?` +
          ".take(BATCH).map(|entry|{",
      ),
      `${name}: bound the keyset iterator before copying rows`,
    ).toBe(true)
  }
})

test("TEST-055 every declared resource limit has a reviewed enforcement boundary", async () => {
  const read = (file: string) => Bun.file(path.join(root, file)).text()
  const check = async (label: string, discovered: string[], reviewed: Record<string, ReturnType<typeof boundary>>) => {
    expect(discovered.length, label).toBeGreaterThan(0)
    expect([...discovered].sort(), `${label}: review new limits and name their enforcing boundary`).toEqual(
      Object.keys(reviewed).sort(),
    )
    for (const [member, target] of Object.entries(reviewed)) {
      const source = await read(target.file)
      const rust = target.file.endsWith(".rs")
      expect(
        source.includes(rust ? `fn ${target.name}(` : target.name),
        `${label}.${member}: ${target.file}::${target.name}`,
      ).toBe(true)
    }
  }
  const foundation = await read("protocol/ycoding/v5/foundation.proto")
  const owners: string[] = []
  for await (const file of new Bun.Glob("protocol/ycoding/v5/*.proto").scan({ cwd: root }))
    if (/enum \w*Limit\s*\{/.test(await read(file))) owners.push(file)
  expect(owners).toEqual(["protocol/ycoding/v5/foundation.proto"])
  const enums = [...foundation.matchAll(/enum (\w*Limit)\s*\{([^}]+)\}/g)]
  expect(enums.map((item) => item[1]).sort()).toEqual(["CodePointLimit", "CollectionLimit", "WireLimit"])
  for (const item of enums) {
    const members = [...item[2]!.matchAll(/^\s*([A-Z][A-Z_0-9]*)\s*=\s*\d+;/gm)]
      .map((entry) => entry[1]!)
      .filter((name) => name !== "REVISION")
    await check(
      item[1]!,
      members,
      item[1] === "WireLimit"
        ? wireCoverage
        : item[1] === "CollectionLimit"
          ? {
              STATUS_RUNNING_MAX_COUNT: collection,
              STATUS_ATTENTION_MAX_COUNT: collection,
              STATUS_OUTSTANDING_MAX_COUNT: collection,
              STATUS_FAILED_MAX_COUNT: collection,
              STATUS_DETAILS_MAX_COUNT: collection,
              STATUS_LOST_MAX_COUNT: collection,
              COMPLETIONS_ITEMS_MAX_COUNT: collection,
              SUBSCRIPTION_SNAPSHOT_SESSION_IDS_MAX_COUNT: collection,
              NOTICES_ADDED_NOTICES_MAX_COUNT: collection,
              NOTICES_REMOVED_IDS_MAX_COUNT: collection,
              NOTICES_PRESENT_ITEMS_MAX_COUNT: collection,
            }
          : {
              ATTENTION_DETAIL_TITLE_MAX_CODEPOINTS: boundary(
                protocol + "wire_conformance.rs",
                "title_codepoints_lossless_whitespace_controls_and_bidi",
              ),
              ALERT_DETAIL_TITLE_MAX_CODEPOINTS: boundary(
                protocol + "wire_conformance.rs",
                "title_codepoints_lossless_whitespace_controls_and_bidi",
              ),
              BLOCKED_TITLE_MAX_CODEPOINTS: boundary(
                protocol + "wire_conformance.rs",
                "title_codepoints_lossless_whitespace_controls_and_bidi",
              ),
              COMPLETION_TITLE_MAX_CODEPOINTS: boundary(
                protocol + "wire_conformance.rs",
                "title_codepoints_lossless_whitespace_controls_and_bidi",
              ),
            },
    )
  }
  await check("defaultBudgets", Object.keys(defaultBudgets), budgetCoverage)
  const rustBudgets = await read("rust/crates/protocol/src/connection/budgets.rs")
  const rustNames = [...rustBudgets.matchAll(/pub (\w+): (?:usize|u64),/g)].map((item) => item[1]!)
  await check("Budgets", rustNames, {
    event_queue_count: hydration,
    event_queue_bytes: wireCoverage.EVENT_QUEUE_BYTES,
    event_window_bytes: disposal,
    bulk_window_bytes: http,
    normal_window_bytes: windows,
    normal_queue_bytes: queue,
    tiny_queue_count: tiny,
    tiny_queue_bytes: occupancy,
    delivery_timeout_ms: wireCoverage.DELIVERY_TIMEOUT_MS,
    relay_peer_bytes: wireCoverage.RELAY_PEER_BYTES,
    client_rate: rates,
    agent_rate: rates,
    rate_window_ms: rates,
    tiny_rate: tiny,
    tiny_rate_bytes: tiny,
    credit_bytes: budgetCoverage.creditBytes,
    credit_delay_ms: budgetCoverage.creditDelayMs,
    ping_interval_ms: budgetCoverage.pingIntervalMs,
    interactive_coalesce_ms: coalescing,
    background_coalesce_ms: coalescing,
  })
  const declared: string[] = []
  for await (const file of new Bun.Glob("rust/crates/store/src/**/*.rs").scan({ cwd: root })) {
    if (file.endsWith("/tests.rs")) continue
    const source = await read(file)
    for (const item of source.matchAll(/\bconst ([A-Z][A-Z_0-9]*): (?:usize|u64|u32|Duration) = [^;]+;/g)) {
      if (["RECORD_CODEC_VERSION", "KEY_CODEC_VERSION"].includes(item[1]!)) continue
      declared.push(`${file}::${item[1]}`)
    }
  }
  await check("Store constants", declared, storeCoverage)
  const protocolConstants: string[] = []
  for await (const file of new Bun.Glob("rust/crates/protocol/src/**/*.rs").scan({ cwd: root })) {
    if (file.endsWith("/tests.rs")) continue
    protocolConstants.push(
      ...[...(await read(file)).matchAll(/\bconst ([A-Z][A-Z_0-9]*): (?:usize|u\d+|Duration) = [^;]+;/g)].map(
        (item) => `${file}::${item[1]}`,
      ),
    )
  }
  expect(protocolConstants, "review new protocol resource constants alongside WireLimit and Budgets").toEqual([])
  const protocolGuards: string[] = []
  for await (const file of new Bun.Glob("rust/crates/protocol/src/**/*.rs").scan({ cwd: root })) {
    if (file.endsWith("/tests.rs")) continue
    protocolGuards.push(
      ...[
        ...(await read(file)).matchAll(
          /([.\w]+(?:\.len\(\))?)\s*(>=|>|<=|<)\s*(\d[\d_]*(?:\s*\*\s*\d[\d_]*)*)(?![\w])/g,
        ),
      ].map((item) => `${file}::${item[0].replace(/\s+/g, " ")}`),
    )
  }
  const structuralGuards = [
    "rust/crates/protocol/src/validate.rs::byte > 1",
    "rust/crates/protocol/src/validate.rs::index > 0",
    "rust/crates/protocol/src/validate.rs::tag < 12",
    "rust/crates/protocol/src/validate.rs::tag <= 4",
    "rust/crates/protocol/src/validate.rs::tag >= 10",
    "rust/crates/protocol/src/validate.rs::tag >= 12",
    "rust/crates/protocol/src/validate.rs::value.integer > 1",
    "rust/crates/protocol/src/connection/state.rs::freed > 0",
    "rust/crates/protocol/src/connection/state.rs::id > 0",
    "rust/crates/protocol/src/connection/state.rs::receive.pending_bytes > 0",
  ]
  expect(structuralGuards.every((guard) => protocolGuards.includes(guard))).toBe(true)
  await check(
    "protocol inline resource guards",
    [...new Set(protocolGuards.filter((guard) => !structuralGuards.includes(guard)))],
    {
      "rust/crates/protocol/src/asset.rs::value.len() > 256": boundary(
        protocol + "connection.rs",
        "reviewed_asset_mime_byte_length_accepts_256_and_rejects_257",
      ),
      "rust/crates/protocol/src/connection/state.rs::self.event_weight < 2": budgetCoverage.eventToBulkRatio,
    },
  )
  await check(
    "upload constants",
    [...(await read(uploads)).matchAll(/\bconst ([A-Z][A-Z_0-9]*): (?:usize|u\d+|Duration) = [^;]+;/g)].map(
      (item) => item[1]!,
    ),
    {
      TTL: uploadTime,
      MAX_CHUNKS: boundary(uploads, "pieces_arrive_once_in_order_for_one_session_and_connection"),
      MAX_CHUNK_BYTES: boundary(uploads, "pieces_arrive_once_in_order_for_one_session_and_connection"),
      MAX_BYTES: uploadSize,
      MAX_CONNECTION_BYTES: uploadSize,
      MAX_UPLOADS: uploadSize,
    },
  )
  const options = (await read("rust/crates/store/src/engine.rs")).match(/pub struct Options \{([^}]+)\}/)![1]!
  await check(
    "Store Options",
    [...options.matchAll(/pub (\w+):/g)].map((item) => item[1]!),
    {
      cache_bytes: ownerOptions,
      queue_capacity: writer,
      max_snapshots: writer,
    },
  )
  const settings = await read("rust/crates/store/src/analytics/numeric.rs")
  await check(
    "DuckDB numeric settings",
    [...settings.matchAll(/\("(\w+)", "\d+[^"\n]*"\)/g)].map((item) => item[1]!),
    {
      threads: native,
      max_expression_depth: native,
      max_memory: native,
      max_temp_directory_size: native,
    },
  )
  await check("RelayLimits", Object.keys(RelayLimits), {
    applicationBytes: aggregate,
    browserPeers: peerCount,
    peerMetadataBytes: peerCount,
    forwardingMetadataBytes: aggregate,
    nativeReceiveBytes: boundary("infra/cloudflare/test/integration/binary-flow.ts", "nativeLimits"),
  })
  await check("RemoteLimits", Object.keys(RemoteLimits), {
    noticePageSize: boundary(
      "infra/cloudflare/test/notice-store.test.ts",
      "pages newest first, ends without a cursor, and visits each notice once",
    ),
    maxNoticeBatch: collection,
    agentOfflineConfirmMs: boundary("infra/cloudflare/test/integration/real-flow.ts", "verifyOffline"),
    pushTestIntervalMs: boundary(
      "infra/cloudflare/test/push-router.test.ts",
      "an admin test alert reaches only the selected account's registered endpoint and reports push-service acceptance",
    ),
  })
  const inlineOwners = {
    "rust/crates/store/src/analytics/mod.rs": {
      "queries.len() > 16": report,
      "sources.len() > 64": boundary(
        store + "tests/analytics.rs",
        "report_snapshot_accepts_64_sources_and_rejects_65_as_configuration",
      ),
      "query.parameters.len() > 64": report,
      "value.len() <= 128": sourceConfiguration,
    },
    "rust/crates/store/src/analytics/worker.rs": {
      "columns > 64": report,
      "source.columns.len() > 64": sourceConfiguration,
      "sources.len() > 64": sourceConfiguration,
    },
    "infra/cloudflare/src/relay/core.ts": { "pushCount < 20": push, "pushWindow >= 60_000": push },
  }
  for (const [file, members] of Object.entries(inlineOwners)) {
    const source = await read(file)
    const guards = [
      ...source.matchAll(/([.\w]+(?:\.len\(\))?)\s*(>=|>|<=|<)\s*(\d[\d_]*(?:\s*\*\s*\d[\d_]*)*)(?![\w])/g),
    ].map((item) => item[0].replace(/\s+/g, " "))
    await check(file + " numeric guards", [...new Set(guards)], members)
  }
  const relaySource = await read("infra/cloudflare/src/relay/core.ts")
  await check(
    "relay literal reservations",
    [
      ...new Set(
        [...relaySource.matchAll(/budget\.(?:reserve|release)\((\d+\s*\*\s*\d+)\)/g)].map((item) =>
          item[1]!.replace(/\s+/g, " "),
        ),
      ),
    ],
    {
      "32 * 1024": boundary(
        "infra/cloudflare/test/relay-core.test.ts",
        "opaque RPC correlation is per browser, and upstream input waits for downstream consumption",
      ),
    },
  )
  await check(
    "relay asynchronous reservation declarations",
    [...relaySource.matchAll(/const (reservation) = \d+\s*\*\s*\d+/g)].map((item) => item[1]!),
    {
      reservation: push,
    },
  )
  const channelOwners: Record<string, Record<string, ReturnType<typeof boundary>>> = {
    "rust/crates/store/src/engine.rs": {
      "1": boundary(store + "tests/durable_store.rs", "receipt_future_wakes_only_after_commit"),
    },
    "rust/crates/store/src/analytics/mod.rs": {
      "1": report,
      "256": boundary(
        store + "src/analytics/tests.rs",
        "analytics_queue_deadline_and_cancellation_bounds_leave_canonical_work_available",
      ),
    },
    "rust/crates/store/src/analytics/worker.rs": {
      "1": storeCoverage["rust/crates/store/src/analytics/mod.rs::REPORT_DEADLINE"],
    },
  }
  for (const [file, channels] of Object.entries(channelOwners)) {
    await check(
      file + " fixed channels",
      [...new Set([...(await read(file)).matchAll(/sync_channel\((\d+)\)/g)].map((item) => item[1]!))],
      channels,
    )
  }
  const relayDeclarations: string[] = []
  for await (const file of new Bun.Glob("infra/cloudflare/src/relay/**/*.ts").scan({ cwd: root }))
    relayDeclarations.push(
      ...[
        ...(await read(file)).matchAll(/\bconst (\w+)(?:\s*:\s*\w+)? = \d[\d_]*(?:\s*\*\s*\d[\d_]*)*(?=\s*(?:\n|;))/g),
      ].map((item) => `${file}::${item[1]}`),
    )
  await check("relay numeric declarations", relayDeclarations, {
    "infra/cloudflare/src/relay/core.ts::reservation": push,
    "infra/cloudflare/src/relay/notice-store.ts::attentionRepeatMs": boundary(
      "infra/cloudflare/test/notice-store.test.ts",
      "attention repetition enforces the exact ten-minute boundary across reopening",
    ),
  })
  const family = boundary(
    protocol + "wire_connector.rs",
    "local_family_reads_preserve_ids_shapes_errors_and_remote_authority",
  )
  const specCoverage = {
    "specs/wire-connector.md": {
      "0–128 entries": family,
      "1–128 entries": family,
      "10-minute": uploadTime,
      "1–21000 bytes": boundary(uploads, "pieces_arrive_once_in_order_for_one_session_and_connection"),
      "20 MiB": uploadSize,
      "64-upload": uploadSize,
      "40-MiB": uploadSize,
      "30-second": boundary(
        "packages/protocol/test/http-bulk.test.ts",
        "a stalled HTTP piece expires at its own consumption deadline and teardown refunds its entire owner",
      ),
      "64 KiB": http,
    },
    "packages/protocol/src/v5/connection/README.md": {
      "25 ms": budgetCoverage.creditDelayMs,
      "256 KiB": wireCoverage.EVENT_BATCH_BYTES,
      "30-second": wireCoverage.DELIVERY_TIMEOUT_MS,
      "40 ms": coalescing,
      "64 KiB": http,
      "750 ms": coalescing,
    },
    "specs/wire-resources.md": {
      "256 entries": boundary(
        protocol + "frontend_boundary.rs",
        "m3_m5_m10_request_and_asset_budgets_reject_overflow_and_unknown_credentials",
      ),
      "1024 descriptors": boundary(
        protocol + "frontend_boundary.rs",
        "m3_m5_m10_request_and_asset_budgets_reject_overflow_and_unknown_credentials",
      ),
      "65,536-byte": wireBytes,
    },
    "specs/wire-platform.md": { "64 KiB": http },
    "specs/wire-session.md": { "64 KiB": http, "500 entries": collection },
  }
  for (const [file, members] of Object.entries(specCoverage)) {
    const quantities = [
      ...(await read(file)).matchAll(
        /\b\d[\d,]*(?:[–/-]\d[\d,]*)?[- ](?:KiB|MiB|GiB|ms|seconds?|minutes?|hours?|bytes?|frames?|pieces?|entries|uploads?|descriptors|(?:HTTP )?streams?|(?:browser )?peers?)\b/g,
      ),
    ].map((item) => item[0])
    await check(file + " resource quantities", [...new Set(quantities)], members)
  }
})
