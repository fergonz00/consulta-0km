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

  return fallos;
})()
`

setTimeout(() => {
  let fallos
  try {
    fallos = win.eval(TEST)
  } catch (e) {
    console.log('EXPLOTO EL TEST: ' + e.message + '\n' + e.stack)
    process.exit(1)
  }
  fallos = Array.from(fallos)
  if (errores.length) fallos.push(...errores.map((e) => 'ERROR EN PANTALLA → ' + e))

  if (fallos.length) {
    console.log('FALLOS (' + fallos.length + '):')
    fallos.forEach((f) => console.log('  x ' + f))
    process.exit(1)
  }
  console.log('SMOKE TEST OK')
  process.exit(0)
}, 1500)
