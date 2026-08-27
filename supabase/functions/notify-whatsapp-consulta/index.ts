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
// WABA "Tito Gonzalez | Tasador" — la unica donde vive el numero real. Un
// template creado en otra WABA NO se puede usar (error 132001). Ver CLAUDE.md.
const WABA_ID_DEFAULT = "1183788370595856";

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
// Los usados YA tienen sus propios templates (creados el 19/08/2026 con
// {"accion":"crear_templates_usado"}). Un evento que apunta a un template con
// su MISMO nombre esta usando el propio; si apunta a uno del 0km, es un
// fallback provisorio mientras Meta lo aprueba. `usaTemplatePropio()` lee eso y
// decide si hace falta meter el marcador "USADO" adentro de {{1}} — asi, el dia
// que se cambia una linea de este map, el texto se acomoda solo.
const EVENT_TO_TEMPLATE: Record<string, string> = {
  "consulta_0km_nueva": "consulta_0km_nueva_v2",
  "consulta_0km_respondida": "consulta_0km_respondida",
  "consulta_0km_sin_responder": "consulta_0km_nueva_v2",
  "consulta_usado_nueva": "consulta_usado_nueva",
  "consulta_usado_respondida": "consulta_usado_respondida",
  "consulta_usado_sin_responder": "consulta_usado_sin_responder",
};

const usaTemplatePropio = (evento: string) => (EVENT_TO_TEMPLATE[evento] ?? evento) === evento;

// Respaldo por evento: si Meta rechaza el template propio porque todavia no lo
// aprobo (o lo pausa mas adelante), se reintenta UNA vez con este, que es el
// del 0km y esta aprobado hace meses. Sin esto, un template en PENDING = aviso
// perdido en silencio. Los del 0km no tienen respaldo: son el respaldo.
const TEMPLATE_FALLBACK: Record<string, string> = {
  "consulta_usado_nueva": "consulta_0km_nueva_v2",
  "consulta_usado_respondida": "consulta_0km_respondida",
  "consulta_usado_sin_responder": "consulta_0km_nueva_v2",
};

// Codigos de Meta que significan "el problema es el template, no el numero".
// 132000 = cantidad de parametros no coincide · 132001 = no existe en ese
// idioma/WABA · 132005 = texto traducido no coincide · 132007 = formato.
const ERRORES_TEMPLATE = new Set([132000, 132001, 132005, 132007]);
const esErrorDeTemplate = (err: any) => {
  const code = Number(err?.code);
  const sub = Number(err?.error_subcode);
  return ERRORES_TEMPLATE.has(code) || ERRORES_TEMPLATE.has(sub);
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

  // Acciones de mantenimiento de templates. Viven aca porque el token de Meta
  // solo existe como secret de Supabase: no se puede crear un template desde
  // afuera sin exponerlo.
  //   {"accion":"listar_templates"}        -> que hay en la WABA y en que estado
  //   {"accion":"crear_templates_usado"}   -> da de alta los 3 de usados (saltea
  //                                           los que ya existen)
  if (body?.accion === "listar_templates") {
    return json(await listarTemplates(WA_TOKEN));
  }
  if (body?.accion === "crear_templates_usado") {
    return json(await crearTemplatesUsado(WA_TOKEN));
  }

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
  // Dos juegos de variables: el del template propio y el del respaldo (que
  // necesita el marcador "USADO" adentro del texto, porque el cuerpo del
  // template del 0km no lo dice).
  const vars = buildVariables(evento, con, itemsParaVars, usaTemplatePropio(evento));
  const varsFallback = TEMPLATE_FALLBACK[evento]
    ? buildVariables(evento, con, itemsParaVars, false)
    : vars;

  // 4) Enviar a cada destinatario
  const enviados: any[] = [];
  const errores: any[] = [];

  const armarPayload = (to: string, template: string, v: string[]) => ({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template,
      language: { code: META_LANGUAGE },
      components: v.length > 0
        ? [{ type: "body", parameters: v.map((x: string) => ({ type: "text", text: String(x || "") })) }]
        : [],
    },
  });

  const postMeta = async (payload: any) => {
    const res = await fetch(`${META_API_URL}/${WA_PHONE_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, json: await res.json() };
  };

  for (const u of destinatarios) {
    const telE164 = String(u.telefono_wa).replace(/^\+/, "").replace(/\s|-/g, "");
    let payload = armarPayload(telE164, EVENT_TO_TEMPLATE[evento] ?? evento, vars);

    try {
      let r = await postMeta(payload);
      let metaOk = r.ok;
      let metaJson = r.json;

      // Respaldo: el template propio todavia no esta aprobado (o Meta lo pauso)
      // => se reintenta con el del 0km para que el aviso no se pierda.
      const fallback = TEMPLATE_FALLBACK[evento];
      if (!metaOk && fallback && esErrorDeTemplate(metaJson?.error)) {
        console.warn(`[${evento}] template propio rechazado, uso respaldo ${fallback}:`, metaJson?.error?.message);
        payload = armarPayload(telE164, fallback, varsFallback);
        r = await postMeta(payload);
        metaOk = r.ok;
        metaJson = r.json;
      }
      const metaRes = { ok: metaOk };

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

// ---------- Templates de Meta ----------

const WABA_ID = () => Deno.env.get("WA_TASADOR_WABA_ID") ?? WABA_ID_DEFAULT;

async function listarTemplates(token: string) {
  const res = await fetch(
    `${META_API_URL}/${WABA_ID()}/message_templates?fields=name,language,status,category&limit=200`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = await res.json();
  return {
    templates: (j?.data ?? []).map((t: any) => ({
      name: t.name, language: t.language, status: t.status, category: t.category,
    })),
    error: j?.error,
  };
}

// Los 3 templates propios de las consultas de usados. Mismas cantidades de
// variables que los del 0km que venian reusandose, asi el switch es solo
// cambiar EVENT_TO_TEMPLATE (no hay que tocar buildVariables).
const TEMPLATES_USADO = [
  {
    name: "consulta_usado_nueva",
    header: "Consulta de precio de un usado",
    // OJO: Meta rechaza cuerpos que empiezan o terminan con una variable
    // (error_subcode 2388299). Siempre texto en los dos extremos.
    body: "Entró una consulta de precio de un usado. La pide {{1}} por {{2}}, con una rebaja del {{3}} sobre el precio publicado. Entrá al portal para aceptar, rechazar o contraofertar.",
    example: ["José Castro", "VOLKSWAGEN GOL TREND 1.6 2015 (OMG291) · pide $12.500.000", "-7.4%"],
  },
  {
    name: "consulta_usado_respondida",
    header: "Respuesta a la consulta del usado",
    body: "Se respondió la consulta del usado {{1}} de {{2}}. Estado: {{3}}. Precio autorizado: {{4}}. Está en el portal con el detalle.",
    example: ["VOLKSWAGEN GOL TREND 1.6 2015 (OMG291)", "José Castro", "Contraoferta (revisá el comentario en el portal)", "$12.800.000"],
  },
  {
    name: "consulta_usado_sin_responder",
    header: "Consulta de usado sin responder",
    body: "Sigue sin responderse la consulta de {{1}}: {{2}} (rebaja del {{3}}). Entrá al portal para cerrarla.",
    example: ["SIN RESPONDER hace 2 h (aviso 3) — José Castro", "VOLKSWAGEN GOL TREND 1.6 2015 (OMG291) · pide $12.500.000", "-7.4%"],
  },
];

async function crearTemplatesUsado(token: string) {
  const existentes = new Set(
    ((await listarTemplates(token)).templates || []).map((t: any) => t.name),
  );
  const resultados: any[] = [];
  for (const t of TEMPLATES_USADO) {
    if (existentes.has(t.name)) {
      resultados.push({ name: t.name, status: "ya existía" });
      continue;
    }
    const res = await fetch(`${META_API_URL}/${WABA_ID()}/message_templates`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: t.name,
        language: META_LANGUAGE,
        category: "UTILITY",
        components: [
          { type: "HEADER", format: "TEXT", text: t.header },
          { type: "BODY", text: t.body, example: { body_text: [t.example] } },
          { type: "FOOTER", text: "Aviso automático · Tito Gonzalez" },
        ],
      }),
    });
    const j = await res.json();
    resultados.push({ name: t.name, http: res.status, respuesta: j });
  }
  return { resultados };
}

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

// `propio` = true si el mensaje va con el template propio del evento (cuyo
// encabezado ya aclara que es un usado); false si va con el del 0km como
// respaldo, y ahi hay que meter el marcador "USADO" dentro del texto.
function buildVariables(evento: string, con: any, items: any[], propio = true): string[] {
  const id = String(con.id || "");

  // ---- USADOS ----
  // Con el template propio, el encabezado ya dice que es un usado. Si todavia
  // estamos cayendo al template del 0km (fallback mientras Meta aprueba), se
  // antepone "USADO" adentro de {{1}} para que no se lea como una consulta de
  // 0km. Ver `usaTemplatePropio`.
  if (evento === "consulta_usado_nueva" || evento === "consulta_usado_sin_responder") {
    const vendedor = con.vendedor_nombre || con.vendedor_usuario || "—";
    let quien = propio ? vendedor : `USADO — ${vendedor}`;
    if (evento === "consulta_usado_sin_responder") {
      // El recordatorio SIEMPRE lleva la marca de cuanto hace y que numero de
      // aviso es: es lo que hace que escale solo sin contar nada a mano.
      const marca = `SIN RESPONDER hace ${antiguedad(con.created_at)} (aviso ${Number(con.recordatorios_enviados || 0) + 1})`;
      quien = `${propio ? "" : "USADO "}${marca} — ${vendedor}`;
    }
    // El "descuento" de un usado es sobre el precio publicado, no sobre una
    // lista: (publicado - pedido) / publicado.
    const pub = Number(con.precio_publicado) || 0;
    const ped = Number(con.precio_pedido) || 0;
    const rebaja = pub > 0 && ped > 0 ? fmtPct((pub - ped) / pub) : "—";
    // Particular vs. reventa (pedido de Fer, 27/08/2026): va PEGADO a {{2}} y no
    // como variable nueva, porque agregar una variable obliga a recrear el
    // template en Meta y esperar la aprobacion de nuevo. Las consultas viejas no
    // tienen el dato y no agregan nada al texto.
    const tipo = con.tipo_cliente === "reventa"
      ? " · a REVENTA"
      : (con.tipo_cliente === "particular" ? " · a particular" : "");
    return [quien, `${unidadUsado(con)} · pide ${fmtMoney(ped)}${tipo}`, rebaja];
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
    const unidad = propio ? unidadUsado(con) : `USADO — ${unidadUsado(con)}`;
    return [unidad, vendedor, estado, monto];
  }

  // ---- 0KM ----
  // Nombre del auto para el WhatsApp. En "sin disponibilidad" el color es el corazon
  // del pedido (piden un color que no tenemos), asi que va pegado al modelo.
  function modelosTxt(): string {
    const sinDisp = String(con.origen || "") === "sin_disponibilidad";
    const partes: string[] = [];
    const vistos = new Set<string>();
    for (const i of items) {
      if (!i.modelo) continue;
      const txt = sinDisp && i.color_pedido ? `${i.modelo} ${i.color_pedido}` : String(i.modelo);
      if (vistos.has(txt)) continue;
      vistos.add(txt);
      partes.push(txt);
    }
    return partes.join(" + ") || "—";
  }
  // Tercera variable del template de "nueva": normalmente el dto extra pedido. En una
  // consulta de disponibilidad sin precio no hay descuento que informar, asi que se
  // manda que hay que averiguar si el auto se consigue.
  function dtoOAviso(): string {
    let dtoMax = -Infinity;
    for (const it of items) {
      // OJO: Number(null) es 0, no NaN. Sin este guard, una consulta SIN precio
      // (disponibilidad pura) informaba "0.0%" de descuento, que es mentira.
      if (it.dto_extra_pedido === null || it.dto_extra_pedido === undefined) continue;
      const d = Number(it.dto_extra_pedido);
      if (isFinite(d) && d > dtoMax) dtoMax = d;
    }
    if (isFinite(dtoMax)) return fmtPct(dtoMax);
    if (String(con.origen || "") === "sin_disponibilidad") return "consulta si se consigue";
    return "—";
  }
  if (evento === "consulta_0km_sin_responder") {
    // Recordatorio: reusa el template de consulta nueva (3 variables) y mete el
    // aviso adelante del vendedor, que es como arranca el cuerpo del mensaje.
    const vendedor = con.vendedor_nombre || con.vendedor_usuario || "—";
    const modelos = modelosTxt();
    const dtoStr = dtoOAviso();
    const marca = `⏰ SIN RESPONDER hace ${antiguedad(con.created_at)}` +
      ` (aviso ${Number(con.recordatorios_enviados || 0) + 1})`;
    return [`${marca} — ${vendedor}`, modelos, dtoStr];
  }
  if (evento === "consulta_0km_nueva") {
    // Template: 3 variables = vendedor, modelo(s), dto extra pedido (peor caso)
    const vendedor = con.vendedor_nombre || con.vendedor_usuario || "—";
    return [vendedor, modelosTxt(), dtoOAviso()];
  }
  if (evento === "consulta_0km_respondida") {
    // Template: 4 variables = modelo(s), vendedor, estado, monto autorizado
    const modelos = modelosTxt();
    const vendedor = con.vendedor_nombre || con.vendedor_usuario || "—";
    const sinDisp = String(con.origen || "") === "sin_disponibilidad";
    let estado = con.estado || "respondida";
    // En "sin disponibilidad" aceptada/rechazada significan otra cosa: se consigue o no.
    // El vendedor tiene que leer eso, no "Aceptada".
    if (sinDisp) {
      estado = con.disponibilidad === "no_se_consigue" || con.estado === "rechazada"
        ? "NO se consigue"
        : "SÍ se consigue";
    } else if (estado === "aceptada") estado = "Aceptada";
    else if (estado === "rechazada") estado = "Rechazada";
    else if (estado === "contraoferta") estado = "Contraoferta (revisá el comentario en el portal)";
    let monto = "—";
    if (sinDisp) {
      // Puede no haber precio: era una consulta de disponibilidad pura.
      if (con.precio_max_admin) monto = fmtMoney(con.precio_max_admin);
      else if (items[0]?.precio_pedido && con.estado === "aceptada") monto = fmtMoney(items[0].precio_pedido);
    } else if (con.estado === "aceptada") {
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
