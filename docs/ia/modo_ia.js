/* modo_ia.js - Unión entre la plataforma y los módulos PodoIA (recorte, calibración, modelo).
 *
 * Qué hace:
 *  - prepararEntrada(): recorte automático de la ventana de la plataforma (modo umbral y modo IA).
 *  - calibrarAuto():   calibración con el marcador de 6 cm de la esquina (modo IA).
 *  - segmentar():      segmentación con el modelo YOLO (ONNX) dentro del navegador (modo IA).
 *  - marcarVentana():  respaldo manual: el usuario marca las 4 esquinas de la ventana.
 *  - utilidades de remuestreo para corregir la diferencia de escala entre los ejes.
 *
 * No toca el login, Firebase ni el informe. Todo se carga de forma perezosa: el modelo (~94 MB) y
 * onnxruntime-web solo se descargan la primera vez que se usa el modo IA.
 * Espacio de nombres: window.PodoIA.App
 */
(function (raiz) {
  'use strict';
  var PodoIA = raiz.PodoIA = raiz.PodoIA || {};

  var CFG = {
    rutaModelo: 'modelo/plantar.onnx',
    // onnxruntime-web: versión fijada. Los archivos .wasm/.mjs se cargan de la misma carpeta.
    ortBase: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/',
    ortScript: 'ort.wasm.min.js',
    confMinRecorte: 0.6,        // por debajo se considera que no se encontró la ventana
    confMinMarcador: 0.6,       // por debajo se pide calibrar a mano
    ladoMarcadorCm: 6,
    escalaVentana: 1037 / 37.0  // px/cm nominal de la imagen recortada (ventana 38,6 cm menos 0,8 cm por lado)
  };

  var promesaOrt = null, promesaModelo = null;

  function crearLienzo(w, h) {
    var c = raiz.document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /** Vuelca una imagen {data,width,height} RGBA en un canvas (lo redimensiona). */
  function volcar(img, canvas) {
    canvas.width = img.width; canvas.height = img.height;
    var ctx = canvas.getContext('2d');
    var datos = img.data instanceof raiz.Uint8ClampedArray ? img.data : new raiz.Uint8ClampedArray(img.data);
    ctx.putImageData(new raiz.ImageData(datos, img.width, img.height), 0, 0);
  }

  function leerImagen(canvas) {
    var ctx = canvas.getContext('2d');
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  /* ------------------------------------------------------------------ */
  /* 1. Recorte automático                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Copia la fuente a resolución nativa, detecta la ventana y, si hay confianza suficiente, deja en
   * `frameCanvas` la imagen rectificada y recortada. Rellena estado.original y estado.recorteInfo.
   * Devuelve true si se recortó; false si hay que seguir con la imagen completa.
   */
  function prepararEntrada(fuente, sw, sh, frameCanvas, estado) {
    var orig = crearLienzo(sw, sh);
    orig.getContext('2d').drawImage(fuente, 0, 0, sw, sh);
    estado.original = orig;
    estado.recorteInfo = { ok: false, auto: false, manual: false, confianza: 0, motivo: null };
    if (!PodoIA.Recorte || !PodoIA.Recorte.detectarVentana) {
      estado.recorteInfo.motivo = 'El módulo de recorte no está disponible.';
      return false;
    }
    var img = leerImagen(orig);
    var det = PodoIA.Recorte.detectarVentana(img, { anchoMax: 1500 });
    estado.recorteInfo.confianza = det.confianza;
    estado.recorteInfo.motivo = det.motivo || null;
    if (det.parcial || !det.esquinas || det.confianza < CFG.confMinRecorte) {
      if (!estado.recorteInfo.motivo) estado.recorteInfo.motivo = 'No se vio la ventana completa de la plataforma.';
      return false;
    }
    var out = PodoIA.Recorte.rectificar(img, det.esquinas, {});
    volcar(out.img, frameCanvas);
    estado.recorteInfo.ok = true;
    estado.recorteInfo.auto = true;
    return true;
  }

  /** Aplica el recorte con 4 esquinas dadas en píxeles de la imagen ORIGINAL (TL, TR, BR, BL). */
  function aplicarEsquinas(estado, frameCanvas, esquinas) {
    var img = leerImagen(estado.original);
    var out = PodoIA.Recorte.rectificar(img, esquinas, {});
    volcar(out.img, frameCanvas);
    estado.recorteInfo = { ok: true, auto: false, manual: true, confianza: 1, motivo: null };
  }

  /* ------------------------------------------------------------------ */
  /* 2. Calibración con el marcador                                      */
  /* ------------------------------------------------------------------ */

  /** Busca el marcador de 6 cm en la imagen ya recortada. */
  function calibrarAuto(canvas) {
    if (!PodoIA.Calibracion || !PodoIA.Calibracion.detectarMarcador) {
      return { ok: false, motivo: 'El módulo de calibración no está disponible.', confianza: 0 };
    }
    var r = PodoIA.Calibracion.detectarMarcador(leerImagen(canvas), { ladoCm: CFG.ladoMarcadorCm });
    if (r && r.encontrado && r.confianza >= CFG.confMinMarcador && r.pxPorCmX > 0 && r.pxPorCmY > 0) {
      return { ok: true, pxPorCmX: r.pxPorCmX, pxPorCmY: r.pxPorCmY, anisotropia: r.pxPorCmY / r.pxPorCmX, confianza: r.confianza, motivo: r.motivo || null };
    }
    return { ok: false, motivo: (r && r.motivo) || 'No se encontró el marcador.', confianza: r ? r.confianza : 0 };
  }

  /* ------------------------------------------------------------------ */
  /* 3. Modelo de IA                                                      */
  /* ------------------------------------------------------------------ */

  function cargarScript(src) {
    return new Promise(function (ok, mal) {
      var s = raiz.document.createElement('script');
      s.src = src; s.async = true;
      s.onload = ok;
      s.onerror = function () { mal(new Error('No se pudo cargar ' + src + '. Comprueba la conexión a internet.')); };
      raiz.document.head.appendChild(s);
    });
  }

  function asegurarOrt() {
    if (raiz.ort) return Promise.resolve();
    if (!promesaOrt) {
      promesaOrt = cargarScript(CFG.ortBase + CFG.ortScript).catch(function (e) { promesaOrt = null; throw e; });
    }
    return promesaOrt;
  }

  /** Descarga onnxruntime-web y el modelo la primera vez. onProgreso(p) con p entre 0 y 1 (o null). */
  function asegurarModelo(onProgreso) {
    if (!promesaModelo) {
      promesaModelo = asegurarOrt().then(function () {
        if (!PodoIA.Modelo || !PodoIA.Modelo.cargar) throw new Error('El módulo del modelo no está disponible.');
        return PodoIA.Modelo.cargar(CFG.rutaModelo, { rutaWasm: CFG.ortBase, onProgreso: onProgreso });
      }).catch(function (e) { promesaModelo = null; throw e; });
    }
    return promesaModelo;
  }

  /** Segmenta la imagen recortada. Devuelve {mask: Uint8Array(w*h) 0/1, w, h, instancias, ms}. */
  async function segmentar(canvas, onProgreso) {
    await asegurarModelo(onProgreso);
    var img = leerImagen(canvas);
    var r = await PodoIA.Modelo.segmentar(img, { umbralConf: 0.25, modoRecorte: 'exacto' });
    return { mask: r.union, w: r.ancho, h: r.alto, instancias: r.instancias.length, ms: r.ms };
  }

  /* ------------------------------------------------------------------ */
  /* 4. Remuestreo (corrección de escala entre ejes)                      */
  /* ------------------------------------------------------------------ */

  /** Remuestrea una máscara 0/1 a otra altura (vecino más próximo). */
  function remuestrearVertical(mask, w, h, h2) {
    var out = new Uint8Array(w * h2);
    for (var y2 = 0; y2 < h2; y2++) {
      var y = Math.min(h - 1, Math.floor((y2 + 0.5) * h / h2));
      out.set(mask.subarray(y * w, (y + 1) * w), y2 * w);
    }
    return out;
  }

  /** Remuestrea un canvas a otra altura (mismo ancho). */
  function remuestrearCanvas(canvas, h2) {
    var c = crearLienzo(canvas.width, h2);
    c.getContext('2d').drawImage(canvas, 0, 0, canvas.width, h2);
    return c;
  }

  /* ------------------------------------------------------------------ */
  /* 5. Respaldo manual: marcar las 4 esquinas de la ventana              */
  /* ------------------------------------------------------------------ */

  var PASOS = ['superior izquierda', 'superior derecha', 'inferior derecha', 'inferior izquierda'];

  /**
   * Muestra la imagen original en el lienzo y espera 4 toques (esquinas internas del anillo verde de la ventana,
   * en el orden superior izquierda, superior derecha, inferior derecha, inferior izquierda).
   * alAvisar(texto): mensajes de ayuda. alTerminar(esquinasEnOriginal). Devuelve una función cancelar().
   */
  function marcarVentana(lienzo, original, alAvisar, alTerminar) {
    var e = Math.min(1, 1100 / original.width);
    lienzo.width = Math.round(original.width * e);
    lienzo.height = Math.round(original.height * e);
    var ctx = lienzo.getContext('2d');
    var pts = [];
    function dibujar() {
      ctx.drawImage(original, 0, 0, lienzo.width, lienzo.height);
      ctx.lineWidth = 2; ctx.strokeStyle = '#ff2bd6'; ctx.fillStyle = '#ffe600';
      if (pts.length > 1) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); if (pts.length === 4) ctx.closePath(); ctx.stroke(); }
      pts.forEach(function (p, i) { ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, 6.2832); ctx.fill(); ctx.stroke(); });
    }
    function mensaje() { alAvisar(pts.length < 4 ? 'Toca la esquina ' + PASOS[pts.length] + ' de la ventana (borde interno del anillo verde). Paso ' + (pts.length + 1) + ' de 4.' : 'Esquinas marcadas.'); }
    function posicion(ev) {
      var r = lienzo.getBoundingClientRect();
      return [(ev.clientX - r.left) * lienzo.width / r.width, (ev.clientY - r.top) * lienzo.height / r.height];
    }
    function alToque(ev) {
      if (pts.length >= 4) return;
      ev.preventDefault();
      pts.push(posicion(ev)); dibujar(); mensaje();
      if (pts.length === 4) {
        quitar();
        alTerminar(pts.map(function (p) { return [p[0] / e, p[1] / e]; }));
      }
    }
    function quitar() { lienzo.removeEventListener('pointerdown', alToque); lienzo.style.touchAction = ''; lienzo.style.cursor = ''; }
    lienzo.style.touchAction = 'none'; lienzo.style.cursor = 'crosshair';
    lienzo.addEventListener('pointerdown', alToque);
    dibujar(); mensaje();
    return quitar;
  }

  PodoIA.App = {
    CFG: CFG,
    prepararEntrada: prepararEntrada,
    aplicarEsquinas: aplicarEsquinas,
    calibrarAuto: calibrarAuto,
    asegurarModelo: asegurarModelo,
    segmentar: segmentar,
    remuestrearVertical: remuestrearVertical,
    remuestrearCanvas: remuestrearCanvas,
    marcarVentana: marcarVentana
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = PodoIA.App;
})(typeof window !== 'undefined' ? window : globalThis);
