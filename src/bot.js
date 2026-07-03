import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { scrapeArticle } from './scraper.js';
import { rewriteArticle } from './claude.js';
import { createWpClient } from './wordpress.js';
import { SITES } from './sites.js';

const URL_REGEX = /https?:\/\/[^\s]+/i;

function escapeAttr(s = '') {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Inserta la foto (con alt = keyword) tras el primer párrafo, y añade al
// final el enlace a la fuente (externo) y a la sección del sitio (interno).
// El análisis SEO puntúa: imagen con keyword en alt, enlace externo e interno.
function buildContent({ html, imageAlt, mediaUrl, sourceUrl, seccionNombre, internalLink, siteName }) {
  let out = html;
  const figure = `<figure class="wp-block-image size-large"><img src="${escapeAttr(mediaUrl)}" alt="${escapeAttr(imageAlt)}"/></figure>`;
  const firstP = out.indexOf('</p>');
  out = firstP >= 0
    ? `${out.slice(0, firstP + 4)}\n${figure}\n${out.slice(firstP + 4)}`
    : `${figure}\n${out}`;

  const host = new URL(sourceUrl).hostname.replace(/^www\./, '');
  out += `\n<p><em>Fuente: <a href="${escapeAttr(sourceUrl)}" target="_blank" rel="noopener">${escapeAttr(host)}</a>. ` +
    `Más noticias de ${escapeAttr(seccionNombre)} en <a href="${escapeAttr(internalLink)}">${escapeAttr(siteName)}</a>.</em></p>`;
  return out;
}

function createSiteBot(site) {
  const wp = createWpClient(site);
  const bot = new Telegraf(site.telegramToken);

  const allowed = new Set(
    site.allowedUsers.split(',').map(id => id.trim()).filter(Boolean)
  );

  // In-memory session store: userId → { state, url }
  const sessions = new Map();

  function isAllowed(ctx) {
    return allowed.size === 0 || allowed.has(String(ctx.from.id));
  }

  function getSession(userId) {
    if (!sessions.has(userId)) sessions.set(userId, { state: 'IDLE', url: null });
    return sessions.get(userId);
  }

  async function processArticle(ctx, url, photoFileId) {
    const userId = String(ctx.from.id);
    const session = getSession(userId);
    session.state = 'PROCESSING';

    const status = await ctx.reply('Procesando noticia... esto puede tardar 1-2 minutos.');

    try {
      // 1. Scrape article content
      const { title, text } = await scrapeArticle(url);

      // 2. Secciones del sitio: taxonomía 'deporte' en DeportesDO,
      //    categorías nativas en los demás sitios.
      const secciones = site.usaTaxonomiaDeporte
        ? await wp.getTaxonomyMap().catch(() => ({}))
        : await wp.getCategories().catch(() => ({}));

      // 3. Rewrite with Claude — con validación SEO y reintentos
      const article = await rewriteArticle({
        title,
        text,
        sourceUrl: url,
        seccionSlugs: Object.keys(secciones),
        editorial: site.editorial,
      });

      const seccion = secciones[article.seccion_slug];
      const seccionNombre = seccion?.name || article.seccion_slug;

      // En DeportesDO la sección es la taxonomía 'deporte' y la categoría
      // nativa comparte slug; en los demás sitios la sección ES la categoría.
      let deporteId = null;
      let categoryId = null;
      if (site.usaTaxonomiaDeporte) {
        deporteId = seccion?.id ?? null;
        categoryId =
          (await wp.getCategoryIdBySlug(article.seccion_slug).catch(() => null)) ||
          (await wp.getCategoryIdBySlug('multideporte').catch(() => null));
      } else {
        categoryId = seccion?.id ?? null;
      }

      // 4. Download photo from Telegram
      const fileLink = await ctx.telegram.getFileLink(photoFileId);
      const imgRes = await fetch(fileLink.href);
      if (!imgRes.ok) throw new Error('No se pudo descargar la foto de Telegram.');
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
      const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
      const ext = mimeType.includes('png') ? 'png' : 'jpg';

      // 5. Upload image to WordPress (con alt = keyword para SEO)
      const imageAlt = article.image_alt || article.focus_keyword;
      const media = await wp.uploadImage(imgBuffer, `noticia-${Date.now()}.${ext}`, mimeType, imageAlt);

      // 6. Etiquetas: buscar o crear cada una
      const tagIds = await wp.ensureTags(article.tags || []).catch(() => []);

      // 7. Contenido final: foto dentro del artículo + enlaces fuente/interno
      const siteUrl = site.wpUrl.replace(/\/$/, '');
      const finalHtml = buildContent({
        html: article.html,
        imageAlt,
        mediaUrl: media.url,
        sourceUrl: url,
        seccionNombre,
        internalLink: siteUrl + site.internalLinkPath(article.seccion_slug),
        siteName: site.nombre,
      });

      // 8. Create and publish post
      const { url: postUrl, published } = await wp.createPost({
        ...article,
        html: finalHtml,
        mediaId: media.id,
        deporteId,
        categoryId,
        tagIds,
      });

      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      if (published) {
        const tagsInfo = tagIds.length ? ` · ${tagIds.length} etiquetas` : '';
        await ctx.reply(`Noticia publicada exitosamente (${seccionNombre}${tagsInfo}):\n${postUrl}`);
      } else {
        await ctx.reply(
          `La noticia se guardó como borrador (WordPress rechazó la publicación directa):\n${postUrl}\n\n` +
          `Revísala y publícala desde wp-admin. Si esto pasa siempre, verifica el rol del usuario y los campos requeridos del post.`
        );
      }
    } catch (err) {
      console.error(`[${site.key}] Error procesando ${url}:`, err.message);
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      await ctx.reply(`Error al procesar la noticia:\n${err.message}`);
    } finally {
      session.state = 'IDLE';
      session.url = null;
    }
  }

  // Auth middleware
  bot.use((ctx, next) => {
    if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
    return next();
  });

  bot.command('start', ctx => {
    ctx.reply(
      `Bienvenido al bot de noticias de ${site.nombre}.\n\n` +
      'Uso:\n' +
      '1. Envia /noticia [URL] o simplemente pega una URL\n' +
      '2. Luego envia la foto para la noticia\n' +
      '   (o envia la foto con la URL en el caption)\n\n' +
      '/cancelar — cancela la operacion actual'
    );
  });

  bot.command('cancelar', ctx => {
    const session = getSession(String(ctx.from.id));
    session.state = 'IDLE';
    session.url = null;
    ctx.reply('Operacion cancelada.');
  });

  bot.command('noticia', ctx => {
    const session = getSession(String(ctx.from.id));
    if (session.state === 'PROCESSING') return ctx.reply('Ya estoy procesando una noticia. Espera un momento.');

    const urlMatch = ctx.message.text.match(URL_REGEX);
    if (!urlMatch) return ctx.reply('Uso: /noticia [URL]\nEjemplo: /noticia https://espn.com/deportes/...');

    session.url = urlMatch[0];
    session.state = 'WAITING_PHOTO';
    ctx.reply('URL guardada. Ahora envia la foto para la noticia.');
  });

  // Handle plain text messages — detect URLs
  bot.on('text', ctx => {
    const session = getSession(String(ctx.from.id));
    if (session.state === 'PROCESSING') return ctx.reply('Ya estoy procesando una noticia. Espera.');

    const urlMatch = ctx.message.text.match(URL_REGEX);
    if (!urlMatch) {
      if (session.state === 'WAITING_PHOTO') return ctx.reply('Envia la foto para continuar, o /cancelar para salir.');
      return;
    }

    session.url = urlMatch[0];
    session.state = 'WAITING_PHOTO';
    ctx.reply('URL guardada. Ahora envia la foto para la noticia.');
  });

  // Handle photos
  bot.on('photo', async ctx => {
    const session = getSession(String(ctx.from.id));
    if (session.state === 'PROCESSING') return ctx.reply('Ya estoy procesando una noticia. Espera.');

    // Photo with URL in caption counts as a single-message submission
    const caption = ctx.message.caption || '';
    const captionUrl = caption.match(URL_REGEX)?.[0];

    const url = captionUrl || session.url;
    if (!url) return ctx.reply('Primero envia la URL del articulo, luego la foto.');

    // Highest resolution photo
    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];

    await processArticle(ctx, url, best.file_id);
  });

  bot.launch();
  console.log(`Bot de ${site.nombre} iniciado correctamente.`);
  return bot;
}

if (!SITES.length) {
  console.error('Ningún sitio configurado: faltan variables de entorno.');
  process.exit(1);
}

const bots = SITES.map(createSiteBot);
console.log(`${bots.length} bot(s) corriendo: ${SITES.map(s => s.nombre).join(', ')}.`);

process.once('SIGINT', () => bots.forEach(b => b.stop('SIGINT')));
process.once('SIGTERM', () => bots.forEach(b => b.stop('SIGTERM')));
