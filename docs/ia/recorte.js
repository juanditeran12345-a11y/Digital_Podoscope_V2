/* PodoIA.Recorte — detección de la ventana de la plataforma y rectificado.
 *
 * Módulo JS puro (ES2018), sin dependencias. Imágenes: {data: Uint8ClampedArray RGBA, width, height}.
 *
 *   PodoIA.Recorte.detectarVentana(img, {anchoMax=1500})
 *        -> {esquinas:[[x,y]x4: TL,TR,BR,BL en px de la imagen ORIGINAL], confianza:0..1,
 *            parcial:boolean, motivo:string|null, ...datos extra de diagnóstico}
 *   PodoIA.Recorte.rectificar(img, esquinas, {relacionAspecto, margenRelX, margenRelY, anchoSalida})
 *        -> {img:{data,width,height}, H, marcoRecorte}
 *
 * La homografía (DLT con 4 puntos) y el remuestreo bilineal están implementados aquí (sin OpenCV).
 */
(function (root) {
  'use strict';

  var PodoIA = root.PodoIA = root.PodoIA || {};

  // ---------------------------------------------------------------------------
  // Constantes de la plataforma (las mismas con que se construyó el dataset)
  // ---------------------------------------------------------------------------
  var CM_ANCHO = 38.6;          // ancho de la ventana (cm) entre esquinas internas del anillo LED
  var CM_ALTO = 34.5;           // alto de la ventana (cm)
  var PX_CM = 28;               // px/cm del rectificado del dataset
  var MARGEN_CM = 0.8;          // recorte por lado del dataset
  var REL_ASPECTO_DATASET = CM_ANCHO / CM_ALTO;
  var MARGEN_REL_X = MARGEN_CM / CM_ANCHO;   // 0.0207
  var MARGEN_REL_Y = MARGEN_CM / CM_ALTO;    // 0.0232
  var ANCHO_SALIDA = Math.round(CM_ANCHO * PX_CM) - 2 * Math.round(MARGEN_CM * PX_CM); // 1037

  // ---------------------------------------------------------------------------
  // Álgebra mínima: homografía por DLT
  // ---------------------------------------------------------------------------

  /** Resuelve A·x = b (n×n) por eliminación gaussiana con pivoteo parcial. Devuelve null si es singular. */
  function resolverSistema(A, b) {
    var n = b.length, i, j, k;
    var M = [];
    for (i = 0; i < n; i++) { M.push(A[i].slice()); M[i].push(b[i]); }
    for (i = 0; i < n; i++) {
      var p = i;
      for (j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
      if (Math.abs(M[p][i]) < 1e-12) return null;
      var t = M[i]; M[i] = M[p]; M[p] = t;
      for (j = i + 1; j < n; j++) {
        var f = M[j][i] / M[i][i];
        if (f === 0) continue;
        for (k = i; k <= n; k++) M[j][k] -= f * M[i][k];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s = M[i][n];
      for (j = i + 1; j < n; j++) s -= M[i][j] * x[j];
      x[i] = s / M[i][i];
    }
    return x;
  }

  /**
   * Homografía H (3×3 en array de 9, fila a fila, H[8]=1) tal que dst ≈ H·src, con 4 pares de puntos.
   * Los puntos se normalizan (centro y escala) para que el sistema esté bien condicionado.
   */
  function homografia(src, dst) {
    function norm(pts) {
      var cx = 0, cy = 0, i;
      for (i = 0; i < pts.length; i++) { cx += pts[i][0]; cy += pts[i][1]; }
      cx /= pts.length; cy /= pts.length;
      var d = 0;
      for (i = 0; i < pts.length; i++) d += Math.hypot(pts[i][0] - cx, pts[i][1] - cy);
      d /= pts.length;
      var s = d > 0 ? Math.SQRT2 / d : 1;
      return { cx: cx, cy: cy, s: s };
    }
    var ns = norm(src), nd = norm(dst), A = [], b = [], i;
    for (i = 0; i < 4; i++) {
      var x = (src[i][0] - ns.cx) * ns.s, y = (src[i][1] - ns.cy) * ns.s;
      var u = (dst[i][0] - nd.cx) * nd.s, v = (dst[i][1] - nd.cy) * nd.s;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    var h = resolverSistema(A, b);
    if (!h) return null;
    var Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    // H = Td^-1 · Hn · Ts
    var Ts = [ns.s, 0, -ns.cx * ns.s, 0, ns.s, -ns.cy * ns.s, 0, 0, 1];
    var Tdi = [1 / nd.s, 0, nd.cx, 0, 1 / nd.s, nd.cy, 0, 0, 1];
    var H = mult3(Tdi, mult3(Hn, Ts));
    var k = H[8];
    for (i = 0; i < 9; i++) H[i] /= k;
    return H;
  }

  function mult3(A, B) {
    var C = new Array(9), i, j;
    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++)
      C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
    return C;
  }

  function aplicarH(H, x, y) {
    var w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  // ---------------------------------------------------------------------------
  // rectificar
  // ---------------------------------------------------------------------------

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  /** Relación ancho/alto medida sobre el cuadrilátero (px): media de bordes horizontales / media de verticales. */
  function relacionMedida(q) {
    var w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
    var h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
    return w / h;
  }

  /**
   * Rectifica la ventana y recorta el margen (como el dataset de entrenamiento).
   *  esquinas: [[x,y]x4] TL,TR,BR,BL en px de la imagen `img` que se pasa.
   *  opciones.relacionAspecto: número (ancho/alto; por defecto 38.6/34.5) o 'medida'.
   *  opciones.margenRelX / margenRelY: fracción del ancho / alto completo de la ventana que se recorta por lado.
   *  opciones.anchoSalida: ancho en px de la imagen devuelta (por defecto 1037).
   */
  function rectificar(img, esquinas, opciones) {
    opciones = opciones || {};
    if (!img || !img.data || !esquinas || esquinas.length !== 4) throw new Error('rectificar: argumentos inválidos');
    var rel = opciones.relacionAspecto;
    if (rel === 'medida') rel = relacionMedida(esquinas);
    else if (typeof rel !== 'number' || !(rel > 0)) rel = REL_ASPECTO_DATASET;
    var mrx = typeof opciones.margenRelX === 'number' ? opciones.margenRelX : MARGEN_REL_X;
    var mry = typeof opciones.margenRelY === 'number' ? opciones.margenRelY : MARGEN_REL_Y;
    var anchoSalida = Math.round(opciones.anchoSalida || ANCHO_SALIDA);

    // Tamaño del cuadro completo (antes de recortar) y márgenes en px.
    var mx = Math.round(mrx * anchoSalida / (1 - 2 * mrx));
    var Wt = anchoSalida + 2 * mx;
    var Ht = Math.round(Wt / rel);
    var my = Math.round(mry * Ht);
    var ow = anchoSalida, oh = Ht - 2 * my;
    if (oh < 1) throw new Error('rectificar: margen demasiado grande');

    var dst = [[0, 0], [Wt, 0], [Wt, Ht], [0, Ht]];
    var H = homografia(dst, esquinas);       // destino (cuadro completo) -> origen
    if (!H) throw new Error('rectificar: esquinas degeneradas');

    var sw = img.width, sh = img.height, sd = img.data;
    var out = new Uint8ClampedArray(ow * oh * 4);
    var y, x, o = 0;
    for (y = 0; y < oh; y++) {
      var v = y + my;
      var nx = H[1] * v + H[2], ny = H[4] * v + H[5], nw = H[7] * v + H[8];
      for (x = 0; x < ow; x++, o += 4) {
        var u = x + mx;
        var w = H[6] * u + nw;
        var X = (H[0] * u + nx) / w, Y = (H[3] * u + ny) / w;
        if (!(X >= 0 && Y >= 0 && X <= sw - 1 && Y <= sh - 1)) {
          // fuera de la foto: transparente (no se inventa contenido)
          if (X > -0.5 && Y > -0.5 && X < sw - 0.5 && Y < sh - 0.5) {
            X = Math.min(Math.max(X, 0), sw - 1); Y = Math.min(Math.max(Y, 0), sh - 1);
          } else { out[o + 3] = 0; continue; }
        }
        var x0 = X | 0, y0 = Y | 0;
        var x1 = x0 + 1 < sw ? x0 + 1 : x0, y1 = y0 + 1 < sh ? y0 + 1 : y0;
        var fx = X - x0, fy = Y - y0;
        var i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4, i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        out[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11 + 0.5;
        out[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11 + 0.5;
        out[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11 + 0.5;
        out[o + 3] = 255;
      }
    }
    var cuatro = [[mx, my], [mx + ow, my], [mx + ow, my + oh], [mx, my + oh]];
    var origen = cuatro.map(function (p) { return aplicarH(H, p[0], p[1]); });
    return {
      img: { data: out, width: ow, height: oh },
      H: H,
      marcoRecorte: {
        x: mx, y: my, ancho: ow, alto: oh,            // recorte dentro del cuadro rectificado completo
        anchoCompleto: Wt, altoCompleto: Ht,
        margenPx: [mx, my],
        relacionAspecto: rel,
        esquinasOrigen: origen                        // las 4 esquinas del recorte, en px de la imagen de entrada
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Detección de la ventana
  // ---------------------------------------------------------------------------
  // La ventana está rodeada por un anillo de LED verde. Se buscan sus 4 bordes INTERNOS:
  //   · izquierdo y derecho: franjas verdes brillantes verticales (estrechas, continuas);
  //   · inferior: franja verde brillante horizontal (en 3 tramos);
  //   · superior: línea verde fina, más tenue, entre las dos franjas verticales.
  // Cada borde se ajusta con una recta robusta (RANSAC + mínimos cuadrados) y las esquinas son
  // las intersecciones. Se trabaja sobre una copia reducida (<= anchoMax) y se escala al final.

  /** Copia reducida (promedio por área) en planos R,G,B. k = factor original/reducida. */
  function reducir(img, anchoMax) {
    var sw = img.width, sh = img.height, sd = img.data, i, x, y, c;
    var w = sw, h = sh;
    if (sw > anchoMax) { w = Math.round(anchoMax); h = Math.max(1, Math.round(sh * w / sw)); }
    var kx = sw / w, ky = sh / h;
    var R = new Uint8Array(w * h), G = new Uint8Array(w * h), B = new Uint8Array(w * h);
    if (w === sw && h === sh) {
      for (i = 0; i < w * h; i++) { R[i] = sd[i * 4]; G[i] = sd[i * 4 + 1]; B[i] = sd[i * 4 + 2]; }
      return { w: w, h: h, kx: 1, ky: 1, R: R, G: G, B: B };
    }
    // pasada horizontal -> tmp (sh × w × 3)
    var tmp = new Float32Array(sh * w * 3);
    var xa = new Int32Array(w), xb = new Int32Array(w);
    for (x = 0; x < w; x++) { xa[x] = Math.floor(x * kx); xb[x] = Math.min(sw, Math.ceil((x + 1) * kx)); }
    for (y = 0; y < sh; y++) {
      var ro = y * sw * 4, to = y * w * 3;
      for (x = 0; x < w; x++) {
        var r = 0, g = 0, b = 0, wt = 0, x0 = x * kx, x1 = (x + 1) * kx;
        for (i = xa[x]; i < xb[x]; i++) {
          var wi = Math.min(i + 1, x1) - Math.max(i, x0);
          if (wi <= 0) continue;
          r += sd[ro + i * 4] * wi; g += sd[ro + i * 4 + 1] * wi; b += sd[ro + i * 4 + 2] * wi; wt += wi;
        }
        tmp[to + x * 3] = r / wt; tmp[to + x * 3 + 1] = g / wt; tmp[to + x * 3 + 2] = b / wt;
      }
    }
    for (y = 0; y < h; y++) {
      var y0 = y * ky, y1 = (y + 1) * ky, ya = Math.floor(y0), yb = Math.min(sh, Math.ceil(y1));
      for (x = 0; x < w; x++) {
        var r2 = 0, g2 = 0, b2 = 0, wt2 = 0;
        for (i = ya; i < yb; i++) {
          var wj = Math.min(i + 1, y1) - Math.max(i, y0);
          if (wj <= 0) continue;
          var o = (i * w + x) * 3;
          r2 += tmp[o] * wj; g2 += tmp[o + 1] * wj; b2 += tmp[o + 2] * wj; wt2 += wj;
        }
        c = y * w + x;
        R[c] = r2 / wt2 + 0.5; G[c] = g2 / wt2 + 0.5; B[c] = b2 / wt2 + 0.5;
      }
    }
    return { w: w, h: h, kx: kx, ky: ky, R: R, G: G, B: B };
  }

  /** Máscaras: S = verde brillante del anillo; gm = exceso de verde (g - max(r,b)). */
  function mascaras(F) {
    var n = F.w * F.h, S = new Uint8Array(n), gm = new Int16Array(n), i;
    for (i = 0; i < n; i++) {
      var r = F.R[i], g = F.G[i], b = F.B[i];
      gm[i] = g - (r > b ? r : b);
      if (g >= 170 && g - r >= 100 && g - b >= 100) S[i] = 1;
    }
    F.S = S; F.gm = gm;
  }

  /** Generador pseudoaleatorio determinista (para que el resultado no varíe entre ejecuciones). */
  function lcg(semilla) {
    var s = semilla >>> 0;
    return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }

  /**
   * Ajuste robusto de recta v = a + b·t. Devuelve {a,b,n,tmin,tmax,idx} o null.
   * opc: tol (px), bMax (pendiente máxima), sepMin (separación mínima en t entre los 2 puntos de la semilla).
   */
  function rectaRobusta(t, v, opc) {
    var n = t.length;
    if (n < 6) return null;
    var tol = opc.tol, bMax = opc.bMax, sepMin = opc.sepMin, rnd = lcg(12345);
    var mejor = null, mejorN = -1, it, i;
    for (it = 0; it < (opc.iter || 400); it++) {
      var i1 = Math.floor(rnd() * n), i2 = Math.floor(rnd() * n);
      var dt = t[i2] - t[i1];
      if (Math.abs(dt) < sepMin) continue;
      var b = (v[i2] - v[i1]) / dt;
      if (Math.abs(b) > bMax) continue;
      var a = v[i1] - b * t[i1], cnt = 0;
      for (i = 0; i < n; i++) if (Math.abs(v[i] - a - b * t[i]) <= tol) cnt++;
      if (cnt > mejorN) { mejorN = cnt; mejor = { a: a, b: b }; }
    }
    if (!mejor) return null;
    // refinado por mínimos cuadrados sobre los inliers (3 pasadas)
    var a2 = mejor.a, b2 = mejor.b, idx = [];
    for (var pasada = 0; pasada < 3; pasada++) {
      idx = [];
      for (i = 0; i < n; i++) if (Math.abs(v[i] - a2 - b2 * t[i]) <= tol) idx.push(i);
      if (idx.length < 4) return null;
      var st = 0, sv = 0, stt = 0, stv = 0, m = idx.length;
      for (i = 0; i < m; i++) { var k = idx[i]; st += t[k]; sv += v[k]; stt += t[k] * t[k]; stv += t[k] * v[k]; }
      var den = m * stt - st * st;
      if (Math.abs(den) < 1e-9) return null;
      b2 = (m * stv - st * sv) / den; a2 = (sv - b2 * st) / m;
    }
    idx = [];
    var tmin = Infinity, tmax = -Infinity, res = 0;
    for (i = 0; i < n; i++) {
      var e = Math.abs(v[i] - a2 - b2 * t[i]);
      if (e <= tol) idx.push(i);
    }
    if (opc.gapMax) {
      // me quedo con el tramo continuo (huecos <= gapMax) que más inliers tiene
      idx.sort(function (p, q) { return t[p] - t[q]; });
      var mejorIni = 0, mejorLen = 0, ini = 0, j;
      for (j = 1; j <= idx.length; j++) {
        if (j === idx.length || t[idx[j]] - t[idx[j - 1]] > opc.gapMax) {
          if (j - ini > mejorLen) { mejorLen = j - ini; mejorIni = ini; }
          ini = j;
        }
      }
      idx = idx.slice(mejorIni, mejorIni + mejorLen);
    }
    for (i = 0; i < idx.length; i++) {
      var kk = idx[i], ee = Math.abs(v[kk] - a2 - b2 * t[kk]);
      if (t[kk] < tmin) tmin = t[kk]; if (t[kk] > tmax) tmax = t[kk]; res += ee;
    }
    return { a: a2, b: b2, n: idx.length, tmin: tmin, tmax: tmax, idx: idx, res: res / Math.max(1, idx.length) };
  }

  /** Puntos del borde interno de una franja vertical (por fila: extremo interno de la tira verde). */
  function puntosVerticales(F, lado) {
    var w = F.w, h = F.h, S = F.S;
    var wmin = Math.max(2, Math.round(0.003 * w)), wmax = Math.round(0.07 * w);
    var xi = lado === 'izq' ? 0 : Math.floor(0.62 * w), xf = lado === 'izq' ? Math.ceil(0.38 * w) : w;
    var T = [], V = [], y, x;
    for (y = Math.floor(0.04 * h); y < Math.floor(0.99 * h); y++) {
      var o = y * w, ini = -1, ult = -2;
      for (x = xi; x <= xf; x++) {
        var on = x < xf && S[o + x] === 1;
        if (on) { if (ini < 0) ini = x; ult = x; }
        else if (ini >= 0 && x - ult > 1) {
          var anc = ult - ini + 1;
          if (anc >= wmin && anc <= wmax) { T.push(y); V.push(lado === 'izq' ? ult + 0.5 : ini - 0.5); }
          ini = -1;
        }
      }
    }
    return { t: T, v: V };
  }

  /** Borde superior: pico de exceso de verde (línea fina) por columna, en una banda alrededor de yEst. */
  function puntosSuperior(F, xs, xe, yEst, banda, gmMin) {
    var w = F.w, h = F.h, gm = F.gm, T = [], V = [], x, y;
    var ya = Math.max(2, Math.floor(yEst - banda)), yb = Math.min(h - 3, Math.ceil(yEst + banda));
    var colsValidas = 0;
    for (x = Math.ceil(xs); x <= Math.floor(xe); x += 2) {
      colsValidas++;
      var mejor = -1e9, ym = -1;
      for (y = ya; y <= yb; y++) {
        var s = 0;
        for (var dx = -2; dx <= 2; dx++) { var xx = x + dx; if (xx >= 0 && xx < w) s += gm[y * w + xx]; }
        s /= 5;
        if (s > mejor) { mejor = s; ym = y; }
      }
      if (mejor >= gmMin && ym > ya && ym < yb) {
        var s0 = 0, s1 = mejor, s2 = 0, nn;
        for (nn = -2; nn <= 2; nn++) { var q = x + nn; if (q >= 0 && q < w) { s0 += gm[(ym - 1) * w + q]; s2 += gm[(ym + 1) * w + q]; } }
        s0 /= 5; s2 /= 5;
        var den = s0 - 2 * s1 + s2, off = den < -1e-6 ? 0.5 * (s0 - s2) / den : 0;
        T.push(x); V.push(ym + Math.max(-1, Math.min(1, off)));
      }
    }
    return { t: T, v: V, cols: colsValidas };
  }

  /** Borde inferior: techo (borde interno) de la franja verde brillante inferior, por columna. */
  function puntosInferior(F, xs, xe, yEst, bandaArr, bandaAbj) {
    var w = F.w, h = F.h, S = F.S, T = [], V = [], x, y;
    var ya = Math.max(1, Math.floor(yEst - bandaArr)), yb = Math.min(h - 2, Math.ceil(yEst + bandaAbj));
    var cols = 0;
    for (x = Math.ceil(xs); x <= Math.floor(xe); x += 2) {
      cols++;
      for (y = ya; y <= yb - 3; y++) {
        if (S[y * w + x] && S[(y + 1) * w + x] && S[(y + 2) * w + x]) { T.push(x); V.push(y - 0.5); break; }
      }
    }
    return { t: T, v: V, cols: cols };
  }

  function interseccion(Lv, Lh) {
    // Lv: x = a + b·y ; Lh: y = c + d·x
    var x = (Lv.a + Lv.b * Lh.a) / (1 - Lv.b * Lh.b);
    return [x, Lh.a + Lh.b * x];
  }

  /** Intercepto de la recta de pendiente fija d que mejor encaja (mediana) con los inliers de `recta`. */
  function medianaResiduo(pts, recta, d) {
    var r = [], i;
    for (i = 0; i < recta.idx.length; i++) { var k = recta.idx[i]; r.push(pts.v[k] - d * pts.t[k]); }
    r.sort(function (a, b) { return a - b; });
    return r[r.length >> 1];
  }

  /** Primera banda horizontal ancha de verde brillante (franja inferior) entre las rectas laterales. */
  function bandaInferior(F, L, R, yA, yB, inset) {
    var w = F.w, S = F.S, y, x, seguidas = 0;
    for (y = Math.max(1, Math.floor(yA)); y <= Math.min(F.h - 2, Math.ceil(yB)); y++) {
      var xl = Math.ceil(L.a + L.b * y + inset), xr = Math.floor(R.a + R.b * y - inset), cnt = 0;
      if (xr - xl < 10) { seguidas = 0; continue; }
      for (x = xl; x <= xr; x++) cnt += S[y * w + x];
      if (cnt / (xr - xl + 1) >= 0.55) { seguidas++; if (seguidas >= 3) return y - 2; }
      else seguidas = 0;
    }
    return -1;
  }

  // ---------------------------------------------------------------------------
  // Validación, confianza y análisis del contenido
  // ---------------------------------------------------------------------------

  function acotar01(x) { return Math.max(0, Math.min(1, x)); }
  /** Fracción de soporte de un borde -> puntuación 0..1 (<=25 % -> 0, >=70 % -> 1). */
  function puntuarFraccion(f) { return acotar01((f - 0.25) / 0.45); }

  /** ¿La recta lateral ajustada es una franja LED real (larga, casi vertical, densa)? */
  function lateralValida(Lr, h) {
    if (!Lr) return false;
    var span = Lr.tmax - Lr.tmin;
    return span >= 0.25 * h && Math.abs(Lr.b) <= 0.1 && Lr.n >= 0.5 * span;
  }

  /**
   * Revisa el contenido del recorte (rectificado pequeño): ¿algún pie toca el borde del recorte o queda fuera de la foto?
   * Devuelve lista de avisos (strings). El marcador de 6 cm no se verifica por color (varía mucho entre fotos);
   * su posible corte solo se advierte cuando falta el borde izquierdo o el superior (ver detectarVentana).
   */
  function avisosContenido(img, esq) {
    var avisos = [], R;
    try { R = rectificar(img, esq, { anchoSalida: 260 }); } catch (e) { return avisos; }
    var im = R.img, w = im.width, h = im.height, d = im.data, n = w * h, i, fuera = 0;
    var M = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      var a = d[i * 4 + 3];
      if (a === 0) { fuera++; continue; }
      var r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      if (r < 110 && g >= 140 && g - b >= 80) M[i] = 1;
    }
    if (fuera > 0.002 * n) avisos.push('parte del recorte cae fuera de la foto (' + (100 * fuera / n).toFixed(1) + ' %)');
    // componentes conexas (4-vecinos) del verde intenso: pies
    var vis = new Uint8Array(n), pila = new Int32Array(n), x, y, k, tocan = 0;
    var areaMin = 0.012 * n, lado = Math.max(8, Math.round(0.06 * w)), bordeIzq = false, bordes = [];
    for (i = 0; i < n; i++) {
      if (!M[i] || vis[i]) continue;
      var sp = 0, area = 0, x0 = w, x1 = -1, y0 = h, y1 = -1, t = { l: 0, r: 0, u: 0, d: 0 };
      pila[sp++] = i; vis[i] = 1;
      while (sp) {
        k = pila[--sp]; area++; x = k % w; y = (k - x) / w;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x <= 1) t.l = 1; if (x >= w - 2) t.r = 1; if (y <= 1) t.u = 1; if (y >= h - 2) t.d = 1;
        if (x > 0 && M[k - 1] && !vis[k - 1]) { vis[k - 1] = 1; pila[sp++] = k - 1; }
        if (x < w - 1 && M[k + 1] && !vis[k + 1]) { vis[k + 1] = 1; pila[sp++] = k + 1; }
        if (y > 0 && M[k - w] && !vis[k - w]) { vis[k - w] = 1; pila[sp++] = k - w; }
        if (y < h - 1 && M[k + w] && !vis[k + w]) { vis[k + w] = 1; pila[sp++] = k + w; }
      }
      if (area >= areaMin && Math.min(x1 - x0 + 1, y1 - y0 + 1) >= lado) {
        if (t.l) bordes.push('izquierdo'); if (t.r) bordes.push('derecho');
        if (t.u) bordes.push('superior'); if (t.d) bordes.push('inferior');
        if (t.l || t.r || t.u || t.d) tocan++;
      }
    }
    if (tocan) avisos.push('un pie parece cortado por el borde ' + bordes.filter(function (v, q, A) { return A.indexOf(v) === q; }).join('/') + ' de la ventana');
    return avisos;
  }

  function aOriginal(q, F) {
    return q.map(function (p) { return [(p[0] + 0.5) * F.kx - 0.5, (p[1] + 0.5) * F.ky - 0.5]; });
  }

  function detectarVentana(img, opciones) {
    opciones = opciones || {};
    var anchoMax = opciones.anchoMax || 1500;
    var F = reducir(img, anchoMax);
    mascaras(F);
    var w = F.w, h = F.h, esc = w / 1500;
    var dbg = { w: w, h: h };
    var RAT_MIN = 1.08, RAT_MAX = 1.28;       // relación ancho/alto plausible del cuadrilátero en la foto
    var fallo = function (m) { return { esquinas: null, confianza: 0, parcial: true, motivo: m, dbg: dbg }; };

    var pL = puntosVerticales(F, 'izq'), pR = puntosVerticales(F, 'der');
    var opV = { tol: Math.max(2, 4 * esc), bMax: 0.2, sepMin: 0.1 * h, iter: 500, gapMax: 0.04 * h };
    var L = rectaRobusta(pL.t, pL.v, opV), R = rectaRobusta(pR.t, pR.v, opV);
    dbg.L = L && { a: L.a, b: L.b, n: L.n, tmin: L.tmin, tmax: L.tmax };
    dbg.R = R && { a: R.a, b: R.b, n: R.n, tmin: R.tmin, tmax: R.tmax };
    var okL = lateralValida(L, h), okR = lateralValida(R, h);
    dbg.okL = okL; dbg.okR = okR;
    if (!okL && !okR) return fallo('no se encontraron las franjas laterales del anillo LED');
    if (!okL || !okR) return detectarParcial(F, okL ? L : R, okL ? 'izq' : 'der', dbg, fallo);

    var yT0 = Math.min(L.tmin, R.tmin);
    var yM = Math.min(L.tmax, R.tmax) * 0.5 + yT0 * 0.5;
    var ancho = (R.a + R.b * yM) - (L.a + L.b * yM), inset = 0.05 * ancho;

    // --- borde inferior: techo de la franja verde inferior, dentro del rango de alturas plausible ---
    var yBandaA = yT0 + ancho / RAT_MAX - 0.03 * h, yBandaB = yT0 + ancho / RAT_MIN + 0.03 * h;
    // Si el extremo superior de las franjas laterales está «lavado» (sobreexposición) yT0 queda demasiado abajo;
    // el extremo inferior de las franjas (mín. de ambos) aporta una cota adicional para el borde inferior.
    var yFinFranjas = Math.min(L.tmax, R.tmax);
    yBandaA = Math.min(yBandaA, yFinFranjas - 0.05 * h);
    var yB0 = (yBandaA + yBandaB) / 2;
    dbg.yT0 = yT0; dbg.banda = [yBandaA, yBandaB];
    var xs = Math.max(L.a + L.b * yBandaB, L.a + L.b * yT0) + inset, xe = Math.min(R.a + R.b * yBandaB, R.a + R.b * yT0) - inset;
    var pB = puntosInferior(F, xs, xe, yB0, (yBandaB - yBandaA) / 2, (yBandaB - yBandaA) / 2);
    var B = rectaRobusta(pB.t, pB.v, { tol: Math.max(2, 3 * esc), bMax: 0.12, sepMin: 0.15 * ancho, iter: 400 });
    dbg.B = B && { a: B.a, b: B.b, n: B.n, cols: pB.cols };
    if (!B) return fallo('no se pudo ajustar el borde inferior de la ventana');

    // --- borde superior: línea fina de verde; se busca en la banda que deja la relación de aspecto plausible ---
    var yBm = B.a + B.b * ((xs + xe) / 2);
    var yTa = yBm - ancho / RAT_MIN, yTb = yBm - ancho / RAT_MAX;
    var pT = puntosSuperior(F, xs, xe, (yTa + yTb) / 2, (yTb - yTa) / 2 + 4 * esc, 55);
    var T = rectaRobusta(pT.t, pT.v, { tol: Math.max(1.5, 2 * esc), bMax: 0.12, sepMin: 0.15 * ancho, iter: 400 });
    dbg.T = T && { a: T.a, b: T.b, n: T.n, cols: pT.cols };
    if (!T) return fallo('no se encontró el borde superior de la ventana');

    var fT = T.n / Math.max(1, pT.cols), fB = B.n / Math.max(1, pB.cols);
    var fL = L.n / (L.tmax - L.tmin), fR = R.n / (R.tmax - R.tmin);
    if (opciones.compatibleDataset !== false) {
      // Modo «como el dataset»: los bordes horizontales llevan la pendiente de la rotación estimada con las
      // franjas laterales (m = -(bL+bR)/2), igual que esquinas_auto.py; solo se ajusta su posición.
      var dC = -(L.b + R.b) / 2;
      T = { a: medianaResiduo(pT, T, dC), b: dC, n: T.n };
      B = { a: medianaResiduo(pB, B, dC), b: dC, n: B.n };
    }
    var q = [interseccion(L, T), interseccion(R, T), interseccion(R, B), interseccion(L, B)];
    var esq = aOriginal(q, F);

    // --- confianza: soporte de cada borde, paralelismo y relación de aspecto plausible ---
    var wTop = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), wBot = Math.hypot(q[2][0] - q[3][0], q[2][1] - q[3][1]);
    var hIzq = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]), hDer = Math.hypot(q[2][0] - q[1][0], q[2][1] - q[1][1]);
    var rel = (wTop + wBot) / (hIzq + hDer);
    var sRel = acotar01(1 - Math.max(0, Math.abs(rel - 1.17) - 0.07) / 0.08);        // 1 en [1.10,1.24]
    var sPar = acotar01(1 - Math.max(0, Math.abs(L.b - R.b) - 0.08) / 0.08) * acotar01(1 - Math.max(0, Math.abs(T.b - B.b) - 0.03) / 0.05);
    var sBordes = Math.min(puntuarFraccion(fL), puntuarFraccion(fR), puntuarFraccion(fT), puntuarFraccion(fB));
    var conf = sBordes * sRel * sPar;
    var motivos = [];
    if (sBordes < 0.5) motivos.push('soporte débil de algún borde (L ' + fL.toFixed(2) + ', R ' + fR.toFixed(2) + ', T ' + fT.toFixed(2) + ', B ' + fB.toFixed(2) + ')');
    if (sRel < 0.5) motivos.push('relación de aspecto atípica (' + rel.toFixed(3) + ')');
    if (sPar < 0.5) motivos.push('bordes poco paralelos');
    var dentro = esq.every(function (p) { return p[0] >= -0.5 && p[1] >= -0.5 && p[0] <= img.width - 0.5 && p[1] <= img.height - 0.5; });
    if (!dentro) { conf = Math.min(conf, 0.2); motivos.push('alguna esquina cae fuera de la foto'); }
    var av = avisosContenido(img, esq);
    motivos = motivos.concat(av);
    dbg.rel = rel; dbg.f = { L: fL, R: fR, T: fT, B: fB }; dbg.s = { bordes: sBordes, rel: sRel, par: sPar };
    var parcial = conf < 0.5 || !dentro;
    return { esquinas: esq, confianza: Math.round(conf * 1000) / 1000, parcial: parcial, motivo: motivos.length ? motivos.join('; ') : null, dbg: dbg };
  }

  /**
   * Caso con un solo lado vertical visible (el otro queda fuera del encuadre): se miden borde superior, inferior y el
   * lado visible; las dos esquinas del lado ausente se EXTRAPOLAN con la relación de aspecto del dataset y no son
   * medidas. Siempre parcial:true y confianza baja: no sirve para recortar.
   */
  function detectarParcial(F, V, lado, dbg, fallo) {
    var w = F.w, h = F.h, esc = w / 1500, RAT_MIN = 1.08, RAT_MAX = 1.28;
    var yFin = V.tmax, xRef = V.a + V.b * yFin;
    var margen = 0.05 * w;
    var xs, xe;
    if (lado === 'der') { xs = 0.03 * w; xe = xRef - margen; } else { xs = xRef + margen; xe = 0.97 * w; }
    if (xe - xs < 0.2 * w) return fallo('solo un borde lateral visible y muy poco ancho útil para medir los bordes horizontales');
    var motivoLado = (lado === 'der' ? 'borde izquierdo' : 'borde derecho') + ' de la ventana fuera del encuadre';
    var bandaA = yFin - 0.03 * h, bandaB = yFin + 0.10 * h;
    var pB = puntosInferior(F, xs, xe, (bandaA + bandaB) / 2, (bandaB - bandaA) / 2, (bandaB - bandaA) / 2);
    var B = rectaRobusta(pB.t, pB.v, { tol: Math.max(2, 3 * esc), bMax: 0.12, sepMin: 0.15 * (xe - xs), iter: 400 });
    dbg.B = B && { a: B.a, b: B.b, n: B.n, cols: pB.cols };
    if (!B) return fallo(motivoLado + '; no se pudo medir el borde inferior');
    var yBm = B.a + B.b * ((xs + xe) / 2), visible = xe - xs;
    var yTa = yBm - (visible + 0.2 * w) / RAT_MIN, yTb = yBm - visible / RAT_MAX;
    var pT = puntosSuperior(F, xs, xe, (yTa + yTb) / 2, (yTb - yTa) / 2 + 4 * esc, 55);
    var T = rectaRobusta(pT.t, pT.v, { tol: Math.max(1.5, 2 * esc), bMax: 0.12, sepMin: 0.15 * (xe - xs), iter: 400 });
    dbg.T = T && { a: T.a, b: T.b, n: T.n, cols: pT.cols };
    if (!T) return fallo(motivoLado + '; no se pudo medir el borde superior');
    var yMid = (yBm + (T.a + T.b * (xs + xe) / 2)) / 2;
    var alto = (B.a + B.b * xRef) - (T.a + T.b * xRef);
    if (alto < 0.2 * h) return fallo(motivoLado + '; alto medido implausible');
    var anchoEst = alto * REL_ASPECTO_DATASET;
    var M = { a: V.a + (lado === 'der' ? -anchoEst : anchoEst), b: V.b };
    var Lq = lado === 'der' ? M : V, Rq = lado === 'der' ? V : M;
    var q = [interseccion(Lq, T), interseccion(Rq, T), interseccion(Rq, B), interseccion(Lq, B)];
    dbg.parcial = { lado: lado, alto: alto, anchoEst: anchoEst };
    return {
      esquinas: aOriginal(q, F), confianza: 0.15, parcial: true,
      motivo: motivoLado + ': esquinas ' + (lado === 'der' ? 'izquierdas' : 'derechas') + ' EXTRAPOLADAS (no medidas); ' +
        'el marcador de 6 cm y/o los pies pueden quedar cortados; no usar para recortar', dbg: dbg
    };
  }

  var API = {
    detectarVentana: detectarVentana,
    rectificar: rectificar,
    homografia: homografia,
    aplicarH: aplicarH,
    relacionMedida: relacionMedida,
    constantes: {
      CM_ANCHO: CM_ANCHO, CM_ALTO: CM_ALTO, PX_CM: PX_CM, MARGEN_CM: MARGEN_CM,
      REL_ASPECTO_DATASET: REL_ASPECTO_DATASET, MARGEN_REL_X: MARGEN_REL_X, MARGEN_REL_Y: MARGEN_REL_Y,
      ANCHO_SALIDA: ANCHO_SALIDA
    }
  };
  PodoIA.Recorte = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
