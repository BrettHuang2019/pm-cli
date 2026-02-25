# Project Agent Instructions

## ADR Maintenance Rule

Detect ADR intent from normal chat messages. Do not require the user to prefix with `ADR:`.

Required actions:

1. Create a new ADR file in `docs/decisions/` using the next number and `_template.md`.
2. Update `docs/decisions/README.md` index table.
3. If the new ADR replaces an old one, set old ADR status to `superseded` and set `Supersedes` in the new ADR.

Scope:

- Record durable technical decisions only.
- Do not create ADRs for routine task execution details.

Detection signals (any strong match should trigger ADR capture):

- User states a final choice among alternatives (`we will`, `let's use`, `decide to`, `go with`).
- User sets a project-wide policy, constraint, interface contract, or workflow rule.
- User explicitly asks to keep/record a decision.

Ambiguity handling:

- If message may be a suggestion rather than a final decision, ask one short confirmation question before creating ADR.
