# Podoscopio digital

Interfaz web (carpeta `docs/`, publicada con GitHub Pages) con:

- Acceso para **profesionales** (documento + contraseña) y **pacientes** (correo + contraseña).
- Registro de pacientes e informes guardados en Firebase (Authentication + Firestore).
- El paciente descarga su informe en PDF desde su portal.

Archivos clave:

- `docs/index.html`: interfaz y análisis.
- `docs/acceso.js`: inicio de sesión, registro, informes y administración.
- `firestore.rules`: reglas de seguridad (se pegan en Firebase > Firestore > Reglas).
- `GUIA_FIREBASE.md`: configuración paso a paso.
