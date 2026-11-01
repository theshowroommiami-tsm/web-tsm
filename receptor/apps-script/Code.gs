/**
 * Receptor temporal de Custom Builds · TSM · 2026-11-01 · v1.1.1
 *
 * Proyecto independiente de Apps Script (script.new), propiedad de
 * liza@showroommiami.com y sin compartir. Escribe en una planilla aparte que sí
 * se comparte con el equipo: así ningún editor de la planilla ve el código ni
 * los secretos. La llama solo la función de web-tsm en Netlify, con el cuerpo
 * firmado por HMAC-SHA256. Es temporal: cuando el CRM del ERP tenga
 * ingest-lead (E124), las filas se migran por lead_id y el receptor se apaga.
 *
 * Contrato v1.1 (docs/satelites/web-tsm/anexos/web-01-receptor-custom-builds.md):
 *   POST con cuerpo JSON {"payload": "<texto JSON>", "firma": "<hex>"}
 *   firma = HMAC-SHA256(payload, secreto del entorno), hex en minúsculas; la
 *   clave es el texto hex del secreto, en UTF-8.
 *   payload = {"v":1, "accion":"crear"|"fotos"|"ping",
 *              "entorno":"production"|"preview", "ts":<segundos unix>, "datos":{...}}
 *   Responde siempre HTTP 200 con {"ok":true,...} o {"ok":false,"error":"<código>"}.
 *
 * Propiedades del script (Project Settings > Script properties):
 *   SECRETO_PRODUCTION, SECRETO_PREVIEW  las pega Hikashi desde cb-secretos.command
 *   AVISO_PARA, AVISO_PRUEBAS            destinatarios, separados por coma
 *   ID_PLANILLA                          la crea setup()
 */

const VERSION = '1.1.1';
const ZONA = 'America/New_York';
const RESPONSABLE = 'John';
const NOMBRE_PLANILLA = 'TSM · Custom Builds · Requests (temporal)';
const TOLERANCIA_TS = 300;       // segundos de diferencia aceptados en ts
const ESPERA_FOTOS_MIN = 3;      // minutos que el aviso espera a las fotos
const PLAZO_AVISO_H = 24;        // después de esto el aviso se da por perdido
const PLAZO_FOTOS_H = 24;        // la acción fotos solo vale dentro de este plazo
const MAX_MINIATURA = 200000;    // largo máximo del base64 de una miniatura
const FILAS_AVISO = 300;         // filas recientes que revisa el aviso
const CUPO_PREVIEW_DIA = 50;     // solicitudes de prueba por día
const AVISOS_PREVIEW_DIA = 10;   // correos de prueba por día

const HOJAS = {
  production: { nombre: 'Requests', prefijo: 'CB-' },
  preview: { nombre: 'Tests', prefijo: 'TEST-' },
};

// [clave del contrato, encabezado de la planilla, ancho en px]
const COLUMNAS = [
  ['folio', 'Folio', 90],
  ['recibida', 'Received (Miami)', 140],
  ['estado', 'Status', 150],
  ['estado_fecha', 'Status changed', 140],
  ['responsable', 'Assigned to', 100],
  ['nombre', 'Name', 160],
  ['telefono', 'Phone', 130],
  ['correo', 'Email', 200],
  ['marca', 'Make', 110],
  ['modelo', 'Model', 120],
  ['anio', 'Year', 60],
  ['zona', 'City / ZIP', 120],
  ['servicio', 'Service', 160],
  ['descripcion', 'Description', 320],
  ['presupuesto', 'Budget', 140],
  ['plazo', 'Timeframe', 140],
  ['foto_1', 'Photo 1', 160],
  ['foto_2', 'Photo 2', 160],
  ['foto_3', 'Photo 3', 160],
  ['fotos', 'Photos (received / expected)', 110],
  ['carpeta_r2', 'Photos folder (R2)', 220],
  ['origen', 'Source', 110],
  ['utm_source', 'utm_source', 110],
  ['utm_medium', 'utm_medium', 110],
  ['utm_campaign', 'utm_campaign', 140],
  ['utm_term', 'utm_term', 110],
  ['utm_content', 'utm_content', 110],
  ['click_id_tipo', 'Click ID type', 90],
  ['click_id', 'Click ID', 160],
  ['aterrizaje', 'Landing page', 160],
  ['referrer', 'Referrer', 140],
  ['duplicado', 'Possible duplicate of', 110],
  ['notas', 'Notes', 240],
  ['avisado', 'Notified', 160],
  ['lead_id', 'Lead ID', 260],
  ['clave', 'Idempotency key', 260],
];
const EDITABLES = ['estado', 'responsable', 'notas'];

const ESTADOS = ['New', 'Contacted', 'Qualified', 'Appointment confirmed',
  'Vehicle received', 'Sold', 'Not qualified', 'Lost', 'Spam'];

// Campos de texto del formulario y su largo máximo (el contrato fija los mismos).
const CAMPOS = {
  nombre: 120, telefono: 40, correo: 160, marca: 60, modelo: 80, anio: 4,
  zona: 80, servicio: 120, descripcion: 2000, presupuesto: 60, plazo: 60,
  origen: 20, utm_source: 120, utm_medium: 120, utm_campaign: 160,
  utm_term: 160, utm_content: 160, click_id_tipo: 10, click_id: 200,
  aterrizaje: 300, referrer: 200,
};
const OBLIGATORIOS = ['nombre', 'marca', 'modelo', 'anio', 'zona', 'servicio', 'descripcion'];

// ---------------------------------------------------------------- web app

function doGet() {
  return responder_({ ok: false, error: 'metodo' });
}

function doPost(e) {
  let cuerpo;
  let p;
  try {
    cuerpo = JSON.parse((e && e.postData && e.postData.contents) || '');
    if (!cuerpo || typeof cuerpo.payload !== 'string' || cuerpo.payload.length > 1500000) {
      return responder_({ ok: false, error: 'formato' });
    }
    p = JSON.parse(cuerpo.payload);
  } catch (err) {
    return responder_({ ok: false, error: 'formato' });
  }
  if (typeof cuerpo.firma !== 'string' || !/^[0-9a-f]{64}$/.test(cuerpo.firma)) {
    return responder_({ ok: false, error: 'firma' });
  }
  try {
    if (!p || !Object.prototype.hasOwnProperty.call(HOJAS, p.entorno)) {
      return responder_({ ok: false, error: 'entorno' });
    }
    const props = PropertiesService.getScriptProperties();
    const secreto = props.getProperty('SECRETO_' + p.entorno.toUpperCase());
    if (!secreto || !firmaValida_(cuerpo.payload, cuerpo.firma, secreto)) {
      return responder_({ ok: false, error: 'firma' });
    }
    const ahora = Math.floor(Date.now() / 1000);
    if (p.v !== 1 || typeof p.ts !== 'number' || Math.abs(ahora - p.ts) > TOLERANCIA_TS) {
      return responder_({ ok: false, error: 'vencido' });
    }
    if (p.accion === 'ping') return responder_({ ok: true, version: VERSION });
    if (p.accion !== 'crear' && p.accion !== 'fotos') {
      return responder_({ ok: false, error: 'accion' });
    }
    if (p.entorno === 'preview' && p.accion === 'crear' && contador_('CUPO_PREVIEW', false) >= CUPO_PREVIEW_DIA) {
      return responder_({ ok: false, error: 'cupo' });
    }
  } catch (err) {
    return responder_({ ok: false, error: 'interno' });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return responder_({ ok: false, error: 'ocupado' });
  try {
    const hoja = hoja_(p.entorno);
    const r = p.accion === 'crear' ? crear_(hoja, p.entorno, p.datos || {})
      : fotos_(hoja, p.datos || {});
    if (!r.ok) registrar_(p.entorno, p.accion, r.error, r.folio || '');
    SpreadsheetApp.flush();
    return responder_(r);
  } catch (err) {
    const config = err && err.name === 'config';
    registrar_(p.entorno, p.accion, (config ? 'config: ' : 'interno: ') + String(err).slice(0, 200), '');
    return responder_({ ok: false, error: config ? 'config' : 'interno' });
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------- acciones

function crear_(hoja, entorno, d) {
  const m = mapa_(hoja);
  const clave = String(d.clave || '');
  if (!/^[0-9a-f-]{36}$/i.test(clave)) return { ok: false, error: 'clave' };

  // Reintento con la misma clave: devuelve la misma solicitud.
  const previa = buscar_(hoja, m.clave, clave);
  if (previa) {
    const fila = hoja.getRange(previa, 1, 1, hoja.getLastColumn()).getValues()[0];
    return {
      ok: true, replay: true, lead_id: String(fila[m.lead_id - 1]),
      folio: String(fila[m.folio - 1]), carpeta: String(fila[m.carpeta_r2 - 1]),
      duplicado: String(fila[m.duplicado - 1]) !== '',
      fotos_esperadas: Number(String(fila[m.fotos - 1]).split('/')[1]) || 0,
    };
  }
  if (entorno === 'preview') {
    if (contador_('CUPO_PREVIEW', false) >= CUPO_PREVIEW_DIA) return { ok: false, error: 'cupo' };
  }

  const v = {};
  Object.keys(CAMPOS).forEach(function (k) {
    const crudo = String(d[k] == null ? '' : d[k]);
    const limpio = k === 'descripcion'
      ? crudo.replace(/[\u202A-\u202E\u2066-\u2069]/g, '').replace(/\r\n?|[\u000B\u000C\u0085\u2028\u2029]/g, '\n')
      : crudo.replace(/[\r\n\t\u000B\u000C\u0085\u2028\u2029\u202A-\u202E\u2066-\u2069]+/g, ' ');
    v[k] = limpio.trim().slice(0, CAMPOS[k]);
  });
  const faltan = OBLIGATORIOS.filter(function (k) { return !v[k]; });
  if (faltan.length || !(v.telefono || v.correo)) return { ok: false, error: 'datos' };

  const esperadas = Math.max(0, Math.min(3, Math.floor(Number(d.fotos_esperadas) || 0)));
  if (entorno === 'preview') contador_('CUPO_PREVIEW', true);
  const folio = siguienteFolio_(hoja, m, entorno);
  const leadId = Utilities.getUuid();
  const carpeta = 'solicitudes/' + folio + '-' + leadId.slice(0, 8) + '/';
  const ahora = new Date();
  const duplicado = duplicadoDe_(hoja, m, v, ahora);

  const fila = new Array(hoja.getLastColumn()).fill('');
  const poner = function (k, valor) { fila[m[k] - 1] = valor; };
  poner('folio', folio);
  poner('recibida', ahora);
  poner('estado', 'New');
  poner('estado_fecha', ahora);
  poner('responsable', RESPONSABLE);
  Object.keys(CAMPOS).forEach(function (k) { poner(k, texto_(v[k])); });
  poner('fotos', '0 / ' + esperadas);
  poner('carpeta_r2', esperadas ? carpeta : '');
  poner('duplicado', duplicado);
  poner('lead_id', leadId);
  poner('clave', clave);
  hoja.appendRow(fila);

  return {
    ok: true, replay: false, lead_id: leadId, folio: folio,
    carpeta: esperadas ? carpeta : '', duplicado: duplicado !== '', fotos_esperadas: esperadas,
  };
}

function fotos_(hoja, d) {
  const m = mapa_(hoja);
  const leadId = String(d.lead_id || '');
  const filaN = /^[0-9a-f-]{36}$/i.test(leadId) ? buscar_(hoja, m.lead_id, leadId) : 0;
  if (!filaN) return { ok: false, error: 'lead' };
  const fila = hoja.getRange(filaN, 1, 1, hoja.getLastColumn()).getValues()[0];
  const folio = String(fila[m.folio - 1]);
  const recibida = fila[m.recibida - 1];
  if (!(recibida instanceof Date) || Date.now() - recibida.getTime() > PLAZO_FOTOS_H * 3600000) {
    return { ok: false, error: 'lead', folio: folio };
  }
  const esperadas = Number(String(fila[m.fotos - 1]).split('/')[1]) || 0;
  const vistas = {};
  (Array.isArray(d.fotos) ? d.fotos : []).forEach(function (f) {
    const n = Number(f && f.n);
    if ([1, 2, 3].indexOf(n) < 0 || n > esperadas || vistas[n]) return;
    vistas[n] = true;
    if (String(fila[m['foto_' + n] - 1]) !== '') return;
    const celda = hoja.getRange(filaN, m['foto_' + n]);
    const b64 = String(f.miniatura || '');
    if (b64.length > MAX_MINIATURA || b64.indexOf('/9j/') !== 0) {
      celda.setValue('Photo ' + n + ' in R2');
      return;
    }
    try {
      celda.setValue(SpreadsheetApp.newCellImage()
        .setSourceUrl('data:image/jpeg;base64,' + b64)
        .setAltTextTitle(folio + ' photo ' + n)
        .build());
    } catch (err) {
      celda.setValue('Photo ' + n + ' in R2');
    }
  });
  // Cuenta las fotos que la función verificó en R2, tengan o no miniatura.
  const previas = [1, 2, 3].filter(function (n) {
    return n <= esperadas && String(fila[m['foto_' + n] - 1]) !== '';
  });
  previas.forEach(function (n) { vistas[n] = true; });
  const recibidas = Object.keys(vistas).length;
  hoja.getRange(filaN, m.fotos).setValue(recibidas + ' / ' + esperadas);
  if (recibidas) hoja.setRowHeight(filaN, 110);
  return { ok: true, folio: folio, fotos: recibidas };
}

// --------------------------------------------- aviso (activador de 1 minuto)

function avisar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  let fallo = null;
  try {
    const libro = libro_();
    [HOJAS.production, HOJAS.preview].forEach(function (h) {
      try {
        const hoja = libro.getSheetByName(h.nombre);
        if (hoja) avisarHoja_(libro, hoja, h === HOJAS.preview);
      } catch (err) {
        registrar_(h === HOJAS.preview ? 'preview' : 'production', 'aviso', String(err).slice(0, 200), '');
        fallo = err;
      }
    });
    SpreadsheetApp.flush();
  } catch (err) {
    registrar_('', 'aviso', String(err).slice(0, 200), '');
    fallo = err;
  } finally {
    lock.releaseLock();
  }
  // Relanzar hace que Apps Script le mande al dueño su aviso de fallas del activador.
  if (fallo) throw fallo;
}

function avisarHoja_(libro, hoja, prueba) {
  const ultima = hoja.getLastRow();
  if (ultima < 2) return;
  const m = mapa_(hoja);
  const desde = Math.max(2, ultima - FILAS_AVISO + 1);
  const rango = hoja.getRange(desde, 1, ultima - desde + 1, hoja.getLastColumn());
  const valores = rango.getValues();
  const vista = rango.getDisplayValues();
  const props = PropertiesService.getScriptProperties();
  const para = props.getProperty(prueba ? 'AVISO_PRUEBAS' : 'AVISO_PARA');
  for (let i = 0; i < valores.length; i++) {
    if (String(valores[i][m.avisado - 1]) !== '') continue;
    const recibida = valores[i][m.recibida - 1];
    if (!(recibida instanceof Date)) continue;
    const edad = Date.now() - recibida.getTime();
    const filaN = desde + i;
    if (edad > PLAZO_AVISO_H * 3600000) {
      hoja.getRange(filaN, m.avisado).setValue('Not notified (24 h)');
      registrar_(prueba ? 'preview' : 'production', 'aviso', 'sin aviso después de 24 h', String(valores[i][m.folio - 1]));
      continue;
    }
    const partes = String(valores[i][m.fotos - 1]).split('/');
    const esperoFotos = Number(partes[0]) < Number(partes[1]) && edad < ESPERA_FOTOS_MIN * 60000;
    if (esperoFotos || !para || MailApp.getRemainingDailyQuota() < para.split(',').length) continue;
    if (prueba && contador_('AVISOS_PREVIEW', false) >= AVISOS_PREVIEW_DIA) {
      hoja.getRange(filaN, m.avisado).setValue('Test: daily email cap reached');
      continue;
    }
    enviarAviso_(libro, hoja, m, vista[i], filaN, prueba, para);
    if (prueba) contador_('AVISOS_PREVIEW', true);
    hoja.getRange(filaN, m.avisado).setValue(new Date());
  }
}

function enviarAviso_(libro, hoja, m, fila, filaN, prueba, para) {
  const val = function (k) { return String(fila[m[k] - 1]).replace(/^'/, ''); };
  const vehiculo = [val('anio'), val('marca'), val('modelo')].filter(String).join(' ');
  const asunto = (prueba ? '[TEST] ' : '') + (val('duplicado') ? '[POSSIBLE DUPLICATE] ' : '')
    + 'New Custom Build request ' + val('folio') + ': ' + vehiculo;
  const enlace = libro.getUrl() + '#gid=' + hoja.getSheetId() + '&range=A' + filaN;
  const lineas = [
    'New Custom Build estimate request from the website.',
    '',
    'Folio: ' + val('folio'),
    'Open the sheet: ' + enlace,
    'Received: ' + val('recibida') + ' (Miami)',
    'Assigned to: ' + val('responsable') + ' (reply within 1 business day)',
    '',
    'Name: ' + val('nombre'),
    'Phone: ' + val('telefono'),
    'Email: ' + val('correo'),
    'Vehicle: ' + vehiculo,
    'Service: ' + val('servicio'),
    'Budget: ' + val('presupuesto'),
    'Timeframe: ' + val('plazo'),
    'City / ZIP: ' + val('zona'),
    'Photos: ' + val('fotos'),
    'Source: ' + val('origen') + (val('utm_campaign') ? ' (campaign ' + val('utm_campaign') + ')' : ''),
  ];
  if (val('duplicado')) lineas.push('Possible duplicate of: ' + val('duplicado'));
  lineas.push('', 'Description (as typed by the customer):');
  val('descripcion').split(/\r\n|[\n\r\u000B\u000C\u0085\u2028\u2029]/).forEach(function (l) { lineas.push('  > ' + l); });
  MailApp.sendEmail({ to: para, subject: asunto.slice(0, 250), body: lineas.join('\n'), name: 'TSM Website' });
}

// ------------------------------------------------ edición manual de estado

function alEditar(e) {
  const hoja = e.range.getSheet();
  const nombres = [HOJAS.production.nombre, HOJAS.preview.nombre];
  if (nombres.indexOf(hoja.getName()) < 0 || e.range.getRow() < 2) return;
  const m = mapa_(hoja);
  if (e.range.getColumn() <= m.estado && e.range.getLastColumn() >= m.estado) {
    const r0 = e.range.getRow();
    const folios = hoja.getRange(r0, m.folio, e.range.getNumRows(), 1).getValues();
    folios.forEach(function (f, j) {
      if (String(f[0]) !== '') hoja.getRange(r0 + j, m.estado_fecha).setValue(new Date());
    });
  }
}

// ------------------------------ limpieza mensual de fotos de más de 12 meses

function limpiarFotos() {
  const libro = libro_();
  [HOJAS.production.nombre, HOJAS.preview.nombre].forEach(function (nombre) {
    const hoja = libro.getSheetByName(nombre);
    if (!hoja || hoja.getLastRow() < 2) return;
    const m = mapa_(hoja);
    const fechas = hoja.getRange(2, m.recibida, hoja.getLastRow() - 1, 1).getValues();
    fechas.forEach(function (f, i) {
      if (f[0] instanceof Date && Date.now() - f[0].getTime() > 365 * 86400000) {
        [1, 2, 3].forEach(function (n) {
          const celda = hoja.getRange(i + 2, m['foto_' + n]);
          if (celda.getValue() !== '' && celda.getValue() !== 'Photo removed (12 months)') {
            celda.setValue('Photo removed (12 months)');
          }
        });
      }
    });
  });
}

// --------------------------------------------- instalación (una sola vez)

function setup() {
  const props = PropertiesService.getScriptProperties();
  let libro;
  if (props.getProperty('ID_PLANILLA')) {
    libro = SpreadsheetApp.openById(props.getProperty('ID_PLANILLA'));
  } else {
    libro = SpreadsheetApp.create(NOMBRE_PLANILLA);
    props.setProperty('ID_PLANILLA', libro.getId());
  }
  if (!props.getProperty('AVISO_PARA')) {
    props.setProperty('AVISO_PARA', 'info@showroommiami.com,liza@showroommiami.com');
  }
  if (!props.getProperty('AVISO_PRUEBAS')) props.setProperty('AVISO_PRUEBAS', 'liza@showroommiami.com');
  libro.setSpreadsheetTimeZone(ZONA);
  const yo = Session.getEffectiveUser().getEmail();

  const listas = libro.getSheetByName('Lists') || libro.insertSheet('Lists');
  if (listas.getLastRow() < 2) {
    listas.getRange(1, 1, 1, 2).setValues([['Status', 'Assigned to']]).setFontWeight('bold');
    listas.getRange(2, 1, ESTADOS.length, 1).setValues(ESTADOS.map(function (s) { return [s]; }));
    listas.getRange(2, 2).setValue(RESPONSABLE);
  }

  [HOJAS.production.nombre, HOJAS.preview.nombre].forEach(function (nombre, i) {
    const hoja = libro.getSheetByName(nombre) || libro.insertSheet(nombre, i);
    const faltan = COLUMNAS.length - hoja.getMaxColumns();
    if (faltan > 0) hoja.insertColumnsAfter(hoja.getMaxColumns(), faltan);
    if (hoja.getLastRow() === 0) {
      hoja.getRange(1, 1, 1, COLUMNAS.length)
        .setValues([COLUMNAS.map(function (c) { return c[1]; })])
        .setFontWeight('bold').setBackground('#1f1f1f').setFontColor('#ffffff').setWrap(true);
    }
    const m = mapa_(hoja);
    hoja.setFrozenRows(1);
    hoja.setFrozenColumns(3);
    COLUMNAS.forEach(function (c) { hoja.setColumnWidth(m[c[0]], c[2]); });
    const max = hoja.getMaxRows() - 1;
    ['telefono', 'anio', 'zona'].forEach(function (k) { hoja.getRange(2, m[k], max, 1).setNumberFormat('@'); });
    ['recibida', 'estado_fecha', 'avisado'].forEach(function (k) {
      hoja.getRange(2, m[k], max, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    });
    hoja.getRange(2, m.descripcion, max, 1).setWrap(true);
    hoja.getRange(2, m.estado, max, 1).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInRange(listas.getRange('A2:A' + (ESTADOS.length + 20)), true)
        .setAllowInvalid(true).build());
    hoja.hideColumns(m.lead_id);
    hoja.hideColumns(m.clave);
    proteger_(hoja, yo, EDITABLES.map(function (k) {
      const letra = colLetra_(m[k]);
      return hoja.getRange(letra + '2:' + letra);
    }));
  });

  const log = libro.getSheetByName('Log') || libro.insertSheet('Log');
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, 5).setValues([['When', 'Environment', 'Action', 'Error', 'Folio']])
      .setFontWeight('bold');
  }
  proteger_(log, yo, []);
  proteger_(listas, yo, []);
  const inicial = libro.getSheetByName('Sheet1') || libro.getSheetByName('Hoja 1');
  if (inicial && libro.getSheets().length > 1 && inicial.getLastRow() === 0) libro.deleteSheet(inicial);

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['avisar', 'alEditar', 'limpiarFotos'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('avisar').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('alEditar').forSpreadsheet(libro).onEdit().create();
  ScriptApp.newTrigger('limpiarFotos').timeBased().onMonthDay(1).atHour(3).create();
  console.log('Planilla: ' + libro.getUrl());
}

// ---------------------------------------------------------------- utilidades

function libro_() {
  const id = PropertiesService.getScriptProperties().getProperty('ID_PLANILLA');
  if (!id) throw errorConfig_('falta ID_PLANILLA: correr setup()');
  return SpreadsheetApp.openById(id);
}

function hoja_(entorno) {
  const hoja = libro_().getSheetByName(HOJAS[entorno].nombre);
  if (!hoja) throw errorConfig_('falta la hoja ' + HOJAS[entorno].nombre + ': correr setup()');
  return hoja;
}

// Ubica cada columna por su encabezado; falla si falta alguna.
function mapa_(hoja) {
  const encabezados = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  const m = {};
  COLUMNAS.forEach(function (c) {
    const i = encabezados.indexOf(c[1]);
    if (i < 0) throw errorConfig_('falta la columna "' + c[1] + '" en ' + hoja.getName());
    m[c[0]] = i + 1;
  });
  return m;
}

// Protege la hoja entera para todos salvo el dueño; deja libres los rangos dados.
function proteger_(hoja, dueno, libres) {
  hoja.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(function (p) { p.remove(); });
  const p = hoja.protect().setDescription('Receptor de Custom Builds: solo Status, Assigned to y Notes');
  if (libres.length) p.setUnprotectedRanges(libres);
  p.addEditor(dueno);
  p.removeEditors(p.getEditors().filter(function (u) { return u.getEmail() !== dueno; }));
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

// El folio sigue al mayor entre el contador y el último folio de la hoja.
function siguienteFolio_(hoja, m, entorno) {
  const props = PropertiesService.getScriptProperties();
  const claveFolio = 'FOLIO_' + hoja.getName();
  let n = Number(props.getProperty(claveFolio) || '0');
  if (hoja.getLastRow() >= 2) {
    const ultimo = String(hoja.getRange(hoja.getLastRow(), m.folio).getValue());
    const k = Number((ultimo.match(/(\d+)$/) || [])[1] || 0);
    if (k > n) n = k;
  }
  n += 1;
  props.setProperty(claveFolio, String(n));
  return HOJAS[entorno].prefijo + ('000' + n).slice(-Math.max(4, String(n).length));
}

function errorConfig_(mensaje) {
  const err = new Error(mensaje);
  err.name = 'config';
  return err;
}

function colLetra_(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function buscar_(hoja, columna, valor) {
  if (hoja.getLastRow() < 2) return 0;
  const celda = hoja.getRange(2, columna, hoja.getLastRow() - 1, 1)
    .createTextFinder(valor).matchEntireCell(true).findNext();
  return celda ? celda.getRow() : 0;
}

// Mismo teléfono o correo, misma marca y modelo, en las últimas 24 horas.
function duplicadoDe_(hoja, m, v, ahora) {
  const ultima = hoja.getLastRow();
  if (ultima < 2) return '';
  const desde = Math.max(2, ultima - 300);
  const filas = hoja.getRange(desde, 1, ultima - desde + 1, hoja.getLastColumn()).getValues();
  const tel = digitos_(v.telefono);
  const mail = v.correo.toLowerCase();
  const auto = (v.marca + '|' + v.modelo).toLowerCase();
  for (let i = filas.length - 1; i >= 0; i--) {
    const f = filas[i];
    const t = f[m.recibida - 1];
    if (!(t instanceof Date) || ahora - t > 86400000) continue;
    const mismoContacto = (tel && digitos_(f[m.telefono - 1]) === tel)
      || (mail && String(f[m.correo - 1]).replace(/^'/, '').toLowerCase() === mail);
    const mismoAuto = (String(f[m.marca - 1]) + '|' + String(f[m.modelo - 1]))
      .replace(/^'/, '').toLowerCase() === auto;
    if (mismoContacto && mismoAuto) return String(f[m.folio - 1]);
  }
  return '';
}

function digitos_(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : '';
}

// Un texto que empieza con = + - @ se guarda como texto, no como fórmula.
function texto_(s) {
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// Contador diario en las propiedades; suma uno si sumar es true.
function contador_(nombre, sumar) {
  const props = PropertiesService.getScriptProperties();
  const k = nombre + '_' + Utilities.formatDate(new Date(), ZONA, 'yyyyMMdd');
  const n = Number(props.getProperty(k) || '0');
  if (sumar) props.setProperty(k, String(n + 1));
  return n;
}

function firmaValida_(payload, firma, secreto) {
  if (typeof firma !== 'string' || !/^[0-9a-f]{64}$/.test(firma)) return false;
  const bytes = Utilities.computeHmacSha256Signature(payload, secreto, Utilities.Charset.UTF_8);
  const esperada = bytes.map(function (b) {
    return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
  }).join('');
  let dif = 0;
  for (let i = 0; i < 64; i++) dif |= esperada.charCodeAt(i) ^ firma.charCodeAt(i);
  return dif === 0;
}

function registrar_(entorno, accion, error, folio) {
  try {
    const log = libro_().getSheetByName('Log');
    if (log) log.appendRow([new Date(), entorno, accion, error, folio]);
  } catch (err) {
    console.error(err);
  }
}

function responder_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
