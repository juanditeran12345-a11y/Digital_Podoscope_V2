# Configuración de Firebase (una sola vez)

Proyecto: `registro-podometrias`

1. **Authentication > Método de acceso**: activar **Correo electrónico/contraseña**.
2. **Firestore Database > Crear base de datos** en **modo producción** (ubicación sugerida: `southamerica-east1`; no se puede cambiar después).
3. **Firestore > Reglas**: pegar el contenido de `firestore.rules` y pulsar **Publicar**.
4. **Authentication > Configuración > Dominios autorizados**: agregar `juanditeran12345-a11y.github.io`.
5. **Authentication > Plantillas**: poner el idioma de los correos en Español.
6. **Crear el primer administrador** (manual, una sola vez):
   - Authentication > Usuarios > **Agregar usuario**
     - Correo: `NUMERODOCUMENTO@profesionales-podoscopio.com` (ej. `1049929035@profesionales-podoscopio.com`)
     - Contraseña: la que elija el administrador.
   - Copiar el **UID** del usuario creado.
   - Firestore > **Iniciar colección** `profesionales` > ID del documento = el **UID** copiado, con estos campos:
     - `documento` (string): `1049929035`
     - `nombre` (string): `Juan Diego Terán Zabaleta`
     - `rol` (string): `admin`
     - `activo` (boolean): `true`
7. Entrar a la página como Profesional. Desde el botón **Profesionales** el administrador crea al resto.

Si un profesional olvida su contraseña: el administrador lo desactiva, elimina su usuario en Authentication > Usuarios y lo vuelve a crear desde el botón Profesionales.
