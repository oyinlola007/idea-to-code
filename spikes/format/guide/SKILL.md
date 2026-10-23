---
name: plan
description: Read and update this project's plan in plan/ (features, flows, components, progress). Use whenever the user asks to plan a feature, add or change steps or flows, add detail under a step, mark work done or in progress, connect features, or asks what is planned, done or next.
---

# Project plan

The project's plan lives in `plan/` as YAML: `plan/map.yaml` (the overview) and `plan/features/*.yaml` (one file per feature, with flows you can drill into).

1. Read `plan/GUIDE.md` before changing anything. It defines the format and its rules.
2. Edit only the YAML files in `plan/`.
3. Never change an existing `id`; change `label` to rename.
4. Keep changes small and focused on what was asked.
5. Before finishing, check the files you changed against every rule in the guide's **Rules** section.
