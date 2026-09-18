-- 0010 · time and materials tickets
--
-- The first record type that belongs to one side of the contract, and the
-- reason 0009 exists. A T&M ticket is a subcontractor's contemporaneous claim
-- about their own crew's hours on work outside their scope. The general
-- contractor's superintendent signs it in the field, that day, or argues with
-- it. What a GC cannot do is raise one, because raising one on a sub's behalf
-- would be asserting something about somebody else's payroll.
--
-- The workflow is short on purpose. T&M tickets that go unsigned for a week
-- are the single most common source of unrecoverable cost on a job: memories
-- fade, the super who watched the work rotates off, and the claim dies. So
-- submission puts the ball in the signer's court with a three day clock, and
-- a dispute hands it straight back rather than leaving it in limbo.

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('t_and_m', 'project', 'T&M Tickets', 55);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('t_and_m', 'create', 'Raise T&M tickets for your own crew'),
    ('t_and_m', 'sign',   'Sign or dispute a T&M ticket on behalf of the contracting party');

INSERT INTO record_types (key, tool_key, display_name, display_name_plural, number_prefix,
                          creatable_by_org_kinds, definition)
VALUES ('t_and_m_ticket', 't_and_m', 'T&M Ticket', 'T&M Tickets', 'TM',
        ARRAY['specialty_contractor']::organization_kind[], $json$
{
  "fields": [
    { "key": "work_date", "label": "Date of Work", "type": "date", "required": true },
    { "key": "description", "label": "Work Performed", "type": "multiline", "required": true },
    { "key": "authorized_by", "label": "Directed By", "type": "text", "required": true },
    { "key": "reference", "label": "Directive or PCO Reference", "type": "text" },
    { "key": "labor_hours", "label": "Labor Hours", "type": "number", "required": true },
    { "key": "labor_detail", "label": "Crew and Classifications", "type": "multiline" },
    { "key": "equipment", "label": "Equipment", "type": "multiline" },
    { "key": "materials", "label": "Materials", "type": "multiline" },
    { "key": "dispute_reason", "label": "Reason for Dispute", "type": "multiline" }
  ],
  "workflow": {
    "initial": "draft",
    "states": [
      { "key": "draft", "label": "Draft", "ballInCourt": "creator" },
      { "key": "submitted", "label": "Awaiting Signature", "ballInCourt": "approver" },
      { "key": "signed", "label": "Signed", "terminal": true, "ballInCourt": "none" },
      { "key": "disputed", "label": "Disputed", "ballInCourt": "creator" },
      { "key": "void", "label": "Void", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "submit", "label": "Submit for Signature", "from": ["draft", "disputed"], "to": "submitted",
        "expectedAction": "Sign this ticket or say why not", "dueInDays": 3,
        "requires": { "level": "standard", "privilege": "create", "participantRoles": ["creator"] } },
      { "key": "sign", "label": "Sign", "from": ["submitted"], "to": "signed",
        "requires": { "level": "standard", "privilege": "sign" } },
      { "key": "dispute", "label": "Dispute", "from": ["submitted"], "to": "disputed",
        "expectedAction": "Answer the dispute or withdraw the ticket",
        "requiresFields": ["dispute_reason"],
        "requires": { "level": "standard", "privilege": "sign" } },
      { "key": "void", "label": "Void", "from": ["draft", "disputed"], "to": "void",
        "requires": { "level": "standard", "participantRoles": ["creator"] } }
    ]
  }
}
$json$);
