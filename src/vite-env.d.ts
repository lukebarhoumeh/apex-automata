/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RUNTIME_API_URL?: string;
  readonly VITE_RUNTIME_WS_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_SUPABASE_PROJECT_ID?: string;
  readonly VITE_DEBUG_WS?: string;
  readonly VITE_DEBUG_REALTIME?: string;
  readonly VITE_DEBUG_EVENT_BUS?: string;
  /** `'1'` builds a static shareable UI with no live runtime. */
  readonly VITE_UI_PREVIEW?: string;
  readonly VITE_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
