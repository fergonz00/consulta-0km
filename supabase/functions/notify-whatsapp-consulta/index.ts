// Edge Function: notify-whatsapp-consulta
// Envía notificaciones por WhatsApp Cloud API (Meta) para eventos del módulo Consulta 0KM.
// Reusa las env vars del tasador (WA_TASADOR_PHONE_ID, WA_TASADOR_TOKEN, SERVICE_ROLE_KEY).
// Destinatarios configurados en `consultas_0km_notif_config`.
// Log de cada envío en `consultas_0km_notif_log`.
//
// Eventos:
//   - consulta_0km_nueva         → al admin (default vendedor.no, gerente.no, fijos = [Fer])
//   - consulta_0km_respondida    → al vendedor + gerentes (default vendedor.si, gerente.si)
//   - consulta_usado_nueva       → idem, pero de la tabla `consultas_usados`
//   - consulta_usado_respondida  → idem
//
// USADOS: las consultas de usados viven en `consultas_usados` (una unidad por
// consulta, sin tabla de items — un usado es una unidad unica). El resto del
// circuito es identico: misma config de destinatarios (filas propias en
// `consultas_0km_notif_config`), mismo log, mismos templates de Meta.

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
  "consulta_0km_sin_responder",
  "consulta_usado_nueva",
  "consulta_usado_respondida",
  "consulta_usado_sin_responder",
]);

// Eventos que leen `consultas_usados` en vez de `consultas_0km` + items.
const EVENTOS_USADO = new Set([
  "consulta_usado_nueva",
  "consulta_usado_respondida",
  "consulta_usado_sin_responder",
]);
const esUsado = (evento: string) => EVENTOS_USADO.has(evento);

// Eventos que heredan la config de destinatarios de OTRO evento. El recordatorio
// de "sin responder" le llega a la misma gente que el aviso de consulta nueva,
// sin mantener dos filas de config en paralelo.
const CONFIG_EVENTO: Record<string, string> = {
  "consulta_0km_sin_responder": "consulta_0km_nueva",
  "consulta_usado_sin_responder": "consulta_usado_nueva",
};

// Mapeo evento -> nombre del template en Meta. El evento es el identificador
// interno (DB, frontend, notif_config), el template name es el que figura
// aprobado en Meta. Util cuando hay que recrear un template con otro nombre
// (ej: consulta_0km_nueva quedo bloqueada con cuerpo equivocado por 24hs).
// `consulta_0km_sin_responder` todavia no tiene template propio: reusa el de la
// consulta nueva y marca el recordatorio dentro de la variable {{1}}. Cuando
// exista el template dedicado, cambiar esta linea y redeployar.
// Los eventos de USADOS todavia no tienen template propio en Meta: reusan los
// del 0km (misma cantidad de variables) y se distinguen con el marcador
// "USADO" al principio de {{1}}, igual que hace el recordatorio de sin
// responder. Cuando existan `consulta_usado_nueva` / `consulta_usado_respondida`
// aprobados en la WABA 1183788370595856, cambiar estas dos lineas y redeployar.
const EVENT_TO_TEMPLATE: Record<string, string> = {
  "consulta_0km_nueva": "consulta_0km_nueva_v2",
  "consulta_0km_respondida": "consulta_0km_respondida",
  "consulta_0km_sin_responder": "consulta_0km_nueva_v2",
  "consulta_usado_nueva": "consulta_0km_nueva_v2",
  "consulta_usado_respondida": "consulta_0km_respondida",
  "consulta_usado_sin_responder": "consulta_0km_nueva_v2",
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

  // Opcional: ids hermanas del mismo submit (el vendedor pidió N modelos y cada
  // uno se guardó como consulta aparte). Sirve para que UN recordatorio nombre
  // todos los modelos en vez de mandar N WhatsApps iguales. Lo arma el sweeper.
  const grupoIds = Array.isArray(body?.grupo_ids)
    ? body.grupo_ids.map((x: any) => Number(x)).filter((n: number) => Number.isSafeInteger(n))
    : [];

  // 1) Traer config + consulta + items en paralelo.
  // Un usado es una unidad unica: la consulta ya trae el modelo y el precio
  // adentro, no hay tabla de items que leer.
  const tablaConsulta = esUsado(evento) ? "consultas_usados" : "consultas_0km";
  let cfgArr: any[], conArr: any[], itemsArr: any[];
  try {
    [cfgArr, conArr, itemsArr] = await Promise.all([
      sb(SUPABASE_URL, SERVICE_KEY, `consultas_0km_notif_config?evento=eq.${CONFIG_EVENTO[evento] ?? evento}&select=*`),
      sb(SUPABASE_URL, SERVICE_KEY, `${tablaConsulta}?id=eq.${consulta_id}&select=*`),
      esUsado(evento)
        ? Promise.resolve([])
        : sb(SUPABASE_URL, SERVICE_KEY, `consultas_0km_items?consulta_id=eq.${consulta_id}&order=orden.asc`),
    ]);
  } catch (e) {
    return json({ error: "Error leyendo Supabase", detalle: String(e) }, 500);
  }

  if (!Array.isArray(cfgArr) || cfgArr.length === 0) {
    return json({ error: `Sin config para evento ${CONFIG_EVENTO[evento] ?? evento}` }, 404);
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
  // Para "respondida": sumar tambien al admin que respondio (para que tenga
  // confirmacion del envio que disparo).
  if ((evento === "consulta_0km_respondida" || evento === "consulta_usado_respondida") && con.admin_user_id) {
    destIds.add(String(con.admin_user_id));
  }

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

  // 3) Variables del template según evento.
  // Si vino un grupo, los items del recordatorio salen de todas las consultas
  // hermanas (así el mensaje dice "Polo + Nivus" y no sólo la primera).
  let itemsParaVars = items;
  if (evento === "consulta_0km_sin_responder" && grupoIds.length > 1) {
    try {
      const todos = await sb(
        SUPABASE_URL,
        SERVICE_KEY,
        `consultas_0km_items?consulta_id=in.(${grupoIds.join(",")})&order=consulta_id.asc,orden.asc`,
      );
      if (Array.isArray(todos) && todos.length > 0) itemsParaVars = todos;
    } catch (e) {
      console.error("Error leyendo items del grupo:", e);
    }
  }
  const vars = buildVariables(evento, con, itemsParaVars);

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

// "1 h" / "3 h" / "1 d 2 h" — antiguedad legible desde un timestamp ISO.
function antiguedad(iso?: string): string {
  if (!iso) return "un rato";
  const ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms) || ms < 0) return "un rato";
  const horas = Math.floor(ms / 3600000);
  if (horas < 1) return "menos de 1 h";
  if (horas < 24) return `${horas} h`;
  const dias = Math.floor(horas / 24);
  const resto = horas % 24;
  return resto ? `${dias} d ${resto} h` : `${dias} d`;
}

// Nombre corto de la unidad usada para el mensaje: "VW GOL TREND 1.6 2015 (OMG291)".
function unidadUsado(con: any): string {
  const base = String(con.unidad || con.modelo || "").trim() || "usado";
  const pat = String(con.patente || "").trim();
  return pat ? `${base} (${pat})` : base;
}

function buildVariables(evento: string, con: any, items: any[]): string[] {
  const id = String(con.id || "");

  // ---- USADOS ----
  // Reusan los templates del 0km, con el marcador "USADO" al principio de la
  // primera variable para que se distinga de un vistazo en el celular.
  if (evento === "consulta_usado_nueva" || evento === "consulta_usado_sin_responder") {
    const vendedor = con.vendedor_nombre || con.vendedor_usuario || "—";
    const marca = evento === "consulta_usado_sin_responder"
      ? `USADO SIN RESPONDER hace ${antiguedad(con.created_at)} (aviso ${Number(con.recordatorios_enviados || 0) + 1})`
      : "USADO";
    // El "descuento" de un usado es sobre el precio publicado, no sobre una
    // lista: (publicado - pedido) / publicado.
    const pub = Number(con.precio_publicado) || 0;
    const ped = Number(con.precio_pedido) || 0;
    const rebaja = pub > 0 && ped > 0 ? fmtPct((pub - ped) / pub) : "—";
    return [`${marca} — ${vendedor}`, `${unidadUsado(con)} · pide ${fmtMoney(ped)}`, rebaja];
  }
  if (evento === "consulta_usado_respondida") {
    const vendedor = con.vendedor_nombre || con.vendedor_usuario || "—";
    let estado = con.estado || "respondida";
    if (estado === "aceptada") estado = "Aceptada";
    else if (estado === "rechazada") estado = "Rechazada";
    else if (estado === "contraoferta") estado = "Contraoferta (revisá el comentario en el portal)";
    let monto = "—";
    if (con.estado === "aceptada") {
      if (con.precio_pedido) monto = fmtMoney(con.precio_pedido);
    } else if (con.precio_max_admin) {
      monto = fmtMoney(con.precio_max_admin);
    }
    return [`USADO — ${unidadUsado(con)}`, vendedor, estado, monto];
  }

  // ---- 0KM ----
  if (evento === "consulta_0km_sin_responder") {
    // Recordatorio: reusa el template de consulta nueva (3 variables) y mete el
    // aviso adelante del vendedor, que es como arranca el cuerpo del mensaje.
    const vendedor = con.vendedor_nombre || con.vendedor_usuario || "—";
    const modelosSet = new Set<string>();
    for (const i of items) if (i.modelo) modelosSet.add(String(i.modelo));
    const modelos = Array.from(modelosSet).join(" + ") || "—";
    let dtoMax = -Infinity;
    for (const it of items) {
      const d = Number(it.dto_extra_pedido);
      if (isFinite(d) && d > dtoMax) dtoMax = d;
    }
    const dtoStr = isFinite(dtoMax) ? fmtPct(dtoMax) : "—";
    const marca = `⏰ SIN RESPONDER hace ${antiguedad(con.created_at)}` +
      ` (aviso ${Number(con.recordatorios_enviados || 0) + 1})`;
    return [`${marca} — ${vendedor}`, modelos, dtoStr];
  }
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
    let estado = con.estado || "respondida";
    if (estado === "aceptada") estado = "Aceptada";
    else if (estado === "rechazada") estado = "Rechazada";
    else if (estado === "contraoferta") estado = "Contraoferta (revisá el comentario en el portal)";
    let monto = "—";
    if (con.estado === "aceptada") {
      // Aceptada: el monto autorizado es lo que el vendedor pidio (precio_pedido de la primera unidad).
      const pedido = items[0]?.precio_pedido;
      if (pedido) monto = fmtMoney(pedido);
    } else if ((con.estado === "rechazada" || con.estado === "contraoferta") && con.precio_max_admin) {
      monto = fmtMoney(con.precio_max_admin);
    }
    return [modelos, vendedor, estado, monto];
  }
  return [];
}
