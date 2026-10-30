// plan/GUIDE.md and the plan skill: what any coding agent or person reads to
// update a plan correctly. Node fields, status values and tool names come from
// the code, so they can't drift. The wording was proven in the ITC-2 agent runs.
import { OPERATIONS } from './opDefinitions.js';
import { ComponentNode, DecisionNode, EndNode, ReferenceNode, StartNode, Status, StepNode, type NodeType } from './schema.js';

const BASE_FIELDS = new Set(['id', 'type', 'label', 'description']);

interface NodeDoc {
  type: NodeType;
  use: string;
  shape: Record<string, { isOptional(): boolean }>;
}

const NODE_DOCS: NodeDoc[] = [
  { type: 'step', use: 'something the app or user does', shape: StepNode.shape },
  { type: 'decision', use: 'a yes/no or multi-way branch; label its outgoing edges', shape: DecisionNode.shape },
  { type: 'start', use: 'where a flow begins (optional)', shape: StartNode.shape },
  { type: 'end', use: 'where a flow finishes (optional)', shape: EndNode.shape },
  { type: 'component', use: 'a piece of the system: database, server, queue, service, external API…', shape: ComponentNode.shape },
  { type: 'reference', use: 'something defined elsewhere: another feature, a flow, or a shared component', shape: ReferenceNode.shape },
];

const EXTRA_NOTES: Record<string, string> = { kind: 'any word' };

function extraFields(doc: NodeDoc): string {
  const extras = Object.entries(doc.shape)
    .filter(([name]) => !BASE_FIELDS.has(name))
    .sort(([, a], [, b]) => Number(a.isOptional()) - Number(b.isOptional()))
    .map(([name, schema]) => {
      const notes = [schema.isOptional() ? '' : 'required', EXTRA_NOTES[name] ?? ''].filter(Boolean).join(', ');
      return `\`${name}\`${notes ? ` (${notes})` : ''}`;
    });
  return extras.join(', ') || 'none';
}

const code = (values: readonly string[], joiner: string) => {
  const quoted = values.map((v) => `\`${v}\``);
  const last = quoted.pop() ?? '';
  return quoted.length > 0 ? `${quoted.join(', ')}${joiner}${last}` : last;
};

export function generateGuide(): string {
  const nodeRows = NODE_DOCS.map((d) => `| \`${d.type}\` | ${d.use} | ${extraFields(d)} |`).join('\n');
  const noStatus = NODE_DOCS.filter((d) => !('status' in d.shape)).map((d) => d.type);
  const withStatus = NODE_DOCS.filter((d) => 'status' in d.shape).map((d) => d.type);
  const tools = OPERATIONS.map((o) => `\`${o.name}\``).join(', ');
  return `# Plan format guide

This folder holds the project's plan: what the app does, feature by feature, as flowcharts you can drill into. People read it as charts in the idea-to-code app. Coding agents read and update it. Keep it accurate: it is the shared picture of what exists, what is done and what is next.

**If the idea-to-code MCP tools are available, prefer them to editing these files.** They check every change and report what to fix: ${tools}. Otherwise, edit the YAML directly as described here.

## Files

\`\`\`
plan/
  map.yaml                 # the overview: features, shared components, how features connect
  features/<feature-id>.yaml   # one file per feature: its flows
  GUIDE.md                 # this guide
\`\`\`

## map.yaml

\`\`\`yaml
project: Toolshed
description: One-line summary of the app.
features:                  # the overview, in this order
  - id: bookings
    label: Bookings
    description: Optional, one or two sentences.
  - id: handover
    label: Pickup and return
components:                # optional: building blocks several features share
  - id: payments-api
    label: Payments API
    kind: external-api
    tech: Stripe
connections:               # how features feed each other ("flows into")
  - from: bookings
    to: handover
    data: confirmed booking
\`\`\`

## features/<feature-id>.yaml

\`\`\`yaml
feature: bookings          # must match the file name and an id in map.yaml
flows:
  main:                    # required: the feature's top-level flow
    label: Bookings
    nodes:
      - id: bookings-start
        type: start
      - id: pick-dates
        type: step
        label: Pick dates
        description: Only whole days in v1, because owners hand tools over in person.
        status: done
      - id: tool-available
        type: decision
        label: Tool available?
      - id: place-booking
        type: step
        label: Place booking
        expands: place-booking-flow
      - id: payments
        type: reference
        label: Payments API
        ref: payments-api
      - id: booking-queue
        type: component
        label: Booking queue
        kind: queue
        tech: SQS
        status: todo
      - id: bookings-end
        type: end
        label: Booking placed
    edges:
      - from: bookings-start
        to: pick-dates
      - from: pick-dates
        to: tool-available
      - from: tool-available
        to: place-booking
        label: "yes"
      - from: place-booking
        to: payments
        data: amount + booking id
      - from: tool-available
        to: bookings-end
        label: "no"
      - from: payments
        to: booking-queue
        data: paid booking
      - from: booking-queue
        to: bookings-end
  place-booking-flow:      # a more detailed flow, opened from the "place-booking" node
    label: Place booking
    nodes:
      - id: hold-tool
        type: step
        label: Hold the tool for the dates
        status: in_progress
    edges: []
\`\`\`

Write one field per line, as above. If you do use inline \`{ ... }\` style, put any value containing a comma, colon or \`#\` in quotes: \`{ id: a, type: step, label: "Bring gloves, goggles and a ladder" }\`. An unquoted comma inside \`{ }\` silently breaks the file.

## Node types

| type | use it for | extra fields |
|---|---|---|
${nodeRows}

Every node has \`id\`, \`type\` and \`label\` (\`start\` and \`end\` may leave out \`label\`); \`description\` is optional. Put decisions and their reasons in \`description\` (e.g. "Only card payments in v1, because…").

## Rules

1. **Every \`id\` is unique in the whole plan**: features, components, flows and nodes. Use lowercase words joined by hyphens: \`place-booking\`.
2. **Never change an existing \`id\`.** To rename something, change its \`label\`. History and links depend on ids.
3. **Status** is ${code(Status.options, ' or ')}, and only on ${code(withStatus, ' and ')} nodes. No status means \`todo\`. Don't put a status on ${code(noStatus, ' or ')}.
4. **A node with a child flow** (\`expands\`) gets its progress from that flow. Don't give it a status; mark the steps inside the child flow instead.
5. **Child flows:** \`expands\` names a flow in the same file. Each flow other than \`main\` is opened from exactly one node. Never expand \`main\`. To show the same flow in two places, use a \`reference\` node.
6. **Edges** mean "flows into", and connect nodes of the same flow. No duplicate edges, no edge from a node to itself. Edges leaving a \`decision\` should have a \`label\` ("yes", "no", …).
7. **\`data\`** on an edge or connection says what is passed along ("confirmed booking"). Add it whenever it is not obvious.
8. **Features:** every file in \`features/\` must be listed under \`features\` in \`map.yaml\`. A listed feature without a file is fine: it just has no flows yet.
9. **A feature's top-level flow** is referred to by the feature's id (e.g. \`ref: bookings\`), not by \`main\`.
10. **Only these keys exist.** Unknown keys (typos like \`stauts\`) make the file invalid.
11. **Shared components:** check \`components\` in \`map.yaml\` first. When a flow uses one, add a \`reference\` node for it, connected by edges, rather than only naming it in a step's label ("Send via SMS service"). Otherwise the chart can't show what depends on it.

## Common tasks

- **Mark work done:** set \`status: done\` on the step or component. If it has a child flow, mark the steps inside that flow.
- **Add detail under a step:** pick a flow key (e.g. \`<node-id>-flow\`), add \`expands: <flow-key>\` to the node, and add the flow under \`flows:\` with \`label\`, \`nodes\` and \`edges\`. Remove any \`status\` from the parent node.
- **Add a feature:** add it under \`features\` in \`map.yaml\`, create \`features/<id>.yaml\` with \`feature: <id>\` and a \`main\` flow, and add \`connections\` to the features it feeds.
- **Use a shared component in a flow:** add a \`reference\` node with \`ref: <component-id>\`.

## Checking your work

The app and the MCP tools validate every plan and report the file, line and reason for any problem. Without them, check every rule above against the files you changed before finishing.
`;
}

export function generateSkill(marker: string): string {
  return `---
name: plan
description: Read and update this project's plan in plan/ (features, flows, components, progress). Use whenever the user asks to plan a feature, add or change steps or flows, add detail under a step, mark work done or in progress, connect features, or asks what is planned, done or next.
---

${marker}

# Project plan

The project's plan lives in \`plan/\` as YAML: \`plan/map.yaml\` (the overview) and \`plan/features/*.yaml\` (one file per feature, with flows you can drill into).

1. Read \`plan/GUIDE.md\` before changing anything. It defines the format and its rules.
2. If the idea-to-code MCP tools are available, use them. Otherwise edit only the YAML files in \`plan/\`.
3. Never change an existing \`id\`; change \`label\` to rename.
4. Keep changes small and focused on what was asked.
5. Before finishing, check the files you changed against every rule in the guide's **Rules** section.
`;
}
