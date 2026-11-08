// The exported page's file name, kept apart from VS Code so it's tested on its own.

/** A file name from the project's name: "Tool Shed" → "tool-shed-plan.html". */
export function pageFileName(project: string): string {
  const slug = project
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'plan'}-plan.html`;
}
