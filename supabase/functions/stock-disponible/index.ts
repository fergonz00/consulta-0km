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
// Ademas del stock de Oversoft devuelve `repartoUnidades`: las unidades que VW ya nos
// asigno en el reparto (reparto_vw) y todavia NO entraron a Oversoft. El vendedor las
// elige como si fueran chasis, para poder pedir mejora de precio sobre un auto que no
// esta fisicamente pero que ya tiene color asignado y precio puesto en el Baratito.
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
// Dias habiles que puede estar una unidad "a recibir" antes de que sea una demora.
// Mismo umbral que la Edge notify-unidad-demorada (tasador-tga).
const DIAS_DEMORA = 7;

const hoyAR = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const _dow = (iso: string) => new Date(iso.slice(0, 10) + "T12:00:00Z").getUTCDay();
const _masDias = (iso: string, n: number) =>
  new Date(new Date(iso.slice(0, 10) + "T12:00:00Z").getTime() + n * 86400_000).toISOString().slice(0, 10);

/** Dias habiles (lun-vie sin feriados) entre dos fechas. Gemelo del de la Edge de avisos. */
function habilesEntre(desde: string, hasta: string, feriados: Set<string>): number {
  let f = desde.slice(0, 10);
  const fin = hasta.slice(0, 10);
  let n = 0, guarda = 0;
  while (f < fin && guarda++ < 800) {
    f = _masDias(f, 1);
    const d = _dow(f);
    if (d !== 0 && d !== 6 && !feriados.has(f)) n++;
  }
  return n;
}

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

// Normaliza un nombre de color para comparar entre fuentes. Oversoft y reparto_vw
// escriben distinto el mismo color: "Gris Volcan"/"Gris Volcán", "Blanco Puro"/"Blanco
// puro", "Gris Indy metalizado"/"Gris Indy". Sin esto, una unidad que SI esta en el
// salon aparece como "color que no tenemos". Mismo criterio en index.html (_normColor).
function normColor(s: unknown): string {
  let t = String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  t = t.replace(/\b(metalizado|metalico|met|efecto perla|perlado|perla|premium)\b/g, "");
  t = t.replace(/mojawe/g, "mojave"); // el catalogo VW lo escribe con w, Oversoft con v
  return t.replace(/[^a-z0-9]+/g, " ").trim();
}

// Quita el token de model-year final (MY26 / MY27 / 2026) del codigodecompra.
// Sirve para un fallback: cuando Oversoft tiene una unidad con un codigo de anio
// NUEVO todavia no cargado en la tabla modelos (ej. "5URTT4 MY27" = Saveiro
// Trendline), matcheamos contra su hermana de otro anio ("5URTT4 MY26"), que
// resuelve al mismo modelo. Sin esto, la unidad se descartaba en silencio.
function baseCode(code: string): string {
  return String(code || "").replace(/\s+(my\d{2}|20\d{2}|\d{4})\s*$/i, "").trim();
}

// ntrim para descripciones que NO vienen de Oversoft (compras/reparto): pueden
// traer el model-year con 4 digitos pegado al final ("... V6 AT 4x4 G2 MY2026"),
// que ntrim no saca porque no hay borde de palabra entre "my" y "2026".
function ntrimDesc(d: unknown): string {
  return ntrim(String(d || "").replace(/\s+MY\s*\d{2,4}\s*$/i, ""));
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
    // Descripcion REAL por chasis: unica forma de nombrar una unidad cuyo codigo
    // MY es nuevo Y cuyo codigo base es ambiguo (CH24K3 = Nivus Highline/Outfit,
    // AGDD8A = Amarok Extreme/Hero/Black Style, DF14D3 = Tera High/Outfit...).
    // compras_vw = lo facturado por VW (carga de Valeria); reparto_vw = lo asignado.
    const repDescP = rest(W, SUPA_KEY, "/reparto_vw?select=vin,descripcion&limit=5000").catch(() => []);
    const comprasP = rest(W, SUPA_KEY, "/compras_vw?select=serie,modelo_valeria&limit=5000").catch(() => []);
    // Historico de unidades (CUALQUIER estado: vendidas, entregadas, asignadas). No es
    // stock: es la unica forma de saber que colores existen de verdad para cada modelo.
    // Alimenta `paleta`, que es el selector de color de las consultas "sin
    // disponibilidad" — ahi el vendedor pide un color que hoy no tenemos, y la lista
    // NO se inventa: sale de lo que VW nos facturo o nos ofrecio alguna vez.
    // Ventana de 4 anios (~2.500 filas): 18 meses dejaba afuera colores reales de
    // modelos de rotacion lenta.
    const desdeHist = new Date(Date.now() - 1095 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    // OJO: PostgREST corta en 1000 filas por request sin importar el `limit`. Sin
    // paginar, el historico devolvia solo las 1000 primeras (las mas viejas) y los
    // modelos recientes se quedaban SIN PALETA. Paginamos ordenando por fecha
    // descendente, asi lo mas nuevo entra primero si algun dia se corta.
    const histP = (async () => {
      const all: any[] = [];
      for (let off = 0; off < 6000; off += 1000) {
        const ch = await rest(
          OV_URL!, OV_KEY!,
          `/unidades?select=serie,modelo,color,fechadepedido&fechadepedido=gte.${desdeHist}` +
            `&order=fechadepedido.desc&limit=1000&offset=${off}`,
        );
        all.push(...ch);
        if (ch.length < 1000) break;
      }
      return all;
    })().catch(() => [] as any[]);
    // Colores tal como los escribe VW en la factura (carga de Valeria) y en la oferta de
    // reparto del Sheet. Suman al historico de Oversoft: cubren casos donde la unidad
    // todavia no entro al sistema o donde Oversoft normalizo el nombre distinto.
    const comprasColorP = rest(W, SUPA_KEY, "/compras_vw?select=modelo_valeria,modelo_oversoft,color,fecha_factura&limit=5000").catch(() => [] as any[]);
    const portalRepP = rest(W, SUPA_KEY, "/portal_reparto?select=modelo,color&limit=2000").catch(() => [] as any[]);
    // Unidades A RECIBIR que no llegan, con lo que contesto VW. La fila la crea la
    // Edge `notify-unidad-demorada` (repo tasador-tga) y la nota la carga Fer en el
    // panel /precios del portal. Es lo unico que tiene el vendedor para saber que
    // plazo prometerle al cliente cuando el auto todavia no esta fisico.
    const demorasP = rest(
      W, SUPA_KEY,
      "/unidades_demora?select=serie,fecha_oversoft,problema,fecha_estimada,silenciada_at&recibida_at=is.null&limit=2000",
    ).catch(() => [] as any[]);
    const feriadosP = rest(W, SUPA_KEY, "/feriados_ar?select=fecha&limit=2000").catch(() => [] as any[]);

    const [unidades, modelos, colores, cat, snapArr, especiales, listaPrecios, repDesc, compras, hist,
           comprasColor, portalRep, demoras, feriadosRows] =
      await Promise.all([unidadesP, modelosP, coloresP, catP, snapP, espP, listaP, repDescP, comprasP, histP,
                         comprasColorP, portalRepP, demorasP, feriadosP]);

    // Demora por chasis, lista para colgarle a la unidad.
    const feriados = new Set<string>((feriadosRows || []).map((f: any) => String(f.fecha).slice(0, 10)));
    const demoraBySerie: Record<string, any> = {};
    for (const d of demoras || []) {
      const serie = String(d.serie || "").trim().toUpperCase();
      if (!serie) continue;
      const alta = d.fecha_oversoft ? String(d.fecha_oversoft).slice(0, 10) : null;
      const diasHabiles = alta ? habilesEntre(alta, hoyAR(), feriados) : 0;
      const problema = String(d.problema || "").trim() || null;
      const fechaEstimada = d.fecha_estimada ? String(d.fecha_estimada).slice(0, 10) : null;
      // Silenciada sin nota = ya se chequeo con VW y no hay nada que contarle al
      // vendedor. Con nota si se muestra: la nota manda sobre el silencio.
      if (d.silenciada_at && !problema && !fechaEstimada) continue;
      // Solo lo que es novedad: hay algo anotado, o ya paso el plazo sin respuesta.
      if (!problema && !fechaEstimada && diasHabiles < DIAS_DEMORA) continue;
      demoraBySerie[serie] = { serie, problema, fechaEstimada, diasHabiles };
    }

    // 3) Mapas de resolucion.
    const descByCode: Record<string, string> = {};
    // Fallback por prefijo de codigo (sin anio). SOLO si todas las hermanas de ese
    // base son el mismo producto: hay bases compartidos por trims distintos
    // ("CH24K3 MY26" = Nivus Highline y "CH24K3 PAR MY26" = Nivus Outfit). Ahi
    // "ultimo gana" colgaba la unidad del trim equivocado -> null = ambiguo.
    const descByBase: Record<string, string | null> = {};
    for (const m of modelos) if (m.codigodecompra) {
      const c = String(m.codigodecompra).trim();
      descByCode[c] = m.descripcionoperativa;
      const b = baseCode(c);
      if (!b) continue;
      if (!(b in descByBase)) descByBase[b] = m.descripcionoperativa;
      else if (ntrim(descByBase[b]) !== ntrim(m.descripcionoperativa)) descByBase[b] = null;
    }
    // serie (8) -> descripcion real de esa unidad.
    const descByChasis: Record<string, string> = {};
    for (const r of repDesc) {
      const s = String(r.vin || "").trim().toUpperCase().slice(-8);
      if (s && r.descripcion) descByChasis[s] = String(r.descripcion);
    }
    for (const r of compras) { // compras pisa a reparto: es lo facturado
      const s = String(r.serie || "").trim().toUpperCase();
      if (s && r.modelo_valeria) descByChasis[s] = String(r.modelo_valeria);
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
    // Igual que descByBase: si la lista tiene el mismo codigo para dos trims
    // (Highline y Outfit comparten CH24K3), el base no alcanza -> ambiguo.
    const modelByListCode: Record<string, string | null> = {};
    for (const p of listaPrecios) {
      const b = baseCode(p.codigo);
      if (!b || !p.modelo) continue;
      const nombre = String(p.modelo).trim();
      if (!(b in modelByListCode)) modelByListCode[b] = nombre;
      else if (modelByListCode[b] && ntrim(modelByListCode[b]) !== ntrim(nombre)) modelByListCode[b] = null;
    }

    // Resuelve el codigo de una unidad al nombreCorto del snapshot recorriendo, en orden:
    //   1) catalogo Oversoft por codigo exacto
    //   2) descripcion real de ESE chasis (factura VW / reparto)  <- desambigua los
    //      bases compartidos, que son justo los que el codigo no puede resolver
    //   3) catalogo Oversoft por codigo-base (hermana de otro anio), si es unico
    //   4) lista de precios VW por codigo-base, si es unico  <- codigos que Oversoft no cargo
    // Devuelve null solo si de verdad no hay forma de nombrar el modelo (y nunca
    // adivina entre dos trims: colgarla del equivocado le cambia el precio al vendedor).
    function resolveNc(code: string, serie?: string): string | null {
      const nc0 = descByCode[code] ? ncByNorm[ntrim(descByCode[code])] : null;
      if (nc0) return nc0;
      const dch = serie ? descByChasis[String(serie).trim().toUpperCase()] : null;
      if (dch) {
        const nc = ncByNorm[ntrimDesc(dch)];
        if (nc) return nc;
      }
      const dBase = descByBase[baseCode(code)];
      if (dBase) {
        const nc = ncByNorm[ntrim(dBase)];
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
      const nc = resolveNc(code, String(u.serie || "").trim());
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
      // Demora: la unidad esta a recibir y no llega. Va para TODOS (vendedores
      // incluidos): es justamente el dato que necesitan antes de prometer fecha.
      const dem = demoraBySerie[String(u.serie || "").trim().toUpperCase()];
      if (dem) row.demora = dem;
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
    // recibir"). Se excluyen las que ya figuran en Oversoft.
    //
    // Se devuelve en DOS formas:
    //   - `reparto`      : agregado modelo -> {disponibles / pedidas} -> color -> cantidad.
    //                      Responde "¿puedo reponer este modelo?" (bloque del admin).
    //   - `repartoUnidades`: una fila POR UNIDAD, con el mismo shape que `unidades`.
    //                      El vendedor las elige como si fueran chasis de stock para
    //                      pedir mejora de precio (mismo criterio que Baratito, que
    //                      publica precio de modelos con stock fisico 0).
    //
    // Desde 2026-08 va para TODOS los roles (antes era solo admin): sin esto el
    // vendedor no podia consultar un auto que no esta fisicamente pero que si esta
    // asignado y con precio puesto (ej. Vento GLI, Amarok TDI AT 4x2). La ganancia
    // sigue blindada: solo se adjunta si includeGcia.
    let reparto: Record<string, any> | undefined;
    const repartoUnidades: any[] = [];
    // Se llenan dentro del bloque de reparto y se reusan despues para la paleta.
    let repRowsAll: any[] = [];
    let colorNameFn: (cod: string) => string = (c) => c || "(sin color)";
    // Catalogo de colores VIGENTE de VW (tabla reparto_colores + la base hardcodeada).
    // Es la unica lista con los nombres que VW usa HOY. El historico de Oversoft
    // arrastra nombres de catalogos viejos que son la MISMA pintura con otro nombre
    // ("Candy White"/"Blanco Candy" = Blanco Cristal, "Plata Metalizada" = Plata
    // Pirita), y ofrecerselos al cliente seria ofrecerle un color que no existe.
    const catalogoColorVw = new Set<string>(Object.values(REPARTO_COLORES_BASE).map(normColor));
    {
      try {
        const repRows = await rest(W, SUPA_KEY, "/reparto_vw?select=vin,descripcion,color_codigo,estado_compra,periodo&limit=8000");
        repRowsAll = repRows;
        if (repRows.length) {
          // "Disponibles para pedir" = solo el reparto del MES EN CURSO (la
          // asignacion vigente de VW; la de meses pasados ya no se puede pedir).
          // OJO: antes esto era "el periodo mas nuevo que haya en la tabla", y al
          // cambiar el mes el reparto viejo seguia vivo — el 1ro se ofrecian autos
          // de la asignacion del mes anterior, que VW ya no da. Ahora, cuando cambia
          // el mes, no hay NADA para ofrecer hasta que se cargue el reparto nuevo.
          // "Ya pedidas / en camino" (comprado u ok) = de cualquier periodo,
          // mientras no hayan entrado a Oversoft todavia (esas SI son nuestras).
          const perVigente = hoyAR().slice(0, 7);
          const PEDIDA = new Set(["comprado", "ok"]);
          const vigentes = repRows.filter((r: any) =>
            String(r.periodo || "") === perVigente || PEDIDA.has(String(r.estado_compra || "").toLowerCase()));

          // Nombres de color (codigo VW -> nombre); DB pisa la base.
          const coloresRep: Record<string, string> = {};
          try {
            for (const c of await rest(W, SUPA_KEY, "/reparto_colores?select=codigo,nombre&limit=2000")) {
              if (c.codigo) coloresRep[String(c.codigo)] = String(c.nombre || "").trim();
            }
          } catch (_) { /* usamos solo la base */ }
          const colorName = (cod: string) => coloresRep[cod] || REPARTO_COLORES_BASE[cod] || cod || "(sin color)";
          colorNameFn = colorName;
          for (const n of Object.values(coloresRep)) if (n) catalogoColorVw.add(normColor(n));

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
          const vistas = new Set<string>();                   // una fila por serie (un VIN puede repetirse entre periodos)
          for (const r of vigentes) {
            const serie = serieDe(r.vin);
            if (!serie || enOv.has(serie)) continue;          // ya entro a Oversoft -> stock real
            if (vistas.has(serie)) continue;
            vistas.add(serie);
            const nc = ncByNorm[ntrim(r.descripcion)];
            if (!nc) continue;                                // no matchea catalogo -> lo salteamos
            const esPedida = PEDIDA.has(String(r.estado_compra || "").toLowerCase());
            // pendiente/elegida solo cuenta como "disponible" si es del reparto vigente
            if (!esPedida && String(r.periodo || "") !== perVigente) continue;
            const price = priceByNc[nc];
            const friendly = price ? (price.modelo || nc) : nc;
            if (!rep[friendly]) rep[friendly] = { modelo: friendly, nombreCorto: nc, total: 0, disponibles: { total: 0, colores: {} }, pedidas: { total: 0, colores: {} } };
            const bucket = esPedida ? rep[friendly].pedidas : rep[friendly].disponibles;
            const col = colorName(String(r.color_codigo || "").trim());
            bucket.total++;
            bucket.colores[col] = (bucket.colores[col] || 0) + 1;
            rep[friendly].total++;

            // Fila por unidad para el selector del vendedor. Sin precio del motor no
            // se puede analizar la consulta -> la dejamos solo en el agregado.
            if (!price) continue;
            const oferta_baratito = Number(price.precioOferta) || 0;
            const gcia_actual = Number(price.gananciaPct) || 0;
            const precio_lista = Number(price.lista) || 0;
            const dto_baratito = Number(price.dtoTG) || 0;
            // Precio especial por chasis: raro en reparto (la unidad todavia no existe
            // en el panel), pero si esta cargado tiene que ganar igual que en stock.
            const espR = espBySerie[serie];
            const tieneEspR = espR && Number(espR.precio) > 0;
            const oferta_vigenteR = tieneEspR ? Number(espR.precio) : oferta_baratito;
            const rowR: any = {
              serie,
              modelo: friendly,
              nombreCorto: nc,
              familia: price.familia || null,
              color: col,
              libre: true,
              aRecibir: false,
              enReparto: true,
              // "pedida" = ya comprada a VW / en camino; "a_pedir" = asignada y todavia
              // se puede pedir. Las dos son vendibles, cambia solo el cartel.
              estadoReparto: esPedida ? "pedida" : "a_pedir",
              fecha_factura: null,
              precio_lista,
              oferta_baratito,
              dto_baratito,
              oferta_vigente: oferta_vigenteR,
              fuente_oferta: tieneEspR ? "unidad" : "baratito",
            };
            if (includeGcia) {
              rowR.gcia_actual = gcia_actual;
              rowR.gcia_vigente = tieneEspR
                ? gciaEnOferta(gcia_actual, precio_lista, oferta_baratito, oferta_vigenteR)
                : gcia_actual;
            }
            repartoUnidades.push(rowR);
          }
          repartoUnidades.sort((a, b) =>
            a.modelo !== b.modelo ? a.modelo.localeCompare(b.modelo) : a.color.localeCompare(b.color));
          reparto = rep;
        }
      } catch (_) { /* reparto es opcional; nunca rompe el stock */ }
    }

    // ================= PALETA DE COLORES POR MODELO =================
    // Que colores existen de verdad para cada modelo, con cuantas unidades tuvimos y
    // cuando fue la ultima. Union de dos fuentes:
    //   - Oversoft (~18 meses de unidades, en cualquier estado) -> lo que nos facturaron.
    //   - reparto_vw (todos los periodos)                       -> lo que VW nos asigno.
    // Es la lista que ve el vendedor cuando pide un color que hoy no tenemos, y la que
    // le dice al admin "de esa combinacion tuvimos N, la ultima el <fecha>".
    // Cada color guarda por separado cuantas veces nos lo FACTURARON (Oversoft +
    // compras_vw) y cuantas VW nos lo OFRECIO en un reparto. No es lo mismo: un color
    // que solo aparece ofrecido nunca lo tuvimos, pero VW lo produce para nosotros.
    // `vw` = el nombre matchea el catalogo de colores vigente de VW. El front solo
    // ofrece los que tienen vw=true; el resto queda en el payload para depurar.
    type PalEntry = { color: string; n: number; nFact: number; nRep: number; ultima: string | null; vw: boolean };
    const paletaAcc: Record<string, Record<string, PalEntry>> = {};
    const addPaleta = (nc: string, color: string, fecha: string | null, tipo: "fact" | "rep") => {
      if (!nc || !color) return;
      const k = normColor(color);
      if (!k) return;
      const porNc = (paletaAcc[nc] ||= {});
      const e = (porNc[k] ||= { color, n: 0, nFact: 0, nRep: 0, ultima: null, vw: catalogoColorVw.has(k) });
      e.n++;
      if (tipo === "fact") e.nFact++;
      else e.nRep++;
      if (fecha && (!e.ultima || fecha > e.ultima)) e.ultima = fecha;
    };
    for (const h of hist as any[]) { // unidades de Oversoft (facturadas)
      const nc = resolveNc(String(h.modelo || "").trim(), String(h.serie || "").trim());
      if (!nc) continue;
      const col = colorById[String(h.color)];
      if (!col) continue;
      addPaleta(nc, col, h.fechadepedido ? String(h.fechadepedido).slice(0, 10) : null, "fact");
    }
    for (const r of comprasColor as any[]) { // facturas de VW (carga de Valeria)
      const nc = ncByNorm[ntrimDesc(r.modelo_valeria)] || ncByNorm[ntrimDesc(r.modelo_oversoft)];
      if (!nc || !r.color) continue;
      addPaleta(nc, String(r.color), r.fecha_factura ? String(r.fecha_factura).slice(0, 10) : null, "fact");
    }
    for (const r of repRowsAll) { // reparto_vw: lo que VW nos ofrecio
      const nc = ncByNorm[ntrim(r.descripcion)];
      if (!nc) continue;
      // El periodo es "YYYY-MM": lo llevamos a fecha para poder comparar con el historico.
      const per = String(r.periodo || "");
      addPaleta(nc, colorNameFn(String(r.color_codigo || "").trim()), /^\d{4}-\d{2}$/.test(per) ? per + "-01" : null, "rep");
    }
    for (const r of portalRep as any[]) { // oferta de reparto del Sheet
      const nc = ncByNorm[ntrimDesc(r.modelo)];
      if (!nc || !r.color) continue;
      addPaleta(nc, String(r.color), null, "rep");
    }
    const paleta: Record<string, any[]> = {};
    for (const nc of Object.keys(paletaAcc)) {
      paleta[nc] = Object.values(paletaAcc[nc]).sort((a, b) => b.n - a.n || a.color.localeCompare(b.color));
    }

    // ================= CATALOGO COMPLETO =================
    // TODOS los modelos con precio publicado, tengan o no unidades. Sin esto, un modelo
    // sin stock ni reparto (hoy 20 de 48) no se puede ni nombrar en una consulta.
    const catalogoModelos = modelosSnap
      .filter((m: any) => m && m.nombreCorto)
      .map((m: any) => {
        const row: any = {
          modelo: m.modelo || m.nombreCorto,
          nombreCorto: m.nombreCorto,
          familia: m.familia || null,
          precio_lista: Number(m.lista) || 0,
          oferta_baratito: Number(m.precioOferta) || 0,
          dto_baratito: Number(m.dtoTG) || 0,
        };
        if (includeGcia) row.gcia_actual = Number(m.gananciaPct) || 0;
        return row;
      });

    return json({
      ok: true,
      updatedAt: payload.updatedAt || null,
      mesUsado: payload.mesUsado || null,
      gciaIncluida: includeGcia,
      count: out.length,
      fisico: out.filter((r) => !r.aRecibir).length,
      aRecibir: out.filter((r) => r.aRecibir).length,
      demoradas: out.filter((r) => r.demora).length,
      sinResolver: sinResolver.length,
      enReparto: repartoUnidades.length,
      unidades: out,
      repartoUnidades,
      catalogoModelos,
      paleta,
      ...(rotacion ? { rotacion } : {}),
      ...(reparto ? { reparto } : {}),
    });
  } catch (e) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
});
