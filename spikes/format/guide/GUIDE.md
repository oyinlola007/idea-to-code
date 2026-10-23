# Plan format guide

This folder holds the project's plan: what the app does, feature by feature, as flowcharts you can drill into. People read it as charts in the idea-to-code app. Coding agents read and update the YAML directly. Keep it accurate: it is the shared picture of what exists, what is done and what is next.

## Files

```
plan/
  map.yaml                 # the overview: features, shared components, how features connect
  features/<feature-id>.yaml   # one file per feature: its flows
  GUIDE.md                 # this guide
```

## map.yaml

```yaml
project: Career Manager
description: One-line summary of the app.
features:                  # the overview, in this order
  - id: job-search
    label: Job search and tailored applications
    description: Optional, one or two sentences.
components:                # optional: building blocks several features share
  - id: app-database
    label: App database
    kind: database
    tech: PostgreSQL
connections:               # how features feed each other ("flows into")
  - from: job-search
    to: application-tracker
    data: application record
```

## features/<feature-id>.yaml

```yaml
feature: job-search        # must match the file name and an id in map.yaml
flows:
  main:                    # required: the feature's top-level flow
    label: Job search
    nodes:
      - id: search-jobs
        type: step
        label: Search jobs
        status: done
      - id: good-fit
        type: decision
        label: Good fit?
      - id: tailor-cv
        type: step
        label: Tailor CV
        expands: tailor-cv-flow
      - id: cv-llm
        type: reference
        label: LLM API
        ref: llm-api
    edges:
      - from: search-jobs
        to: good-fit
      - from: good-fit
        to: tailor-cv
        label: "yes"
      - from: tailor-cv
        to: cv-llm
        data: job description + profile
  tailor-cv-flow:          # a more detailed flow, opened from the "tailor-cv" node
    label: Tailor CV
    nodes:
      - id: parse-job
        type: step
        label: Extract requirements
        status: in_progress
    edges: []
```

Write one field per line, as above. If you do use inline `{ ... }` style, put any value containing a comma, colon or `#` in quotes: `{ id: a, type: step, label: "Collect CV, cover letter and answers" }`. An unquoted comma inside `{ }` silently breaks the file.

## Node types

| type | use it for | extra fields |
|---|---|---|
| `step` | something the app or user does | `status`, `expands` |
| `decision` | a yes/no or multi-way branch; label its outgoing edges | none |
| `start`, `end` | where a flow begins or finishes (optional) | none |
| `component` | a piece of the system: database, server, queue, service, external API… | `kind` (required, any word), `tech`, `status`, `expands` |
| `reference` | something defined elsewhere: another feature, a flow, or a shared component | `ref` (required) |

Every node has `id`, `type` and `label` (`start` and `end` may leave out `label`); `description` is optional. Put decisions and their reasons in `description` (e.g. "Only PDF upload in v1, because…").

## Rules

1. **Every `id` is unique in the whole plan**: features, components, flows and nodes. Use lowercase words joined by hyphens: `tailor-cv`.
2. **Never change an existing `id`.** To rename something, change its `label`. History and links depend on ids.
3. **Status** is `todo`, `in_progress` or `done`, and only on `step` and `component` nodes. No status means `todo`. Don't put a status on `decision`, `start`, `end` or `reference`.
4. **A node with a child flow** (`expands`) gets its progress from that flow. Don't give it a status; mark the steps inside the child flow instead.
5. **Child flows:** `expands` names a flow in the same file. Each flow other than `main` is opened from exactly one node. Never expand `main`. To show the same flow in two places, use a `reference` node.
6. **Edges** connect nodes of the same flow. No duplicate edges, no edge from a node to itself. Edges leaving a `decision` should have a `label` ("yes", "no", …).
7. **`data`** on an edge or connection says what is passed along ("application record"). Add it whenever it is not obvious.
8. **Features:** every file in `features/` must be listed under `features` in `map.yaml`. A listed feature without a file is fine: it just has no flows yet.
9. **A feature's top-level flow** is referred to by the feature's id (e.g. `ref: job-search`), not by `main`.
10. **Only these keys exist.** Unknown keys (typos like `stauts`) make the file invalid.

## Common tasks

- **Mark work done:** set `status: done` on the step or component. If it has a child flow, mark the steps inside that flow.
- **Add detail under a step:** pick a flow key (e.g. `<node-id>-flow`), add `expands: <flow-key>` to the node, and add the flow under `flows:` with `label`, `nodes` and `edges`. Remove any `status` from the parent node.
- **Add a feature:** add it under `features` in `map.yaml`, create `features/<id>.yaml` with `feature: <id>` and a `main` flow, and add `connections` to the features it feeds.
- **Use a shared component in a flow:** add a `reference` node with `ref: <component-id>`.

Before finishing, check every rule above against the files you changed.
