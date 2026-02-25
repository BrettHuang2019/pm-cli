# ADR-0002: Implicit ADR Intent Detection

- Date: 2026-02-25
- Status: accepted
- Supersedes: 0001

## Context

Requiring a strict `ADR:` prefix adds friction to the normal chat workflow. The preferred interaction is natural conversation while still preserving durable decisions.

## Decision

Codex will detect ADR-worthy decisions from regular chat messages and update ADR files without requiring explicit user formatting.

## Alternatives Considered

- Keep strict `ADR:` message format as mandatory trigger.
- Ask the user to manually maintain ADR files after each session.

## Consequences

- Positive: lower friction; better alignment with natural collaboration.
- Negative: risk of false positives on ambiguous messages.
- Follow-up: ask one short confirmation question when decision intent is ambiguous.

