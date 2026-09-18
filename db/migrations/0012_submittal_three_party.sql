-- 0012 · the submittal workflow as it is actually run
--
-- The submittal shipped in 0004 was a two party workflow: the subcontractor
-- submits, a reviewer answers. Nobody in construction runs it that way, and a
-- project engineer would spot it in ten seconds. The real thing is three
-- party, and the missing party is the general contractor, who is not a passive
-- pipe in the middle.
--
--   1. The sub prepares and submits to the GC.
--   2. The GC reviews FIRST, for completeness, contract conformance and
--      coordination with other trades. Plenty of submittals die here and never
--      reach the architect at all, which is the GC doing their job.
--   3. The GC forwards to the architect or engineer of record.
--   4. The design team returns a disposition. Approved, approved as noted,
--      revise and resubmit, rejected, or for record only.
--   5. The GC receives it back and distributes it to the sub. This step is not
--      ceremony: until the sub has the stamped copy in hand they cannot order
--      material, and "the architect approved it three weeks ago" is not a
--      defence when the steel is late.
--   6. Revise and resubmit sends it back to step 1 as a new revision.
--
-- Modelled with the four participant roles the kernel already has: creator is
-- the sub, assignee is the GC's submittal coordinator, reviewer is the design
-- team, approver is a second tier reviewer such as a structural consultant.
--
-- Two fields are new and they are the ones that make a submittal matter to the
-- schedule rather than to a filing cabinet: lead_time_days and
-- required_on_site. A submittal is a procurement clock, and the only reason
-- anybody chases one is that material cannot be ordered until it clears.

-- Refuse to run if live records sit in a status this definition removes. The
-- application has publishRecordType for this check; a migration that quietly
-- strands records would make a liar of it.
DO $$
DECLARE
    stranded TEXT;
BEGIN
    SELECT string_agg(DISTINCT status, ', ') INTO stranded
      FROM records
     WHERE type_key = 'submittal'
       AND status NOT IN ('draft', 'revise_and_resubmit', 'rejected', 'void');

    IF stranded IS NOT NULL THEN
        RAISE EXCEPTION
            'Cannot migrate submittals: records are sitting in %, which this definition replaces. Move them first, or publish with force through publishRecordType.',
            stranded;
    END IF;
END $$;

INSERT INTO tool_privileges (tool_key, privilege, description) VALUES
    ('submittals', 'forward', 'Forward a submittal to the design team and distribute the response')
ON CONFLICT DO NOTHING;

UPDATE record_types SET version = 2, definition = $json$
{
  "fields": [
    { "key": "spec_section", "label": "Spec Section", "type": "text", "required": true },
    { "key": "submittal_type", "label": "Type", "type": "select",
      "options": ["Product Data", "Shop Drawing", "Sample", "Mock-up", "Certificate", "Test Report", "Other"] },
    { "key": "description", "label": "Description", "type": "multiline", "required": true },
    { "key": "revision", "label": "Revision", "type": "number" },
    { "key": "lead_time_days", "label": "Lead Time (days)", "type": "number" },
    { "key": "required_on_site", "label": "Required On Site", "type": "date" },
    { "key": "gc_comments", "label": "Contractor Comments", "type": "multiline" },
    { "key": "review_comments", "label": "Review Comments", "type": "multiline" }
  ],
  "workflow": {
    "initial": "draft",
    "states": [
      { "key": "draft", "label": "Draft", "ballInCourt": "creator" },
      { "key": "contractor_review", "label": "Contractor Review", "ballInCourt": "assignee" },
      { "key": "design_review", "label": "Design Team Review", "ballInCourt": "reviewer" },
      { "key": "approved", "label": "Approved", "ballInCourt": "assignee" },
      { "key": "approved_as_noted", "label": "Approved as Noted", "ballInCourt": "assignee" },
      { "key": "for_record_only", "label": "For Record Only", "ballInCourt": "assignee" },
      { "key": "rejected", "label": "Rejected", "ballInCourt": "assignee" },
      { "key": "revise_and_resubmit", "label": "Revise and Resubmit", "ballInCourt": "creator" },
      { "key": "closed", "label": "Closed", "terminal": true, "ballInCourt": "none" },
      { "key": "void", "label": "Void", "terminal": true, "ballInCourt": "none" }
    ],
    "transitions": [
      { "key": "submit", "label": "Submit to Contractor", "from": ["draft"], "to": "contractor_review",
        "expectedAction": "Review this submittal and forward it to the design team", "dueInDays": 7,
        "requires": { "level": "standard", "participantRoles": ["creator"] } },

      { "//": "No default on revision, deliberately: a defaulted field is filled in by normalizeBody, so requiresFields can never force anybody to state it.",
        "key": "resubmit", "label": "Resubmit", "from": ["revise_and_resubmit"], "to": "contractor_review",
        "expectedAction": "Review this revision and forward it to the design team", "dueInDays": 7,
        "requiresFields": ["revision", "description"],
        "requires": { "level": "standard", "participantRoles": ["creator"] } },

      { "key": "return_to_sub", "label": "Return Without Forwarding", "from": ["contractor_review"], "to": "revise_and_resubmit",
        "expectedAction": "Correct this and resubmit",
        "requiresFields": ["gc_comments"],
        "requires": { "level": "standard", "privilege": "forward" } },

      { "key": "forward", "label": "Forward to Design Team", "from": ["contractor_review"], "to": "design_review",
        "expectedAction": "Return a disposition on this submittal", "dueInDays": 14,
        "requires": { "level": "standard", "privilege": "forward" } },

      { "key": "approve", "label": "Approved", "from": ["design_review"], "to": "approved",
        "expectedAction": "Distribute the stamped copy to the subcontractor", "dueInDays": 3,
        "requires": { "level": "standard", "privilege": "review" } },
      { "key": "approve_as_noted", "label": "Approved as Noted", "from": ["design_review"], "to": "approved_as_noted",
        "expectedAction": "Distribute the stamped copy to the subcontractor", "dueInDays": 3,
        "requiresFields": ["review_comments"],
        "requires": { "level": "standard", "privilege": "review" } },
      { "key": "for_record", "label": "For Record Only", "from": ["design_review"], "to": "for_record_only",
        "expectedAction": "File this and tell the subcontractor", "dueInDays": 3,
        "requires": { "level": "standard", "privilege": "review" } },
      { "key": "revise", "label": "Revise and Resubmit", "from": ["design_review"], "to": "rejected",
        "expectedAction": "Send the review comments back to the subcontractor", "dueInDays": 3,
        "requiresFields": ["review_comments"],
        "requires": { "level": "standard", "privilege": "review" } },
      { "key": "reject", "label": "Rejected", "from": ["design_review"], "to": "rejected",
        "expectedAction": "Send the review comments back to the subcontractor", "dueInDays": 3,
        "requiresFields": ["review_comments"],
        "requires": { "level": "standard", "privilege": "review" } },

      { "key": "distribute", "label": "Distribute to Subcontractor",
        "from": ["approved", "approved_as_noted", "for_record_only"], "to": "closed",
        "requires": { "level": "standard", "privilege": "forward" } },
      { "key": "send_back", "label": "Send Back for Revision",
        "from": ["rejected"], "to": "revise_and_resubmit",
        "expectedAction": "Revise this and resubmit",
        "requires": { "level": "standard", "privilege": "forward" } },

      { "key": "void", "label": "Void", "from": ["draft", "contractor_review", "revise_and_resubmit"], "to": "void",
        "requires": { "level": "admin" } }
    ]
  }
}
$json$
WHERE key = 'submittal';

INSERT INTO record_type_versions (type_key, version, definition, note)
SELECT key, version, definition, 'Three party workflow: sub to contractor to design team and back'
  FROM record_types WHERE key = 'submittal';
