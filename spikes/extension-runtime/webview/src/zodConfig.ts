// zod probes for eval to speed up parsing; the webview's CSP forbids eval, so
// skip the probe. Imported before any schema is built.
import { z } from 'zod';

z.config({ jitless: true });
