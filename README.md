# RDparty News Bot

Bot de Telegram (**@rdparty_news_bot**) que publica noticias en [RDparty.com](https://rdparty.com) con redacción por IA optimizada para SEO (Yoast).

## Flujo

1. Envía la URL de un artículo al bot (o `/noticia [URL]`)
2. Envía la foto para la noticia (o la foto con la URL en el caption)
3. El bot: scrapea la fuente → Claude reescribe en español dominicano con validación SEO (keyword exacta en título/slug/H2, 650-800 palabras, reintenta hasta 3 veces) → sube la foto con alt → crea/asigna etiquetas → elige la categoría del sitio → publica con meta de Yoast y enlaces fuente/interno.

## Configuración

Secretos de GitHub Actions (ver `.env.example`): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USERS`, `WORDPRESS_URL`, `WORDPRESS_USERNAME`, `WORDPRESS_APP_PASSWORD`, `ANTHROPIC_API_KEY`.

Requisitos del WordPress:

- Usuario con rol **Editor** y Application Password.
- Los campos meta de Yoast (`_yoast_wpseo_focuskw`, `_yoast_wpseo_metadesc`, `_yoast_wpseo_title`) registrados en el REST API con `register_post_meta` (`show_in_rest`), o WordPress descartará el SEO en silencio.

## Ejecución

Corre 24/7 en GitHub Actions (`.github/workflows/telegram-bot.yml`): se reinicia cada 5 horas y con cada push a `main`.

```bash
npm install
npm start   # local, requiere .env
```

Proyecto hermano: [armatusemestre-scraper](https://github.com/vmdventura/armatusemestre-scraper) (bot de DeportesDO, mismo diseño).
