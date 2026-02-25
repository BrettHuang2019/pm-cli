# ADR-0001: Chat-Driven ADR Capture

- Date: 2026-02-25
- Status: superseded
- Supersedes: none (superseded by ADR-0002)

## Context

The primary workflow is direct chat with Codex while building `pm-cli`. Decisions happen quickly in conversation and can be lost unless recorded immediately in a consistent format.

## Decision

Adopt a chat-first ADR workflow:

- The user sends a short `ADR:` block in chat when a decision is made.
- Codex creates and updates ADR files under `docs/decisions/`.
- Codex keeps `docs/decisions/README.md` index in sync.

## Alternatives Considered

- Manual ADR editing by the user after each session.
- Free-form notes in `plan.md` without formal ADR records.

## Consequences

- Positive: decisions are documented as part of normal chat flow.
- Negative: requires discipline to send an `ADR:` block for each durable decision.
- Follow-up: add a PR checklist item to require ADR link or explicit no-decision statement.
