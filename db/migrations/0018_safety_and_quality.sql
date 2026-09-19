-- 0018 · incidents and inspections
--
-- The last two kernel-shaped tools from Procore's Quality & Safety
-- certification, and the two with the sharpest edges.
--
-- An incident is the one record type where the software's usual instincts are
-- actively wrong. Everywhere else, drafting early and filling in detail later
-- is the whole point. An incident is a legal document from the moment it is
-- written: OSHA recordability is decided on it, insurers read it, and in a
-- serious case a lawyer will read every revision of it. So it is the one type
-- where the agent drafts and a human must sign, where nothing auto-closes,
-- and where "who was told, and when" is a field rather than an afterthought.
--
-- An inspection is the opposite shape to everything else here: a checklist
-- with a pass or fail per line, not a single body. The kernel handles it
-- because the checklist is JSONB and the failure disposition is a state, but
-- the honest note is that this is the edge of what the record kernel should
-- be asked to do. A real inspection module wants a template library and
-- per-line photo evidence, and that is a subsystem, not a field.

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('incidents',   'project', 'Incidents',   42),
    ('inspections', 'project', 'Inspections', 44);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('incidents',   'create',      'Report an incident'),
    ('incidents',   'investigate', 'Record the investigation and corrective action'),
    ('incidents',   'sign',        'Sign off an incident report as complete and accurate'),
    ('inspections', 'create',      'Create and conduct inspections'),
    ('inspections', 'close',       'Close an inspection once deficiencies are resolved');

INSERT INTO record_types (key, tool_key, display_name, display_name_plural, number_prefix, definition) VALUES

('incident', 'incidents', 'Incident', 'Incidents', 'INC', $json$
{
  "fields": [
    { "key": "occurred_at", "label": "Date and Time", "type": "date", "required": true },
    { "key": "incident_type", "label": "Type", "type": "select", "required": true,
      "options": ["Injury", "Near Miss", "Property Damage", "Environmental", "Utility Strike", "Theft", "Other"] },
    { "key": "location", "label": "Location", "type": "text", "required": true },
    { "key": "description", "label": "What Happened", "type": "multiline", "required": true },
    { "key": "people_involved", "label": "People Involved", "type": "multiline" },
    { "key": "witnesses", "label": "Witnesses", "type": "multiline" },
    { "key": "immediate_action", "label": "Immediate Action Taken", "type": "multiline" },
    { "key": "notifications_made", "label": "Who Was Notified, and When", "type": "multiline" },
    { "key": "medical_treatment", "label": "Medical Treatment", "type": "select",
      "options": ["None", "First Aid", "Doctor Visit", "Emergency Room", "Hospitalisation", "Fatality"] },
    { "key": "recordable", "label": "OSHA Recordable", "type": "select", "options": ["Undetermined", "Yes", "No"],
      "default": "Undetermined" },
    { "key": "root_cause", "label": "Root Cause", "type": "multiline" },
    { "key": "corrective_action", "label": "Corrective Action", "type": "multiline" }
  ],
  "workflow": {
    "initial": "reported",
    "states": [
      { "//": "The reporter holds it until somebody picks up the investigation. Requiring an assignee at creation would mean a foreman cannot report an injury from the field without first knowing who will investigate it, which is the moment you lose the report.",
        "key": "reported", "label": "Reported", "ballInCourt": "creator" },
      { "key": "investigating", "label": "Under Investigation", "ballInCourt": "assignee" },
      { "key": "pending_signoff", "label": "Pending Sign-off", "ballInCourt": "approver" },
      { "key": "closed", "label": "Closed", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "investigate", "label": "Begin Investigation", "from": ["reported"], "to": "investigating",
        "expectedAction": "Establish the root cause and the corrective action", "dueInDays": 3,
        "requires": { "level": "standard", "privilege": "investigate" } },
      { "//": "Root cause and corrective action are both required to leave the investigation. An incident closed without either is a filing exercise, and it is the version a lawyer will read out loud.",
        "key": "submit_findings", "label": "Submit Findings", "from": ["investigating"], "to": "pending_signoff",
        "expectedAction": "Review and sign this incident report", "dueInDays": 5,
        "requiresFields": ["root_cause", "corrective_action", "recordable"],
        "requires": { "level": "standard", "privilege": "investigate" } },
      { "key": "return_findings", "label": "Return for More Detail", "from": ["pending_signoff"], "to": "investigating",
        "expectedAction": "Answer the questions raised on this report",
        "requires": { "level": "standard", "privilege": "sign" } },
      { "//": "There is no auto-close and no void. An incident is a legal document from the moment it is written, and the only way out is a named person signing it.",
        "key": "sign_off", "label": "Sign Off", "from": ["pending_signoff"], "to": "closed",
        "requires": { "level": "standard", "privilege": "sign" } }
    ]
  }
}
$json$),

('inspection', 'inspections', 'Inspection', 'Inspections', 'INS', $json$
{
  "fields": [
    { "key": "inspection_type", "label": "Type", "type": "select", "required": true,
      "options": ["Quality", "Safety", "Commissioning", "Pre-pour", "Pre-cover", "Punch Walk", "Authority Having Jurisdiction"] },
    { "key": "scheduled_for", "label": "Scheduled For", "type": "date", "required": true },
    { "key": "location", "label": "Location", "type": "text" },
    { "key": "checklist", "label": "Checklist", "type": "multiline" },
    { "key": "result", "label": "Result", "type": "select", "options": ["Pass", "Pass with Deficiencies", "Fail"] },
    { "key": "deficiencies", "label": "Deficiencies", "type": "multiline" },
    { "key": "resolution", "label": "Resolution", "type": "multiline" }
  ],
  "workflow": {
    "initial": "scheduled",
    "states": [
      { "key": "scheduled", "label": "Scheduled", "ballInCourt": "assignee" },
      { "key": "deficient", "label": "Deficiencies Outstanding", "ballInCourt": "assignee" },
      { "key": "passed", "label": "Passed", "terminal": true, "ballInCourt": "none" },
      { "key": "closed", "label": "Closed", "terminal": true, "ballInCourt": "none" },
      { "key": "cancelled", "label": "Cancelled", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "pass", "label": "Pass", "from": ["scheduled"], "to": "passed",
        "requiresFields": ["result"],
        "requires": { "level": "standard", "privilege": "create" } },
      { "//": "A failed inspection hands the ball straight to whoever has to fix it. An inspection that records a failure and notifies nobody is how the same thing fails the reinspection.",
        "key": "fail", "label": "Record Deficiencies", "from": ["scheduled"], "to": "deficient",
        "expectedAction": "Correct the deficiencies and call for reinspection", "dueInDays": 5,
        "requiresFields": ["result", "deficiencies"],
        "requires": { "level": "standard", "privilege": "create" } },
      { "key": "reinspect", "label": "Reinspect", "from": ["deficient"], "to": "scheduled",
        "expectedAction": "Reinspect the corrected work",
        "requiresFields": ["resolution"],
        "requires": { "level": "standard", "privilege": "create" } },
      { "key": "close", "label": "Close", "from": ["deficient"], "to": "closed",
        "requiresFields": ["resolution"],
        "requires": { "level": "standard", "privilege": "close" } },
      { "key": "cancel", "label": "Cancel", "from": ["scheduled"], "to": "cancelled",
        "requires": { "level": "standard", "privilege": "close" } }
    ]
  }
}
$json$);

INSERT INTO record_type_versions (type_key, version, definition, note)
SELECT key, version, definition, 'Initial definition'
  FROM record_types WHERE key IN ('incident', 'inspection');
