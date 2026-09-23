// Edge Function: db-proxy
// Proxy PostgREST autenticado por firma tga_session para tablas internas que
// hoy el navegador toca con la anon key (cualquiera con la key pública podía
// leer/escribir). El cliente manda { session, path, method, body, prefer } con
// su sesión firmada; el proxy verifica la firma y reenvía a PostgREST con
// service_role SOLO para las tablas de la whitelist. Así se cierra el acceso
// anónimo sin reescribir decenas de llamadas (solo el helper sbFetch de la app).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Tablas que el proxy acepta. Cualquier otra ruta se rechaza.
const TABLAS_OK = new Set([
  "consultas_0km",
  "consultas_0km_items",
  "consultas_usados",
  "consultas_reaperturas",
  "tasaciones",
  "notificaciones_config",
  "competencia_precios", // solo lectura desde el simulador; se escribe con service_role (portal-precios)
]);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

let _secret: string | null = null;
async function getSecret(): Promise<string> {
  if (_secret) return _secret;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/app_config?clave=eq.tga_session_secret&select=valor`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  const rows = await r.json().catch(() => []);
  _secret = (Array.isArray(rows) && rows[0]?.valor) || "";
  return _secret;
}
function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function sesionValida(sess: any): Promise<boolean> {
  if (!sess || typeof sess !== "object") return false;
  const usuario = String(sess.usuario || "").trim().toLowerCase();
  const exp = Number(sess.session_exp);
  const sig = String(sess.session_sig || "");
  if (!usuario || !exp || !sig) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const secret = await getSecret();
  if (!secret) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${usuario}.${exp}`));
  return timingSafeEqual(toHex(mac), sig);
}

// Extrae el nombre de tabla del path PostgREST ("tasaciones?foo=bar" -> "tasaciones").
function tablaDe(path: string): string {
  const limpio = String(path || "").replace(/^\/+/, "").replace(/^rest\/v1\//, "");
  const m = limpio.match(/^([a-zA-Z0-9_]+)/);
  return m ? m[1] : "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON inválido" }, 400);
  }

  if (!(await sesionValida(body?.session))) return json({ error: "No autorizado" }, 401);

  const path = String(body?.path || "");
  const tabla = tablaDe(path);
  if (!TABLAS_OK.has(tabla)) return json({ error: "Tabla no permitida" }, 403);

  const method = String(body?.method || "GET").toUpperCase();
  if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) return json({ error: "Método inválido" }, 400);

  // Reenvío a PostgREST con service_role.
  const headers: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };
  if (body?.prefer) headers["Prefer"] = String(body.prefer);
  const init: RequestInit = { method, headers };
  if (method === "POST" || method === "PATCH") {
    headers["Content-Type"] = "application/json";
    init.body = typeof body.body === "string" ? body.body : JSON.stringify(body.body ?? {});
  }

  try {
    const clean = path.replace(/^\/+/, "").replace(/^rest\/v1\//, "");
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${clean}`, init);
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": resp.headers.get("Content-Type") || "application/json",
        // Reexponemos Content-Range para las lecturas con count.
        ...(resp.headers.get("Content-Range") ? { "Content-Range": resp.headers.get("Content-Range")! } : {}),
      },
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 502);
  }
});
