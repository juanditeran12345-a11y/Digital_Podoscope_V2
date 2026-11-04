"use strict";
/* ============================================================
   Acceso, registro de pacientes e informes (Firebase)
   - Profesionales: usuario = número de documento + contraseña personal.
   - Pacientes: correo + contraseña (pueden crearla y recuperarla por correo).
   - La seguridad real está en las reglas de Firestore (firestore.rules).
   ============================================================ */
(function () {
  const CONFIG_FB = {
    apiKey: "AIzaSyCE2h06ymEPmG_gulj5AgZGKwlM1ZShWxA",
    authDomain: "registro-podometrias.firebaseapp.com",
    projectId: "registro-podometrias",
    storageBucket: "registro-podometrias.firebasestorage.app",
    messagingSenderId: "17579490010",
    appId: "1:17579490010:web:c21c621b819d92877e43e3"
  };
  // Los profesionales entran con su documento; internamente se guarda como un correo con este dominio.
  const DOMINIO_PROF = "@profesionales-podoscopio.com";
  const LIMITE_DOC = 900000; // bytes aproximados (el máximo de Firestore es 1 MiB por documento)

  const $ = id => document.getElementById(id);
  const vista = v => { document.body.dataset.vista = v; };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const msg = (id, txt, tipo) => { const el = $(id); if (!el) return; el.textContent = txt || ""; el.className = "aviso" + (tipo ? " " + tipo : ""); };
  const fechaCorta = iso => { const d = new Date(iso); return isNaN(d) ? "—" : d.toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" }); };
  const soloDigitos = t => String(t || "").replace(/\D/g, "");
  const emailValido = t => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);

  if (typeof firebase === "undefined") {
    vista("login");
    msg("loginAviso", "No se pudo cargar Firebase. Revisa tu conexión a internet y recarga la página.", "error");
    return;
  }

  firebase.initializeApp(CONFIG_FB);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const ts = () => firebase.firestore.FieldValue.serverTimestamp();
  // La sesión dura solo mientras la pestaña esté abierta (equipos compartidos)
  const persistencia = auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(() => {});

  let perfil = null;          // datos del profesional que inició sesión
  let pacientes = [];         // caché del registro
  let informesCache = {};     // informes mostrados actualmente

  function errorAuth(e) {
    switch (e && e.code) {
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/user-not-found":
      case "auth/invalid-login-credentials": return "Usuario o contraseña incorrectos.";
      case "auth/invalid-email": return "El correo no es válido.";
      case "auth/email-already-in-use": return "Ya existe una cuenta con ese correo. Usa “Ya tengo cuenta” o recupera tu contraseña.";
      case "auth/weak-password": return "La contraseña es muy débil. Usa al menos 8 caracteres.";
      case "auth/too-many-requests": return "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.";
      case "auth/network-request-failed": return "Sin conexión con el servidor. Revisa tu internet.";
      case "auth/operation-not-allowed": return "Falta activar el método Correo/contraseña en Firebase Authentication.";
      case "auth/requires-recent-login": return "Por seguridad, vuelve a iniciar sesión e inténtalo de nuevo.";
      default: return "No se pudo completar la acción (" + ((e && (e.code || e.message)) || "error desconocido") + ").";
    }
  }
  function errorDB(e) {
    if (e && e.code === "permission-denied") return "No tienes permiso para esta acción.";
    if (e && e.code === "unavailable") return "Sin conexión con el servidor. Inténtalo de nuevo.";
    return "Ocurrió un error (" + ((e && (e.code || e.message)) || "desconocido") + ").";
  }

  /* ---------------- Pantalla de acceso ---------------- */
  function pestana(cual) {
    const prof = cual === "prof";
    $("tabProf").classList.toggle("activa", prof);
    $("tabPac").classList.toggle("activa", !prof);
    $("formProf").classList.toggle("oculto", !prof);
    $("formPac").classList.toggle("oculto", prof);
    msg("loginAviso", "");
    if (!prof) modoPaciente("entrar");
  }
  $("tabProf").addEventListener("click", () => pestana("prof"));
  $("tabPac").addEventListener("click", () => pestana("pac"));

  let modo = "entrar";
  function modoPaciente(m) {
    modo = m;
    const t = {
      entrar: ["Acceso de pacientes", "Ingresa con tu correo y tu contraseña para ver tu informe.", "Ingresar", ["Crear cuenta", "registro"], ["Olvidé mi contraseña", "recuperar"]],
      registro: ["Crear cuenta", "Usa el mismo correo que le diste a tu profesional.", "Crear cuenta", ["Ya tengo cuenta", "entrar"], null],
      recuperar: ["Recuperar contraseña", "Te enviaremos un enlace a tu correo para crear una nueva contraseña.", "Enviar enlace", ["Volver", "entrar"], null]
    }[m];
    $("pacTitulo").textContent = t[0]; $("pacAyuda").textContent = t[1]; $("btnPac").textContent = t[2];
    [["lnkA", t[3]], ["lnkB", t[4]]].forEach(([id, v]) => {
      const b = $(id); b.classList.toggle("oculto", !v);
      if (v) { b.textContent = v[0]; b.dataset.modo = v[1]; }
    });
    $("bloqueClave").classList.toggle("oculto", m === "recuperar");
    $("bloqueClave2").classList.toggle("oculto", m !== "registro");
    $("bloqueConsent").classList.toggle("oculto", m !== "registro");
    $("pacClave").autocomplete = m === "registro" ? "new-password" : "current-password";
    msg("loginAviso", "");
  }
  ["lnkA", "lnkB"].forEach(id => $(id).addEventListener("click", e => modoPaciente(e.currentTarget.dataset.modo)));

  $("formProf").addEventListener("submit", async e => {
    e.preventDefault();
    const doc = soloDigitos($("profDoc").value), clave = $("profClave").value;
    if (doc.length < 5 || !clave) { msg("loginAviso", "Escribe tu número de documento y tu contraseña.", "error"); return; }
    const btn = $("btnProfEntrar"); btn.disabled = true; msg("loginAviso", "Ingresando…");
    try {
      await persistencia;
      await auth.signInWithEmailAndPassword(doc + DOMINIO_PROF, clave);
      msg("loginAviso", "");
    } catch (err) { msg("loginAviso", errorAuth(err), "error"); }
    finally { btn.disabled = false; }
  });

  $("formPac").addEventListener("submit", async e => {
    e.preventDefault();
    const email = $("pacEmail").value.trim().toLowerCase(), clave = $("pacClave").value;
    if (!emailValido(email)) { msg("loginAviso", "Escribe un correo válido.", "error"); return; }
    if (email.endsWith(DOMINIO_PROF)) { msg("loginAviso", "Ese correo no es válido para pacientes.", "error"); return; }
    const btn = $("btnPac"); btn.disabled = true;
    try {
      await persistencia;
      if (modo === "recuperar") {
        await auth.sendPasswordResetEmail(email);
        msg("loginAviso", "Si el correo está registrado, recibirás un enlace para crear una nueva contraseña. Revisa también el spam.", "ok");
      } else if (modo === "registro") {
        if (clave.length < 8) { msg("loginAviso", "La contraseña debe tener al menos 8 caracteres.", "error"); return; }
        if (clave !== $("pacClave2").value) { msg("loginAviso", "Las contraseñas no coinciden.", "error"); return; }
        if (!$("pacConsent").checked) { msg("loginAviso", "Debes autorizar el tratamiento de tus datos para continuar.", "error"); return; }
        msg("loginAviso", "Creando cuenta…");
        const cred = await auth.createUserWithEmailAndPassword(email, clave);
        try { await cred.user.sendEmailVerification(); } catch (_) { /* se puede reenviar desde el portal */ }
      } else {
        if (!clave) { msg("loginAviso", "Escribe tu contraseña.", "error"); return; }
        msg("loginAviso", "Ingresando…");
        await auth.signInWithEmailAndPassword(email, clave);
        msg("loginAviso", "");
      }
    } catch (err) { msg("loginAviso", errorAuth(err), "error"); }
    finally { btn.disabled = false; }
  });

  /* ---------------- Estado de sesión ---------------- */
  auth.onAuthStateChanged(async user => {
    perfil = null;
    if (!user) {
      ["profClave", "pacClave", "pacClave2"].forEach(id => { $(id).value = ""; });
      vista("login");
      return;
    }
    vista("cargando");
    try {
      const snap = await db.collection("profesionales").doc(user.uid).get();
      if (snap.exists) {
        const p = snap.data();
        if (p.activo === true) { perfil = Object.assign({ uid: user.uid }, p); abrirProfesional(); }
        else {
          await auth.signOut();
          msg("loginAviso", "Tu cuenta está desactivada. Contacta al administrador.", "error");
        }
      } else {
        abrirPaciente(user);
      }
    } catch (err) {
      console.error(err);
      await auth.signOut();
      msg("loginAviso", "No se pudo verificar tu cuenta. " + errorDB(err), "error");
    }
  });

  async function cerrarSesion() {
    try { await auth.signOut(); } finally { location.reload(); } // limpia imágenes y datos en memoria
  }
  $("btnSalir").addEventListener("click", cerrarSesion);
  $("btnSalirPac").addEventListener("click", cerrarSesion);

  /* ---------------- Vista del profesional ---------------- */
  function abrirProfesional() {
    vista("pro");
    $("usuarioNombre").textContent = perfil.nombre || "";
    $("btnProfs").classList.toggle("oculto", perfil.rol !== "admin");
    const prof = $("pProf"); prof.value = perfil.nombre || ""; prof.readOnly = true;
  }

  /* ---- Modales ---- */
  function abrirModal(id) { $(id).classList.remove("oculto"); }
  function cerrarModales() { document.querySelectorAll(".modal").forEach(m => m.classList.add("oculto")); }
  document.querySelectorAll("[data-cerrar]").forEach(b => b.addEventListener("click", cerrarModales));
  document.addEventListener("keydown", e => { if (e.key === "Escape") cerrarModales(); });

  /* ---- Guardar paciente / informe ---- */
  function datosPacienteForm() {
    const v = id => ($(id).value || "").trim();
    return { nombre: v("pNombre"), documento: soloDigitos(v("pDoc")), email: v("pEmail").toLowerCase(), edad: v("pEdad"), sexo: v("pSexo"), peso: v("pPeso"), estatura: v("pEstatura") };
  }
  async function guardarPaciente() {
    const p = datosPacienteForm();
    if (!p.nombre || !p.documento) throw new Error("Escribe al menos el nombre y el documento del paciente.");
    if (p.email && !emailValido(p.email)) throw new Error("El correo del paciente no es válido.");
    const datos = Object.assign({}, p, { actualizado: ts(), actualizadoPor: perfil.uid });
    const q = await db.collection("pacientes").where("documento", "==", p.documento).limit(1).get();
    if (!q.empty) { await q.docs[0].ref.set(datos, { merge: true }); return q.docs[0].id; }
    const ref = await db.collection("pacientes").add(Object.assign({}, datos, { creado: ts(), creadoPor: perfil.uid }));
    return ref.id;
  }

  $("btnGuardarPaciente").addEventListener("click", async () => {
    const btn = $("btnGuardarPaciente"); btn.disabled = true;
    try {
      await guardarPaciente();
      const sinCorreo = !$("pEmail").value.trim();
      mostrarAviso("Paciente guardado en el registro." + (sinCorreo ? " Sin correo, el paciente no podrá consultar sus informes." : ""), "ok");
    } catch (err) { mostrarAviso(err.code ? errorDB(err) : err.message, "error"); }
    finally { btn.disabled = false; }
  });

  $("btnGuardarInforme").addEventListener("click", async () => {
    const btn = $("btnGuardarInforme"); btn.disabled = true; mostrarAviso("Guardando informe…");
    try {
      let d = capturarInforme(640, 0.75);
      if (!d) throw new Error("Primero analiza una imagen.");
      if (JSON.stringify(d).length > LIMITE_DOC) d = capturarInforme(420, 0.6);
      if (JSON.stringify(d).length > LIMITE_DOC) throw new Error("El informe es demasiado grande para guardarlo. Usa una imagen más pequeña.");
      const pacienteId = await guardarPaciente();
      await db.collection("informes").add({
        pacienteId, pacienteEmail: d.paciente.email, pacienteNombre: d.paciente.nombre,
        profesionalUid: perfil.uid, profesionalNombre: perfil.nombre || "",
        fecha: d.fecha, creado: ts(), informe: d
      });
      mostrarAviso("Informe guardado en el registro." + (d.paciente.email ? "" : " Sin correo del paciente, él no podrá verlo."), "ok");
    } catch (err) { mostrarAviso(err.code ? errorDB(err) : err.message, "error"); }
    finally { btn.disabled = !estado.resultado; }
  });

  /* ---- Registro de pacientes ---- */
  $("btnRegistro").addEventListener("click", async () => {
    abrirModal("modalRegistro");
    $("regDetalle").classList.add("oculto"); $("regLista").classList.remove("oculto");
    $("regBuscar").value = ""; msg("regAviso", "Cargando pacientes…");
    try {
      const s = await db.collection("pacientes").get();
      pacientes = s.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
      msg("regAviso", ""); renderPacientes();
    } catch (err) { msg("regAviso", errorDB(err), "error"); }
  });

  function renderPacientes() {
    const q = $("regBuscar").value.trim().toLowerCase();
    const lista = pacientes.filter(p => !q || [p.nombre, p.documento, p.email].some(x => String(x || "").toLowerCase().includes(q)));
    $("regCuerpo").innerHTML = lista.length ? lista.map(p => `<tr>
      <td>${esc(p.nombre)}</td><td>${esc(p.documento)}</td><td>${esc(p.email || "—")}</td>
      <td style="white-space:nowrap"><button class="btn" data-acc="cargar" data-id="${esc(p.id)}">Cargar</button> <button class="btn" data-acc="informes" data-id="${esc(p.id)}">Informes</button></td>
    </tr>`).join("") : `<tr><td colspan="4">${pacientes.length ? "Sin resultados." : "Aún no hay pacientes registrados."}</td></tr>`;
  }
  $("regBuscar").addEventListener("input", renderPacientes);

  $("regCuerpo").addEventListener("click", async e => {
    const b = e.target.closest("button[data-acc]"); if (!b) return;
    const p = pacientes.find(x => x.id === b.dataset.id); if (!p) return;
    if (b.dataset.acc === "cargar") {
      $("pNombre").value = p.nombre || ""; $("pDoc").value = p.documento || ""; $("pEmail").value = p.email || "";
      $("pEdad").value = p.edad || ""; $("pSexo").value = p.sexo || ""; $("pPeso").value = p.peso || ""; $("pEstatura").value = p.estatura || "";
      cerrarModales(); mostrarAviso("Datos del paciente cargados en el formulario.", "ok");
    } else {
      $("regLista").classList.add("oculto"); $("regDetalle").classList.remove("oculto");
      $("regDetalleTit").textContent = "Informes de " + (p.nombre || "paciente");
      $("regInformes").innerHTML = ""; msg("regDetAviso", "Cargando informes…");
      try {
        const s = await db.collection("informes").where("pacienteId", "==", p.id).get();
        const lista = s.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
        informesCache = {}; lista.forEach(i => { informesCache[i.id] = i; });
        msg("regDetAviso", lista.length ? "" : "Este paciente aún no tiene informes guardados.");
        $("regInformes").innerHTML = lista.map(i => `<tr>
          <td>${esc(fechaCorta(i.fecha))}</td><td>${esc(i.profesionalNombre || "—")}</td>
          <td style="white-space:nowrap"><button class="btn" data-acc="pdf" data-id="${esc(i.id)}">Descargar PDF</button>${perfil.rol === "admin" ? ` <button class="btn" data-acc="borrar" data-id="${esc(i.id)}">Eliminar</button>` : ""}</td>
        </tr>`).join("");
      } catch (err) { msg("regDetAviso", errorDB(err), "error"); }
    }
  });
  $("regVolver").addEventListener("click", () => { $("regDetalle").classList.add("oculto"); $("regLista").classList.remove("oculto"); });

  $("regInformes").addEventListener("click", async e => {
    const b = e.target.closest("button[data-acc]"); if (!b) return;
    const inf = informesCache[b.dataset.id]; if (!inf) return;
    if (b.dataset.acc === "pdf") {
      if (!generarPDF(inf.informe)) msg("regDetAviso", "No se cargó la librería del PDF. Revisa tu conexión y recarga.", "error");
    } else if (b.dataset.acc === "borrar") {
      if (!confirm("¿Eliminar este informe de forma permanente?")) return;
      try { await db.collection("informes").doc(inf.id).delete(); b.closest("tr").remove(); delete informesCache[inf.id]; msg("regDetAviso", "Informe eliminado.", "ok"); }
      catch (err) { msg("regDetAviso", errorDB(err), "error"); }
    }
  });

  /* ---- Administración de profesionales ---- */
  let listaProfs = [];
  async function cargarProfs() {
    msg("profsAviso", "Cargando…");
    try {
      const s = await db.collection("profesionales").get();
      listaProfs = s.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es"));
      msg("profsAviso", "");
      $("profsCuerpo").innerHTML = listaProfs.map(p => `<tr>
        <td>${esc(p.nombre)}</td><td>${esc(p.documento)}</td><td>${p.rol === "admin" ? "Administrador" : "Profesional"}</td>
        <td>${p.activo ? "Activo" : "Desactivado"}</td>
        <td>${p.id === perfil.uid ? "" : `<button class="btn" data-id="${esc(p.id)}" data-activo="${p.activo ? "1" : "0"}">${p.activo ? "Desactivar" : "Activar"}</button>`}</td>
      </tr>`).join("");
    } catch (err) { msg("profsAviso", errorDB(err), "error"); }
  }
  $("btnProfs").addEventListener("click", () => { abrirModal("modalProfs"); cargarProfs(); });

  $("profsCuerpo").addEventListener("click", async e => {
    const b = e.target.closest("button[data-id]"); if (!b) return;
    try { await db.collection("profesionales").doc(b.dataset.id).update({ activo: b.dataset.activo !== "1" }); await cargarProfs(); }
    catch (err) { msg("profsAviso", errorDB(err), "error"); }
  });

  $("formNuevoProf").addEventListener("submit", async e => {
    e.preventDefault();
    const documento = soloDigitos($("npDoc").value), nombre = $("npNombre").value.trim(), clave = $("npClave").value, rol = $("npRol").value;
    if (documento.length < 5 || !nombre) { msg("profsAviso", "Escribe el documento y el nombre.", "error"); return; }
    if (clave.length < 8) { msg("profsAviso", "La contraseña debe tener al menos 8 caracteres.", "error"); return; }
    const btn = $("btnCrearProf"); btn.disabled = true; msg("profsAviso", "Creando…");
    let sec;
    try {
      // Se usa una segunda conexión para no cerrar la sesión del administrador
      const app2 = firebase.apps.find(a => a.name === "secundaria") || firebase.initializeApp(CONFIG_FB, "secundaria");
      sec = app2.auth();
      await sec.setPersistence(firebase.auth.Auth.Persistence.NONE).catch(() => {});
      const cred = await sec.createUserWithEmailAndPassword(documento + DOMINIO_PROF, clave);
      await db.collection("profesionales").doc(cred.user.uid).set({ documento, nombre, rol, activo: true, creado: ts(), creadoPor: perfil.uid });
      $("formNuevoProf").reset();
      msg("profsAviso", "Profesional creado. Entrégale su documento y la contraseña inicial.", "ok");
      await cargarProfs();
    } catch (err) {
      msg("profsAviso", err.code === "auth/email-already-in-use"
        ? "Ya existe una cuenta con ese documento. Si fue un registro incompleto, elimínala en Firebase > Authentication y vuelve a crearla."
        : (err.code && err.code.startsWith("auth/") ? errorAuth(err) : errorDB(err)), "error");
    } finally {
      if (sec) { try { await sec.signOut(); } catch (_) {} }
      btn.disabled = false;
    }
  });

  /* ---- Cambiar contraseña ---- */
  $("btnClave").addEventListener("click", () => { $("formClave").reset(); msg("claveAviso", ""); abrirModal("modalClave"); });
  $("formClave").addEventListener("submit", async e => {
    e.preventDefault();
    const actual = $("ccActual").value, nueva = $("ccNueva").value;
    if (!actual) { msg("claveAviso", "Escribe tu contraseña actual.", "error"); return; }
    if (nueva.length < 8) { msg("claveAviso", "La contraseña nueva debe tener al menos 8 caracteres.", "error"); return; }
    if (nueva !== $("ccNueva2").value) { msg("claveAviso", "Las contraseñas nuevas no coinciden.", "error"); return; }
    try {
      const u = auth.currentUser;
      await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, actual));
      await u.updatePassword(nueva);
      $("formClave").reset(); msg("claveAviso", "Contraseña actualizada.", "ok");
    } catch (err) { msg("claveAviso", errorAuth(err), "error"); }
  });

  /* ---------------- Portal del paciente ---------------- */
  function abrirPaciente(user) {
    vista("paciente");
    $("portalCorreo").textContent = user.email || "";
    $("verifCorreo").textContent = user.email || "";
    const verificado = user.emailVerified === true;
    $("portalVerificar").classList.toggle("oculto", verificado);
    $("portalInformes").classList.toggle("oculto", !verificado);
    if (verificado) cargarInformesPaciente(user);
  }

  $("btnReenviar").addEventListener("click", async () => {
    try { await auth.currentUser.sendEmailVerification(); msg("verifAviso", "Correo reenviado. Revisa tu bandeja y el spam.", "ok"); }
    catch (err) { msg("verifAviso", errorAuth(err), "error"); }
  });
  $("btnYaVerifique").addEventListener("click", async () => {
    try {
      const u = auth.currentUser;
      await u.reload();
      await u.getIdToken(true); // actualiza el permiso con el correo ya verificado
      if (auth.currentUser.emailVerified) abrirPaciente(auth.currentUser);
      else msg("verifAviso", "Todavía no aparece verificado. Abre el enlace del correo y vuelve a intentarlo.", "error");
    } catch (err) { msg("verifAviso", errorAuth(err), "error"); }
  });

  async function cargarInformesPaciente(user) {
    msg("portalAviso", "Cargando tus informes…");
    $("listaInformes").innerHTML = "";
    try {
      const s = await db.collection("informes").where("pacienteEmail", "==", String(user.email).toLowerCase()).get();
      const lista = s.docs.map(d => Object.assign({ id: d.id }, d.data())).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
      informesCache = {}; lista.forEach(i => { informesCache[i.id] = i; });
      msg("portalAviso", lista.length ? "" : "Aún no tienes informes. Cuando tu profesional guarde uno con este correo, aparecerá aquí.");
      $("listaInformes").innerHTML = lista.map(i => `<div class="informe-item">
        <div><b>Informe podoscópico</b><small>${esc(fechaCorta(i.fecha))}${i.profesionalNombre ? " · " + esc(i.profesionalNombre) : ""}</small></div>
        <button class="btn primario" data-id="${esc(i.id)}">Descargar PDF</button></div>`).join("");
    } catch (err) { msg("portalAviso", errorDB(err), "error"); }
  }
  $("listaInformes").addEventListener("click", e => {
    const b = e.target.closest("button[data-id]"); if (!b) return;
    const inf = informesCache[b.dataset.id]; if (!inf) return;
    if (!generarPDF(inf.informe)) msg("portalAviso", "No se cargó la librería del PDF. Revisa tu conexión y recarga la página.", "error");
  });

  modoPaciente("entrar");
})();
