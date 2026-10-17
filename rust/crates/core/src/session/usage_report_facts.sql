WITH RECURSIVE
args AS (SELECT $1::VARCHAR AS root, $2::BIGINT AS from_time, $3::BIGINT AS to_time,
    $4::VARCHAR AS grouping, $5::VARCHAR AS sorting, $6::BOOLEAN AS descending,
    $7::BIGINT AS page_offset, $8::BIGINT AS page_limit, $9::VARCHAR AS offsets,
    $10::VARCHAR AS prices, $11::VARCHAR AS selected_provider, $12::VARCHAR AS selected_model,
    $13::VARCHAR AS selected_profile, $14::VARCHAR AS selected_effort),
offsets AS (SELECT split_part(value, '|', 1)::BIGINT AS start,
    split_part(value, '|', 2)::INTEGER AS seconds, split_part(value, '|', 3) AS label
    FROM args, unnest(string_split(offsets, ';')) AS entries(value) WHERE value <> ''),
prices AS (SELECT split_part(value, '|', 1) AS reference,
    split_part(value, '|', 2)::INTEGER AS priority, nullif(split_part(value, '|', 3), '~')::BIGINT AS tier,
    split_part(value, '|', 4)::INTEGER AS ordinal, split_part(value, '|', 5)::DOUBLE AS input_price,
    split_part(value, '|', 6)::DOUBLE AS output_price, split_part(value, '|', 7)::DOUBLE AS read_price,
    split_part(value, '|', 8)::DOUBLE AS write_price
    FROM args, unnest(string_split(prices, ';')) AS entries(value) WHERE value <> ''),
candidates AS MATERIALIZED (
    SELECT r.*, r.session_id AS id, coalesce(s.title, r.session_id) AS title, r.session_updated AS time_updated,
        p.name AS project_name, p.worktree,
        (0::BIGINT, [0::BIGINT], r.session_updated, r.session_id, r.request_order) AS observation_order,
        coalesce(o.seconds, 0) AS seconds, o.label AS zone_label,
        TIMESTAMP '1970-01-01' + (r.time_created::DOUBLE / 1000 + coalesce(o.seconds, 0)) * INTERVAL '1 second' AS local_time,
        estimated.amount AS estimate
    FROM report_usage_analytics_request r
    LEFT JOIN report_session s ON s.id = r.session_id
    LEFT JOIN report_project p ON p.id = r.project_id, args a
    LEFT JOIN LATERAL (SELECT seconds, label FROM offsets WHERE start <= r.time_created ORDER BY start DESC LIMIT 1) o ON true
    LEFT JOIN LATERAL (
        SELECT (r.input * input_price + (r.output + r.reasoning) * output_price + r.cache_read * read_price + r.cache_write * write_price) / 1000000 AS amount
        FROM prices WHERE r.cost IS NULL AND r.source <> 'decision'
            AND reference = hex(r.directory) || ':' || coalesce(hex(r.workspace_id), '~') || ':' || hex(r.provider) || ':' || hex(r.model) || ':' || coalesce(hex(r.profile), '~')
            AND (tier IS NULL OR r.input + r.cache_read + r.cache_write > tier)
        ORDER BY priority, tier DESC NULLS LAST, ordinal LIMIT 1
    ) estimated ON true
    WHERE (a.from_time IS NULL OR r.time_created >= a.from_time)
        AND (a.to_time IS NULL OR r.time_created < a.to_time)
        AND (a.selected_provider IS NULL OR r.provider = a.selected_provider)
        AND (a.selected_model IS NULL OR r.model = a.selected_model)
        AND (a.selected_profile IS NULL OR r.profile = a.selected_profile)
        AND (a.selected_effort IS NULL OR r.variant = a.selected_effort)
),
