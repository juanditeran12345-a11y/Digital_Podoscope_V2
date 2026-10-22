"""
Servidor de la interfaz clínica del podoscopio.

Cómo ejecutarlo en Visual Studio Code:
  1. Abre esta carpeta (Archivo > Abrir carpeta).
  2. Abre una terminal (Terminal > Nueva terminal) y crea el entorno:
         python -m venv venv
         venv\\Scripts\\activate          (Windows)
         source venv/bin/activate         (Mac o Linux)
  3. Instala las dependencias:
         pip install -r requirements.txt
  4. Ejecuta:
         python app.py
  5. En la terminal aparecerá el enlace de la interfaz.
     Mantén Ctrl presionado y haz clic sobre él (Cmd en Mac).
     Además, el navegador se abre solo.
"""

import threading
import webbrowser

from flask import Flask, send_from_directory

HOST = "127.0.0.1"   # solo este equipo (la cámara del navegador exige localhost o https)
PUERTO = 5000
URL = f"http://localhost:{PUERTO}"

app = Flask(__name__, static_folder="docs", static_url_path="/docs")


@app.route("/")
def interfaz():
    return send_from_directory(app.static_folder, "index.html")


if __name__ == "__main__":
    print("=" * 62)
    print("Interfaz del podoscopio lista")
    print(f"Abre este enlace en el navegador: {URL}")
    print("Para detener el servidor presiona Ctrl+C")
    print("=" * 62)
    threading.Timer(1.2, lambda: webbrowser.open(URL)).start()
    app.run(host=HOST, port=PUERTO, debug=False)
