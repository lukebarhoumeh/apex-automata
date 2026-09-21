/**
 * Side-effect import that MUST be the first import of `main.tsx`.
 * Wraps `window.fetch` before `@supabase/supabase-js` (and anything else)
 * can capture the original fetch at module init.
 */
import { installUiPreviewFetch } from "./ui-preview";

installUiPreviewFetch();
