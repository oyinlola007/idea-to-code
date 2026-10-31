// Which files count as a plan. Pure, so the rule that decides what the custom
// editor keeps is tested without an editor.

const PLAN_FILE = /^plan\/(map\.yaml|features\/[^/]+\.yaml)$/;

/** The file's path inside the folder, if it's a plan file there. Paths use forward slashes, as in a Uri. */
export function planFileIn(folderPath: string, filePath: string): string | undefined {
  const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
  if (!filePath.startsWith(prefix)) return undefined;
  const relative = filePath.slice(prefix.length);
  return PLAN_FILE.test(relative) ? relative : undefined;
}

/** Any folder can be called `plan`; a real plan's map says what project it's for, even when the rest of the file is broken. */
export function looksLikePlan(mapText: string | null): boolean {
  return mapText !== null && /^project\s*:/m.test(mapText);
}

/** The feature a plan file belongs to, if it isn't the map. */
export function featureOfPlanFile(planFile: string): string | undefined {
  return /^plan\/features\/([^/]+)\.yaml$/.exec(planFile)?.[1];
}
