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
// GANANCIA BLINDADA: la gcia (gcia_actual/gcia_vigente) es dato sensible y SOLO se
// devuelve a los usuarios de GCIA_USUARIOS (hoy: solo fngonzalez), validados
// server-side con {usuario, clave} (POST) contra tasador_usuarios. El resto
// (otros admin incluidos), vendedor/gerente y cualquier GET reciben stock SIN gcia.
//
// Secrets requeridos: OVERSOFT_URL, OVERSOFT_KEY (replica solo-lectura).
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY los inyecta el runtime.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
};

// Usuarios autorizados a ver la ganancia. Los demas admin (ej. mlubrano) NO.
const GCIA_USUARIOS = new Set(["fngonzalez", "fgonzalez", "cgonzalez"]);

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

// Quita el token de model-year final (MY26 / MY27 / 2026) del codigodecompra.
// Sirve para un fallback: cuando Oversoft tiene una unidad con un codigo de anio
// NUEVO todavia no cargado en la tabla modelos (ej. "5URTT4 MY27" = Saveiro
// Trendline), matcheamos contra su hermana de otro anio ("5URTT4 MY26"), que
// resuelve al mismo modelo. Sin esto, la unidad se descartaba en silencio.
function baseCode(code: string): string {
  return String(code || "").replace(/\s+(my\d{2}|20\d{2}|\d{4})\s*$/i, "").trim();
}

// Nombres de color VW (codigo -> nombre) como fallback cuando reparto_colores no
// tiene el codigo. Portado de gestion-tga (REPARTO_COLORES_BASE). La DB pisa esto.
const REPARTO_COLORES_BASE: Record<string, string> = {
  "0Q0Q": "Blanco puro", "0Q2T": "Blanco Cristal / Negro Universal", "1B1B": "Beige Mojawe Metalizado",
  "1B2T": "Beige Mojawe Metalizado / Negro Profundo efecto perla", "2R2R": "Gris Platino",
  "2RA1": "Gris platino / negro", "2T2T": "Negro Profundo efecto perla", "3X3X": "Gris Salvia",
  "3XA1": "Gris salvia techo negro", "5T5T": "Azul Egeo", "6K6K": "Rojo Sunset", "6U6U": "Blanco Marfil",
  "6UA1": "Marfil / negro universal (bitono)", "7Z7Z": "Plata Sirius", "9711": "Gris Artico",
  "9728": "Gris Artico", "A1A1": "Negro Universal", "B4A1": "Blanco Cristal / Negro Universal",
  "B4B4": "Blanco Cristal", "C2A1": "Gris volcán / Negro Universal", "C2C2": "Gris Volcán", "D7": "Azul",
  "D7A1": "Azul Turbo / Negro Universal", "D7D7": "Azul Turbo", "H7H7": "Azul Atlántico metalizado",
  "I8A1": "Titanio techo negro", "I8I8": "Gris Titanio", "K22T": "Plata pirita techo negro",
  "K2A1": "Plata Pirita / Negro", "K2K2": "Plata Pirita", "L0L0": "Rojo hypernova",
  "L4A1": "Azul con techo negro", "L4L4": "Azul Malibu", "R4A1": "gris Alba", "R4R4": "gris alba",
  "U1U1": "Azul Pacifico", "X3X3": "Gris Indy",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  const SUPA_URL = Deno.env.get("SUPABASE_URL");
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const OV_URL = Deno.env.get("OVERSOFT_URL"); // .../rest/v1
  const OV_KEY = Deno.env.get("OVERSOFT_KEY");
  if (!SUPA_URL || !SUPA_KEY) return json({ ok: false, error: "SUPABASE env vars missing" }, 500);
  if (!OV_URL || !OV_KEY) return json({ ok: false, error: "OVERSOFT env vars missing" }, 500);
  const W = SUPA_URL + "/rest/v1";

  // Credenciales opcionales (POST) para desbloquear la gcia. Validadas contra
  // tasador_usuarios; solo cuentas con rol admin reciben ganancia.
  let includeGcia = false;
  if (req.method === "POST") {
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const usuario = String(body?.usuario || "").trim().toLowerCase();
    const clave = String(body?.clave || "");
    if (usuario && clave) {
      try {
        if (GCIA_USUARIOS.has(usuario)) {
          const u = await rest(
            W, SUPA_KEY,
            `/tasador_usuarios?usuario=eq.${encodeURIComponent(usuario)}&clave=eq.${encodeURIComponent(clave)}&activo=eq.true&select=usuario`
          );
          includeGcia = u.length > 0; // credenciales validas del usuario autorizado
        }
      } catch (_) { includeGcia = false; }
    }
  }

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
    // Lista de precios VW: mapea codigo-base (sin anio) -> nombre de modelo. La terminal
    // suele cargar aca los codigos nuevos ANTES que Oversoft actualice su catalogo, asi que
    // es la red de seguridad para que ninguna unidad quede sin resolver. order desc => la
    // lista mas nueva gana al deduplicar por codigo.
    const listaP = rest(W, SUPA_KEY, "/precios_lista?select=codigo,modelo&order=lista_num.desc&limit=5000");

    const [unidades, modelos, colores, cat, snapArr, especiales, listaPrecios] =
      await Promise.all([unidadesP, modelosP, coloresP, catP, snapP, espP, listaP]);

    // 3) Mapas de resolucion.
    const descByCode: Record<string, string> = {};
    const descByBase: Record<string, string> = {}; // fallback por prefijo de codigo (sin anio)
    for (const m of modelos) if (m.codigodecompra) {
      const c = String(m.codigodecompra).trim();
      descByCode[c] = m.descripcionoperativa;
      const b = baseCode(c);
      if (b) descByBase[b] = m.descripcionoperativa; // ultimo gana; hermanas ntrim al mismo modelo
    }
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
    // codigo-base -> nombre de modelo desde la lista de precios (primera aparicion = mas nueva).
    const modelByListCode: Record<string, string> = {};
    for (const p of listaPrecios) {
      const b = baseCode(p.codigo);
      if (b && p.modelo && !modelByListCode[b]) modelByListCode[b] = String(p.modelo).trim();
    }

    // Resuelve el codigo de una unidad al nombreCorto del snapshot recorriendo, en orden:
    //   1) catalogo Oversoft por codigo exacto
    //   2) catalogo Oversoft por codigo-base (hermana de otro anio)
    //   3) lista de precios VW por codigo-base  <- cubre codigos nuevos que Oversoft no cargo
    // Devuelve null solo si de verdad no hay forma de nombrar el modelo.
    function resolveNc(code: string): string | null {
      const desc = descByCode[code] || descByBase[baseCode(code)];
      if (desc) {
        const nc = ncByNorm[ntrim(desc)];
        if (nc) return nc;
      }
      const lm = modelByListCode[baseCode(code)];
      if (lm) {
        if (priceByNc[lm]) return lm;        // el nombre de la lista ya es un nombreCorto del snapshot
        const nc2 = ncByNorm[ntrim(lm)];     // o matchea via normalizacion
        if (nc2) return nc2;
      }
      return null;
    }

    // Ajuste de gcia al pasar de la oferta del modelo a la de un chasis con precio
    // especial. La gcia es LINEAL en la ventaNeta (costo/incentivos son fijos; IIBB,
    // comisión y cheque son proporcionales a vn), así que partimos de la gcia que ya
    // calculó el motor para el modelo (gcia_actual) y le sumamos solo el delta. Queda
    // consistente con el modelo sin importar la tasa exacta de cheque del motor, y no
    // depende de Apps Script. FYF se cancela en la resta de ofertas.
    const _GCIA_TAXRATE = 0.0135 / 1.21 + 0.014 / 1.21 + 0.006; // porción lineal en vn (cheque 0,6%)
    function gciaEnOferta(gciaModelo: number, lista: number, ofertaModelo: number, ofertaEsp: number): number {
      if (!(lista > 0)) return gciaModelo;
      return gciaModelo + ((ofertaEsp - ofertaModelo) * (1 - _GCIA_TAXRATE)) / lista;
    }

    // 4) Join por unidad.
    const out: any[] = [];
    const sinResolver: any[] = [];
    for (const u of unidades) {
      const code = String(u.modelo || "").trim();
      const nc = resolveNc(code);
      const price = nc ? priceByNc[nc] : null;
      if (!nc || !price) { sinResolver.push({ serie: u.serie, modelo: code }); continue; }

      const oferta_baratito = Number(price.precioOferta) || 0;
      const gcia_actual = Number(price.gananciaPct) || 0;
      const precio_lista = Number(price.lista) || 0;
      const dto_baratito = Number(price.dtoTG) || 0;

      // precio especial por chasis (pisa la oferta del modelo)
      const esp = espBySerie[String(u.serie || "").trim()];
      const tieneEsp = esp && Number(esp.precio) > 0;
      const oferta_vigente = tieneEsp ? Number(esp.precio) : oferta_baratito;
      const fuente_oferta = tieneEsp ? "unidad" : "baratito";
      // Con precio especial ajustamos la gcia a esa oferta (delta lineal desde la del
      // modelo). Antes se dejaba la del modelo tal cual y sobrestimaba el margen.
      const gcia_vigente = tieneEsp
        ? gciaEnOferta(gcia_actual, precio_lista, oferta_baratito, oferta_vigente)
        : gcia_actual;

      const fecha = u.facturafecha || u.fechaderecepcion || u.fechadepedido || null;

      const row: any = {
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
        dto_baratito,
        oferta_vigente,
        fuente_oferta,
      };
      // gcia solo para admin (ver bloque de credenciales arriba).
      if (includeGcia) { row.gcia_actual = gcia_actual; row.gcia_vigente = gcia_vigente; }
      out.push(row);
    }

    // Orden: por modelo, y dentro del modelo del mas viejo al mas nuevo (prioriza unidades antiguas).
    out.sort((a, b) => {
      if (a.modelo !== b.modelo) return a.modelo.localeCompare(b.modelo);
      const fa = a.fecha_factura ? Date.parse(a.fecha_factura) : Infinity;
      const fb = b.fecha_factura ? Date.parse(b.fecha_factura) : Infinity;
      return fa - fb;
    });

    // Rotacion por modelo (los "comparativos" del Baratito: vendidos por mes,
    // stock para meses-de-stock y dias en venderse). Sale del MISMO snapshot que
    // los precios -> mismos numeros que el panel. Sensible: solo admin (gcia).
    let rotacion: Record<string, any> | undefined;
    if (includeGcia) {
      rotacion = {};
      for (const nc of new Set(out.map((r) => r.nombreCorto))) {
        const p = priceByNc[nc as string];
        if (!p) continue;
        rotacion[nc as string] = {
          stock: Number(p.stock) || 0,
          ventasPorMes: p.ventasPorMes || {},
          diasVenta: p.diasVenta || null,
        };
      }
    }

    // Reparto (stock virtual): unidades que VW ya nos asigno en el reparto del
    // mes pero que TODAVIA no entraron a Oversoft (no son stock fisico ni "a
    // recibir"). Sirve para responder "¿puedo reponer este modelo?" con cuantas
    // y de que colores. Dato interno: SOLO admin (mismo blindaje que la gcia).
    // Se agrupa por modelo -> {disponibles (sin comprar aun) / pedidas (comprado
    // u ok)} -> color -> cantidad. Se excluyen las que ya figuran en Oversoft.
    let reparto: Record<string, any> | undefined;
    if (includeGcia) {
      try {
        const repRows = await rest(W, SUPA_KEY, "/reparto_vw?select=vin,descripcion,color_codigo,estado_compra,periodo&limit=8000");
        if (repRows.length) {
          // "Disponibles para pedir" = solo el reparto del periodo mas nuevo (la
          // asignacion vigente de VW; la de meses pasados ya no se puede pedir).
          // "Ya pedidas / en camino" (comprado u ok) = de cualquier periodo,
          // mientras no hayan entrado a Oversoft todavia.
          const perMax = repRows.reduce((m: string, r: any) => (String(r.periodo || "") > m ? String(r.periodo) : m), "");
          const PEDIDA = new Set(["comprado", "ok"]);
          const vigentes = repRows.filter((r: any) =>
            String(r.periodo || "") === perMax || PEDIDA.has(String(r.estado_compra || "").toLowerCase()));

          // Nombres de color (codigo VW -> nombre); DB pisa la base.
          const coloresRep: Record<string, string> = {};
          try {
            for (const c of await rest(W, SUPA_KEY, "/reparto_colores?select=codigo,nombre&limit=2000")) {
              if (c.codigo) coloresRep[String(c.codigo)] = String(c.nombre || "").trim();
            }
          } catch (_) { /* usamos solo la base */ }
          const colorName = (cod: string) => coloresRep[cod] || REPARTO_COLORES_BASE[cod] || cod || "(sin color)";

          // Excluir las que YA estan en Oversoft (por serie = ultimos 8 del VIN):
          // esas ya las cuenta el stock fisico / a recibir.
          const serieDe = (vin: string) => String(vin || "").toUpperCase().slice(-8);
          const seriesRep = [...new Set(vigentes.map((r: any) => serieDe(r.vin)).filter(Boolean))];
          const enOv = new Set<string>();
          for (let i = 0; i < seriesRep.length; i += 60) {
            const lote = seriesRep.slice(i, i + 60).map((s) => '"' + s + '"').join(",");
            try {
              for (const u of await rest(OV_URL!, OV_KEY!, `/unidades?select=serie&serie=in.(${encodeURIComponent(lote)})`)) {
                enOv.add(String(u.serie || "").toUpperCase());
              }
            } catch (_) { /* si falla, no excluimos ese lote */ }
          }

          const rep: Record<string, any> = {};
          for (const r of vigentes) {
            const serie = serieDe(r.vin);
            if (!serie || enOv.has(serie)) continue;          // ya entro a Oversoft -> stock real
            const nc = ncByNorm[ntrim(r.descripcion)];
            if (!nc) continue;                                // no matchea catalogo -> lo salteamos
            const esPedida = PEDIDA.has(String(r.estado_compra || "").toLowerCase());
            // pendiente/elegida solo cuenta como "disponible" si es del reparto vigente
            if (!esPedida && String(r.periodo || "") !== perMax) continue;
            const price = priceByNc[nc];
            const friendly = price ? (price.modelo || nc) : nc;
            if (!rep[friendly]) rep[friendly] = { modelo: friendly, nombreCorto: nc, total: 0, disponibles: { total: 0, colores: {} }, pedidas: { total: 0, colores: {} } };
            const bucket = esPedida ? rep[friendly].pedidas : rep[friendly].disponibles;
            const col = colorName(String(r.color_codigo || "").trim());
            bucket.total++;
            bucket.colores[col] = (bucket.colores[col] || 0) + 1;
            rep[friendly].total++;
          }
          reparto = rep;
        }
      } catch (_) { /* reparto es opcional; nunca rompe el stock */ }
    }

    return json({
      ok: true,
      updatedAt: payload.updatedAt || null,
      mesUsado: payload.mesUsado || null,
      gciaIncluida: includeGcia,
      count: out.length,
      fisico: out.filter((r) => !r.aRecibir).length,
      aRecibir: out.filter((r) => r.aRecibir).length,
      sinResolver: sinResolver.length,
      unidades: out,
      ...(rotacion ? { rotacion } : {}),
      ...(reparto ? { reparto } : {}),
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
});
