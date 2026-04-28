// Edge Function: notify-whatsapp-consulta
// Envía notificaciones por WhatsApp Cloud API (Meta) para eventos del módulo Consulta 0KM.
// Reusa las env vars del tasador (WA_TASADOR_PHONE_ID, WA_TASADOR_TOKEN, SERVICE_ROLE_KEY).
// Destinatarios configurados en `consultas_0km_notif_config`.
// Log de cada envío en `consultas_0km_notif_log`.
//
// Eventos:
//   - consulta_0km_nueva       → al admin (default vendedor.no, gerente.no, fijos = [Fer])
//   - consulta_0km_respondida  → al vendedor + gerentes (default vendedor.si, gerente.si)

const META_API_URL = "https://graph.facebook.com/v25.0";
const META_LANGUAGE = "es_AR";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

const EVENTOS_VALIDOS = new Set([
  "consulta_0km_nueva",
  "consulta_0km_respondida",
]);

// Mapeo evento -> nombre del template en Meta. El evento es el identificador
// interno (DB, frontend, notif_config), el template name es el que figura
// aprobado en Meta. Util cuando hay que recrear un template con otro nombre
// (ej: consulta_0km_nueva quedo bloqueada con cuerpo equivocado por 24hs).
const EVENT_TO_TEMPLATE: Record<string, string> = {
  "consulta_0km_nueva": "consulta_0km_nueva_v2",
  "consulta_0km_respondida": "consulta_0km_respondida",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const WA_PHONE_ID = Deno.env.get("WA_TASADOR_PHONE_ID");
  const WA_TOKEN = Deno.env.get("WA_TASADOR_TOKEN");

  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!WA_PHONE_ID || !WA_TOKEN) return json({ error: "WA_TASADOR env vars missing" }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "JSON inválido" }, 400); }

  const { consulta_id, evento } = body || {};
  if (!consulta_id) return json({ error: "consulta_id requerido" }, 400);
  if (!evento || !EVENTOS_VALIDOS.has(evento)) return json({ error: "evento inválido" }, 400);

  // 1) Traer config + consulta + items en paralelo
  let cfgArr: any[], conArr: any[], itemsArr: any[];
  try {
    [cfgArr, conArr, itemsArr] = await Promise.all([
      sb(SUPABASE_URL, SERVICE_KEY, `consultas_0km_notif_config?evento=eq.${evento}&select=*`),
      sb(SUPABASE_URL, SERVICE_KEY, `consultas_0km?id=eq.${consulta_id}&select=*`),
      sb(SUPABASE_URL, SERVICE_KEY, `consultas_0km_items?consulta_id=eq.${consulta_id}&order=orden.asc`),
    ]);
  } catch (e) {
    return json({ error: "Error leyendo Supabase", detalle: String(e) }, 500);
  }

  if (!Array.isArray(cfgArr) || cfgArr.length === 0) {
    return json({ error: `Sin config para evento ${evento}` }, 404);
  }
  if (!Array.isArray(conArr) || conArr.length === 0) {
    return json({ error: "Consulta no encontrada" }, 404);
  }

  const cfg = cfgArr[0];
  const con = conArr[0];
  const items = Array.isArray(itemsArr) ? itemsArr : [];

  // 2) Resolver destinatarios
  const destIds = new Set<string>();
  if (cfg.incluir_vendedor && con.vendedor_id) destIds.add(String(con.vendedor_id));
  for (const u of (cfg.usuarios_ids || [])) destIds.add(String(u));

  // Si incluir_gerente, sumar todos los activos con rol 'gerente'
  if (cfg.incluir_gerente) {
    try {
      const allUsers = await sb(SUPABASE_URL, SERVICE_KEY, `tasador_usuarios?activo=eq.true&select=id,roles,rol`);
      for (const u of (allUsers || [])) {
        const r = Array.isArray(u.roles) ? u.roles : (u.rol ? [u.rol] : []);
        if (r.includes("gerente")) destIds.add(String(u.id));
      }
    } catch (e) {
      console.error("Error leyendo gerentes:", e);
    }
  }

  if (destIds.size === 0) return json({ enviados: 0, errores: [], info: "sin destinatarios" });

  const idsArr = Array.from(destIds);
  const idsCsv = idsArr.map((id) => `"${id}"`).join(",");
  const users = await sb(
    SUPABASE_URL,
    SERVICE_KEY,
    `tasador_usuarios?id=in.(${idsCsv})&select=id,nombre,usuario,telefono_wa,notificaciones_wa,activo`,
  );

  const destinatarios = (users || []).filter((u: any) =>
    u.activo !== false &&
    u.notificaciones_wa !== false &&
    u.telefono_wa && String(u.telefono_wa).trim().length > 0
  );

  if (destinatarios.length === 0) {
    return json({ enviados: 0, errores: [], info: "sin destinatarios válidos" });
  }

  // 3) Variables del template según evento
  const vars = buildVariables(evento, con, items);

  // 4) Enviar a cada destinatario
  const enviados: any[] = [];
  const errores: any[] = [];

  for (const u of destinatarios) {
    const telE164 = String(u.telefono_wa).replace(/^\+/, "").replace(/\s|-/g, "");
    const components = vars.length > 0
      ? [{ type: "body", parameters: vars.map((v: string) => ({ type: "text", text: String(v || "") })) }]
      : [];
    const payload = {
      messaging_product: "whatsapp",
      to: telE164,
      type: "template",
      template: {
        name: EVENT_TO_TEMPLATE[evento] ?? evento,
        language: { code: META_LANGUAGE },
        components,
      },
    };

    try {
      const metaRes = await fetch(`${META_API_URL}/${WA_PHONE_ID}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const metaJson = await metaRes.json();

      if (metaRes.ok && metaJson.messages && metaJson.messages[0]) {
        await log(SUPABASE_URL, SERVICE_KEY, {
          consulta_id,
          destinatario_id: u.id,
          destinatario_telefono: telE164,
          template: evento,
          evento,
          estado: "enviado",
          meta_message_id: metaJson.messages[0].id,
          payload: { request: payload, response: metaJson },
        });
        enviados.push({ usuario: u.usuario, meta_id: metaJson.messages[0].id });
      } else {
        await log(SUPABASE_URL, SERVICE_KEY, {
          consulta_id,
          destinatario_id: u.id,
          destinatario_telefono: telE164,
          template: evento,
          evento,
          estado: "error",
          error_detalle: JSON.stringify(metaJson.error || metaJson).slice(0, 2000),
          payload: { request: payload, response: metaJson },
        });
        errores.push({ usuario: u.usuario, error: metaJson.error || metaJson });
      }
    } catch (e) {
      await log(SUPABASE_URL, SERVICE_KEY, {
        consulta_id,
        destinatario_id: u.id,
        destinatario_telefono: telE164,
        template: evento,
        evento,
        estado: "fallido",
        error_detalle: String(e),
        payload: { request: payload },
      });
      errores.push({ usuario: u.usuario, error: String(e) });
    }
  }

  return json({ enviados: enviados.length, errores });
});

// ---------- Helpers ----------

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sb(url: string, key: string, path: string, options: RequestInit = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${res.status}: ${t}`);
  }
  return res.json();
}

async function log(url: string, key: string, row: any) {
  try {
    await fetch(`${url}/rest/v1/consultas_0km_notif_log`, {
      method: "POST",
      headers: {
        "apikey": key,
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
      },
      body: JSON.stringify(row),
    });
  } catch (e) {
    console.error("log err:", e);
  }
}

function fmtMoney(n: any): string {
  const v = Number(n);
  if (!isFinite(v)) return "—";
  return "$" + new Intl.NumberFormat("es-AR").format(Math.round(v));
}

function fmtPct(n: any): string {
  const v = Number(n);
  if (!isFinite(v)) return "—";
  const pct = v * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function buildVariables(evento: string, con: any, items: any[]): string[] {
  const id = String(con.id || "");
  if (evento === "consulta_0km_nueva") {
    // Template: 3 variables = vendedor, modelo(s), dto extra pedido (peor caso)
    const vendedor = con.vendedor_nombre || con.vendedor_usuario || "—";
    const modelos = items.map((i) => i.modelo).filter(Boolean).join(" + ") || "—";
    let dtoMax = -Infinity;
    for (const it of items) {
      const d = Number(it.dto_extra_pedido);
      if (isFinite(d) && d > dtoMax) dtoMax = d;
    }
    const dtoStr = isFinite(dtoMax) ? fmtPct(dtoMax) : "—";
    return [vendedor, modelos, dtoStr];
  }
  if (evento === "consulta_0km_respondida") {
    // Template: 4 variables = modelo(s), vendedor, estado, monto autorizado
    const modelos = items.map((i) => i.modelo).filter(Boolean).join(" + ") || "—";
    const vendedor = con.vendedor_nombre || con.vendedor_usuario || "—";
    const estado = con.estado === "aceptada" ? "Aceptada" : (con.estado === "rechazada" ? "Rechazada" : (con.estado || "respondida"));
    let monto = "—";
    if (con.estado === "aceptada") {
      // Aceptada: el monto autorizado es lo que el vendedor pidio (precio_pedido de la primera unidad).
      const pedido = items[0]?.precio_pedido;
      if (pedido) monto = fmtMoney(pedido);
    } else if (con.estado === "rechazada" && con.precio_max_admin) {
      monto = fmtMoney(con.precio_max_admin);
    }
    return [modelos, vendedor, estado, monto];
  }
  return [];
}
