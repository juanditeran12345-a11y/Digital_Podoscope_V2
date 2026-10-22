"""
Genera docs/usuarios.js a partir de usuarios.csv.

Uso:
  1. Crea un archivo usuarios.csv en esta carpeta (una persona por línea):
         documento,nombre
         1234567890,Dra. Ana Pérez
         9876543210,Dr. Luis Gómez
  2. Ejecuta:   python generar_usuarios.py
  3. Sube a GitHub solo docs/usuarios.js (usuarios.csv está en .gitignore).

Los documentos no se guardan en claro: se guarda un hash SHA-256 con sal.
"""
import csv, hashlib, json, re, secrets, sys
from pathlib import Path

RAIZ = Path(__file__).parent
ENTRADA = RAIZ / "usuarios.csv"
SALIDA = RAIZ / "docs" / "usuarios.js"


def solo_digitos(texto):
    return re.sub(r"\D", "", texto)


def hash_doc(sal, doc):
    return hashlib.sha256(f"{sal}:{doc}".encode("utf-8")).hexdigest()


def main():
    if not ENTRADA.exists():
        sys.exit("No encuentro usuarios.csv. Crea el archivo con las columnas: documento,nombre")
    sal = secrets.token_hex(16)
    usuarios = []
    with ENTRADA.open(encoding="utf-8-sig", newline="") as f:
        for fila in csv.reader(f):
            if not fila or fila[0].strip().lower() == "documento":
                continue
            doc = solo_digitos(fila[0])
            if not doc:
                continue
            nombre = fila[1].strip() if len(fila) > 1 else ""
            usuarios.append({"h": hash_doc(sal, doc), "nombre": nombre})
    contenido = "window.USUARIOS = " + json.dumps({"sal": sal, "lista": usuarios}, ensure_ascii=False, indent=2) + ";\n"
    SALIDA.write_text(contenido, encoding="utf-8")
    print(f"Listo: {len(usuarios)} usuario(s) escritos en {SALIDA}")


if __name__ == "__main__":
    main()
