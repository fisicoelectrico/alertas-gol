// Configuración pública del frontend. Aquí NO hay secretos:
// la PWA solo conoce la URL de la Edge Function `api`. La API key de API-Football
// y la llave VAPID privada viven únicamente en los secretos de Supabase.
window.CONFIG = {
  API: "https://zdhkhsrwvvripuczhvam.supabase.co/functions/v1/api",
  REFRESCO_MS: 60000, // cada cuánto se vuelve a pedir la pantalla visible
};
