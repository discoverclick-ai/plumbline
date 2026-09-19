-- 0013 · change events, the workflow that carries the money
--
-- Every other record type in here describes information moving. This one
-- describes money moving, and it is the reason a general contractor tolerates
-- construction software at all. An RFI answered late is annoying. A change
-- event that never becomes a signed change order is a contractor eating cost
-- they were owed.
--
-- The shape, in the industry's own order:
--
--   1. Something happens. An owner directive, a design change, a condition
--      nobody drew. Anybody on the job can raise the event, and raising it
--      early is the whole game, because the argument about whether it was a
--      change gets harder every week that passes.
--   2. The GC sends it out for pricing. The subs affected price their portion.
--   3. The GC assembles the pricing into a number and a time impact.
--   4. The GC submits it to the OWNER as a change order request.
--   5. The owner approves, rejects, or sends it back.
--   6. Approved, it is executed as a signed change order.
--
-- The owner approving is the first place the permission model earns its keep
-- across company kinds: the owner's template is otherwise read-only on this
-- project, and this one privilege is the reason they are here.
--
-- Deliberately NOT here yet: the budget, the commitment, the schedule of
-- values. Those are the financial spine and they attach to these records
-- later. A change event that knows its own cost impact is useful on its own;
-- one that pretends to know its cost code before a work breakdown structure
-- exists would be lying.

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('change_management', 'project', 'Change Management', 45);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('change_management', 'create',          'Raise a change event'),
    ('change_management', 'price',           'Price your scope of a change event'),
    ('change_management', 'submit_to_owner', 'Submit a priced change to the owner'),
    ('change_management', 'approve',         'Approve or reject a change on behalf of the owner'),
    ('change_management', 'execute',         'Execute an approved change order');

INSERT INTO record_types (key, tool_key, display_name, display_name_plural, number_prefix, definition)
VALUES ('change_event', 'change_management', 'Change Event', 'Change Events', 'CE', $json$
{
  "fields": [
    { "key": "description", "label": "What Changed", "type": "multiline", "required": true },
    { "key": "cause", "label": "Cause", "type": "select", "required": true,
      "options": ["Owner Directive", "Design Change", "Unforeseen Condition", "Coordination", "Weather", "Other"] },
    { "key": "origin_reference", "label": "Arising From", "type": "text" },
    { "key": "scope_of_work", "label": "Scope of Work", "type": "multiline" },
    { "key": "rough_order_magnitude", "label": "Rough Order of Magnitude", "type": "number" },
    { "key": "cost_impact", "label": "Cost Impact", "type": "number" },
    { "key": "schedule_impact_days", "label": "Schedule Impact (days)", "type": "number" },
    { "key": "owner_reference", "label": "Owner Reference", "type": "text" },
    { "key": "rejection_reason", "label": "Reason for Rejection", "type": "multiline" }
  ],
  "workflow": {
    "initial": "open",
    "states": [
      { "key": "open", "label": "Open", "ballInCourt": "assignee" },
      { "key": "pricing", "label": "Out for Pricing", "ballInCourt": "assignee" },
      { "key": "priced", "label": "Priced", "ballInCourt": "assignee" },
      { "key": "submitted", "label": "With the Owner", "ballInCourt": "approver" },
      { "key": "approved", "label": "Approved", "ballInCourt": "assignee" },
      { "key": "executed", "label": "Executed", "terminal": true, "ballInCourt": "none" },
      { "key": "void", "label": "Not a Change", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "request_pricing", "label": "Send Out for Pricing", "from": ["open"], "to": "pricing",
        "expectedAction": "Collect pricing for this change", "dueInDays": 7,
        "requires": { "level": "standard", "privilege": "price" } },

      { "//": "cost_impact and schedule_impact_days carry no defaults on purpose: a defaulted field is filled in by normalizeBody and can never gate a transition, and a change priced at a silent zero is worse than one not priced at all.",
        "key": "record_pricing", "label": "Record Pricing", "from": ["pricing", "open"], "to": "priced",
        "expectedAction": "Submit this change to the owner", "dueInDays": 5,
        "requiresFields": ["cost_impact", "schedule_impact_days", "scope_of_work"],
        "requires": { "level": "standard", "privilege": "price" } },

      { "key": "submit_to_owner", "label": "Submit to Owner", "from": ["priced"], "to": "submitted",
        "expectedAction": "Approve or reject this change", "dueInDays": 14,
        "requires": { "level": "standard", "privilege": "submit_to_owner" } },

      { "key": "approve", "label": "Approve", "from": ["submitted"], "to": "approved",
        "expectedAction": "Execute the change order", "dueInDays": 10,
        "requires": { "level": "standard", "privilege": "approve" } },
      { "key": "reject", "label": "Reject", "from": ["submitted"], "to": "priced",
        "expectedAction": "Revise the pricing or withdraw this change",
        "requiresFields": ["rejection_reason"],
        "requires": { "level": "standard", "privilege": "approve" } },

      { "key": "execute", "label": "Execute Change Order", "from": ["approved"], "to": "executed",
        "requiresFields": ["owner_reference"],
        "requires": { "level": "standard", "privilege": "execute" } },

      { "key": "void", "label": "Not a Change", "from": ["open", "pricing", "priced"], "to": "void",
        "requiresFields": ["rejection_reason"],
        "requires": { "level": "standard", "privilege": "submit_to_owner" } }
    ]
  }
}
$json$);

INSERT INTO record_type_versions (type_key, version, definition, note)
SELECT key, version, definition, 'Initial definition' FROM record_types WHERE key = 'change_event';
