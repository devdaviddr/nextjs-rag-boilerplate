-- Filtered vector search keeps looking until it has enough rows (spec 0033 1e).
--
-- HNSW applies the `owner_id` / `knowledge_base_id` filter AFTER its scan, so
-- when the planner chooses the HNSW index for a filtered query, a tenant with a
-- small share of all chunks gets most of its true nearest neighbours filtered
-- away — correct-looking results, silently worse. Measured 2026-09-25 on a
-- 30,561-row corpus, top-20 recall against exact search when HNSW is used:
--
--   tenant share   off     relaxed_order
--   0.1%           0.055   0.950
--   2%             0.087   0.895
--   20%            0.373   0.805
--   78%            0.777   0.777   (the planner's own choice at this share)
--
-- At today's sizes the planner prefers the owner index plus a sort (exact) for
-- every share up to 20%, so this changes nothing yet; it is what keeps recall
-- up once a corpus is large enough for the planner to pick HNSW for a filtered
-- query. relaxed_order never lowered recall and cost milliseconds.
-- retrieve.ts re-ranks the vector candidates with ROW_NUMBER() OVER (ORDER BY
-- distance), so relaxed ordering from the index cannot reach the fusion step.
--
-- Set per database so it applies to every connection without touching the
-- query path. Takes effect for new sessions.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET hnsw.iterative_scan = relaxed_order',
    current_database()
  );
END
$$;
