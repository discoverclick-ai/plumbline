-- 0014 · the rest of the kernel-shaped tools
--
-- Procore's Project Management certification covers Correspondence, Meetings,
-- Tasks, Drawings, Specifications, Photos and Schedule. Three of those seven
-- are records with a typed body, a state machine and a ball in court, which
-- means they are configuration and they ship in this migration with no engine
-- code behind them. That is the architectural claim being cashed: adding a
-- tool is a row, not a release.
--
-- The other four are not, and no amount of JSON makes them so. Drawings and
-- Specifications need versioned documents with markup. Photos need object
-- storage and geolocation. Schedule needs a time series and activity
-- dependencies. Pretending the kernel covers those would be the kind of
-- architectural lie that costs a rewrite, so they are absent on purpose.
--
-- Meetings deserve a note. The reason meeting minutes software is uniformly
-- terrible is that it models a meeting as a document. A meeting is not a
-- document, it is a set of commitments people made out loud, and the only
-- part anybody needs afterwards is who owes what. So a meeting here is a
-- record whose business items carry forward, and the minutes are a byproduct.

INSERT INTO tools (key, scope, display_name, sort_order) VALUES
    ('correspondence', 'project', 'Correspondence', 15),
    ('meetings',       'project', 'Meetings',       25),
    ('tasks',          'project', 'Tasks',          35);

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('correspondence', 'create',   'Send correspondence'),
    ('correspondence', 'respond',  'Respond to correspondence on behalf of your company'),
    ('correspondence', 'close',    'Close out a correspondence thread'),
    ('meetings',       'create',   'Schedule meetings and publish minutes'),
    ('meetings',       'chair',    'Chair a meeting and close its minutes'),
    ('tasks',          'create',   'Create tasks'),
    ('tasks',          'close',    'Close a task somebody else completed');

INSERT INTO record_types (key, tool_key, display_name, display_name_plural, number_prefix, definition) VALUES

-- Formal letters. The distinction from a comment thread is that
-- correspondence is a contractual act: it is the paper somebody points at
-- later, so it has a sender, a recipient, a subject and a record of response.
('correspondence', 'correspondence', 'Letter', 'Correspondence', 'LTR', $json$
{
  "fields": [
    { "key": "letter_type", "label": "Type", "type": "select", "required": true,
      "options": ["General", "Notice", "Transmittal", "Request", "Response", "Demand"] },
    { "key": "body", "label": "Letter", "type": "multiline", "required": true },
    { "key": "response_required_by", "label": "Response Required By", "type": "date" },
    { "key": "response", "label": "Response", "type": "multiline" },
    { "key": "delivery_method", "label": "Delivered By", "type": "select",
      "options": ["Platform", "Email", "Hand Delivery", "Certified Mail", "Courier"] }
  ],
  "workflow": {
    "initial": "draft",
    "states": [
      { "key": "draft", "label": "Draft", "ballInCourt": "creator" },
      { "key": "issued", "label": "Issued", "ballInCourt": "assignee" },
      { "key": "responded", "label": "Responded", "ballInCourt": "creator" },
      { "key": "closed", "label": "Closed", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "issue", "label": "Issue", "from": ["draft"], "to": "issued",
        "expectedAction": "Respond to this letter", "dueInDays": 7,
        "requiresFields": ["delivery_method"],
        "requires": { "level": "standard", "participantRoles": ["creator"] } },
      { "key": "respond", "label": "Respond", "from": ["issued"], "to": "responded",
        "expectedAction": "Review the response and close",
        "requiresFields": ["response"],
        "requires": { "level": "standard", "privilege": "respond" } },
      { "key": "close", "label": "Close", "from": ["issued", "responded"], "to": "closed",
        "requires": { "level": "standard", "privilege": "close" } }
    ]
  }
}
$json$),

-- A meeting is a set of commitments, not a document. Business items carry
-- forward until somebody closes them, which is the only part of a meeting
-- anybody cares about a week later.
('meeting', 'meetings', 'Meeting', 'Meetings', 'MTG', $json$
{
  "fields": [
    { "key": "meeting_type", "label": "Type", "type": "select", "required": true,
      "options": ["Owner Architect Contractor", "Coordination", "Safety", "Preconstruction", "Subcontractor", "Other"] },
    { "key": "scheduled_for", "label": "Scheduled For", "type": "date", "required": true },
    { "key": "location", "label": "Location", "type": "text" },
    { "key": "agenda", "label": "Agenda", "type": "multiline" },
    { "key": "attendance", "label": "Attendance", "type": "multiline" },
    { "key": "minutes", "label": "Minutes", "type": "multiline" },
    { "key": "carried_forward", "label": "Business Carried Forward", "type": "multiline" }
  ],
  "workflow": {
    "initial": "scheduled",
    "states": [
      { "key": "scheduled", "label": "Scheduled", "ballInCourt": "creator" },
      { "key": "held", "label": "Held", "ballInCourt": "creator" },
      { "key": "minutes_issued", "label": "Minutes Issued", "ballInCourt": "assignee" },
      { "key": "closed", "label": "Closed", "terminal": true, "ballInCourt": "none" },
      { "key": "cancelled", "label": "Cancelled", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "hold", "label": "Mark Held", "from": ["scheduled"], "to": "held",
        "expectedAction": "Publish the minutes", "dueInDays": 2,
        "requiresFields": ["attendance"],
        "requires": { "level": "standard", "privilege": "chair" } },
      { "key": "issue_minutes", "label": "Issue Minutes", "from": ["held"], "to": "minutes_issued",
        "expectedAction": "Review the minutes and raise corrections", "dueInDays": 5,
        "requiresFields": ["minutes"],
        "requires": { "level": "standard", "privilege": "chair" } },
      { "key": "close", "label": "Close", "from": ["minutes_issued"], "to": "closed",
        "requires": { "level": "standard", "privilege": "chair" } },
      { "key": "cancel", "label": "Cancel", "from": ["scheduled"], "to": "cancelled",
        "requires": { "level": "standard", "privilege": "create" } }
    ]
  }
}
$json$),

-- The catch-all, and the honest one. Plenty of work on a job is not an RFI or
-- a punch item, and forcing it into one of those distorts the record. A task
-- is a named person owing a named thing by a date, which is the smallest
-- useful unit of ball in court.
('task', 'tasks', 'Task', 'Tasks', 'TSK', $json$
{
  "fields": [
    { "key": "detail", "label": "What Needs Doing", "type": "multiline", "required": true },
    { "key": "priority", "label": "Priority", "type": "select",
      "options": ["Low", "Medium", "High", "Urgent"], "default": "Medium" },
    { "key": "category", "label": "Category", "type": "text" },
    { "key": "completion_note", "label": "Completion Note", "type": "multiline" }
  ],
  "workflow": {
    "initial": "open",
    "states": [
      { "key": "open", "label": "Open", "ballInCourt": "assignee" },
      { "key": "done", "label": "Done", "ballInCourt": "creator" },
      { "key": "closed", "label": "Closed", "terminal": true, "ballInCourt": "none" },
      { "key": "cancelled", "label": "Cancelled", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "complete", "label": "Mark Done", "from": ["open"], "to": "done",
        "expectedAction": "Confirm this is done",
        "requires": { "level": "standard", "participantRoles": ["assignee"] } },
      { "key": "reopen", "label": "Reopen", "from": ["done"], "to": "open",
        "expectedAction": "This is not finished yet",
        "requires": { "level": "standard", "privilege": "close" } },
      { "key": "close", "label": "Close", "from": ["done", "open"], "to": "closed",
        "requires": { "level": "standard", "privilege": "close" } },
      { "key": "cancel", "label": "Cancel", "from": ["open"], "to": "cancelled",
        "requires": { "level": "standard", "privilege": "close" } }
    ]
  }
}
$json$);

INSERT INTO record_type_versions (type_key, version, definition, note)
SELECT key, version, definition, 'Initial definition'
  FROM record_types WHERE key IN ('correspondence', 'meeting', 'task');
