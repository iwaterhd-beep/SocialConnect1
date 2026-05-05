/**
 * Cliente global de Supabase (tras cargar el UMD de @supabase/supabase-js).
 */
(function () {
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('Supabase JS no está cargado. Incluye el script CDN antes de supabase-client.js');
    return;
  }
  const cfg = window.SC_CONFIG;
  var apiKey =
    (cfg.anonKeyLegacy && String(cfg.anonKeyLegacy).trim()) || cfg.anonKey;
  window.scSupabase = window.supabase.createClient(cfg.url, apiKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
})();
