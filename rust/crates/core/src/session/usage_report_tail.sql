expanded AS (
    SELECT candidates.*, unnest(CASE WHEN grouping = 'task' AND task_entries <> ''
        THEN string_split(task_entries, '|') ELSE [NULL::VARCHAR] END) AS task_entry FROM candidates, args
),
keyed AS MATERIALIZED (
    SELECT *, CASE grouping
        WHEN 'model' THEN model_key WHEN 'session' THEN id WHEN 'project' THEN project_id WHEN 'agent' THEN agent
        WHEN 'provider' THEN provider_key
        WHEN 'provider-model' THEN provider_model_key
        WHEN 'provider-profile-model' THEN provider_profile_model_key
        WHEN 'model-id' THEN model_id_key
        WHEN 'profile' THEN profile_key
        WHEN 'prompt' THEN prompt_key
        WHEN 'task' THEN '["task",' || coalesce(decode(from_hex(split_part(task_entry, '.', 2))), 'null') || ']'
        WHEN 'day' THEN strftime(local_time, '%Y-%m-%d') WHEN 'month' THEN strftime(local_time, '%Y-%m')
        ELSE strftime(local_time, '%Y-%m-%dT%H:00:00') || coalesce(zone_label, '.000Z') END AS group_key,
        CASE grouping
        WHEN 'model' THEN provider || '/' || model || CASE WHEN variant IS NULL OR variant = '' THEN '' ELSE ' (' || variant || ')' END || CASE WHEN profile IS NULL OR profile = '' THEN '' ELSE ' · ' || profile END
        WHEN 'session' THEN title
        WHEN 'project' THEN CASE WHEN project_id = 'global' THEN 'Global (no project)' WHEN worktree IS NULL THEN project_id WHEN project_name IS NULL OR project_name = '' THEN worktree ELSE project_name || ' · ' || worktree END
        WHEN 'agent' THEN agent
        WHEN 'provider' THEN provider
        WHEN 'provider-model' THEN provider || '/' || model
        WHEN 'provider-profile-model' THEN provider || '/' || model || ' · ' || coalesce(profile, 'Provider default')
        WHEN 'model-id' THEN model
        WHEN 'profile' THEN provider || ' · ' || coalesce(profile, 'Provider default')
        WHEN 'prompt' THEN coalesce(anchor_input_id, 'Unattributed')
        WHEN 'task' THEN coalesce(decode(from_hex(split_part(task_entry, '.', 1))), 'Main Session / unattributed')
        WHEN 'day' THEN strftime(local_time, '%Y-%m-%d') WHEN 'month' THEN strftime(local_time, '%Y-%m')
        ELSE strftime(local_time, '%Y-%m-%dT%H:00') || ' ' || coalesce(zone_label, 'UTC') END AS group_label,
        epoch(date_trunc('hour', local_time)) - seconds AS hour_order,
        decode(from_hex(split_part(task_entry, '.', 2))) AS task_json
    FROM expanded, args
),
groups AS (
    SELECT group_key, arg_min(group_label, observation_order) AS label, min(hour_order) AS hour_order,
        arg_min(model_json, observation_order) AS model_json, arg_min(anchor_json, observation_order) AS anchor_json, arg_min(task_json, observation_order) AS task_json,
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
        coalesce(sum(CASE WHEN generation_ns > 0 AND generation_ns <= 9007199254740991 AND generated_tokens > 0 AND generated_tokens <= 9007199254740991 THEN generation_ns END),0)::DOUBLE AS duration,
        count(*) FILTER (WHERE generation_ns > 0 AND generated_tokens > 0) AS generations,
        count(*) FILTER (WHERE generation_ns > 0 AND generated_tokens > 0 AND provider_timed) AS providers,
        count(*) FILTER (WHERE generation_ns > 0 AND generated_tokens > 0 AND NOT provider_timed) AS observations,
        quantile_disc(CASE WHEN generation_ns > 0 AND generated_tokens > 0 THEN generated_tokens::DOUBLE * 1e9 / generation_ns END, 0.5) AS generation50,
        quantile_disc(CASE WHEN generation_ns > 0 AND generated_tokens > 0 THEN generated_tokens::DOUBLE * 1e9 / generation_ns END, 0.9) AS generation90
    FROM keyed WHERE group_key IN (SELECT group_key FROM page) GROUP BY group_key
),
total AS (
    SELECT count(*) AS logical, coalesce(sum(attempts),0) AS physical, coalesce(sum(source <> 'step'),0) AS helpers,
        coalesce(sum(continuation = 'continued'),0) AS continued, coalesce(sum(continuation = 'fallback'),0) AS fallback,
        coalesce(sqlite_sum(input),0) AS input, coalesce(sqlite_sum(output),0) AS output, coalesce(sqlite_sum(reasoning),0) AS reasoning,
        coalesce(sqlite_sum(cache_read),0) AS cache_read, coalesce(sqlite_sum(cache_write),0) AS cache_write,
        coalesce(sqlite_sum(cost),0) + coalesce(sum(estimate),0) AS cost, count(cost) + count(estimate) AS priced,
        bool_and(cache_reported) AS reported, count(estimate) AS corrections FROM candidates
),
result AS (
    SELECT 0 AS kind, '' AS key, '' AS label, logical, physical, helpers, continued, fallback,
        input, output, reasoning, cache_read, cache_write, cost, priced, reported, corrections,
        NULL::BIGINT AS samples, NULL::BIGINT AS totals, NULL::BIGINT AS first50, NULL::BIGINT AS first95, NULL::BIGINT AS total50, NULL::BIGINT AS total95,
        NULL::DOUBLE AS generated, NULL::DOUBLE AS duration, (SELECT count(*) FROM groups) AS row_count,
        NULL::BIGINT AS generations, NULL::BIGINT AS providers, NULL::BIGINT AS observations, NULL::DOUBLE AS generation50, NULL::DOUBLE AS generation90,
        NULL::VARCHAR AS model_json, NULL::VARCHAR AS anchor_json, NULL::VARCHAR AS task_json,
        0 AS sort_metric, false AS descending, '' AS sorting FROM total
    UNION ALL
    SELECT 1, p.group_key, p.label, p.logical, p.physical, p.helpers, p.continued, p.fallback,
        p.input, p.output, p.reasoning, p.cache_read, p.cache_write, p.cost, p.priced, p.reported, p.corrections,
        s.samples, s.totals, s.first50, s.first95, s.total50, s.total95, s.generated, s.duration,
        (SELECT count(*) FROM groups), s.generations, s.providers, s.observations, s.generation50, s.generation90, p.model_json, p.anchor_json, p.task_json, p.sort_metric, p.descending, p.sorting
    FROM page p JOIN speed s ON s.group_key = p.group_key
)
SELECT kind, key, label, logical, physical, helpers, continued, fallback, input, output, reasoning,
    cache_read, cache_write, cost, priced, reported, corrections, samples, totals, first50, first95,
    total50, total95, generated, duration, row_count, generations, providers, observations, generation50, generation90, model_json, anchor_json, task_json
FROM result ORDER BY kind, CASE WHEN descending THEN sort_metric END DESC,
    CASE WHEN NOT descending THEN sort_metric END ASC, CASE WHEN sorting = 'key' AND descending THEN key END DESC, key ASC
