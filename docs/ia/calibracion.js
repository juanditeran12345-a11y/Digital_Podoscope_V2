/* ============================================================================
 * PodoIA.Calibracion  (v1.0)  -  calibración de escala px/cm
 *   - detectarMarcador(imgRect, opciones): marcador cuadrado de 6 cm, bordes subpíxel
 *   - escalaDesdePuntos(pares): ajuste por mínimos cuadrados de px/cm
 *   - UI.iniciar(canvas, opciones): calibración manual con ratón o pantalla táctil
 * JavaScript puro (ES2018), sin dependencias. No toca index.html: solo devuelve
 * valores que la app puede asignar a `escala` (px/cm) y marcar como `calibrado`.
 * Convención de coordenadas: continuas; el píxel (i,j) ocupa [i,i+1] x [j,j+1].
 * ========================================================================== */
(function () {
  'use strict';
  var RAIZ = (typeof window !== 'undefined') ? window : globalThis;
  RAIZ.PodoIA = RAIZ.PodoIA || {};
  var Cal = RAIZ.PodoIA.Calibracion = RAIZ.PodoIA.Calibracion || {};

  /* ---------------------------------------------------------------- utilidades */
  function acotar(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function mediana(arr) {
    if (!arr.length) return NaN;
    var s = Array.prototype.slice.call(arr).sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return (s.length & 1) ? s[m] : 0.5 * (s[m - 1] + s[m]);
  }

  // Color bilineal en coordenadas continuas (centro del píxel i = i + 0.5).
  function muestrear(img, x, y, out) {
    var w = img.width, h = img.height, d = img.data;
    var fx = x - 0.5, fy = y - 0.5;
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var tx = fx - x0, ty = fy - y0;
    var xa = acotar(x0, 0, w - 1), xb = acotar(x0 + 1, 0, w - 1);
    var ya = acotar(y0, 0, h - 1), yb = acotar(y0 + 1, 0, h - 1);
    var i00 = (ya * w + xa) * 4, i10 = (ya * w + xb) * 4, i01 = (yb * w + xa) * 4, i11 = (yb * w + xb) * 4;
    for (var c = 0; c < 3; c++) {
      var a = d[i00 + c] * (1 - tx) + d[i10 + c] * tx;
      var b = d[i01 + c] * (1 - tx) + d[i11 + c] * tx;
      out[c] = a * (1 - ty) + b * ty;
    }
    return out;
  }

  /* ------------------------------------------------- ajuste robusto de una recta */
  // Puntos (s, e): e = a + b*s. Theil-Sen + reajuste por mínimos cuadrados con inliers.
  function ajusteRecta(pts) {
    var n = pts.length;
    if (n < 6) return null;
    var pend = [];
    for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      var ds = pts[j][0] - pts[i][0];
      if (Math.abs(ds) > 1e-6) pend.push((pts[j][1] - pts[i][1]) / ds);
    }
    var b = mediana(pend);
    var inter = pts.map(function (p) { return p[1] - b * p[0]; });
    var a = mediana(inter);
    var res = pts.map(function (p) { return p[1] - (a + b * p[0]); });
    var mad = mediana(res.map(Math.abs)) * 1.4826;
    var tol = Math.max(0.6, 2.5 * mad);
    var idx = [];
    for (var k = 0; k < n; k++) if (Math.abs(res[k]) <= tol) idx.push(k);
    if (idx.length >= 6) {              // reajuste LS con inliers
      var sx = 0, sy = 0, sxx = 0, sxy = 0, m = idx.length;
      idx.forEach(function (q) { sx += pts[q][0]; sy += pts[q][1]; sxx += pts[q][0] * pts[q][0]; sxy += pts[q][0] * pts[q][1]; });
      var den = m * sxx - sx * sx;
      if (Math.abs(den) > 1e-9) { b = (m * sxy - sx * sy) / den; a = (sy - b * sx) / m; }
      res = pts.map(function (p) { return p[1] - (a + b * p[0]); });
      idx = [];
      for (var k2 = 0; k2 < n; k2++) if (Math.abs(res[k2]) <= tol) idx.push(k2);
    }
    var ss = 0;
    idx.forEach(function (q) { ss += res[q] * res[q]; });
    return { a: a, b: b, inliers: idx.length, n: n, rms: Math.sqrt(ss / Math.max(1, idx.length)), tol: tol };
  }

  /* ------------------------------------------------------- perfil perpendicular */
  // D(t) = distancia de color al interior del marcador, t en px (+ = hacia afuera).
  // Devuelve {t, fuerza} con t subpíxel del máximo de gradiente, o null.
  function bordePerfil(img, c0, px, py, nx, ny, T, paso, sigmaPix, t0, sigmaPeso) {
    var n = Math.round(2 * T / paso) + 1, D = new Float64Array(n), col = [0, 0, 0], i, j;
    for (i = 0; i < n; i++) {
      var t = -T + i * paso;
      muestrear(img, px + nx * t, py + ny * t, col);
      var dr = col[0] - c0[0], dg = col[1] - c0[1], db = col[2] - c0[2];
      D[i] = Math.sqrt(dr * dr + dg * dg + db * db);
    }
    var rad = Math.ceil(3 * sigmaPix / paso), ker = [], sk = 0;
    for (j = -rad; j <= rad; j++) { var w = Math.exp(-0.5 * Math.pow(j * paso / sigmaPix, 2)); ker.push(w); sk += w; }
    var S = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var acc = 0, wsum = 0;
      for (j = -rad; j <= rad; j++) { var q = i + j; if (q < 0 || q >= n) continue; acc += D[q] * ker[j + rad]; wsum += ker[j + rad]; }
      S[i] = acc / wsum;
    }
    var G = new Float64Array(n);
    for (i = 1; i < n - 1; i++) G[i] = (S[i + 1] - S[i - 1]) / (2 * paso);
    var mejor = -1, mejorVal = 0;
    for (i = 2; i < n - 2; i++) {
      var tt = -T + i * paso;
      var val = G[i] * Math.exp(-0.5 * Math.pow((tt - t0) / sigmaPeso, 2));
      if (G[i] > 0 && val > mejorVal) { mejorVal = val; mejor = i; }
    }
    if (mejor < 0) return null;
    var g0 = G[mejor - 1], g1 = G[mejor], g2 = G[mejor + 1];
    var den = g0 - 2 * g1 + g2, dlt = 0;
    if (Math.abs(den) > 1e-9) dlt = acotar(0.5 * (g0 - g2) / den, -1, 1);
    return { t: -T + (mejor + dlt) * paso, fuerza: g1 * 2 /* ~ salto de D por px */ };
  }

  /* ------------------------------------------------------ morfología (cuadrada, separable) */
  function dilatar(m, w, h, r) {
    var t = new Uint8Array(w * h), o = new Uint8Array(w * h), x, y, a;
    for (y = 0; y < h; y++) {
      var dist = 1e9;
      for (x = 0; x < w; x++) { dist = m[y * w + x] ? 0 : dist + 1; t[y * w + x] = dist <= r ? 1 : 0; }
      dist = 1e9;
      for (x = w - 1; x >= 0; x--) { dist = m[y * w + x] ? 0 : dist + 1; if (dist <= r) t[y * w + x] = 1; }
    }
    for (x = 0; x < w; x++) {
      var d = 1e9;
      for (y = 0; y < h; y++) { d = t[y * w + x] ? 0 : d + 1; o[y * w + x] = d <= r ? 1 : 0; }
      d = 1e9;
      for (y = h - 1; y >= 0; y--) { d = t[y * w + x] ? 0 : d + 1; if (d <= r) o[y * w + x] = 1; }
    }
    return o;
  }
  function erosionar(m, w, h, r) {                  // erosión = complemento de la dilatación del complemento (borde = 0)
    var inv = new Uint8Array(w * h), i;
    for (i = 0; i < inv.length; i++) inv[i] = m[i] ? 0 : 1;
    var d = dilatar(inv, w, h, r), o = new Uint8Array(w * h);
    for (i = 0; i < o.length; i++) o[i] = d[i] ? 0 : 1;
    return o;
  }
  function cerrar(m, w, h, r) { return erosionar(dilatar(m, w, h, r), w, h, r); }
  function abrir(m, w, h, r) { return dilatar(erosionar(m, w, h, r), w, h, r); }

  /* ------------------------------------------------------- detección del marcador */
  var MOTIVOS = {
    sinImagen: 'Imagen inválida: se espera {data, width, height}.',
    sinCandidato: 'No se ve ningún marcador verde en la región de búsqueda.',
    forma: 'No se identifica un marcador de {lado} cm: las manchas verdes de la región no tienen forma ni tamaño de cuadrado (pueden ser el LED, los pies o la ropa; si hay marcador, puede estar tapado).',
    tapado: 'Forma incompleta (posible marcador parcialmente tapado, p. ej. por una mano).',
    bordes: 'Bordes incompletos o irregulares en el lado {lado} (posible reflejo pegado o marcador parcialmente tapado).',
    ruido: 'Bordes con demasiado ruido para medir con precisión subpíxel.',
    geometria: 'Los lados no son paralelos/perpendiculares (posible distorsión o recorte erróneo).',
    tamano: 'El tamaño no corresponde al esperado para {lado} cm (¿otro objeto o escala muy distinta?).',
    contraste: 'Contraste bajo entre el marcador y su entorno.'
  };
  function motivo(clave, lado, ladoCm) {
    return MOTIVOS[clave].replace('{lado}', lado === undefined ? String(ladoCm) : lado).replace('{lado}', String(ladoCm));
  }
  var NOMBRES_LADO = { izq: 'izquierdo', der: 'derecho', sup: 'superior', inf: 'inferior' };

  function resultadoVacio(mot, extra) {
    var r = { encontrado: false, caja: null, ladoPxX: null, ladoPxY: null, pxPorCmX: null, pxPorCmY: null,
      anisotropia: null, confianza: 0, motivo: mot };
    if (extra) for (var k in extra) r[k] = extra[k];
    return r;
  }

  function esVerdeMarcador(r, g, b) {
    var m = r > b ? r : b;
    return g >= 45 && g <= 170 && m <= 125 && (g - m) >= 25 && g >= 1.4 * m;
  }

  function detectarMarcador(imgRect, opciones) {
    if (!imgRect || !imgRect.data || !(imgRect.width > 0) || !(imgRect.height > 0)) {
      return resultadoVacio(MOTIVOS.sinImagen);
    }
    var o = Object.assign({ ladoCm: 6, anchoVentanaCm: 38.6, umbralConfianza: 0.6, umbralRechazo: 0.35, pxPorCmAprox: null }, opciones || {});
    var reg = Object.assign({ xMaxFrac: 0.35, yMaxFrac: 0.35 }, (opciones && opciones.region) || {});
    var W = imgRect.width, H = imgRect.height, dat = imgRect.data;
    var rw = Math.max(8, Math.min(W, Math.floor(W * reg.xMaxFrac))), rh = Math.max(8, Math.min(H, Math.floor(H * reg.yMaxFrac)));
    var pxcmNom = o.pxPorCmAprox || (W / o.anchoVentanaCm);
    var ladoNom = o.ladoCm * pxcmNom;

    // 1) máscara por color (verde medio-oscuro) dentro de la región
    var mask = new Uint8Array(rw * rh), x, y;
    for (y = 0; y < rh; y++) for (x = 0; x < rw; x++) {
      var p = (y * W + x) * 4;
      if (esVerdeMarcador(dat[p], dat[p + 1], dat[p + 2])) mask[y * rw + x] = 1;
    }
    // 2) limpieza morfológica (elemento cuadrado, separable): cierre r=3 (rellena rayas láser y huecos)
    //    y apertura r=5 (corta puentes finos con el borde LED y otras manchas verdes pegadas).
    var limpia = abrir(cerrar(mask, rw, rh, 3), rw, rh, 5);
    var lab = new Int32Array(rw * rh), nlab = 0, pila = new Int32Array(rw * rh);
    for (var s0 = 0; s0 < rw * rh; s0++) {
      if (!limpia[s0] || lab[s0]) continue;
      nlab++; var sp = 0; pila[sp++] = s0; lab[s0] = nlab;
      while (sp) {
        var cur = pila[--sp], cx = cur % rw, cy = (cur / rw) | 0;
        if (cx > 0 && limpia[cur - 1] && !lab[cur - 1]) { lab[cur - 1] = nlab; pila[sp++] = cur - 1; }
        if (cx < rw - 1 && limpia[cur + 1] && !lab[cur + 1]) { lab[cur + 1] = nlab; pila[sp++] = cur + 1; }
        if (cy > 0 && limpia[cur - rw] && !lab[cur - rw]) { lab[cur - rw] = nlab; pila[sp++] = cur - rw; }
        if (cy < rh - 1 && limpia[cur + rw] && !lab[cur + rw]) { lab[cur + rw] = nlab; pila[sp++] = cur + rw; }
      }
    }
    var area = new Int32Array(nlab + 1);
    for (var q = 0; q < rw * rh; q++) if (lab[q]) area[lab[q]]++;
    var minArea = 0.12 * ladoNom * ladoNom, cands = [], grandeSinForma = false;
    for (var L = 1; L <= nlab; L++) {
      if (area[L] < minArea) continue;
      // proyecciones para una caja robusta (insensible a rayas finas)
      var colc = new Int32Array(rw), rowc = new Int32Array(rh);
      for (y = 0; y < rh; y++) for (x = 0; x < rw; x++) if (lab[y * rw + x] === L) { colc[x]++; rowc[y]++; }
      var mc = 0, mr = 0;
      for (x = 0; x < rw; x++) if (colc[x] > mc) mc = colc[x];
      for (y = 0; y < rh; y++) if (rowc[y] > mr) mr = rowc[y];
      var x0 = -1, x1 = -1, y0 = -1, y1 = -1;
      for (x = 0; x < rw; x++) if (colc[x] >= 0.5 * mc) { if (x0 < 0) x0 = x; x1 = x; }
      for (y = 0; y < rh; y++) if (rowc[y] >= 0.5 * mr) { if (y0 < 0) y0 = y; y1 = y; }
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1, dentro = 0;
      for (y = y0; y <= y1; y++) for (x = x0; x <= x1; x++) if (lab[y * rw + x] === L) dentro++;
      var fill = dentro / (bw * bh), asp = bw / bh;
      var okTam = bw >= 0.6 * ladoNom && bw <= 1.5 * ladoNom && bh >= 0.6 * ladoNom && bh <= 1.5 * ladoNom;
      if (fill >= 0.6 && asp >= 0.7 && asp <= 1.43 && okTam) {
        cands.push({ L: L, x0: x0, x1: x1, y0: y0, y1: y1, bw: bw, bh: bh, fill: fill,
          score: fill * (1 - Math.abs(Math.log(asp))) });
      } else grandeSinForma = true;
    }
    if (!cands.length) {
      return resultadoVacio(grandeSinForma ? motivo('forma', undefined, o.ladoCm) : MOTIVOS.sinCandidato);
    }
    cands.sort(function (u, v) { return v.score - u.score; });
    var cd = cands[0];
    if (cd.fill < 0.8) {
      // demasiado hueco para medir con garantías: no se adivina
      return resultadoVacio(MOTIVOS.tapado, { confianza: 0.2, depuracion: { relleno: cd.fill, bw: cd.bw, bh: cd.bh, x0: cd.x0, y0: cd.y0, ladoNominalPx: ladoNom } });
    }

    // 3) color interior (mediana del núcleo) = referencia del perfil de bordes
    var mx0 = cd.x0 + Math.round(0.2 * cd.bw), mx1 = cd.x1 - Math.round(0.2 * cd.bw);
    var my0 = cd.y0 + Math.round(0.2 * cd.bh), my1 = cd.y1 - Math.round(0.2 * cd.bh);
    var cr = [], cg = [], cb = [];
    for (y = my0; y <= my1; y++) for (x = mx0; x <= mx1; x++) if (mask[y * rw + x]) {
      var pp = (y * W + x) * 4; cr.push(dat[pp]); cg.push(dat[pp + 1]); cb.push(dat[pp + 2]);
    }
    if (cr.length < 50) return resultadoVacio(MOTIVOS.tapado, { confianza: 0.2 });
    var c0 = [mediana(cr), mediana(cg), mediana(cb)];

    // 4) bordes subpíxel: perfiles perpendiculares + recta robusta por lado
    var T = Math.max(8, Math.round(0.06 * ladoNom)), NPERF = 48;
    var lados = {
      izq: { s0: cd.y0, s1: cd.y1 + 1, e0: cd.x0, nx: -1, ny: 0, vert: true },
      der: { s0: cd.y0, s1: cd.y1 + 1, e0: cd.x1 + 1, nx: 1, ny: 0, vert: true },
      sup: { s0: cd.x0, s1: cd.x1 + 1, e0: cd.y0, nx: 0, ny: -1, vert: false },
      inf: { s0: cd.x0, s1: cd.x1 + 1, e0: cd.y1 + 1, nx: 0, ny: 1, vert: false }
    };
    var rec = {}, info = {}, col = [0, 0, 0], reflejo = [];
    Object.keys(lados).forEach(function (nombre) {
      var ld = lados[nombre], pts = [], fuerzas = [], pal = 0, tot = 0;
      var largo = ld.s1 - ld.s0, ia = ld.s0 + 0.15 * largo, ib = ld.s0 + 0.85 * largo;
      for (var k = 0; k < NPERF; k++) {
        var s = ia + (ib - ia) * (k + 0.5) / NPERF;
        var px = ld.vert ? ld.e0 : s, py = ld.vert ? s : ld.e0;
        var r = bordePerfil(imgRect, c0, px, py, ld.nx, ld.ny, T, 0.5, 0.9, 0, 3.5);
        if (r && r.fuerza >= 8) { pts.push([s, ld.e0 + (ld.vert ? ld.nx : ld.ny) * r.t]); fuerzas.push(r.fuerza); }
        // ¿bloque pálido y brillante (reflejo del LED) pegado por fuera de este lado?
        muestrear(imgRect, px + ld.nx * (T + 3), py + ld.ny * (T + 3), col);
        tot++; if (col[0] > 130 && col[1] > 190 && col[2] > 130 && (col[1] - col[0]) < 110 && (col[1] - col[2]) < 110 && col[1] - col[0] > 15) pal++;
      }
      rec[nombre] = ajusteRecta(pts);
      info[nombre] = {
        validos: pts.length, perfiles: NPERF,
        inliers: rec[nombre] ? rec[nombre].inliers : 0,
        rms: rec[nombre] ? rec[nombre].rms : null,
        contraste: fuerzas.length ? mediana(fuerzas) : 0
      };
      if (pal / tot > 0.5) reflejo.push(nombre);
    });
    var falta = Object.keys(rec).filter(function (k) { return !rec[k]; });
    if (falta.length) {
      return resultadoVacio(motivo('bordes', NOMBRES_LADO[falta[0]], o.ladoCm), { confianza: 0.1, lados: info, reflejoAdyacente: reflejo });
    }

    // 5) geometría: esquinas por intersección, lados, ángulos
    function interV(v, h) { // v: x=a+b*y ; h: y=c+d*x  ->  [x,y]
      var den = 1 - v.b * h.b;
      var xx = (v.a + v.b * h.a) / den, yy = h.a + h.b * xx;
      return [xx, yy];
    }
    var TL = interV(rec.izq, rec.sup), TR = interV(rec.der, rec.sup), BR = interV(rec.der, rec.inf), BL = interV(rec.izq, rec.inf);
    var ymid = 0.5 * (TL[1] + BR[1]), xmid = 0.5 * (TL[0] + BR[0]);
    var anchoH = (rec.der.a + rec.der.b * ymid) - (rec.izq.a + rec.izq.b * ymid);
    var altoV = (rec.inf.a + rec.inf.b * xmid) - (rec.sup.a + rec.sup.b * xmid);
    var ladoPxX = anchoH * Math.cos(Math.atan(0.5 * (rec.izq.b + rec.der.b)));
    var ladoPxY = altoV * Math.cos(Math.atan(0.5 * (rec.sup.b + rec.inf.b)));
    var angSup = Math.atan(0.5 * (rec.sup.b + rec.inf.b)), angIzq = Math.atan(0.5 * (rec.izq.b + rec.der.b));
    var deg = 180 / Math.PI;
    var ortogDeg = (angSup + angIzq) * deg;                 // 0 si los lados son perpendiculares
    var paralXDeg = (Math.atan(rec.izq.b) - Math.atan(rec.der.b)) * deg;
    var paralYDeg = (Math.atan(rec.sup.b) - Math.atan(rec.inf.b)) * deg;
    var desvGeo = Math.max(Math.abs(ortogDeg), Math.abs(paralXDeg), Math.abs(paralYDeg));

    // 6) confianza (heurística 0..1, no es una probabilidad calibrada)
    var nombres = ['izq', 'der', 'sup', 'inf'];
    var fracMin = 1, rmsMax = 0, peorLado = 'izq', contrMin = Infinity;
    nombres.forEach(function (k) {
      var f = info[k].inliers / info[k].perfiles;
      if (f < fracMin) { fracMin = f; peorLado = k; }
      if (info[k].rms > rmsMax) rmsMax = info[k].rms;
      if (info[k].contraste < contrMin) contrMin = info[k].contraste;
    });
    var comp = {
      bordes: acotar((fracMin - 0.4) / 0.5, 0, 1),
      ruido: acotar((1.5 - rmsMax) / 1.15, 0, 1),
      geometria: acotar((3 - desvGeo) / 2.3, 0, 1),
      tamano: acotar(1 - (Math.max(Math.abs(ladoPxX / ladoNom - 1), Math.abs(ladoPxY / ladoNom - 1)) - 0.25) / 0.25, 0, 1),
      relleno: acotar((cd.fill - 0.75) / 0.2, 0, 1),
      contraste: acotar((contrMin - 4) / 12, 0, 1)
    };
    var prod = 1, peorClave = 'bordes', peorVal = 2, kc;
    for (kc in comp) { prod *= Math.max(comp[kc], 1e-3); if (comp[kc] < peorVal) { peorVal = comp[kc]; peorClave = kc; } }
    var confianza = Math.pow(prod, 1 / 6);

    var res = {
      encontrado: true,
      caja: null, ladoPxX: ladoPxX, ladoPxY: ladoPxY,
      pxPorCmX: ladoPxX / o.ladoCm, pxPorCmY: ladoPxY / o.ladoCm,
      anisotropia: (ladoPxY / o.ladoCm) / (ladoPxX / o.ladoCm),
      confianza: confianza, motivo: null,
      // extras (no requeridos por la API mínima)
      pxPorCm: Math.sqrt((ladoPxX / o.ladoCm) * (ladoPxY / o.ladoCm)),
      esquinas: [TL, TR, BR, BL],
      anguloGrados: angSup * deg,
      lados: info, reflejoAdyacente: reflejo,
      detalle: { componentes: comp, ortogonalidadGrados: ortogDeg, paralelismoXGrados: paralXDeg, paralelismoYGrados: paralYDeg,
        relleno: cd.fill, colorInterior: c0, ladoNominalPx: ladoNom, cajaMascara: { x0: cd.x0, x1: cd.x1, y0: cd.y0, y1: cd.y1 } }
    };
    var xs = [TL[0], TR[0], BR[0], BL[0]], ys = [TL[1], TR[1], BR[1], BL[1]];
    var xmn = Math.min.apply(null, xs), ymn = Math.min.apply(null, ys);
    res.caja = { x: xmn, y: ymn, w: Math.max.apply(null, xs) - xmn, h: Math.max.apply(null, ys) - ymn };

    if (confianza < o.umbralConfianza) {
      var cl = peorClave;
      if (cl === 'bordes') {
        res.motivo = motivo('bordes', NOMBRES_LADO[peorLado], o.ladoCm);
        if (reflejo.indexOf(peorLado) >= 0) res.motivo = 'Marcador unido al reflejo del LED por el lado ' + NOMBRES_LADO[peorLado] + ' (bordes poco fiables).';
      } else if (cl === 'relleno') res.motivo = MOTIVOS.tapado;
      else res.motivo = motivo(cl, undefined, o.ladoCm);
    }
    if (confianza < o.umbralRechazo) {
      // por debajo del umbral de rechazo no se entregan medidas: la interfaz debe pedir calibración manual
      res.encontrado = false;
      res.pxPorCm = res.pxPorCmX = res.pxPorCmY = res.ladoPxX = res.ladoPxY = res.anisotropia = null;
    }
    return res;
  }

  /* ------------------------------------------------------ escala desde puntos */
  function escalaDesdePuntos(pares) {
    if (!Array.isArray(pares)) throw new TypeError('escalaDesdePuntos espera un arreglo de pares {x1,y1,x2,y2,distCm}.');
    var d = [], cm = [], i;
    for (i = 0; i < pares.length; i++) {
      var p = pares[i];
      var dist = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
      if (!(p.distCm > 0) || !isFinite(dist)) throw new RangeError('Par ' + (i + 1) + ' inválido (distCm debe ser > 0 y las coordenadas numéricas).');
      d.push(dist); cm.push(p.distCm);
    }
    var n = d.length;
    if (n === 0) return { pxPorCm: null, error_rel: null, residuos: [], residuosRel: [], rmsRel: null, n: 0 };
    var sdc = 0, scc = 0;
    for (i = 0; i < n; i++) { sdc += d[i] * cm[i]; scc += cm[i] * cm[i]; }
    var s = sdc / scc;                                  // ajuste por el origen: d = s * cm
    var residuos = [], rel = [], ss = 0;
    for (i = 0; i < n; i++) { var r = d[i] - s * cm[i]; residuos.push(r); rel.push(r / (s * cm[i])); ss += r * r; }
    var errRel = null;
    if (n >= 2) errRel = Math.sqrt(ss / (n - 1)) / Math.sqrt(scc) / s;   // error estándar de s / s
    return { pxPorCm: s, error_rel: errRel, residuos: residuos, residuosRel: rel,
      rmsRel: Math.sqrt(rel.reduce(function (a, v) { return a + v * v; }, 0) / n), n: n };
  }

  // La app trabaja con fotogramas de ancho <= ANCHO_MAX: convierte px/cm entre anchos de imagen.
  function escalaParaAncho(pxPorCm, anchoOrigen, anchoDestino) { return pxPorCm * anchoDestino / anchoOrigen; }

  /* -------------------------------------------------------- dibujo del resultado */
  function dibujarResultado(ctx, res, op) {
    if (!res || !res.esquinas) return;
    op = Object.assign({ color: '#ff2d95', grosor: 1.5 }, op || {});
    ctx.save(); ctx.strokeStyle = op.color; ctx.lineWidth = op.grosor;
    ctx.beginPath();
    res.esquinas.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
    ctx.closePath(); ctx.stroke(); ctx.restore();
  }

  Cal.detectarMarcador = detectarMarcador;
  Cal.escalaDesdePuntos = escalaDesdePuntos;
  Cal.escalaParaAncho = escalaParaAncho;
  Cal.dibujarResultado = dibujarResultado;
  Cal._interno = { ajusteRecta: ajusteRecta, muestrear: muestrear, mediana: mediana, bordePerfil: bordePerfil };

  /* ====================================================================== UI manual */
  var UI = Cal.UI = Cal.UI || {};

  UI.iniciar = function (canvas, opciones) {
    var o = Object.assign({ onPunto: null, onResultado: null, lupa: true, zoomLupa: 4, tamLupa: 132, panel: true, distanciaCm: 6 }, opciones || {});
    var doc = canvas.ownerDocument, ctx = canvas.getContext('2d');
    var base = doc.createElement('canvas');              // copia limpia de la foto
    var pares = [], pend = [], activo = null, cursor = null, panelEl = null, panelPropio = false;

    function fijarBase(fuente) {
      var s = fuente || canvas;
      base.width = canvas.width; base.height = canvas.height;
      var bc = base.getContext('2d'); bc.clearRect(0, 0, base.width, base.height);
      bc.drawImage(s, 0, 0, canvas.width, canvas.height);
      dibujar();
    }
    // El lienzo se muestra con CSS object-fit:contain: la imagen puede quedar centrada con bandas vacías.
    // Hay que descontar ese desplazamiento y usar la escala real (la del lado limitante), no la del elemento.
    function geomVisible() {
      var r = canvas.getBoundingClientRect();
      var e = Math.min(r.width / canvas.width, r.height / canvas.height) || 1;
      return { r: r, e: e, ox: (r.width - canvas.width * e) / 2, oy: (r.height - canvas.height * e) / 2 };
    }
    function escalaPantalla() { return 1 / geomVisible().e; }
    function aCanvas(ev) {
      var g = geomVisible();
      return { x: (ev.clientX - g.r.left - g.ox) / g.e, y: (ev.clientY - g.r.top - g.oy) / g.e };
    }
    function resultado() {
      return pares.length ? Object.assign(escalaDesdePuntos(pares), { pares: pares.map(function (p) { return Object.assign({}, p); }) })
        : { pxPorCm: null, error_rel: null, residuos: [], residuosRel: [], rmsRel: null, n: 0, pares: [] };
    }
    function notificar() {
      var r = resultado();
      actualizarPanel(r);
      if (typeof o.onResultado === 'function') o.onResultado(r);
    }

    /* ---- dibujo sobre el mismo canvas ---- */
    function punto(c, p, etiqueta, color, k) {
      c.save(); c.strokeStyle = color; c.fillStyle = color; c.lineWidth = 1.2 * k;
      c.beginPath(); c.arc(p.x, p.y, 5 * k, 0, 6.2832); c.stroke();
      c.beginPath(); c.moveTo(p.x - 9 * k, p.y); c.lineTo(p.x - 2.5 * k, p.y); c.moveTo(p.x + 2.5 * k, p.y); c.lineTo(p.x + 9 * k, p.y);
      c.moveTo(p.x, p.y - 9 * k); c.lineTo(p.x, p.y - 2.5 * k); c.moveTo(p.x, p.y + 2.5 * k); c.lineTo(p.x, p.y + 9 * k); c.stroke();
      if (etiqueta) { c.font = (12 * k) + 'px sans-serif'; c.fillText(etiqueta, p.x + 8 * k, p.y - 8 * k); }
      c.restore();
    }
    function dibujar() {
      var k = escalaPantalla(), res = pares.length ? escalaDesdePuntos(pares) : null, i;
      ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
      for (i = 0; i < pares.length; i++) {
        var p = pares[i], col = '#ffd400';
        ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = 1.2 * k; ctx.beginPath(); ctx.moveTo(p.x1, p.y1); ctx.lineTo(p.x2, p.y2); ctx.stroke(); ctx.restore();
        punto(ctx, { x: p.x1, y: p.y1 }, '', col, k); punto(ctx, { x: p.x2, y: p.y2 }, '', col, k);
        var txt = '#' + (i + 1) + ' ' + p.distCm + ' cm';
        if (res && res.n >= 2) txt += ' (' + (res.residuosRel[i] >= 0 ? '+' : '') + (res.residuosRel[i] * 100).toFixed(2) + ' %)';
        ctx.save(); ctx.font = (12 * k) + 'px sans-serif'; ctx.lineWidth = 3 * k; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.fillStyle = col;
        var mx = (p.x1 + p.x2) / 2 + 6 * k, my = (p.y1 + p.y2) / 2 - 6 * k;
        ctx.strokeText(txt, mx, my); ctx.fillText(txt, mx, my); ctx.restore();
      }
      pend.forEach(function (q, j) { punto(ctx, q, 'P' + (j + 1), '#00e5ff', k); });
      if (pend.length === 1 && activo && activo.idx === 1) { /* la línea al cursor se ve en la lupa */ }
      if (activo && o.lupa) dibujarLupa(activo.pos, k);
    }
    function dibujarLupa(pos, k) {
      var z = o.zoomLupa, tam = o.tamLupa * k, src = tam / z;
      var ox = pos.x < canvas.width / 2 && pos.y < canvas.height / 2 ? canvas.width - tam - 8 * k : 8 * k, oy = 8 * k;
      ctx.save();
      ctx.beginPath(); ctx.rect(ox, oy, tam, tam); ctx.clip();
      ctx.fillStyle = '#000'; ctx.fillRect(ox, oy, tam, tam);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(base, pos.x - src / 2, pos.y - src / 2, src, src, ox, oy, tam, tam);
      ctx.restore();
      ctx.save(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * k; ctx.strokeRect(ox, oy, tam, tam);
      ctx.strokeStyle = '#ff2d95'; ctx.lineWidth = 1 * k; ctx.beginPath();
      ctx.moveTo(ox + tam / 2, oy); ctx.lineTo(ox + tam / 2, oy + tam); ctx.moveTo(ox, oy + tam / 2); ctx.lineTo(ox + tam, oy + tam / 2); ctx.stroke();
      ctx.font = (11 * k) + 'px sans-serif'; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3 * k;
      var t = pos.x.toFixed(1) + ', ' + pos.y.toFixed(1);
      ctx.strokeText(t, ox + 4 * k, oy + tam - 5 * k); ctx.fillText(t, ox + 4 * k, oy + tam - 5 * k); ctx.restore();
    }

    /* ---- panel (distancia, lista de pares, deshacer, borrar) ---- */
    function crearPanel() {
      if (!o.panel) return;
      if (o.panel instanceof canvas.ownerDocument.defaultView.HTMLElement) { panelEl = o.panel; }
      else { panelEl = doc.createElement('div'); panelPropio = true; canvas.parentNode.insertBefore(panelEl, canvas.nextSibling); }
      panelEl.className = (panelEl.className ? panelEl.className + ' ' : '') + 'podoia-cal-panel';
      panelEl.style.cssText += ';font:14px/1.35 system-ui,sans-serif;margin-top:8px;max-width:560px';
      panelEl.innerHTML =
        '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
        '<label>Distancia real (cm) <input data-r="dist" type="number" min="0.01" step="0.01" value="' + o.distanciaCm + '" style="width:5.5em;font-size:16px"></label>' +
        '<button type="button" data-r="ok" disabled>Añadir par</button>' +
        '<button type="button" data-r="undo" disabled>Deshacer</button>' +
        '<button type="button" data-r="clear" disabled>Borrar todo</button></div>' +
        '<div data-r="msg" style="margin:6px 0;color:#555">Toca o haz clic en el primer punto; mantén pulsado y arrastra para afinar con la lupa.</div>' +
        '<ol data-r="lista" style="margin:4px 0 4px 1.2em;padding:0"></ol><div data-r="res" style="font-weight:600"></div>';
      var q = function (n) { return panelEl.querySelector('[data-r="' + n + '"]'); };
      q('ok').addEventListener('click', function () { ctrl.confirmarPar(parseFloat(q('dist').value)); });
      q('undo').addEventListener('click', function () { ctrl.deshacer(); });
      q('clear').addEventListener('click', function () { ctrl.borrarTodo(); });
      q('dist').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); ctrl.confirmarPar(parseFloat(q('dist').value)); } });
      actualizarPanel(resultado());
    }
    function actualizarPanel(r) {
      if (!panelEl) return;
      var q = function (n) { return panelEl.querySelector('[data-r="' + n + '"]'); };
      q('ok').disabled = pend.length !== 2;
      q('undo').disabled = !(pend.length || pares.length);
      q('clear').disabled = !(pend.length || pares.length);
      var msg = pend.length === 0 ? 'Marca el primer punto de una distancia conocida.' :
        pend.length === 1 ? 'Marca el segundo punto.' : 'Escribe la distancia real y pulsa «Añadir par» (o Enter).';
      q('msg').textContent = msg;
      var li = '';
      pares.forEach(function (p, i) {
        var px = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
        li += '<li>' + p.distCm + ' cm &middot; ' + px.toFixed(2) + ' px' +
          (r.n >= 2 ? ' &middot; residuo ' + (r.residuosRel[i] >= 0 ? '+' : '') + (r.residuosRel[i] * 100).toFixed(2) + ' %' : '') +
          ' <button type="button" data-borrar="' + i + '" style="font-size:12px">✕</button></li>';
      });
      q('lista').innerHTML = li;
      Array.prototype.forEach.call(q('lista').querySelectorAll('[data-borrar]'), function (b) {
        b.addEventListener('click', function () { ctrl.borrarPar(parseInt(b.getAttribute('data-borrar'), 10)); });
      });
      q('res').textContent = r.n ? ('Escala: ' + r.pxPorCm.toFixed(3) + ' px/cm' +
        (r.error_rel !== null ? '  (error estándar ' + (r.error_rel * 100).toFixed(2) + ' %, ' + r.n + ' pares)' : '  (1 par: sin redundancia para estimar el error)')) : '';
    }

    /* ---- eventos de puntero (ratón, táctil y lápiz) ---- */
    function alBajar(ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (pend.length >= 2) return;                       // hay un par pendiente de distancia
      ev.preventDefault();
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* no crítico */ }
      activo = { id: ev.pointerId, idx: pend.length + 1, pos: aCanvas(ev) };
      dibujar();
    }
    function alMover(ev) {
      if (!activo || ev.pointerId !== activo.id) return;
      ev.preventDefault(); activo.pos = aCanvas(ev); dibujar();
    }
    function alSoltar(ev) {
      if (!activo || ev.pointerId !== activo.id) return;
      ev.preventDefault();
      var pos = aCanvas(ev), idx = activo.idx; activo = null;
      pend.push(pos);
      if (typeof o.onPunto === 'function') o.onPunto({ indice: idx, x: pos.x, y: pos.y, parIndice: pares.length });
      dibujar(); notificar();
    }
    function alCancelar(ev) { if (activo && ev.pointerId === activo.id) { activo = null; dibujar(); } }
    function alTeclar(ev) {
      var paso = ev.shiftKey ? 1 : 0.25, dx = 0, dy = 0, tgt = pend.length ? pend : null;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ctrl.deshacer(); return; }
      if (ev.key === 'ArrowLeft') dx = -paso; else if (ev.key === 'ArrowRight') dx = paso;
      else if (ev.key === 'ArrowUp') dy = -paso; else if (ev.key === 'ArrowDown') dy = paso; else return;
      if (!tgt) return;
      ev.preventDefault(); tgt[tgt.length - 1].x += dx; tgt[tgt.length - 1].y += dy;
      dibujar();
    }
    canvas.addEventListener('pointerdown', alBajar);
    canvas.addEventListener('pointermove', alMover);
    canvas.addEventListener('pointerup', alSoltar);
    canvas.addEventListener('pointercancel', alCancelar);
    canvas.addEventListener('keydown', alTeclar);
    var antes = { touchAction: canvas.style.touchAction, tabIndex: canvas.getAttribute('tabindex'), cursor: canvas.style.cursor };
    canvas.style.touchAction = 'none'; canvas.style.cursor = 'crosshair';
    if (antes.tabIndex === null) canvas.setAttribute('tabindex', '0');

    /* ---- controlador devuelto ---- */
    var ctrl = {
      fijarBase: fijarBase,
      refrescarBase: function () { fijarBase(canvas); },
      confirmarPar: function (distCm) {
        if (pend.length !== 2) return false;
        if (!(distCm > 0)) { if (panelEl) panelEl.querySelector('[data-r="msg"]').textContent = 'La distancia debe ser un número mayor que 0.'; return false; }
        pares.push({ x1: pend[0].x, y1: pend[0].y, x2: pend[1].x, y2: pend[1].y, distCm: distCm });
        pend = []; dibujar(); notificar(); return true;
      },
      deshacer: function () { if (pend.length) pend.pop(); else if (pares.length) pares.pop(); dibujar(); notificar(); },
      borrarPar: function (i) { if (i >= 0 && i < pares.length) pares.splice(i, 1); dibujar(); notificar(); },
      borrarTodo: function () { pares = []; pend = []; activo = null; dibujar(); notificar(); },
      resultado: resultado,
      pares: function () { return pares.map(function (p) { return Object.assign({}, p); }); },
      destruir: function () {
        canvas.removeEventListener('pointerdown', alBajar); canvas.removeEventListener('pointermove', alMover);
        canvas.removeEventListener('pointerup', alSoltar); canvas.removeEventListener('pointercancel', alCancelar);
        canvas.removeEventListener('keydown', alTeclar);
        canvas.style.touchAction = antes.touchAction; canvas.style.cursor = antes.cursor;
        if (antes.tabIndex === null) canvas.removeAttribute('tabindex');
        ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
        if (panelEl && panelPropio && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
      }
    };
    fijarBase(canvas);
    crearPanel();
    return ctrl;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Cal;
})();
