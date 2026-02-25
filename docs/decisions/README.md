# Architecture Decision Records (ADR)

This folder tracks durable technical decisions for `pm-cli`.

## How We Capture Decisions In Chat

Codex should detect ADR-worthy decisions from normal chat automatically.

Optional structured format (faster, but not required):

```text
ADR: <short title>
Context: <why this matters now>
Decision: <what we chose>
Alternatives: <option A>; <option B>
Consequences: <tradeoffs, risks, follow-up>
```

Codex workflow when a decision is detected:

1. Create a new ADR file from `_template.md` using the next number.
2. Fill the sections from your message.
3. Add the ADR to the index table in this file.
4. If this replaces an old decision, mark old ADR `Status: superseded` and link the new ADR.

Detection rules:

- Capture durable choices: architecture, project-wide workflow, major tool/library choices, contracts, and constraints.
- Skip non-durable execution chatter: temporary debugging steps, one-off commands, and status updates.
- If intent is unclear, ask one short confirmation question before writing ADR.

## Index

| ADR | Title | Date | Status | Supersedes |
| --- | --- | --- | --- | --- |
| [0001](./0001-chat-driven-adr-capture.md) | Chat-Driven ADR Capture | 2026-02-25 | superseded | none |
| [0002](./0002-implicit-adr-intent-detection.md) | Implicit ADR Intent Detection | 2026-02-25 | accepted | 0001 |
