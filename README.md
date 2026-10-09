# PatentIA — patentes.skynetgenesis.com

Herramienta interna de SkyNet Genesis para crear, proteger y licenciar patentes, modelos de utilidad, diseños y marcas.

- `docs/` — la app (GitHub Pages, dominio patentes.skynetgenesis.com).
- `server/` — servidor (Render, plan gratis) con base de datos en Neon.
- `render.yaml` — configuración para crear el servidor en Render (Blueprint).

Variables en Render: `DATABASE_URL` (cadena de Neon), `CLAVE_RECUPERACION` (la define el dueño; sirve para crear el administrador y recuperar la contraseña), `JWT_SECRET` (automática), `ORIGEN`.

SkyNet Genesis · contacto@skynetgenesis.com · WhatsApp 3044375758
