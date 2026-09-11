/**
 * Smoke test de consulta-0km: levanta index.html en jsdom con los scripts corriendo,
 * intercepta fetch (Supabase + Edge) con datos falsos y verifica la matematica nueva
 * del pago por transferencia y el circuito de reapertura.
 *
 * Un ReferenceError adentro de un try/catch deja la pantalla en cero sin romper nada,
 * asi que aca se falla ruidosamente ante cualquier error de consola.
 *
 * OJO: las variables de tope de archivo del index estan declaradas con `let`/`const`,
 * que NO cuelgan de window. Por eso las aserciones corren con win.eval(), que si ve
 * el scope global del script.
 */
const fs = require('fs')
const { JSDOM, VirtualConsole } = require('jsdom')

const HTML = fs.readFileSync('C:/proyectos/consulta-0km/index.html', 'utf8')

const errores = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => errores.push('jsdomError: ' + e.message))
vc.on('error', (...a) => errores.push('console.error: ' + a.join(' ')))
vc.on('warn', () => {})
vc.on('log', () => {})
vc.on('info', () => {})

const ALICUOTA = [{ periodo: '2026-09-01', sircreb_pct: 0.003, deb_cred_pct: 0.012 }]

function jsonResp(data) {
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  })
}

const dom = new JSDOM(HTML, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole: vc,
  url: 'https://consulta0km.titogonzalez.online/',
  beforeParse(win) {
    win.alert = (m) => errores.push('alert(): ' + m)
    win.confirm = () => true
    // jsdom no implementa scrollTo y el wizard lo llama al cambiar de paso.
    win.scrollTo = () => {}
    win.fetch = (url) => {
      const u = String(url)
      if (u.includes('costos_financieros_mes')) return jsonResp(ALICUOTA)
      return jsonResp([])
    }
  },
})

const win = dom.window

const TEST = `
(async function () {
  const fallos = [];
  // El index solo carga la alicuota despues del login; aca la pedimos a mano.
  await cargarCostosFinancieros();
  const ok = (cond, msg) => { if (!cond) fallos.push(msg); };
  const casi = (a, b, msg, tol) => {
    tol = tol || 1e-9;
    if (a == null || Math.abs(a - b) > tol) fallos.push(msg + ': esperaba ' + b + ', dio ' + a);
  };

  // 1) La alicuota se lee de la tabla y suma bien.
  casi(alicuotaTransferencia(), 0.015, 'alicuota total sep-26');
  ok(costoTransfer.desactualizado === false, 'sep-26 no deberia figurar desactualizado');
  ok(costoTransfer.sinDatos === false, 'sep-26 deberia tener datos');

  // 2) El costo en pesos del ejemplo de Fer.
  casi(costoTransferencia(10000000), 150000, 'costo de 10M al 1,5%');
  casi(costoTransferencia(0), 0, 'costo de 0');

  // 3) Analisis sobre el caso concreto: oferta 31.000.000, pedido 30.000.000,
  //    lista 34.000.000, ganancia del modelo 9%.
  stockData = [{
    serie: 'CHASIS1', modelo: 'VW Nivus Comfortline MY26', color: 'Blanco Cristal',
    libre: true, oferta_vigente: 31000000, gcia_vigente: 0.09, precio_lista: 34000000,
    fuente_oferta: 'baratito', fecha_factura: null
  }];
  const base = {
    modelo: 'VW Nivus Comfortline MY26',
    chasisSeleccionados: ['CHASIS1'],
    precioPedido: 30000000,
    esReparto: false
  };
  const sinTr = calcularAnalisisUnidad(base);
  ok(!!sinTr, 'el analisis sin transferencia no deberia ser null');
  casi(sinTr.dto_extra_pedido, 1000000 / 34000000, 'dto extra sin transferencia');
  casi(sinTr.gcia_resultante, 0.09 - 1000000 / 34000000, 'gcia sin transferencia');
  casi(sinTr.transferencia_costo, 0, 'costo de transferencia cuando no hay');

  const conTr = calcularAnalisisUnidad(Object.assign({}, base, { transferenciaMonto: 10000000 }));
  casi(conTr.transferencia_costo, 150000, 'costo de la transferencia');
  casi(conTr.precio_efectivo, 29850000, 'precio efectivo');
  casi(conTr.dto_extra_pedido, 1000000 / 34000000, 'el dto de precio no se toca');
  casi(conTr.dto_transferencia, 150000 / 34000000, 'dto de la transferencia');
  casi(conTr.dto_extra_total, 1150000 / 34000000, 'dto extra total');
  casi(conTr.gcia_resultante, 0.09 - 1150000 / 34000000, 'gcia neta con transferencia');
  // Tiene que dar exactamente lo mismo que haber vendido al precio efectivo.
  const equiv = calcularAnalisisUnidad(Object.assign({}, base, { precioPedido: 29850000 }));
  casi(conTr.gcia_resultante, equiv.gcia_resultante, 'gcia con transferencia vs precio efectivo');

  // 4) El wrapper no rompe los casos borde que ya devolvian null.
  ok(calcularAnalisisUnidad({ modelo: null, precioPedido: 1 }) === null, 'sin modelo deberia dar null');
  ok(calcularAnalisisUnidad(Object.assign({}, base, { precioPedido: null })) === null, 'sin precio deberia dar null');

  // 5) El analisis del admin arrastra el monto guardado en el item.
  const aAdmin = analisisAdminVivo({
    modelo: 'VW Nivus Comfortline MY26', precio_pedido: 30000000,
    chasis: [{ serie: 'CHASIS1' }], transferencia_monto: 10000000
  });
  casi(aAdmin.gcia_resultante, 0.09 - 1150000 / 34000000, 'gcia del admin con transferencia');

  // 6) Los bloques de UI se renderizan.
  const html = bloqueTransferencia({
    transferencia_monto: 10000000, precio_pedido: 30000000,
    precio_lista: 34000000, transferencia_alicuota: 0.015
  }, true);
  ok(html.indexOf('$150.000') >= 0, 'el bloque deberia mostrar el costo en pesos');
  ok(html.indexOf('$29.850.000') >= 0, 'el bloque deberia mostrar lo que entra de verdad');
  ok(bloqueTransferencia({ transferencia_monto: 0 }, true) === '', 'sin transferencia el bloque va vacio');
  // Si la alicuota cambio desde que se cargo, tiene que avisarlo.
  const htmlViejo = bloqueTransferencia({
    transferencia_monto: 10000000, precio_pedido: 30000000,
    precio_lista: 34000000, transferencia_alicuota: 0.014
  }, true);
  ok(htmlViejo.indexOf('hoy la al') >= 0, 'deberia avisar que la alicuota cambio');

  // 7) Reapertura: el bloque de referencia se arma con la ganancia recalculada.
  reaperturasMap = {
    '0km:77': [{
      created_at: '2026-09-08T12:00:00Z', respuesta_previa_at: '2026-09-05T12:00:00Z',
      estado_previo: 'contraoferta', precio_previo: 30500000,
      observaciones_previas: 'hasta el viernes', solicitada_por_nombre: 'Juan Perez',
      transferencia_monto: 10000000, transferencia_monto_previo: null
    }]
  };
  const ref = bloqueReaperturas({ id: 77 }, { modelo: 'VW Nivus Comfortline MY26' }, '0km', true);
  ok(ref.indexOf('$30.500.000') >= 0, 'la referencia deberia mostrar el precio anterior');
  ok(ref.indexOf('te quedaba') >= 0, 'la referencia deberia mostrar la ganancia anterior');
  ok(ref.indexOf('$10.000.000') >= 0, 'la referencia deberia decir cuanto pide por transferencia');
  // Al vendedor no se le muestra ninguna ganancia.
  const refVend = bloqueReaperturas({ id: 77 }, { modelo: 'VW Nivus Comfortline MY26' }, '0km', false);
  ok(refVend.indexOf('te quedaba') === -1, 'el vendedor NO deberia ver la ganancia anterior');
  ok(bloqueReaperturas({ id: 999 }, {}, '0km', true) === '', 'sin reaperturas el bloque va vacio');

  // 8) La maquina de pasos mete los pasos nuevos donde corresponde.
  formData = { origen: 'stock', unidades: [{}], pagaTransferencia: null, tipoCliente: null };
  ok(getNextStep('precios') === 'transferencia', 'despues de precios va la transferencia');
  ok(getNextStep('transferencia') === 'tipo-cliente', 'sin transferencia salta al cliente');
  formData.pagaTransferencia = 'si';
  ok(getNextStep('transferencia') === 'transferencia-monto', 'con transferencia pide el monto');
  ok(getNextStep('transferencia-monto') === 'tipo-cliente', 'del monto sigue al cliente');
  formUsado = { pagaTransferencia: 'si' };
  ok(getNextStep('u-precio') === 'u-transferencia', 'usados: despues del precio va la transferencia');
  ok(getNextStep('u-transferencia') === 'u-transferencia-monto', 'usados: pide el monto');
  ok(getNextStep('u-transferencia-monto') === 'u-tipo-cliente', 'usados: sigue al cliente');

  // 9) Los pasos nuevos renderizan sin explotar.
  currentMode = 'vendedor';
  formData = {
    origen: 'stock', pagaTransferencia: 'si', tipoCliente: null,
    unidades: [{
      modelo: 'VW Nivus Comfortline MY26', precioPedido: 30000000,
      transferenciaMonto: 10000000, chasisSeleccionados: ['CHASIS1']
    }]
  };
  const paso = STEP_RENDERERS['transferencia-monto']();
  ok(paso.body.indexOf('transfMonto0') >= 0, 'el paso del monto deberia tener el input');
  ok(STEP_RENDERERS['transferencia']().body.indexOf('SICE') >= 0, 'el paso deberia nombrar SICE');
  formUsado = { pagaTransferencia: 'si', transferenciaMonto: 5000000, precioPedido: 12000000, usadoid: 1 };
  ok(STEP_RENDERERS['u-transferencia']().body.length > 0, 'el paso de usados deberia renderizar');
  ok(STEP_RENDERERS['u-transferencia-monto']().body.indexOf('usadoTransfInput') >= 0, 'usados: input del monto');

  // 10) El total de pasos acompana.
  currentMode = 'vendedor'; wizardTipo = '0km';
  formData = { origen: 'stock', pagaTransferencia: 'no', tipoCliente: 'reventa', financia: 'no', vsOtro: 'no', unidades: [{}] };
  const nSin = totalSteps();
  formData.pagaTransferencia = 'si';
  ok(totalSteps() === nSin + 1, 'pedir el monto deberia sumar un paso');

  // 11) El formulario de reapertura solo aparece en consultas ya respondidas.
  currentMode = 'vendedor';
  ok(renderPedirTransferencia({ id: 1, estado: 'pendiente', items: [{}] }, '0km') === '', 'pendiente no se reabre');
  ok(renderPedirTransferencia({ id: 1, estado: 'contraoferta', items: [{}] }, '0km').indexOf('reabrirMonto') >= 0, 'respondida si se reabre');
  currentMode = 'admin';
  ok(renderPedirTransferencia({ id: 1, estado: 'contraoferta', items: [{}] }, '0km') === '', 'el admin no reabre');
  currentMode = 'vendedor';

  // 12) El cartel de desactualizado aparece cuando corresponde y no cuando no.
  ok(avisoAlicuota() === '', 'con el mes al dia no deberia haber cartel');
  costoTransfer = { total: 0.014, sircreb: 0.002, debCred: 0.012, periodo: '2026-08-01',
    periodoActual: '2026-09-01', desactualizado: true, sinDatos: false };
  ok(avisoAlicuota().indexOf('desactualizado') >= 0, 'deberia avisar que el SIRCREB quedo viejo');
  ok(avisoAlicuota().indexOf('ago 26') >= 0, 'deberia decir de que mes es el que se usa');
  costoTransfer = { total: 0.012, sircreb: 0, debCred: 0.012, periodo: null,
    periodoActual: '2026-09-01', desactualizado: true, sinDatos: true };
  ok(avisoAlicuota().indexOf('ninguna al') >= 0, 'sin ninguna fila deberia avisar aparte');


  // 13) Aviso "si vuelve a SICE": solo con transferencia y solo una vez respondida.
  costoTransfer = { total: 0.015, sircreb: 0.003, debCred: 0.012, periodo: '2026-09-01',
    periodoActual: '2026-09-01', desactualizado: false, sinDatos: false };
  const cTr = { id: 5, estado: 'contraoferta', items: [{ transferencia_monto: 10000000 }] };
  const nota = notaVolverASice(cTr, '0km');
  ok(nota.indexOf('$150.000') >= 0, 'la nota deberia decir cuanto mas de descuento se puede dar');
  ok(nota.indexOf('SICE') >= 0, 'la nota deberia nombrar SICE');
  ok(notaVolverASice({ id: 5, estado: 'pendiente', items: [{ transferencia_monto: 10000000 }] }, '0km') === '',
    'sin responder todavia no va la nota');
  ok(notaVolverASice({ id: 5, estado: 'contraoferta', items: [{}] }, '0km') === '',
    'sin transferencia no va la nota');
  // Usados: la transferencia vive en la cabecera, no en items.
  ok(notaVolverASice({ id: 5, estado: 'aceptada', transferencia_monto: 4000000 }, 'usado').indexOf('$60.000') >= 0,
    'usados: la nota deberia calcular sobre la cabecera');

  // 14) Pedido de la preventa al marcar la venta.
  ok(transferenciaDe(cTr, '0km') === 10000000, 'transferenciaDe deberia leer el item');
  ok(transferenciaDe({ transferencia_monto: 7 }, 'usado') === 7, 'transferenciaDe deberia leer la cabecera');
  const bpv = bloquePreventaVenta(cTr, '0km');
  ok(bpv.indexOf('pvVenta') >= 0, 'el bloque deberia tener el input de PV');
  ok(bpv.indexOf('obligatorio') >= 0, 'con transferencia la PV tiene que ser obligatoria');
  ok(bloquePreventaVenta({ id: 6, items: [{}] }, '0km').indexOf('opcional') >= 0,
    'sin transferencia la PV es opcional');

  // 15) Anotar la PV de una consulta ajena: solo Fer, Daniel y Matias.
  const cVend = { id: 9, estado: 'aceptada', vendedor_id: 'uuid-otro', vendedor_usuario: 'jcastro',
    resultado_venta: 'vendida', preventa: null, items: [{ transferencia_monto: 10000000 }] };
  currentUser = { id: 'uuid-yo', usuario: 'gbuena' };
  ok(puedeAnotarPvDeOtros() === false, 'un vendedor comun no deberia poder anotar PV ajenas');
  ok(bloqueAnotarPv(cVend, '0km') === '', 'un vendedor comun no ve el bloque en una consulta ajena');
  for (const u of ['fngonzalez', 'dlopez', 'mlubrano']) {
    currentUser = { id: 'uuid-' + u, usuario: u };
    ok(puedeAnotarPvDeOtros() === true, u + ' deberia poder anotar la PV');
    ok(bloqueAnotarPv(cVend, '0km').indexOf('guardarPreventaSuelta(9') >= 0, u + ' deberia ver el boton de guardar');
  }
  // El dueno de la consulta tambien puede, aunque no este en la lista.
  currentUser = { id: 'uuid-otro', usuario: 'jcastro' };
  ok(bloqueAnotarPv(cVend, '0km').indexOf('pvVenta') >= 0, 'el vendedor propio deberia poder anotarla');
  // Con PV ya cargada, un vendedor comun no la puede corregir; los tres si.
  const cConPv = Object.assign({}, cVend, { preventa: '8114/1' });
  ok(bloqueAnotarPv(cConPv, '0km') === '', 'el vendedor propio no deberia poder corregir una PV ya cargada');
  currentUser = { id: 'uuid-fer', usuario: 'fngonzalez' };
  ok(bloqueAnotarPv(cConPv, '0km').indexOf('Corregir') >= 0, 'los tres si deberian poder corregirla');
  // Nunca sobre una consulta sin responder ni sobre una no vendida.
  ok(bloqueAnotarPv(Object.assign({}, cVend, { estado: 'pendiente' }), '0km') === '', 'pendiente no lleva PV');
  ok(bloqueAnotarPv(Object.assign({}, cVend, { resultado_venta: 'no_vendida' }), '0km') === '', 'no vendida no lleva PV');

  // 16) La seccion entera de "Resultado de venta" tiene que renderizar. Es la que
  // se rompio: llamaba a bloquePreventaVenta() cuando esa funcion no existia, y el
  // detalle de la consulta no abria mas.
  currentMode = 'vendedor';
  currentUser = { id: 'uuid-otro', usuario: 'jcastro' };
  const cAbierta = { id: 9, estado: 'contraoferta', vendedor_id: 'uuid-otro',
    vendedor_usuario: 'jcastro', items: [{ transferencia_monto: 10000000 }] };
  let secc0km = null, seccUsado = null;
  try { secc0km = renderResultadoVentaSection(cAbierta); } catch (e) { fallos.push('renderResultadoVentaSection explota: ' + e.message); }
  try { seccUsado = renderResultadoVentaUsadoSection({ id: 9, estado: 'contraoferta', vendedor_id: 'uuid-otro', transferencia_monto: 4000000 }); } catch (e) { fallos.push('renderResultadoVentaUsadoSection explota: ' + e.message); }
  ok(secc0km && secc0km.indexOf('pvVenta') >= 0, '0km: la seccion de resultado deberia pedir la PV');
  ok(seccUsado && seccUsado.indexOf('pvVenta') >= 0, 'usados: la seccion de resultado deberia pedir la PV');

  // 17) Venta YA HECHA: el precio no se pide, sale de Oversoft + FyF, y el analisis
  //     tiene que dar lo mismo que una consulta normal a ese precio.
  costoTransfer = { total: 0.015, sircreb: 0.003, debCred: 0.012, periodo: '2026-09-01',
    periodoActual: '2026-09-01', desactualizado: false, sinDatos: false };
  currentMode = 'vendedor';
  currentUser = { id: 'uuid-yo', usuario: 'jcastro' };
  formData = { origen: 'venta_hecha', unidades: [], pvVendida: null, pagaTransferencia: null, tipoCliente: null };
  preventasVendidas = [{
    preventa: '8140/1', fecha: '2026-09-09', serie: 'CH1', color: 'Gris Volcan',
    nombreCorto: 'Nivus Comfortline', modelo: 'VW Nivus Comfortline MY26',
    precio_sin_fyf: 29060000, precio_con_fyf: 30170000,
    precio_lista: 34000000, oferta_baratito: 31000000, consulta_id: null,
  }];
  preventasVendidasCargadas = true;
  const pasoPv = STEP_RENDERERS['pv-vendida']();
  ok(pasoPv.body.indexOf('8140/1') >= 0, 'el paso deberia listar la preventa');
  ok(pasoPv.body.indexOf('$30.170.000') >= 0, 'deberia mostrar el precio CON flete y formulario');
  ok(pasoPv.body.indexOf('$29.060.000') === -1, 'NO deberia mostrar el precio sin FyF como precio de venta');

  selectPvVendida('8140/1');
  ok(formData.unidades.length === 1, 'elegir la venta deberia armar una unidad');
  ok(formData.unidades[0].precioPedido === 30170000, 'el precio de la unidad es el de venta con FyF');
  ok(formData.unidades[0].modelo === 'VW Nivus Comfortline MY26', 'deberia quedar el modelo canonico');
  ok(formData.pagaTransferencia === 'si', 'en una venta hecha la transferencia se da por hecha');

  // Los pasos: elegir venta -> monto -> tipo de cliente -> observaciones -> resumen.
  ok(getNextStep('origen') === 'pv-vendida', 'venta hecha arranca eligiendo la preventa');
  ok(getNextStep('pv-vendida') === 'transferencia-monto', 'de la preventa va al monto');
  ok(getNextStep('transferencia-monto') === 'tipo-cliente', 'del monto va al tipo de cliente');
  ok(getNextStep('tipo-cliente') === 'observaciones', 'venta hecha no pide nombre ni ubicacion');

  // El analisis: vendida a 30.170.000 con 10.000.000 por transferencia.
  formData.unidades[0].transferenciaMonto = 10000000;
  const aVenta = calcularAnalisisUnidad({ ...formData.unidades[0], sinDisponibilidad: true });
  ok(!!aVenta, 'la venta hecha deberia analizarse contra el catalogo del modelo');
  casi(aVenta.transferencia_costo, 150000, 'costo de la transferencia en la venta hecha');
  casi(aVenta.precio_efectivo, 30020000, 'precio efectivo de la venta hecha');

  const resumenVh = STEP_RENDERERS['resumen']();
  ok(resumenVh.body.indexOf('$30.170.000') >= 0, 'el resumen deberia mostrar el precio de venta');
  ok(resumenVh.body.indexOf('$150.000') >= 0, 'el resumen deberia mostrar el costo');
  ok(resumenVh.footer.indexOf('Enviar pedido') >= 0, 'el resumen de venta hecha tiene su propio boton');

  // 18) INTEGRACION: el detalle completo tiene que abrir. Es el camino que se rompio
  //     la vez pasada (un ReferenceError adentro del template dejaba el modal sin
  //     abrir y no lo agarraba ninguna asercion de funciones sueltas).
  currentMode = 'admin';
  currentUser = { id: 'uuid-fer', usuario: 'fngonzalez' };
  stockData = [{
    serie: 'CH1', modelo: 'VW Nivus Comfortline MY26', color: 'Gris Volcan', libre: true,
    oferta_vigente: 31000000, gcia_vigente: 0.09, precio_lista: 34000000,
    fuente_oferta: 'baratito', fecha_factura: null,
  }];
  const detalleAbre = (c, etiqueta) => {
    adminConsultas = [c];
    try {
      abrirDetalle(c.id);
    } catch (e) {
      fallos.push('abrirDetalle explota en ' + etiqueta + ': ' + e.message);
      return '';
    }
    const cont = document.getElementById('modalContent');
    return cont ? cont.innerHTML : '';
  };

  const htmlVh = detalleAbre({
    id: 900, origen: 'venta_hecha', estado: 'pendiente', tipo_cliente: 'reventa',
    vendedor_nombre: 'Jose Castro', vendedor_usuario: 'jcastro', vendedor_id: 'uuid-jc',
    created_at: '2026-09-10T12:00:00Z', preventa: '8140/1', venta_fecha: '2026-09-09',
    venta_precio_sin_fyf: 29060000, reventa_nombre: '', financia: false,
    items: [{ id: 1, modelo: 'VW Nivus Comfortline MY26', precio_pedido: 30170000,
      precio_lista: 34000000, oferta_vigente_min: 31000000, gcia_vigente_min: 0.09,
      chasis: [{ serie: 'CH1', color: 'Gris Volcan' }], transferencia_monto: 10000000,
      transferencia_alicuota: 0.015 }],
  }, 'venta ya hecha');
  ok(htmlVh.indexOf('8140/1') >= 0, 'el detalle deberia mostrar la preventa');
  ok(htmlVh.indexOf('$30.170.000') >= 0, 'el detalle deberia mostrar el precio de venta con FyF');
  ok(htmlVh.indexOf('Vendida en:') >= 0, 'en una venta hecha el precio no se llama "precio pedido"');
  ok(htmlVh.indexOf('Autorizo la transferencia') >= 0, 'el boton deberia hablar de autorizar, no de aceptar una mejora');
  ok(htmlVh.indexOf('$150.000') >= 0, 'el detalle deberia mostrar el costo de la transferencia');

  // Y una consulta normal tiene que seguir abriendo igual que siempre.
  const htmlNorm = detalleAbre({
    id: 901, origen: 'stock', estado: 'pendiente', tipo_cliente: 'particular',
    cliente_nombre: 'Ana', cliente_apellido: 'Perez', vendedor_nombre: 'Jose Castro',
    vendedor_usuario: 'jcastro', vendedor_id: 'uuid-jc', created_at: '2026-09-10T12:00:00Z',
    items: [{ id: 2, modelo: 'VW Nivus Comfortline MY26', precio_pedido: 30000000,
      precio_lista: 34000000, oferta_vigente_min: 31000000, gcia_vigente_min: 0.09,
      chasis: [{ serie: 'CH1', color: 'Gris Volcan' }] }],
  }, 'consulta normal');
  ok(htmlNorm.indexOf('Precio pedido:') >= 0, 'la consulta normal sigue diciendo "precio pedido"');
  ok(htmlNorm.indexOf('Aceptar mejora') >= 0, 'la consulta normal sigue ofreciendo aceptar la mejora');

  // 19) UNIDAD TRABADA: VW la facturo pero todavia no habilito la venta. Cuenta en
  //     el stock, asi que el cartel es lo unico que evita que el vendedor la ofrezca.
  const blq = { serie: 'CH1', motivo: 'VW todavia no habilito la venta de la Unlimited' };
  ok(badgeChasis({ serie: 'CH1', bloqueo: blq }).indexOf('NO SE PUEDE VENDER') >= 0,
    'el chasis trabado deberia cantar el badge');
  ok(badgeChasis({ serie: 'CH1', aRecibir: true, bloqueo: blq }).indexOf('NO SE PUEDE VENDER') >= 0,
    'trabada Y a recibir deberia mostrar los dos badges');
  ok(badgeChasis({ serie: 'CH1', enReparto: true, bloqueo: blq }).indexOf('NO SE PUEDE VENDER') >= 0,
    'trabada en reparto tambien');
  ok(badgeChasis({ serie: 'CH1' }).indexOf('NO SE PUEDE VENDER') === -1,
    'una unidad normal NO deberia decir que no se puede vender');
  ok(cartelBloqueo(blq).indexOf('no habilito la venta') >= 0, 'el cartel deberia mostrar el motivo');
  ok(cartelBloqueo({ serie: 'CH1', motivo: '' }).indexOf('todav') >= 0, 'sin motivo tiene que haber texto igual');
  ok(cartelBloqueo(null) === '', 'sin bloqueo no va cartel');

  // El detalle de una consulta cruza el bloqueo EN VIVO contra el stock: si la
  // unidad se trabo despues de mandada la consulta, el admin tiene que verlo.
  stockData = [{
    serie: 'CH1', modelo: 'VW Nivus Comfortline MY26', color: 'Gris Volcan', libre: true,
    oferta_vigente: 31000000, gcia_vigente: 0.09, precio_lista: 34000000,
    fuente_oferta: 'baratito', fecha_factura: null, bloqueo: blq,
  }];
  const htmlTrab = detalleAbre({
    id: 902, origen: 'stock', estado: 'pendiente', tipo_cliente: 'particular',
    cliente_nombre: 'Ana', cliente_apellido: 'Perez', vendedor_nombre: 'Jose Castro',
    vendedor_usuario: 'jcastro', vendedor_id: 'uuid-jc', created_at: '2026-09-10T12:00:00Z',
    items: [{ id: 3, modelo: 'VW Nivus Comfortline MY26', precio_pedido: 30000000,
      precio_lista: 34000000, oferta_vigente_min: 31000000, gcia_vigente_min: 0.09,
      chasis: [{ serie: 'CH1', color: 'Gris Volcan' }] }],
  }, 'consulta de una unidad trabada');
  ok(htmlTrab.indexOf('NO SE PUEDE VENDER TODAV') >= 0, 'el detalle deberia cantar que la unidad esta trabada');
  ok(htmlTrab.indexOf('no habilito la venta') >= 0, 'el detalle deberia mostrar el motivo');

  return fallos;
})()
`

// TEST es una async IIFE: devuelve una PROMESA. Resolverlo de forma sincrona
// (Array.from(promesa) da []) hacia que el test diera verde SIEMPRE - paso de
// verdad, y por eso no detecto que faltaban funciones enteras en index.html.
setTimeout(() => {
  const morir = (msg, e) => {
    console.log(msg)
    if (e) console.log(String((e && e.stack) || (e && e.message) || e))
    process.exit(1)
  }
  let devuelto
  try {
    devuelto = win.eval(TEST)
  } catch (e) {
    return morir('EXPLOTO EL TEST', e)
  }
  if (!devuelto || typeof devuelto.then !== 'function') {
    return morir('EL TEST NO DEVOLVIO UNA PROMESA - el runner no esta corriendo las aserciones')
  }
  devuelto.then(
    (res) => {
      const fallos = Array.isArray(res) ? Array.from(res) : ['el test no devolvio la lista de fallos']
      if (errores.length) fallos.push(...errores.map((e) => 'ERROR EN PANTALLA -> ' + e))
      if (fallos.length) {
        console.log('FALLOS (' + fallos.length + '):')
        fallos.forEach((f) => console.log('  x ' + f))
        process.exit(1)
      }
      console.log('SMOKE TEST OK')
      process.exit(0)
    },
    (e) => morir('EXPLOTO EL TEST', e),
  )
}, 1500)
