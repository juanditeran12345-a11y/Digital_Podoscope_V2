/* =============================================================================
 * ia_modelo.js — Ejecuta el modelo YOLO26-seg ("Plantar") con onnxruntime-web.
 *
 * Espacio de nombres: window.PodoIA.Modelo
 *   cargar(urlModelo, {rutaWasm, onProgreso, webgpu, ort})  -> Promise<void>
 *   segmentar(img, {umbralConf=0.25, umbralMascara=0.5, umbralIoU=0.7, maxDet=300,
 *                       modoRecorte='ultralytics'|'exacto'})
 *       -> Promise<{ancho, alto, instancias:[{puntuacion, caja, mascara}], union, ms, tiempos}>
 *   estado()   -> info de la sesión cargada (proveedor, formato de salida detectado)
 *   liberar()  -> Promise<void>
 *
 * Requiere que `ort` (onnxruntime-web, p. ej. ort.min.js) esté cargado antes en el
 * navegador, o que se pase en las opciones. En Node se usa onnxruntime-node.
 * Sin dependencias adicionales. JavaScript ES2018.
 * ========================================================================== */
(function (raiz) {
  'use strict';

  const PodoIA = (raiz.PodoIA = raiz.PodoIA || {});

  const TAM = 640;          // tamaño de entrada fijo del modelo
  const RELLENO = 114;      // valor de relleno del letterbox (Ultralytics)
  const esNode = typeof process !== 'undefined' && process.versions && process.versions.node &&
    typeof window === 'undefined';

  let ort = null;
  let sesion = null;
  let info = null;
  let cola = Promise.resolve();   // serializa las llamadas: una sesión WASM no admite runs concurrentes

  const ahora = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const ceder = () => new Promise((r) => setTimeout(r, 0));   // devuelve el control a la interfaz

  /** round() de Python: los empates (x.5) van al entero par. Ultralytics usa round() de Python. */
  function redondearPy(x) {
    const f = Math.floor(x);
    const d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  // ---------------------------------------------------------------------------
  // CARGA
  // ---------------------------------------------------------------------------
  async function obtenerBytes(origen, onProgreso) {
    if (origen instanceof Uint8Array) return origen;
    if (origen instanceof ArrayBuffer) return new Uint8Array(origen);
    if (typeof origen !== 'string') throw new Error('urlModelo debe ser una URL/ruta (string), ArrayBuffer o Uint8Array');

    if (esNode && !/^https?:\/\//i.test(origen)) {
      const datos = await require('fs').promises.readFile(origen);
      if (onProgreso) onProgreso(1);
      return new Uint8Array(datos.buffer, datos.byteOffset, datos.byteLength);
    }

    const resp = await fetch(origen);
    if (!resp.ok) throw new Error('No se pudo descargar el modelo (' + resp.status + ' ' + resp.statusText + '): ' + origen);
    const total = Number(resp.headers.get('Content-Length')) || 0;
    if (!resp.body || !resp.body.getReader) {
      const b = new Uint8Array(await resp.arrayBuffer());
      if (onProgreso) onProgreso(1);
      return b;
    }
    const lector = resp.body.getReader();
    const trozos = [];
    let recibido = 0;
    for (;;) {
      const { done, value } = await lector.read();
      if (done) break;
      trozos.push(value);
      recibido += value.length;
      // Content-Length puede ser el tamaño comprimido (gzip): se limita a 1 y, sin total, se pasa null.
      if (onProgreso) onProgreso(total ? Math.min(1, recibido / total) : null);
    }
    const bytes = new Uint8Array(recibido);
    let pos = 0;
    for (const t of trozos) { bytes.set(t, pos); pos += t.length; }
    if (onProgreso) onProgreso(1);
    return bytes;
  }

  function resolverOrt(opcOrt) {
    if (opcOrt) return opcOrt;
    if (raiz.ort) return raiz.ort;
    if (esNode) {
      try { return require('onnxruntime-node'); } catch (e) { /* se intenta web */ }
      try { return require('onnxruntime-web'); } catch (e) { /* nada */ }
    }
    throw new Error('onnxruntime no está cargado. Incluya ort.min.js (onnxruntime-web) antes de ia_modelo.js.');
  }

  /**
   * Carga el modelo. Por defecto usa WASM. Con {webgpu:true} intenta WebGPU y,
   * si falla la creación de la sesión, reintenta con WASM.
   */
  async function cargar(urlModelo, opc) {
    opc = opc || {};
    ort = resolverOrt(opc.ort);
    if (opc.rutaWasm && ort.env && ort.env.wasm) ort.env.wasm.wasmPaths = opc.rutaWasm;

    const bytes = await obtenerBytes(urlModelo, opc.onProgreso);
    const wasm = esNode ? 'cpu' : 'wasm';
    const quiereGpu = !!opc.webgpu && typeof navigator !== 'undefined' && !!navigator.gpu;

    let proveedor = wasm;
    let s = null;
    if (quiereGpu) {
      try {
        s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu', wasm] });
        proveedor = 'webgpu(con respaldo wasm)';
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('PodoIA.Modelo: WebGPU no disponible, se usa WASM:', e && e.message);
        s = null;
      }
    }
    if (!s) s = await ort.InferenceSession.create(bytes, { executionProviders: [wasm] });

    sesion = s;
    info = { proveedor, entrada: TAM, formato: null, bytes: bytes.length };
  }

  /** Solo para pruebas: inyecta una sesión (real o simulada) sin pasar por cargar(). */
  function _inyectar(sesionExt, ortExt) {
    sesion = sesionExt;
    ort = ortExt;
    info = { proveedor: 'inyectada', entrada: TAM, formato: null, bytes: 0 };
  }

  async function liberar() {
    if (sesion && typeof sesion.release === 'function') await sesion.release();
    sesion = null; info = null;
  }

  // ---------------------------------------------------------------------------
  // PREPROCESADO: letterbox idéntico al de Ultralytics (center=True, relleno 114,
  // redimensión bilineal estilo cv2.INTER_LINEAR en punto fijo de 11 bits), RGB, /255, NCHW.
  // ---------------------------------------------------------------------------
  function tablaLineal(origen, destino) {
    // Para cada píxel destino: índices origen (x0,x1) y coeficientes enteros (a0,a1) /2048, como OpenCV.
    const escala = origen / destino;
    const x0 = new Int32Array(destino), x1 = new Int32Array(destino);
    const a0 = new Int32Array(destino), a1 = new Int32Array(destino);
    for (let d = 0; d < destino; d++) {
      let fx = (d + 0.5) * escala - 0.5;
      let sx = Math.floor(fx);
      fx -= sx;
      if (sx < 0) { fx = 0; sx = 0; }
      if (sx >= origen - 1) { fx = 0; sx = origen - 1; }
      x0[d] = sx;
      x1[d] = Math.min(sx + 1, origen - 1);
      a0[d] = Math.round((1 - fx) * 2048);
      a1[d] = Math.round(fx * 2048);
    }
    return { x0, x1, a0, a1 };
  }

  function letterbox(img) {
    const w = img.width, h = img.height;
    const px = img.data;
    const r = Math.min(TAM / h, TAM / w);
    const nw = redondearPy(w * r), nh = redondearPy(h * r);
    const dw = (TAM - nw) / 2, dh = (TAM - nh) / 2;
    const izq = redondearPy(dw - 0.1), arr = redondearPy(dh - 0.1);

    const plano = TAM * TAM;
    const t = new Float32Array(3 * plano);
    t.fill(RELLENO / 255);

    const H = tablaLineal(w, nw), V = tablaLineal(h, nh);
    const fila0 = new Int32Array(nw * 3), fila1 = new Int32Array(nw * 3);
    const hresize = (sy, salida) => {
      const base = sy * w * 4;
      for (let x = 0; x < nw; x++) {
        const p0 = base + H.x0[x] * 4, p1 = base + H.x1[x] * 4, c0 = H.a0[x], c1 = H.a1[x];
        salida[x * 3] = px[p0] * c0 + px[p1] * c1;
        salida[x * 3 + 1] = px[p0 + 1] * c0 + px[p1 + 1] * c1;
        salida[x * 3 + 2] = px[p0 + 2] * c0 + px[p1 + 2] * c1;
      }
    };
    const inv255 = 1 / 255;
    for (let y = 0; y < nh; y++) {
      hresize(V.x0[y], fila0);
      hresize(V.x1[y], fila1);
      const b0 = V.a0[y], b1 = V.a1[y];
      const dest = (arr + y) * TAM + izq;
      for (let x = 0; x < nw; x++) {
        const i = x * 3;
        // Segunda pasada en punto fijo (22 bits en total) con redondeo, como cv2.
        const R = (fila0[i] * b0 + fila1[i] * b1 + 2097152) >> 22;
        const G = (fila0[i + 1] * b0 + fila1[i + 1] * b1 + 2097152) >> 22;
        const B = (fila0[i + 2] * b0 + fila1[i + 2] * b1 + 2097152) >> 22;
        t[dest + x] = R * inv255;
        t[plano + dest + x] = G * inv255;
        t[2 * plano + dest + x] = B * inv255;
      }
    }
    return { tensor: t, r, izq, arr, nw, nh };
  }

  // ---------------------------------------------------------------------------
  // POSPROCESADO
  // ---------------------------------------------------------------------------
  function cajaAOriginal(b, g, ancho, alto) {
    const lim = (v, max) => Math.min(Math.max(v, 0), max);
    return [
      lim((b[0] - g.izq) / g.r, ancho), lim((b[1] - g.arr) / g.r, alto),
      lim((b[2] - g.izq) / g.r, ancho), lim((b[3] - g.arr) / g.r, alto),
    ];
  }

  function iouCajas(a, b) {
    const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
    const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const inter = ix * iy;
    const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return u > 0 ? inter / u : 0;
  }

  /**
   * Convierte la salida de detecciones en candidatos {puntuacion, caja640, coef}.
   * Formatos soportados (se autodetectan por la forma):
   *  - "end2end": [1, N, 6+nm]  filas = [x1,y1,x2,y2,conf,clase,coef*nm]  (sin NMS)
   *  - "crudo":   [1, 4+nc+nm, A]  canales = [cx,cy,w,h,puntuaciones*nc,coef*nm]  (requiere NMS)
   */
  function extraerCandidatos(det, nm, umbralConf, umbralIoU, maxDet) {
    const d = det.dims, v = det.data;
    const cand = [];
    if (d[2] === 6 + nm) {
      const N = d[1], C = d[2];
      for (let i = 0; i < N; i++) {
        const o = i * C, conf = v[o + 4];
        if (!(conf > umbralConf)) continue;
        cand.push({ puntuacion: conf, caja640: [v[o], v[o + 1], v[o + 2], v[o + 3]], coef: v.subarray(o + 6, o + 6 + nm) });
      }
      cand.sort((a, b) => b.puntuacion - a.puntuacion);
      info.formato = 'end2end';
      return cand.slice(0, maxDet);
    }
    const C = d[1], A = d[2], nc = C - 4 - nm;
    if (nc < 1) throw new Error('Forma de salida no reconocida: [' + d.join(',') + '] con nm=' + nm);
    for (let a = 0; a < A; a++) {
      let mejor = 0;
      for (let c = 0; c < nc; c++) mejor = Math.max(mejor, v[(4 + c) * A + a]);
      if (!(mejor > umbralConf)) continue;
      const cx = v[a], cy = v[A + a], w = v[2 * A + a], h = v[3 * A + a];
      const coef = new Float32Array(nm);
      for (let k = 0; k < nm; k++) coef[k] = v[(4 + nc + k) * A + a];
      cand.push({ puntuacion: mejor, caja640: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], coef });
    }
    cand.sort((a, b) => b.puntuacion - a.puntuacion);
    const keep = [];
    for (const c of cand) {
      if (keep.length >= maxDet) break;
      if (keep.every((k) => iouCajas(k.caja640, c.caja640) <= umbralIoU)) keep.push(c);
    }
    info.formato = 'crudo+NMS';
    return keep;
  }

  /**
   * Máscara de una instancia al tamaño de la imagen original:
   * logits = coef · protos (resolución de protos) -> reescalado bilineal (align_corners=False)
   * al tamaño original -> recorte por caja -> umbral. Solo se calcula dentro de la caja.
   * modo 'ultralytics' (por defecto): el relleno del letterbox se quita a resolución de protos con
   *   enteros redondeados, como scale_masks/process_mask_native de Ultralytics (retina_masks).
   * modo 'exacto': usa el relleno real (flotante) del letterbox; evita el desplazamiento de hasta
   *   ~1,6 px que introduce el redondeo de Ultralytics (importa en dedos pequeños).
   */
  function mascaraInstancia(coef, protos, nm, mh, mw, ancho, alto, caja, umbralLogit, lb, modo) {
    const mascara = new Uint8Array(ancho * alto);
    const n = mh * mw;
    const logit = new Float32Array(n);
    for (let k = 0; k < nm; k++) {
      const c = coef[k];
      if (c === 0) continue;
      const off = k * n;
      for (let i = 0; i < n; i++) logit[i] += c * protos[off + i];
    }
    let left, top, rw, rh, loX, hiX, loY, hiY;
    if (modo === 'exacto') {
      left = (lb.izq * mw) / TAM; top = (lb.arr * mh) / TAM;
      rw = (lb.nw * mw) / TAM; rh = (lb.nh * mh) / TAM;
      loX = 0; hiX = mw - 1; loY = 0; hiY = mh - 1;
    } else {
      const gain = Math.min(mh / alto, mw / ancho);
      const padW = (mw - ancho * gain) / 2, padH = (mh - alto * gain) / 2;
      top = redondearPy(padH - 0.1); left = redondearPy(padW - 0.1);
      const bottom = mh - redondearPy(padH + 0.1), right = mw - redondearPy(padW + 0.1);
      rh = bottom - top; rw = right - left;
      loX = left; hiX = left + rw - 1; loY = top; hiY = top + rh - 1;
    }
    if (rh < 1 || rw < 1) return mascara;

    // Píxeles dentro de la caja: columna c cumple x1 <= c < x2 (crop_mask de Ultralytics).
    const xa = Math.max(0, Math.ceil(caja[0])), xb = Math.min(ancho, Math.ceil(caja[2]));
    const ya = Math.max(0, Math.ceil(caja[1])), yb = Math.min(alto, Math.ceil(caja[3]));
    if (xb <= xa || yb <= ya) return mascara;

    const ex = rw / ancho, ey = rh / alto;
    const cx0 = new Int32Array(xb - xa), cx1 = new Int32Array(xb - xa), cwx = new Float32Array(xb - xa);
    for (let x = xa; x < xb; x++) {
      const f = Math.min(Math.max(left + (x + 0.5) * ex - 0.5, loX), hiX);
      const i0 = Math.floor(f);
      cx0[x - xa] = i0; cx1[x - xa] = Math.min(i0 + 1, hiX); cwx[x - xa] = f - i0;
    }
    for (let y = ya; y < yb; y++) {
      const f = Math.min(Math.max(top + (y + 0.5) * ey - 0.5, loY), hiY);
      const j0 = Math.floor(f), j1 = Math.min(j0 + 1, hiY), wy = f - j0;
      const r0 = j0 * mw, r1 = j1 * mw;
      const base = y * ancho;
      for (let x = xa; x < xb; x++) {
        const k = x - xa, wx = cwx[k];
        const sup = logit[r0 + cx0[k]] * (1 - wx) + logit[r0 + cx1[k]] * wx;
        const inf = logit[r1 + cx0[k]] * (1 - wx) + logit[r1 + cx1[k]] * wx;
        if (sup * (1 - wy) + inf * wy > umbralLogit) mascara[base + x] = 1;
      }
    }
    return mascara;
  }

  // ---------------------------------------------------------------------------
  // API: segmentar
  // ---------------------------------------------------------------------------
  async function segmentarInterno(img, opc) {
    if (!sesion) throw new Error('Modelo no cargado: llame antes a PodoIA.Modelo.cargar().');
    if (!img || !img.data || !(img.width > 0) || !(img.height > 0) || img.data.length < img.width * img.height * 4) {
      throw new Error('Imagen no válida: se espera {data: RGBA, width, height} compatible con ImageData.');
    }
    opc = opc || {};
    const umbralConf = opc.umbralConf === undefined ? 0.25 : opc.umbralConf;
    const umbralMasc = opc.umbralMascara === undefined ? 0.5 : opc.umbralMascara;
    const umbralIoU = opc.umbralIoU === undefined ? 0.7 : opc.umbralIoU;
    const maxDet = opc.maxDet === undefined ? 300 : opc.maxDet;
    const modo = opc.modoRecorte === 'ultralytics' ? 'ultralytics' : 'exacto';   // por defecto 'exacto' (medido: IoU 0,985 vs 0,982 con 'ultralytics')
    const umbralLogit = Math.log(umbralMasc / (1 - umbralMasc));   // sigmoide(x) > u  <=>  x > ln(u/(1-u))
    const ancho = img.width, alto = img.height;

    const t0 = ahora();
    const lb = letterbox(img);
    await ceder();
    const t1 = ahora();

    const entrada = new ort.Tensor('float32', lb.tensor, [1, 3, TAM, TAM]);
    const salidas = await sesion.run({ [sesion.inputNames[0]]: entrada });
    await ceder();
    const t2 = ahora();

    // Se identifican las salidas por su forma: protos = 4D [1,nm,mh,mw]; detecciones = 3D.
    let protos = null, det = null;
    for (const nombre of sesion.outputNames) {
      const t = salidas[nombre];
      if (t.dims.length === 4) protos = t; else if (t.dims.length === 3) det = t;
    }
    if (!protos || !det) throw new Error('Salidas inesperadas del modelo: se esperaban una salida 3D y una 4D.');
    if (protos.type !== 'float32' || det.type !== 'float32') throw new Error('Las salidas del modelo deben ser float32.');
    const nm = protos.dims[1], mh = protos.dims[2], mw = protos.dims[3];

    const cand = extraerCandidatos(det, nm, umbralConf, umbralIoU, maxDet);
    const union = new Uint8Array(ancho * alto);
    const instancias = [];
    for (const c of cand) {
      const caja = cajaAOriginal(c.caja640, lb, ancho, alto);
      const mascara = mascaraInstancia(c.coef, protos.data, nm, mh, mw, ancho, alto, caja, umbralLogit, lb, modo);
      for (let i = 0; i < mascara.length; i++) if (mascara[i]) union[i] = 1;
      instancias.push({ puntuacion: c.puntuacion, caja, mascara });
      await ceder();
    }
    const t3 = ahora();
    return {
      ancho, alto, instancias, union, ms: t3 - t0,
      tiempos: { pre: t1 - t0, inferencia: t2 - t1, post: t3 - t2 },
    };
  }

  function segmentar(img, opc) {
    const p = cola.then(() => segmentarInterno(img, opc));
    cola = p.catch(() => {});
    return p;
  }

  const Modelo = {
    cargar, segmentar, liberar,
    estado: () => (info ? Object.assign({}, info) : null),
    _inyectar,
    _interno: { letterbox, redondearPy, mascaraInstancia, extraerCandidatos, cajaAOriginal, TAM },
  };
  PodoIA.Modelo = Modelo;
  if (typeof module !== 'undefined' && module.exports) module.exports = Modelo;
})(typeof window !== 'undefined' ? window : globalThis);
