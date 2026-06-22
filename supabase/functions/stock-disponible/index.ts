// Edge Function: stock-disponible
// Devuelve el stock 0km DISPONIBLE PARA VENDER leyendo Oversoft EN VIVO (no la planilla espejo).
//
// Por que existe: la consulta 0km leia un CSV espejo del Sheet maestro que solo contenia
// el stock FISICO recibido. Las unidades "a recibir" (pedidas / en camino, recibida=false)
// nunca entraban => el vendedor no las veia. Esta funcion las incluye.
//
// Definicion de "disponible" (igual que gestion-tga / motor baratito):
//   unidades.entregada = false  &&  unidades.asignada = false  &&  unidades.preventa = ''
//   => fisico libre (recibida=true) + a recibir (recibida=false).
//
// Cadena de resolucion (validada end-to-end, 84/84 unidades resueltas):
//   unidades.modelo (codigo)  -> Oversoft modelos.codigodecompra -> descripcionoperativa
//                             -> _ntrim() -> wjfgl catalogo_modelos (nombre_corto/nombre_bt) -> nombreCorto
//                             -> baratito_snapshot.payload.modelos[nombreCorto] -> precios + ganancia
//   unidades.color (numerico) -> Oversoft colores.colorid -> descripcion
//   serie con precio especial -> wjfgl portal_precios_unidad (activo) -> pisa la oferta
//
// El precio y la ganancia salen del snapshot del Motor Baratito (lo calcula gestion-tga,
// fuente unica de verdad) -> aca NO se reimplementa ninguna formula.
//
// Secrets requeridos: OVERSOFT_URL, OVERSOFT_KEY (replica solo-lectura).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY los inyecta el runtime.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// GET helper para PostgREST (Oversoft o wjfgl) con manejo de error.
async function rest(base: string, key: string, path: string): Promise<any[]> {
  const res = await fetch(base + path, {
    headers: { apikey: key, Authorization: "Bearer " + key },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// Normalizador de nombres de modelo. Portado VERBATIM de gestion-tga Codigo.js (_ntrim).
// Load-bearing: define como matchea descripcionoperativa de Oversoft con el catalogo wjfgl.
function ntrim(s: unknown): string {
  let t = String(s || "").toLowerCase();
  t = t.replace(/bi[\s-]*tono/g, "bitono");
  t = t.replace(/\b(vw|nuevo)\b/g, "");
  t = t.replace(/\bmtg([123])\b/g, "mt"); // "MTG3" = "MT G3"
  t = t.replace(/\bmy2[0-9]\b/g, "").replace(/\b20[0-9][0-9]\b/g, "").replace(/\bg[123]\b/g, "");
  t = t.replace(/\bph[ag]\b/g, "").replace(/\b(se|cd|l)\b/g, "");
  return t.replace(/[^a-z0-9]/g, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const SUPA_URL = Deno.env.get("SUPABASE_URL");
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const OV_URL = Deno.env.get("OVERSOFT_URL"); // .../rest/v1
  const OV_KEY = Deno.env.get("OVERSOFT_KEY");
  if (!SUPA_URL || !SUPA_KEY) return json({ ok: false, error: "SUPABASE env vars missing" }, 500);
  if (!OV_URL || !OV_KEY) return json({ ok: false, error: "OVERSOFT env vars missing" }, 500);
  const W = SUPA_URL + "/rest/v1";

  try {
    // 1) Unidades disponibles + catalogos Oversoft (modelos paginado, colores).
    const unidadesP = rest(
      OV_URL, OV_KEY,
      "/unidades?select=serie,modelo,color,fechadepedido,fechaderecepcion,facturafecha,recibida" +
      "&entregada=eq.false&asignada=eq.false&preventa=eq.&limit=5000"
    );
    const modelosP = (async () => {
      const all: any[] = [];
      for (let off = 0; off < 6000; off += 1000) {
        const ch = await rest(OV_URL!, OV_KEY!, `/modelos?select=codigodecompra,descripcionoperativa&order=modeloid&limit=1000&offset=${off}`);
        all.push(...ch);
        if (ch.length < 1000) break;
      }
      return all;
    })();
    const coloresP = rest(OV_URL, OV_KEY, "/colores?select=colorid,descripcion&limit=3000");

    // 2) wjfgl: catalogo + snapshot del motor + precios especiales por chasis.
    const catP = rest(W, SUPA_KEY, "/catalogo_modelos?select=nombre_corto,nombre_bt&limit=2000");
    const snapP = rest(W, SUPA_KEY, "/baratito_snapshot?select=payload&id=eq.1&limit=1");
    const espP = rest(W, SUPA_KEY, "/portal_precios_unidad?select=serie,precio,dto,nota&activo=eq.true&limit=2000");

    const [unidades, modelos, colores, cat, snapArr, especiales] =
      await Promise.all([unidadesP, modelosP, coloresP, catP, snapP, espP]);

    // 3) Mapas de resolucion.
    const descByCode: Record<string, string> = {};
    for (const m of modelos) if (m.codigodecompra) descByCode[String(m.codigodecompra).trim()] = m.descripcionoperativa;
    const colorById: Record<string, string> = {};
    for (const c of colores) colorById[String(c.colorid)] = String(c.descripcion || "").trim();
    const ncByNorm: Record<string, string> = {};
    for (const c of cat) {
      if (c.nombre_corto) ncByNorm[ntrim(c.nombre_corto)] = c.nombre_corto;
      if (c.nombre_bt) ncByNorm[ntrim(c.nombre_bt)] = c.nombre_corto;
    }
    const payload = (snapArr[0]?.payload) || {};
    const modelosSnap: any[] = payload.modelos || [];
    const priceByNc: Record<string, any> = {};
    for (const s of modelosSnap) if (s.nombreCorto) priceByNc[s.nombreCorto] = s;
    const espBySerie: Record<string, any> = {};
    for (const e of especiales) if (e.serie) espBySerie[String(e.serie).trim()] = e;

    // 4) Join por unidad.
    const out: any[] = [];
    const sinResolver: any[] = [];
    for (const u of unidades) {
      const code = String(u.modelo || "").trim();
      const desc = descByCode[code];
      const nc = desc ? ncByNorm[ntrim(desc)] : null;
      const price = nc ? priceByNc[nc] : null;
      if (!nc || !price) { sinResolver.push({ serie: u.serie, modelo: code, desc: desc || null }); continue; }

      const oferta_baratito = Number(price.precioOferta) || 0;
      const gcia_actual = Number(price.gananciaPct) || 0;
      const precio_lista = Number(price.lista) || 0;
      const dto_baratito = Number(price.dtoTG) || 0;

      // precio especial por chasis (pisa la oferta del modelo)
      const esp = espBySerie[String(u.serie || "").trim()];
      const oferta_vigente = esp && Number(esp.precio) > 0 ? Number(esp.precio) : oferta_baratito;
      const fuente_oferta = esp && Number(esp.precio) > 0 ? "unidad" : "baratito";
      const gcia_vigente = gcia_actual; // el motor no calcula gcia por chasis especial; usamos la del modelo

      const fecha = u.facturafecha || u.fechaderecepcion || u.fechadepedido || null;

      out.push({
        serie: String(u.serie || "").trim(),
        modelo: price.modelo || nc, // nombre amigable (nombre_bt)
        nombreCorto: nc,
        familia: price.familia || null,
        color: colorById[String(u.color)] || ("color " + u.color),
        libre: true,
        aRecibir: u.recibida === false,
        fecha_factura: fecha, // ISO; el cliente lo parsea a Date
        precio_lista,
        oferta_baratito,
        gcia_actual,
        dto_baratito,
        oferta_vigente,
        gcia_vigente,
        fuente_oferta,
      });
    }

    // Orden: por modelo, y dentro del modelo del mas viejo al mas nuevo (prioriza unidades antiguas).
    out.sort((a, b) => {
      if (a.modelo !== b.modelo) return a.modelo.localeCompare(b.modelo);
      const fa = a.fecha_factura ? Date.parse(a.fecha_factura) : Infinity;
      const fb = b.fecha_factura ? Date.parse(b.fecha_factura) : Infinity;
      return fa - fb;
    });

    return json({
      ok: true,
      updatedAt: payload.updatedAt || null,
      mesUsado: payload.mesUsado || null,
      count: out.length,
      fisico: out.filter((r) => !r.aRecibir).length,
      aRecibir: out.filter((r) => r.aRecibir).length,
      sinResolver: sinResolver.length,
      unidades: out,
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
});
