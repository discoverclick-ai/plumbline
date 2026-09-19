-- 0025 · quantities, for the people who may not see dollars
--
-- The budget already distinguished seeing the budget from seeing the cost
-- figures, and the templates already gave a superintendent the first without
-- the second. What was missing is anything to show them: the summary view
-- carried nothing but money, so read access without cost access produced a
-- screen that could only fail.
--
-- A superintendent manages production. Units in place, units remaining, and
-- which scope is behind are the numbers they act on, and none of them are
-- dollars. So the view carries the unit of measure and the quantities, which
-- were on the line table from the start and never surfaced.

DROP VIEW budget_summary;

CREATE VIEW budget_summary AS
SELECT
    bl.id                AS budget_line_id,
    bl.tenant_id,
    bl.project_id,
    bl.budget_code_id,
    bc.display           AS budget_code,
    bl.description,
    bl.unit_of_measure,
    bl.original_quantity,
    COALESCE(q.quantity, 0)                         AS quantity_to_date,
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
    SELECT SUM(quantity) AS quantity
      FROM cost_entries ce
     WHERE ce.budget_code_id = bl.budget_code_id AND ce.project_id = bl.project_id
       AND ce.kind = 'actual'
) q ON TRUE
LEFT JOIN LATERAL (
    SELECT committed FROM committed_by_budget_code cb
     WHERE cb.budget_code_id = bl.budget_code_id AND cb.project_id = bl.project_id
) com ON TRUE;

GRANT SELECT ON budget_summary TO plumbline_app;
