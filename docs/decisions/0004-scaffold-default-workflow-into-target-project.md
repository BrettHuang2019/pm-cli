# ADR-0004: Scaffold Default Workflow Into Target Project

- Date: 2026-02-26
- Status: accepted
- Supersedes: none

## Context

`pm-cli` currently has a built-in workflow in code and can load workflow files from explicit paths, a project-local file, or a global default file. However, the built-in workflow is used in-memory and is not scaffolded into the newly created project folder during `pm inbox`.

This makes workflow behavior less visible to users and creates confusion about where the default workflow should live and be edited.

## Decision

`pm-cli` will provide a default workflow and scaffold it into the target project folder when `pm inbox` creates a new project.

The canonical project-local workflow file location is the target project folder (for example, `projects/<project-name>/pm.workflow.yaml`).
