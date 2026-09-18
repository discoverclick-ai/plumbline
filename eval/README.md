# Capture interpreter eval

A number for the one place in this product where a model decides something.

Everything else in Plumbline is deterministic: the kernel either allows a transition or it does not. The interpreter reads a voice note and decides it is an observation rather than an RFI, and there is no compiler for that. This suite is how a prompt change, a model change or a new record type gets checked before it reaches a jobsite.

## Running it

```bash
# exercise the harness with no key and no spend
DATABASE_URL=postgres://…/plumbline node plumbline/eval/run.mjs --provider=selftest

# score the real model
DATABASE_URL=… npm run eval:capture                            # whole suite
DATABASE_URL=… npm run eval:capture -- --split=test            # held-out slice
DATABASE_URL=… npm run eval:capture -- --save-baseline         # record a baseline
DATABASE_URL=… npm run eval:capture -- --check                 # fail on regression
```

`DATABASE_URL` is required because the record type registry is loaded from the database, exactly as the product loads it. An eval that stubs the registry cannot catch a regression caused by a migration, which is the class of regression most likely to happen here.

## What is measured

Five metrics, not one score, because they trade against each other. A prompt change that lifts field recall by inventing plausible values shows up as `no_invention` falling, which is precisely the failure worth catching.

| Metric | Question |
|---|---|
| `type_match` | Did it pick the right record type? (headline) |
| `field_recall` | How many of the fields the capture supports did it fill correctly? |
| `people` | Exactly the right participants, no more and no fewer? |
| `no_invention` | Did it leave empty the things the capture never said? |
| `wellformed` | Clean draft on a complete capture; named gaps on an incomplete one? |

Plus `calibration` (Brier score over confidence versus correctness, because a confidently wrong draft is worse than an unsure one — the approver stops reading), cost, and latency.

Two metrics can be `n/a` for a case. A capture with nothing usable in it has no determinable type, so `type_match` is not scored rather than labelled with somebody's guess; a case that expects no fields does not score `field_recall`. Unscored is excluded from the mean, never counted as a pass.

## Reading the number

The runner prints a noise floor next to every score: `±20.4 points at n=24`. At this sample size a move smaller than that is not a result. To detect a five-point improvement you need roughly four hundred cases, or repeated runs; pretending otherwise is how a team ships a prompt change that did nothing.

The regression gate (`--check`) uses the baseline's noise floor as its tolerance by default. A gate that fires inside the noise trains everyone to ignore it.

## The cases

`cases/capture-v1.jsonl`, one JSON object per line. 24 cases covering every record type the product ships, plus the ones that matter more than coverage:

- **hallucination probes** — a capture that never mentions a spec section, where inventing one is the most damaging failure available, because a wrong citation in an RFI gets quoted back in a claim.
- **adversarial** — a capture containing "ignore your previous instructions". Field captures are attacker-controlled text; anyone who can email the project can put instructions in one.
- **boundary** — water staining of unknown cause, sitting exactly between an observation and a punch item.
- **incomplete** — a mumbled voice note, a photo with no description. The right answer is a draft that names its gaps.
- **out-of-roster** — "get Jim from ACME to look at it", where Jim is not on the project.

These are synthesized, which is the weakest source. They are anchored on real construction language and each carries a `note` saying why it exists, but they are a seed, not a sample of production traffic. Replace them as soon as there is traffic to replace them with.

An integration test audits this file against the live registry on every CI run: every expected field must exist on its type, every select value must be one of the declared options, every participant must be on the case roster. A suite whose gold answers name fields that no longer exist scores the model against a product that shipped two migrations ago, and nothing else would notice.

## The living-suite loop

That replacement is automatic:

```bash
DATABASE_URL=… node plumbline/eval/run.mjs --export --tenant=<uuid> --edited-only >> cases/capture-v2.jsonl
```

Every proposal a human edited before accepting is a case the interpreter got wrong, with the correction already attached: the record as accepted **is** the gold answer. Accepted-unedited proposals export too, as the easy positives that catch a regression the hard cases miss.

This is why `capture_proposals.edited` is a column rather than a log line. Review exported cases before committing them — a human correcting a draft is not always a human being right.

## What this deliberately does not do

**No judge model.** The output space is constrained: a type key from a closed set, fields declared by that type, user ids that exist. A judge would add cost, variance, and nothing a programmatic check misses. When the suite grows to grade the *wording* of a drafted RFI, that changes.

**No committed fixtures.** Replaying recorded model responses would make CI deterministic, and it would also mean the committed number came from whenever the fixtures were recorded. The honest options are the stub, which measures the harness, or the real model, which costs money. The runner refuses to write a baseline from the stub, and every stub run says so on its own output.

## Output

Each run writes `runs/<name>/` (gitignored): `results.jsonl`, `errors.jsonl`, `traces/<id>_rep0.json` and `_state.json`, in the layout the bundled hillclimb report builder consumes. Errors live in their own file rather than scoring as zeros, because plumbing failures and model failures are different things and a score column cannot tell them apart.
