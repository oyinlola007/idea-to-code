// Component kinds → codicons (VS Code's own icon set, so the chart reads as
// part of the editor). Unknown kinds get a generic box.
const KIND_ICONS: [RegExp, string][] = [
  [/^(database|db|sql|table)s?$/, 'database'],
  [/^(server|backend|api-server)$/, 'server'],
  [/^(service|microservice|function|lambda)$/, 'server-process'],
  [/^(queue|topic|stream|bus|event-bus)$/, 'list-ordered'],
  [/^(cache|redis)$/, 'zap'],
  [/^(external-api|api|third-party|webhook)$/, 'globe'],
  [/^(client|frontend|web|web-app|ui|browser)$/, 'browser'],
  [/^(mobile|app|ios|android)$/, 'device-mobile'],
  [/^(llm|ai|model|ml)$/, 'sparkle'],
  [/^(storage|bucket|blob|file|files|object-storage)$/, 'archive'],
  [/^(auth|identity|iam|sso)$/, 'key'],
  [/^(email|mail|smtp|inbox)$/, 'mail'],
  [/^(worker|job|cron|scheduler)$/, 'gear'],
  [/^(cloud|cdn|hosting)$/, 'cloud'],
];

export function kindIcon(kind: string | undefined): string {
  const k = (kind ?? '').toLowerCase();
  return KIND_ICONS.find(([re]) => re.test(k))?.[1] ?? 'package';
}

export function kindLabel(kind: string | undefined): string {
  return (kind ?? 'component').replace(/-/g, ' ');
}
