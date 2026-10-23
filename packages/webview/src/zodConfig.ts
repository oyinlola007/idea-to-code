// zod probes for eval to speed up parsing; the webview's CSP forbids eval, so
// skip the probe. Imported before any schema is built (ITC-3 finding).
import { z } from 'zod';

z.config({ jitless: true });
