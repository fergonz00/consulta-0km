// Edge Function: validar-preventa
//
// Valida el numero de preventa que el vendedor carga al marcar una consulta como
// VENDIDA. Ese numero es el NEXO entre la consulta (donde quedo autorizado cuanto
// iba por transferencia) y la venta real: la solapa Ventas cruza por ahi para
// descontarle a la ganancia el costo de haber cobrado por transferencia. Una PV
// mal tipeada = el costo nunca aterriza y la ganancia sale inflada, que es
// justamente lo que se quiere arreglar.
//
// Vive aca y no en el front porque la key de la replica de Oversoft NO puede
// viajar al navegador: el repo de consulta-0km es publico.
//
// Mismo criterio que `validarPreventa` de gestion-next (Fer, 20-ago-2026): la PV
// que no existe se bloquea y el vendedor tiene que coincidir. Diferencias:
//  - Aca el vendedor viene de `tasador_usuarios` y no de `vendedores` del CRM, pero
//    el mapa a Oversoft es EL MISMO (`pv_vendedores_map`, usuario -> vendedorid):
//    los dos validadores tienen que decir lo mismo sobre la misma PV.
//  - Si el usuario no tiene mapeo (Fer, un gerente, una cargadora) NO se bloquea:
//    se deja pasar marcado para revisar. Bloquear seria inventar un problema.
//
// Secrets: OVERSOFT_URL, OVERSOFT_KEY (replica SOLO LECTURA — jamas escribir),
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
//
// POST { preventa: "8114/1", usuario: "jperez", tipo: "0km"|"usado", consulta_id: 123 }
//   -> { ok, code, mensaje, revisar?, preventa_normalizada }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const SUPA_URL = Deno.env.get("SUPABASE_URL");
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const OV_URL = Deno.env.get("OVERSOFT_URL");
  const OV_KEY = Deno.env.get("OVERSOFT_KEY");
  if (!SUPA_URL || !SUPA_KEY) return json({ error: "SUPABASE env vars missing" }, 500);
  if (!OV_URL || !OV_KEY) return json({ error: "OVERSOFT env vars missing" }, 500);

  let body: any = {};
  try { body = await req.json(); } catch { /* body opcional */ }

  const preventaRaw = String(body?.preventa ?? "").trim();
  const usuario = String(body?.usuario ?? "").trim().toLowerCase();
  const tipo = String(body?.tipo ?? "0km") === "usado" ? "usado" : "0km";
  const consultaId = Number(body?.consulta_id) || null;

  const partes = partirPV(preventaRaw);
  if (!partes) {
    return json({
      ok: false,
      code: "formato",
      mensaje: `"${preventaRaw}" no tiene formato de preventa. Tiene que ser número/sufijo, por ejemplo 8114/1.`,
    });
  }
  const norm = `${partes.num}/${partes.suf}`;
  const numeroOv = `PV ${String(partes.num).padStart(5, "0")}/${partes.suf}`;

  // 1) ¿Existe en Oversoft y no está anulada?
  let pv: any = null;
  try {
    const filas = await ov(OV_URL, OV_KEY,
      `/preventas?select=numero,vendedorid,cliente,fecha,anulada&numero=eq.${encodeURIComponent(numeroOv)}`);
    pv = filas[0] || null;
  } catch (e) {
    return json({ error: "Error leyendo Oversoft", detalle: String(e) }, 500);
  }

  if (!pv) {
    return json({
      ok: false,
      code: "no_existe",
      mensaje: `La preventa ${norm} no existe en el sistema. Revisá el número.`,
      preventa_normalizada: norm,
    });
  }
  if (pv.anulada) {
    return json({
      ok: false,
      code: "anulada",
      mensaje: `La preventa ${norm} está anulada en el sistema.`,
      preventa_normalizada: norm,
    });
  }

  // 2) ¿Ya la usó otra consulta? Dos consultas con la misma PV es siempre un
  //    error de carga, y ademas duplicaria el descuento de la transferencia.
  const tabla = tipo === "usado" ? "consultas_usados" : "consultas_0km";
  try {
    const usadas = await sb(SUPA_URL, SUPA_KEY,
      `${tabla}?select=id,vendedor_nombre&preventa=eq.${encodeURIComponent(norm)}`);
    const otra = (usadas || []).find((c: any) => Number(c.id) !== consultaId);
    if (otra) {
      return json({
        ok: false,
        code: "duplicada",
        mensaje: `La preventa ${norm} ya está cargada en la consulta #${otra.id}` +
          (otra.vendedor_nombre ? ` (${otra.vendedor_nombre})` : "") + ". Verificá el número.",
        preventa_normalizada: norm,
      });
    }
  } catch (e) {
    return json({ error: "Error leyendo Supabase", detalle: String(e) }, 500);
  }

  // 3) ¿Es del vendedor que dice haberla cerrado? Se usa el MISMO mapa que el CRM
  //    (`pv_vendedores_map`, usuario -> vendedorid) para que los dos validadores
  //    digan lo mismo. Un vendedor puede tener varios vendedorid en Oversoft (el
  //    normal y el de Autoahorro: Loisi es 6 y 141, Castro 5 y 140): vale
  //    cualquiera. Sin mapeo NO se bloquea, se marca para revisar.
  let mapeos: any[] = [];
  try {
    mapeos = await sb(SUPA_URL, SUPA_KEY,
      `pv_vendedores_map?select=vendedorid,nombre_oversoft&usuario=ilike.${encodeURIComponent(usuario)}`);
  } catch {
    mapeos = [];
  }
  const mios = (mapeos || []).map((m: any) => Number(m.vendedorid));

  if (mios.length === 0) {
    return json({
      ok: true,
      code: "sin_mapeo",
      revisar: true,
      mensaje: `Preventa ${norm} encontrada. ` +
        "No se pudo verificar que sea tuya (tu usuario no está mapeado en el sistema), así que queda para revisar.",
      preventa_normalizada: norm,
      cliente: pv.cliente ?? null,
    });
  }

  if (pv.vendedorid == null || !mios.includes(Number(pv.vendedorid))) {
    let deQuien = "otro vendedor";
    try {
      const otros = await sb(SUPA_URL, SUPA_KEY,
        `pv_vendedores_map?select=nombre_oversoft&vendedorid=eq.${Number(pv.vendedorid) || 0}`);
      if (otros[0]?.nombre_oversoft) deQuien = String(otros[0].nombre_oversoft);
    } catch { /* si no se puede resolver el nombre, alcanza con el generico */ }
    return json({
      ok: false,
      code: "otro_vendedor",
      mensaje: `La preventa ${norm} figura a nombre de ${deQuien}. Solo podés cargar tu propia preventa.`,
      preventa_normalizada: norm,
    });
  }

  return json({
    ok: true,
    code: "valida",
    mensaje: `Preventa ${norm} verificada.`,
    preventa_normalizada: norm,
    cliente: pv.cliente ?? null,
  });
});

/**
 * "8114/1" -> { num: 8114, suf: "1" }. El sufijo NO es decorativo: 8031/1 y
 * 8031/3 son preventas distintas, de clientes y años distintos.
 */
function partirPV(pv: string): { num: number; suf: string } | null {
  const m = String(pv || "").trim().replace(/^PV\s*/i, "").match(/^0*(\d{1,6})\s*\/\s*(\w{1,3})$/);
  if (!m) return null;
  return { num: parseInt(m[1], 10), suf: m[2] };
}

async function ov(url: string, key: string, path: string) {
  const res = await fetch(`${url}${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`oversoft ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

async function sb(url: string, key: string, path: string) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const t = await res.text();
  return t ? JSON.parse(t) : [];
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
