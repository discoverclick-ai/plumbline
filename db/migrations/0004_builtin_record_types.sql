-- 0004 · built-in record types
--
-- Five tools, zero new tables. Each row below is an entire product surface:
-- the fields a user fills in, the states the work moves through, who owes the
-- next action in each state, and what permission a transition demands.
--
-- The `requires` block on a transition is the whole authorization story for
-- that action: a minimum permission level on the type's tool, optionally a
-- granular privilege, optionally a role the actor must hold ON THIS RECORD.
-- Company administrators bypass the level check (see resolvePermissions) but
-- never the field and state checks — an admin still cannot answer an RFI that
-- has no answer written.
--
-- `ballInCourt` on a state resolves against the record's participants:
-- 'creator' | 'assignee' | 'reviewer' | 'approver' | 'none'.

INSERT INTO record_types (key, tool_key, display_name, display_name_plural, number_prefix, definition) VALUES
('rfi', 'rfis', 'RFI', 'RFIs', 'RFI', $json$
{
  "fields": [
    { "key": "question", "label": "Question", "type": "multiline", "required": true },
    { "key": "discipline", "label": "Discipline", "type": "select",
      "options": ["Architectural", "Structural", "Mechanical", "Electrical", "Plumbing", "Civil", "Other"] },
    { "key": "drawing_number", "label": "Drawing Number", "type": "text" },
    { "key": "spec_section", "label": "Spec Section", "type": "text" },
    { "key": "cost_impact", "label": "Cost Impact", "type": "select", "options": ["Yes", "No", "TBD"], "default": "TBD" },
    { "key": "schedule_impact", "label": "Schedule Impact", "type": "select", "options": ["Yes", "No", "TBD"], "default": "TBD" },
    { "key": "answer", "label": "Official Response", "type": "multiline" }
  ],
  "workflow": {
    "initial": "draft",
    "states": [
      { "key": "draft", "label": "Draft", "ballInCourt": "creator" },
      { "key": "open", "label": "Open", "ballInCourt": "assignee" },
      { "key": "answered", "label": "Answered", "ballInCourt": "creator" },
      { "key": "closed", "label": "Closed", "terminal": true, "ballInCourt": "none" },
      { "key": "void", "label": "Void", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "submit", "label": "Submit", "from": ["draft"], "to": "open",
        "expectedAction": "Answer this RFI", "dueInDays": 7,
        "requires": { "level": "standard", "participantRoles": ["creator"] } },
      { "key": "answer", "label": "Answer", "from": ["open"], "to": "answered",
        "expectedAction": "Review the response and close",
        "requiresFields": ["answer"],
        "requires": { "level": "standard", "privilege": "respond" } },
      { "key": "close", "label": "Close", "from": ["open", "answered"], "to": "closed",
        "requires": { "level": "standard", "privilege": "close" } },
      { "key": "reopen", "label": "Reopen", "from": ["closed"], "to": "open",
        "expectedAction": "Answer this RFI",
        "requires": { "level": "standard", "privilege": "close" } },
      { "key": "void", "label": "Void", "from": ["draft", "open", "answered"], "to": "void",
        "requires": { "level": "admin" } }
    ]
  }
}
$json$),

('submittal', 'submittals', 'Submittal', 'Submittals', 'SUB', $json$
{
  "fields": [
    { "key": "spec_section", "label": "Spec Section", "type": "text", "required": true },
    { "key": "submittal_type", "label": "Type", "type": "select",
      "options": ["Product Data", "Shop Drawing", "Sample", "Mock-up", "Certificate", "Test Report", "Other"] },
    { "key": "description", "label": "Description", "type": "multiline", "required": true },
    { "key": "revision", "label": "Revision", "type": "number", "default": 0 },
    { "key": "review_comments", "label": "Review Comments", "type": "multiline" }
  ],
  "workflow": {
    "initial": "draft",
    "states": [
      { "key": "draft", "label": "Draft", "ballInCourt": "creator" },
      { "key": "submitted", "label": "Submitted", "ballInCourt": "reviewer" },
      { "key": "approved", "label": "Approved", "terminal": true, "ballInCourt": "none" },
      { "key": "approved_as_noted", "label": "Approved as Noted", "terminal": true, "ballInCourt": "none" },
      { "key": "revise_and_resubmit", "label": "Revise and Resubmit", "ballInCourt": "creator" },
      { "key": "rejected", "label": "Rejected", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "submit", "label": "Submit for Review", "from": ["draft", "revise_and_resubmit"], "to": "submitted",
        "expectedAction": "Review this submittal", "dueInDays": 14,
        "requires": { "level": "standard", "participantRoles": ["creator"] } },
      { "key": "approve", "label": "Approve", "from": ["submitted"], "to": "approved",
        "requires": { "level": "standard", "privilege": "review" } },
      { "key": "approve_as_noted", "label": "Approve as Noted", "from": ["submitted"], "to": "approved_as_noted",
        "requiresFields": ["review_comments"],
        "requires": { "level": "standard", "privilege": "review" } },
      { "key": "revise", "label": "Revise and Resubmit", "from": ["submitted"], "to": "revise_and_resubmit",
        "expectedAction": "Revise and resubmit",
        "requiresFields": ["review_comments"],
        "requires": { "level": "standard", "privilege": "review" } },
      { "key": "reject", "label": "Reject", "from": ["submitted"], "to": "rejected",
        "requiresFields": ["review_comments"],
        "requires": { "level": "standard", "privilege": "review" } }
    ]
  }
}
$json$),

('punch_item', 'punch_list', 'Punch Item', 'Punch List', 'PI', $json$
{
  "fields": [
    { "key": "description", "label": "Description", "type": "multiline", "required": true },
    { "key": "location", "label": "Location", "type": "text" },
    { "key": "trade", "label": "Trade", "type": "text" },
    { "key": "priority", "label": "Priority", "type": "select", "options": ["Low", "Medium", "High"], "default": "Medium" },
    { "key": "rejection_reason", "label": "Rejection Reason", "type": "multiline" }
  ],
  "workflow": {
    "initial": "draft",
    "states": [
      { "key": "draft", "label": "Draft", "ballInCourt": "creator" },
      { "key": "open", "label": "Open", "ballInCourt": "assignee" },
      { "key": "ready_for_review", "label": "Ready for Review", "ballInCourt": "reviewer" },
      { "key": "closed", "label": "Closed", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "issue", "label": "Issue", "from": ["draft"], "to": "open",
        "expectedAction": "Complete this work", "dueInDays": 14,
        "requires": { "level": "standard", "participantRoles": ["creator"] } },
      { "key": "mark_complete", "label": "Mark Complete", "from": ["open"], "to": "ready_for_review",
        "expectedAction": "Verify the completed work",
        "requires": { "level": "standard", "participantRoles": ["assignee"] } },
      { "key": "accept", "label": "Accept Work", "from": ["ready_for_review"], "to": "closed",
        "requires": { "level": "standard", "privilege": "verify" } },
      { "key": "reject", "label": "Reject Work", "from": ["ready_for_review"], "to": "open",
        "expectedAction": "Rework and resubmit",
        "requiresFields": ["rejection_reason"],
        "requires": { "level": "standard", "privilege": "verify" } }
    ]
  }
}
$json$),

('observation', 'observations', 'Observation', 'Observations', 'OBS', $json$
{
  "fields": [
    { "key": "description", "label": "Description", "type": "multiline", "required": true },
    { "key": "observation_type", "label": "Type", "type": "select",
      "options": ["Safety", "Quality", "Work to Complete", "Commissioning", "Warranty"], "default": "Safety" },
    { "key": "location", "label": "Location", "type": "text" },
    { "key": "priority", "label": "Priority", "type": "select", "options": ["Low", "Medium", "High"], "default": "Medium" },
    { "key": "resolution", "label": "Resolution", "type": "multiline" }
  ],
  "workflow": {
    "initial": "draft",
    "states": [
      { "key": "draft", "label": "Draft", "ballInCourt": "creator" },
      { "key": "open", "label": "Open", "ballInCourt": "assignee" },
      { "key": "ready_for_review", "label": "Ready for Review", "ballInCourt": "creator" },
      { "key": "closed", "label": "Closed", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "issue", "label": "Issue", "from": ["draft"], "to": "open",
        "expectedAction": "Resolve this observation", "dueInDays": 3,
        "requires": { "level": "standard", "participantRoles": ["creator"] } },
      { "key": "resolve", "label": "Mark Resolved", "from": ["open"], "to": "ready_for_review",
        "expectedAction": "Confirm the resolution",
        "requiresFields": ["resolution"],
        "requires": { "level": "standard", "participantRoles": ["assignee"] } },
      { "key": "close", "label": "Close", "from": ["ready_for_review", "open"], "to": "closed",
        "requires": { "level": "standard", "privilege": "close" } },
      { "key": "reopen", "label": "Reopen", "from": ["ready_for_review"], "to": "open",
        "expectedAction": "Resolve this observation",
        "requires": { "level": "standard", "privilege": "close" } }
    ]
  }
}
$json$),

('daily_log', 'daily_log', 'Daily Log', 'Daily Logs', 'LOG', $json$
{
  "fields": [
    { "key": "log_date", "label": "Date", "type": "date", "required": true },
    { "key": "weather", "label": "Weather", "type": "text" },
    { "key": "temperature_f", "label": "Temperature (F)", "type": "number" },
    { "key": "manpower_count", "label": "Workers On Site", "type": "number" },
    { "key": "work_performed", "label": "Work Performed", "type": "multiline", "required": true },
    { "key": "delays", "label": "Delays", "type": "multiline" }
  ],
  "workflow": {
    "initial": "draft",
    "states": [
      { "key": "draft", "label": "Draft", "ballInCourt": "creator" },
      { "key": "submitted", "label": "Submitted", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "submit", "label": "Submit", "from": ["draft"], "to": "submitted",
        "requires": { "level": "standard", "participantRoles": ["creator"] } }
    ]
  }
}
$json$);
