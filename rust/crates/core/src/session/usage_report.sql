WITH RECURSIVE
args AS (SELECT $1::VARCHAR AS root, $2::BIGINT AS from_time, $3::BIGINT AS to_time,
    $4::VARCHAR AS grouping, $5::VARCHAR AS sorting, $6::BOOLEAN AS descending,
    $7::BIGINT AS page_offset, $8::BIGINT AS page_limit, $9::VARCHAR AS offsets,
    $10::VARCHAR AS prices),
children AS (SELECT id, parent_id, row_number() OVER (PARTITION BY parent_id ORDER BY time_updated DESC, id DESC) AS child_order FROM session),
family(id, depth, position) AS (
    SELECT s.id, 0, [0::BIGINT] FROM session s, args a WHERE s.id = a.root
    UNION ALL
    SELECT s.id, f.depth + 1, list_append(f.position, s.child_order) FROM children s JOIN family f ON s.parent_id = f.id, args a
    WHERE EXISTS (SELECT 1 FROM session root WHERE root.id = a.root AND root.parent_id IS NULL)
),
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
    SELECT r.*, s.id, s.title, s.project_id, s.time_updated, p.name AS project_name, p.worktree,
        (coalesce(f.depth, 0), coalesce(f.position, [0::BIGINT]), CASE WHEN a.root IS NULL THEN s.time_updated ELSE 0 END, s.id, r.request_order) AS observation_order,
        coalesce(o.seconds, 0) AS seconds, o.label AS zone_label,
        TIMESTAMP '1970-01-01' + (r.time_created::DOUBLE / 1000 + coalesce(o.seconds, 0)) * INTERVAL '1 second' AS local_time,
        estimated.amount AS estimate
    FROM session_provider_request r JOIN session s ON s.id = r.session_id
    LEFT JOIN project p ON p.id = s.project_id
    LEFT JOIN family f ON f.id = s.id, args a
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
),
keyed AS MATERIALIZED (
    SELECT *, CASE grouping
        WHEN 'model' THEN model_key WHEN 'session' THEN id WHEN 'project' THEN project_id WHEN 'agent' THEN agent
        WHEN 'day' THEN strftime(local_time, '%Y-%m-%d') WHEN 'month' THEN strftime(local_time, '%Y-%m')
        ELSE strftime(local_time, '%Y-%m-%dT%H:00:00') || coalesce(zone_label, '.000Z') END AS group_key,
        CASE grouping
        WHEN 'model' THEN provider || '/' || model || CASE WHEN variant IS NULL OR variant = '' THEN '' ELSE ' (' || variant || ')' END || CASE WHEN profile IS NULL OR profile = '' THEN '' ELSE ' · ' || profile END
        WHEN 'session' THEN title
        WHEN 'project' THEN CASE WHEN project_id = 'global' THEN 'Global (no project)' WHEN worktree IS NULL THEN project_id WHEN project_name IS NULL OR project_name = '' THEN worktree ELSE project_name || ' · ' || worktree END
        WHEN 'agent' THEN agent
        WHEN 'day' THEN strftime(local_time, '%Y-%m-%d') WHEN 'month' THEN strftime(local_time, '%Y-%m')
        ELSE strftime(local_time, '%Y-%m-%dT%H:00') || ' ' || coalesce(zone_label, 'UTC') END AS group_label,
        epoch(date_trunc('hour', local_time)) - seconds AS hour_order
    FROM candidates, args
),
groups AS (
    SELECT group_key, arg_min(group_label, observation_order) AS label, min(hour_order) AS hour_order,
        count(*) AS logical, coalesce(sum(attempts),0) AS physical, coalesce(sum(source <> 'step'),0) AS helpers,
        coalesce(sum(continuation = 'continued'),0) AS continued, coalesce(sum(continuation = 'fallback'),0) AS fallback,
        coalesce(sqlite_sum(input),0) AS input, coalesce(sqlite_sum(output),0) AS output, coalesce(sqlite_sum(reasoning),0) AS reasoning,
        coalesce(sqlite_sum(cache_read),0) AS cache_read, coalesce(sqlite_sum(cache_write),0) AS cache_write,
        coalesce(sqlite_sum(cost),0) + coalesce(sum(estimate),0) AS cost, count(cost) + count(estimate) AS priced,
        bool_and(cache_reported) AS reported, count(estimate) AS corrections
    FROM keyed GROUP BY group_key
),
ranked AS (
    SELECT *, CASE sorting WHEN 'tokens' THEN input + output + reasoning + cache_read + cache_write
        WHEN 'cost' THEN cost WHEN 'steps' THEN logical WHEN 'input' THEN input WHEN 'output' THEN output
        WHEN 'reasoning' THEN reasoning WHEN 'cacheRead' THEN cache_read WHEN 'cacheWrite' THEN cache_write
        ELSE CASE WHEN grouping = 'hour' AND offsets <> '' THEN hour_order ELSE 0 END END AS sort_metric
    FROM groups, args
),
page AS MATERIALIZED (
    SELECT * FROM ranked ORDER BY
        CASE WHEN descending THEN sort_metric END DESC, CASE WHEN NOT descending THEN sort_metric END ASC,
        CASE WHEN sorting = 'key' AND descending THEN group_key END DESC, group_key ASC
    LIMIT (SELECT page_limit FROM args) OFFSET (SELECT page_offset FROM args)
),
speed AS (
    SELECT group_key, count(first_ms) AS samples, count(total_ms) AS totals,
        quantile_disc(first_ms, 0.5) AS first50, quantile_disc(first_ms, 0.95) AS first95,
        quantile_disc(total_ms, 0.5) AS total50, quantile_disc(total_ms, 0.95) AS total95,
        coalesce(sum(CASE WHEN generation_ns > 0 AND generation_ns <= 9007199254740991 AND generated_tokens > 0 AND generated_tokens <= 9007199254740991 THEN generated_tokens END),0)::DOUBLE AS generated,
        coalesce(sum(CASE WHEN generation_ns > 0 AND generation_ns <= 9007199254740991 AND generated_tokens > 0 AND generated_tokens <= 9007199254740991 THEN generation_ns END),0)::DOUBLE AS duration
    FROM keyed WHERE group_key IN (SELECT group_key FROM page) GROUP BY group_key
),
total AS (
    SELECT count(*) AS logical, coalesce(sum(attempts),0) AS physical, coalesce(sum(source <> 'step'),0) AS helpers,
        coalesce(sum(continuation = 'continued'),0) AS continued, coalesce(sum(continuation = 'fallback'),0) AS fallback,
        coalesce(sqlite_sum(input),0) AS input, coalesce(sqlite_sum(output),0) AS output, coalesce(sqlite_sum(reasoning),0) AS reasoning,
        coalesce(sqlite_sum(cache_read),0) AS cache_read, coalesce(sqlite_sum(cache_write),0) AS cache_write,
        coalesce(sqlite_sum(cost),0) + coalesce(sum(estimate),0) AS cost, count(cost) + count(estimate) AS priced,
        bool_and(cache_reported) AS reported, count(estimate) AS corrections FROM keyed
),
result AS (
    SELECT 0 AS kind, '' AS key, '' AS label, logical, physical, helpers, continued, fallback,
        input, output, reasoning, cache_read, cache_write, cost, priced, reported, corrections,
        NULL AS samples, NULL AS totals, NULL AS first50, NULL AS first95, NULL AS total50, NULL AS total95,
        NULL AS generated, NULL AS duration, (SELECT count(*) FROM groups) AS row_count,
        0 AS sort_metric, false AS descending, '' AS sorting FROM total
    UNION ALL
    SELECT 1, p.group_key, p.label, p.logical, p.physical, p.helpers, p.continued, p.fallback,
        p.input, p.output, p.reasoning, p.cache_read, p.cache_write, p.cost, p.priced, p.reported, p.corrections,
        s.samples, s.totals, s.first50, s.first95, s.total50, s.total95, s.generated, s.duration,
        (SELECT count(*) FROM groups), p.sort_metric, p.descending, p.sorting
    FROM page p JOIN speed s ON s.group_key = p.group_key
)
SELECT kind, key, label, logical, physical, helpers, continued, fallback, input, output, reasoning,
    cache_read, cache_write, cost, priced, reported, corrections, samples, totals, first50, first95,
    total50, total95, generated, duration, row_count
FROM result ORDER BY kind, CASE WHEN descending THEN sort_metric END DESC,
    CASE WHEN NOT descending THEN sort_metric END ASC, CASE WHEN sorting = 'key' AND descending THEN key END DESC, key ASC
