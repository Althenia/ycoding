WITH RECURSIVE
args AS (SELECT $1::VARCHAR AS root, $2::BIGINT AS from_time, $3::BIGINT AS to_time,
    $4::VARCHAR AS grouping, $5::VARCHAR AS sorting, $6::BOOLEAN AS descending,
    $7::BIGINT AS page_offset, $8::BIGINT AS page_limit, $9::VARCHAR AS offsets,
    $10::VARCHAR AS prices, $11::VARCHAR AS selected_provider, $12::VARCHAR AS selected_model,
    $13::VARCHAR AS selected_profile, $14::VARCHAR AS selected_effort, $15::VARCHAR AS hints),
children AS (SELECT id, parent_id, row_number() OVER (PARTITION BY parent_id ORDER BY time_updated DESC, id DESC) AS child_order FROM report_session),
family(id, depth, position) AS (
    SELECT s.id, 0, [0::BIGINT] FROM report_session s, args a WHERE s.id = a.root
    UNION ALL
    SELECT s.id, f.depth + 1, list_append(f.position, s.child_order) FROM children s JOIN family f ON s.parent_id = f.id, args a
    WHERE EXISTS (SELECT 1 FROM report_session root WHERE root.id = a.root AND root.parent_id IS NULL)
),
offsets AS (SELECT split_part(value, '|', 1)::BIGINT AS start,
    split_part(value, '|', 2)::INTEGER AS seconds, split_part(value, '|', 3) AS label
    FROM args, unnest(string_split(offsets, ';')) AS entries(value) WHERE value <> ''),
hints AS (SELECT decode(from_hex(split_part(value, '|', 1))) AS hint_lookup,
    decode(from_hex(split_part(value, '|', 2))) AS hint_anchor_session, decode(from_hex(split_part(value, '|', 3))) AS hint_anchor_input,
    decode(from_hex(split_part(value, '|', 4))) AS hint_key, decode(from_hex(split_part(value, '|', 5))) AS hint_json
    FROM args, unnest(string_split(hints, ';')) AS entries(value) WHERE value <> ''),
task_ancestry(origin, id, parent_id) AS (
    SELECT s.id, s.id, s.parent_id FROM report_session s, args a
    WHERE a.grouping = 'task' AND (a.root IS NULL OR s.id IN (SELECT id FROM family))
    UNION
    SELECT x.origin, s.id, s.parent_id FROM task_ancestry x JOIN report_session s ON s.id = x.parent_id
),
prices AS (SELECT split_part(value, '|', 1) AS reference,
    split_part(value, '|', 2)::INTEGER AS priority, nullif(split_part(value, '|', 3), '~')::BIGINT AS tier,
    split_part(value, '|', 4)::INTEGER AS ordinal, split_part(value, '|', 5)::DOUBLE AS input_price,
    split_part(value, '|', 6)::DOUBLE AS output_price, split_part(value, '|', 7)::DOUBLE AS read_price,
    split_part(value, '|', 8)::DOUBLE AS write_price
    FROM args, unnest(string_split(prices, ';')) AS entries(value) WHERE value <> ''),
candidates AS MATERIALIZED (
    SELECT r.* REPLACE (
        CASE WHEN r.anchor_session_id IS NULL AND h.hint_key IS NOT NULL THEN h.hint_key ELSE r.prompt_key END AS prompt_key,
        CASE WHEN r.anchor_session_id IS NULL THEN h.hint_json ELSE r.anchor_json END AS anchor_json,
        coalesce(r.anchor_session_id, h.hint_anchor_session) AS anchor_session_id,
        coalesce(r.anchor_input_id, h.hint_anchor_input) AS anchor_input_id),
        s.id, s.title, s.project_id, s.time_updated, p.name AS project_name, p.worktree,
        (coalesce(f.depth, 0), coalesce(f.position, [0::BIGINT]), CASE WHEN a.root IS NULL THEN s.time_updated ELSE 0 END, s.id, r.request_order) AS observation_order,
        coalesce(o.seconds, 0) AS seconds, o.label AS zone_label,
        TIMESTAMP '1970-01-01' + (r.time_created::DOUBLE / 1000 + coalesce(o.seconds, 0)) * INTERVAL '1 second' AS local_time,
        estimated.amount AS estimate,
        coalesce((SELECT string_agg(t.path_entry, '|') FROM task_ancestry x JOIN report_task t ON t.session_id = x.id WHERE x.origin = r.session_id), '') AS task_entries
    FROM report_session_provider_request r JOIN report_session s ON s.id = r.session_id
    LEFT JOIN report_project p ON p.id = s.project_id
    LEFT JOIN family f ON f.id = s.id
    LEFT JOIN hints h ON h.hint_lookup = r.input_key AND r.anchor_session_id IS NULL, args a
    LEFT JOIN LATERAL (SELECT seconds, label FROM offsets WHERE start <= r.time_created ORDER BY start DESC LIMIT 1) o ON true
    LEFT JOIN LATERAL (
        SELECT (r.input * input_price + (r.output + r.reasoning) * output_price + r.cache_read * read_price + r.cache_write * write_price) / 1000000 AS amount
        FROM prices WHERE r.cost IS NULL AND r.source <> 'decision'
            AND reference = hex(s.directory) || ':' || coalesce(hex(s.workspace_id), '~') || ':' || hex(r.provider) || ':' || hex(r.model) || ':' || coalesce(hex(r.profile), '~')
            AND (tier IS NULL OR r.input + r.cache_read + r.cache_write > tier)
        ORDER BY priority, tier DESC NULLS LAST, ordinal LIMIT 1
    ) estimated ON true
    WHERE (a.root IS NULL OR s.id IN (SELECT id FROM family))
        AND (a.from_time IS NULL OR r.time_created >= a.from_time)
        AND (a.to_time IS NULL OR r.time_created < a.to_time)
        AND (a.selected_provider IS NULL OR r.provider = a.selected_provider)
        AND (a.selected_model IS NULL OR r.model = a.selected_model)
        AND (a.selected_profile IS NULL OR r.profile = a.selected_profile)
        AND (a.selected_effort IS NULL OR r.variant = a.selected_effort)
),
