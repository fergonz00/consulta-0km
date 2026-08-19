// Edge Function: usados-disponibles
//
// Devuelve los USADOS en venta para que el vendedor pueda pedir mejor precio
// sobre una unidad concreta (consultas de usados, hermanas de las de 0km).
//
// Universo: el MISMO que la solapa /usados de portal-precios, para que el
// vendedor vea exactamente lo que ya conoce:
//   Oversoft `usados` con estado=Activado, fechadeventa is null y fechadealta
//   dentro de los ultimos 18 meses (corta la chatarra historica 2009-2024).
//   Entran tanto las fisicas (recibida=true) como las "a recibir".
//   Se saltean las ocultas y las marcadas vendido en wjfgl `portal_usados`.
//
// Precio publicado = override de `portal_usados.precio_venta` si existe, sino
// `usados.preciodeventa` de Oversoft. Es el precio que el vendedor ve hoy y
// sobre el que pide la rebaja. Si es 0 => "precio a definir": la unidad se
// devuelve igual pero marcada, porque no se puede pedir rebaja sobre nada.
//
// COSTO BLINDADO (mismo criterio que la gcia en `stock-disponible`): el costo
// de toma y el margen son plata interna. Solo se devuelven a los usuarios de
// COSTO_USUARIOS, validados server-side con {usuario, clave} (POST) contra
// tasador_usuarios. Vendedor, gerente, cualquier otro admin y cualquier GET
// reciben la lista SIN costo ni margen.
//
// EL COSTO SALE DE OVERSOFT (`usados.preciodetoma`), que es lo que se tomo
// realmente. Decision explicita de Fer (19/08/2026): NO se cae al
// `precio_toma_final` del tasador si viene en 0 — si Oversoft no lo tiene, se
// informa `costo_toma: null` y la pantalla lo muestra como "sin costo cargado".
// Del tasador se toma solo informacion de color (`tasaciones.color`), km real y
// el total de arreglos del analisis fisico, que va aparte y bien etiquetado.
//
// Secrets: OVERSOFT_URL, OVERSOFT_KEY (replica solo-lectura).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY los inyecta el runtime.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

// Mismos usuarios que ven la ganancia del 0km (los tres duenios).
const COSTO_USUARIOS = new Set(["fngonzalez", "fgonzalez", "cgonzalez"]);

// Mismo criterio que la solapa /usados del portal.
const ANTIGUEDAD_MAX_MESES = 18;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
async function rest(base: string, key: string, path: string): Promise<any[]> {
  const res = await fetch(base + path, {
    headers: { apikey: key, Authorization: "Bearer " + key },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

const normPat = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// Oversoft ya trae la version adentro de `modelo` ("CROSSFOX 1.6 MSI 16V 2016"),
// asi que el anio se agrega solo si no viene ya en el texto. Mismo criterio que
// tituloUsado() en portal-precios: si no, el nombre sale con el anio duplicado.
// deno-lint-ignore no-explicit-any
function tituloUsado(u: any): string {
  const base = [String(u.marca ?? "").trim(), String(u.modelo ?? "").trim()]
    .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const anio = u.anio ? String(u.anio) : "";
  return anio && !/\b(19|20)\d{2}\b/.test(base) ? `${base} ${anio}` : base;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const SUPA_URL = Deno.env.get("SUPABASE_URL");
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const OV_URL = Deno.env.get("OVERSOFT_URL");
  const OV_KEY = Deno.env.get("OVERSOFT_KEY");
  if (!SUPA_URL || !SUPA_KEY) return json({ ok: false, error: "SUPABASE env vars missing" }, 500);
  if (!OV_URL || !OV_KEY) return json({ ok: false, error: "OVERSOFT env vars missing" }, 500);
  const W = SUPA_URL + "/rest/v1";

  // Credenciales opcionales (POST) para desbloquear el costo de toma.
  let includeCosto = false;
  if (req.method === "POST") {
    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const usuario = String(body?.usuario || "").trim().toLowerCase();
    const clave = String(body?.clave || "");
    if (usuario && clave && COSTO_USUARIOS.has(usuario)) {
      try {
        const u = await rest(
          W, SUPA_KEY,
          `/tasador_usuarios?usuario=eq.${encodeURIComponent(usuario)}&clave=eq.${encodeURIComponent(clave)}&activo=eq.true&select=usuario`,
        );
        includeCosto = u.length > 0;
      } catch (_) { includeCosto = false; }
    }
  }

  try {
    const corte = new Date();
    corte.setMonth(corte.getMonth() - ANTIGUEDAD_MAX_MESES);
    const corteAlta = corte.toISOString().slice(0, 10);

    // 1) Universo vendible en Oversoft (fisicas + a recibir).
    const raw = await rest(
      OV_URL, OV_KEY,
      "/usados?select=usadoid,marca,modelo,anio,km,color,patente,preciodetoma,preciodeventa," +
        "preventaorigen,fechadealta,fechadeingreso,recibida,enreparacion" +
        `&estado=eq.Activado&fechadeventa=is.null&fechadealta=gte.${corteAlta}` +
        "&order=fechadealta.desc&limit=500",
    );
    if (!raw.length) return json({ ok: true, costoIncluido: includeCosto, usados: [] });

    const ids = raw.map((u) => u.usadoid).join(",");

    // 2) Override de precio + ocultas/vendidas del portal.
    const portal = await rest(
      W, SUPA_KEY,
      `/portal_usados?usadoid=in.(${ids})&select=usadoid,precio_venta,oculto,vendido`,
    );
    // deno-lint-ignore no-explicit-any
    const portalMap = new Map<number, any>(portal.map((p) => [Number(p.usadoid), p]));

    // 3) Tasador por patente: km real, color y arreglos del analisis fisico.
    const patentes = raw.map((u) => String(u.patente ?? "").trim()).filter(Boolean);
    // deno-lint-ignore no-explicit-any
    const tasMap = new Map<string, any>();
    if (patentes.length) {
      const lista = patentes.map((p) => `"${p}"`).join(",");
      const tas = await rest(
        W, SUPA_KEY,
        `/tasaciones?patente=in.(${encodeURIComponent(lista)})&select=patente,color,kilometros,version,analisis_fisico,created_at&order=created_at.desc&limit=500`,
      );
      for (const t of tas) {
        const k = normPat(t.patente);
        if (k && !tasMap.has(k)) tasMap.set(k, t); // la mas reciente gana
      }
    }

    const usados = [];
    for (const u of raw) {
      const p = portalMap.get(Number(u.usadoid));
      if (p && (p.oculto === true || p.vendido === true)) continue;

      const t = tasMap.get(normPat(u.patente));
      const override = p && Number(p.precio_venta) > 0 ? Number(p.precio_venta) : 0;
      const oversoft = Number(u.preciodeventa) > 0 ? Number(u.preciodeventa) : 0;
      const precio = override || oversoft;

      const km = t?.kilometros != null && Number(t.kilometros) > 0
        ? Number(t.kilometros) : (Number(u.km) || 0);

      // deno-lint-ignore no-explicit-any
      const row: any = {
        usadoid: u.usadoid,
        patente: String(u.patente ?? "").trim() || null,
        marca: String(u.marca ?? "").trim(),
        modelo: String(u.modelo ?? "").trim(),
        anio: u.anio || null,
        unidad: tituloUsado(u),
        version: t?.version || null,
        km,
        color: String(t?.color ?? u.color ?? "").trim() || null,
        precio_venta: precio || 0,
        precio_origen: override ? "portal" : (oversoft ? "oversoft" : "sin_precio"),
        estado: u.recibida === true ? "fisico" : "a_recibir",
        enreparacion: u.enreparacion === true,
        fecha_ingreso: String(u.fechadeingreso ?? "").slice(0, 10) || null,
        preventa_origen: String(u.preventaorigen ?? "").trim() || null,
      };

      // Plata interna: SOLO para los usuarios autorizados (ver cabecera).
      if (includeCosto) {
        const toma = Number(u.preciodetoma) || 0;
        row.costo_toma = toma > 0 ? toma : null;
        const arr = Number(t?.analisis_fisico?.total_arreglos) || 0;
        row.arreglos = arr > 0 ? arr : null;
      }

      usados.push(row);
    }

    // Los que tienen precio primero; dentro de cada grupo, los mas caros arriba.
    usados.sort((a, b) => (b.precio_venta || 0) - (a.precio_venta || 0));

    return json({ ok: true, costoIncluido: includeCosto, total: usados.length, usados });
  } catch (e) {
    console.error("usados-disponibles:", e);
    return json({ ok: false, error: String(e) }, 500);
  }
});
