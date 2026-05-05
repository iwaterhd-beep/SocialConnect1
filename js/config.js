/**
 * Configuración de Supabase — Social Connect V2
 * Edita aquí si cambias de proyecto.
 */
window.SC_CONFIG = {
  url: 'https://lkpyybmqvyhevcifezws.supabase.co',
  /**
   * Clave pública. Si el login falla siempre, en Supabase:
   * Project Settings → API → copia la clave "anon" "public" larga que empieza por eyJ...
   * y pégala en anonKeyLegacy (deja anonKey como está o al revés).
   */
  anonKey: 'sb_publishable_Qwso1wNWAMe0AYxXer97wg_XkGR_P0b',
  /** Opcional: clave anon JWT (eyJhbGciOi...) — misma página API */
  anonKeyLegacy: '',
  /**
   * Si escribes "admin" sin @, se usa admin@{loginEmailDomain}.
   * Evita *.local — Supabase Auth suele rechazar correos .local al crear usuario.
   */
  loginEmailDomain: 'example.com',

  /**
   * Carpeta de HTML parciales del panel club (dashboard-club.html).
   * Solo necesario si despliegas en un subdirectorio; por defecto "partials/".
   */
  partialsBase: 'partials/',
};
