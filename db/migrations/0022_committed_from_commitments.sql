-- 0022 · committed cost comes from signed contracts
--
-- budget_summary took its committed figure from cost entries somebody typed,
-- which was honest while nothing else existed and is wrong now that
-- commitments do. A committed dollar means somebody signed something; a
-- number a project engineer typed into a cost field is a guess wearing a
-- contract's clothes.
--
-- So committed now comes from committed_by_budget_code, which counts executed
-- commitments and executed change orders only. Cost entries keep actual,
-- pending and forecast, which are the three that genuinely arrive as entries.
--
-- The 'committed' value stays in the cost_kind enum rather than being dropped:
-- an ERP import that brings a commitment across from an accounting system
-- with no matching subcontract here has to land somewhere, and it is counted
-- below alongside the contracts.

DROP VIEW budget_summary;

CREATE VIEW budget_summary AS
SELECT
    bl.id                AS budget_line_id,
    bl.tenant_id,
    bl.project_id,
    bl.budget_code_id,
    bc.display           AS budget_code,
    bl.description,
    bl.original_amount,
    COALESCE(rev.revised, 0)                        AS approved_revisions,
    bl.original_amount + COALESCE(rev.revised, 0)   AS current_budget,
    COALESCE(com.committed, 0) + COALESCE(c.committed, 0) AS committed_cost,
    COALESCE(c.actual, 0)                           AS actual_cost,
    COALESCE(c.pending, 0)                          AS pending_cost,
    GREATEST(COALESCE(com.committed, 0) + COALESCE(c.committed, 0), COALESCE(c.actual, 0))
      + COALESCE(c.pending, 0)                      AS projected_cost,
    (bl.original_amount + COALESCE(rev.revised, 0))
      - (GREATEST(COALESCE(com.committed, 0) + COALESCE(c.committed, 0), COALESCE(c.actual, 0))
         + COALESCE(c.pending, 0))                  AS projected_over_under
FROM budget_lines bl
JOIN budget_codes bc ON bc.id = bl.budget_code_id
LEFT JOIN LATERAL (
    SELECT SUM(amount) AS revised FROM budget_revisions r WHERE r.budget_line_id = bl.id
) rev ON TRUE
LEFT JOIN LATERAL (
    SELECT
        SUM(amount) FILTER (WHERE kind = 'committed') AS committed,
        SUM(amount) FILTER (WHERE kind = 'actual')    AS actual,
        SUM(amount) FILTER (WHERE kind = 'pending')   AS pending
      FROM cost_entries ce
     WHERE ce.budget_code_id = bl.budget_code_id AND ce.project_id = bl.project_id
) c ON TRUE
LEFT JOIN LATERAL (
    SELECT committed FROM committed_by_budget_code cb
     WHERE cb.budget_code_id = bl.budget_code_id AND cb.project_id = bl.project_id
) com ON TRUE;

GRANT SELECT ON budget_summary TO plumbline_app;
