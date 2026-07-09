import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { scrapeArticle } from './scraper.js';
import { rewriteArticle } from './claude.js';
import { createWpClient } from './wordpress.js';
import { SITES } from './sites.js';
import { getTrendingBrief } from './trends.js';

const URL_REGEX = /https?:\/\/[^\s]+/i;

function escapeAttr(s = '') {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Inserta la foto (con alt = keyword) tras el primer párrafo, y añade al
// final el enlace interno a la sección del sitio. El análisis SEO puntúa:
// imagen con keyword en alt y enlace interno. Sin crédito externo a la
// fuente (no le regalamos enlace/autoridad a la competencia).
function buildContent({ html, imageAlt, mediaUrl, seccionNombre, internalLink, siteName }) {
  let out = html;
  const figure = `<figure class="wp-block-image size-large"><img src="${escapeAttr(mediaUrl)}" alt="${escapeAttr(imageAlt)}"/></figure>`;
  const firstP = out.indexOf('</p>');
  out = firstP >= 0
    ? `${out.slice(0, firstP + 4)}\n${figure}\n${out.slice(firstP + 4)}`
    : `${figure}\n${out}`;

  out += `\n<p><em>Más noticias de ${escapeAttr(seccionNombre)} en <a href="${escapeAttr(internalLink)}">${escapeAttr(siteName)}</a>.</em></p>`;
  return out;
}

function createSiteBot(site) {
  const wp = createWpClient(site);
  // handlerTimeout por defecto de Telegraf (90s) se queda corto: el bot puede
  // hacer hasta 3 intentos de redacción con Claude para cumplir el SEO, más
  // scraping e imagen — todo eso junto puede pasar de los 90s fácilmente.
  const bot = new Telegraf(site.telegramToken, { handlerTimeout: 600_000 });

  // Red de seguridad: sin esto, cualquier error no capturado (incluido un
  // timeout de Telegraf) tumba TODO el proceso — el bot deja de responder
  // hasta que alguien lo reinicie a mano. Con esto, el bot loguea y sigue vivo.
  bot.catch((err, ctx) => {
    console.error(`[${site.key}] Error no capturado en el bot:`, err.message);
    ctx.reply(`Error interno del bot:\n${err.message}`).catch(() => {});
  });

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

  // Continúa el pipeline una vez que ya tenemos texto del artículo — sea por
  // scraping automático o porque el usuario lo pegó a mano (sitios con todo
  // el contenido en JavaScript, como DAZN, no dejan nada que leer en el HTML).
  async function processArticleCore(ctx, { url, title, text, photoFileId }) {
    const userId = String(ctx.from.id);
    const session = getSession(userId);
    session.state = 'PROCESSING';

    const status = await ctx.reply('Procesando noticia... esto puede tardar 1-2 minutos.');

    // Único punto de log de volumen real: cada vez que se llega aquí, se va
    // a invocar a Claude sí o sí (con éxito o no). Sin esto no hay forma de
    // saber desde Actions cuántas veces se llamó a la API por día.
    console.log(`[${site.key}] Procesando: ${url}`);

    try {
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
        seccionNombre,
        internalLink: siteUrl + site.internalLinkPath(article.seccion_slug),
        siteName: site.nombre,
      });

      // 8. Create and publish post — espaciado automático si hay cola (ver createPost)
      const { url: postUrl, status: postStatus, scheduledFor } = await wp.createPost({
        ...article,
        html: finalHtml,
        mediaId: media.id,
        deporteId,
        categoryId,
        tagIds,
      });

      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      console.log(`[${site.key}] OK (${postStatus}): ${postUrl}`);
      const tagsInfo = tagIds.length ? ` · ${tagIds.length} etiquetas` : '';
      if (postStatus === 'publish') {
        await ctx.reply(`Noticia publicada exitosamente (${seccionNombre}${tagsInfo}):\n${postUrl}`);
      } else if (postStatus === 'future') {
        const hora = scheduledFor.toLocaleTimeString('es-DO', { timeZone: 'America/Santo_Domingo', hour: '2-digit', minute: '2-digit' });
        await ctx.reply(
          `Noticia programada para las ${hora} (${seccionNombre}${tagsInfo}) — para no amontonar publicaciones seguidas:\n${postUrl}`
        );
      } else {
        await ctx.reply(
          `La noticia se guardó como borrador (WordPress rechazó la publicación directa):\n${postUrl}\n\n` +
          `Revísala y publícala desde wp-admin. Si esto pasa siempre, verifica el rol del usuario y los campos requeridos del post.`
        );
      }
    } catch (err) {
      console.error(`[${site.key}] Error procesando ${url}:`, err.message);
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      // El 415 con HTML de openresty es el WAF del hosting (Imunify360)
      // bloqueando la IP de ESTA sesión del runner — no un error del
      // contenido. El preflight del workflow filtra las IPs bloqueadas al
      // arrancar, pero la lista gris puede alcanzar una IP a mitad de las
      // ~5h de sesión. El mensaje crudo (HTML del WAF) no le dice nada al
      // usuario; esto sí.
      if (/error 415/.test(err.message) && /openresty/i.test(err.message)) {
        await ctx.reply(
          'El firewall del hosting bloqueó la IP de esta sesión del bot (error 415 del WAF).\n\n' +
          'No es un problema de la noticia. El bot se reinicia solo con otra IP en unas horas, ' +
          'o puedes reiniciarlo ya desde GitHub: Actions → Telegram News Bot → Run workflow. ' +
          'Después reenvía la noticia (URL + foto).'
        );
      } else {
        await ctx.reply(`Error al procesar la noticia:\n${err.message}`);
      }
    } finally {
      session.state = 'IDLE';
      session.url = null;
    }
  }

  // Intenta leer la URL automáticamente. Si el sitio no sirve contenido
  // estático (ej. DAZN, apps 100% en React) o bloquea el scraping, en vez
  // de fallar le pide al usuario que pegue el texto del artículo a mano.
  async function processArticle(ctx, url, photoFileId) {
    const userId = String(ctx.from.id);
    const session = getSession(userId);

    let title, text;
    try {
      ({ title, text } = await scrapeArticle(url));
    } catch (err) {
      session.state = 'WAITING_TEXT_FALLBACK';
      session.pendingUrl = url;
      session.pendingPhotoFileId = photoFileId;
      await ctx.reply(
        `No pude leer ese artículo automáticamente (${err.message}).\n\n` +
        `Copia y pega aquí el texto completo de la noticia y continúo con eso. O /cancelar.`
      );
      return;
    }

    await processArticleCore(ctx, { url, title, text, photoFileId });
  }

  // Auth middleware
  bot.use((ctx, next) => {
    if (!isAllowed(ctx)) return ctx.reply('No autorizado.');
    return next();
  });

  bot.command('start', ctx => {
    const session = getSession(String(ctx.from.id));
    session.state = 'IDLE';
    session.url = null;
    session.pendingUrl = null;
    session.pendingPhotoFileId = null;
    ctx.reply(
      `Bienvenido al bot de noticias de ${site.nombre}.\n\n` +
      'Uso:\n' +
      '1. Envia /noticia [URL] o simplemente pega una URL\n' +
      '2. Luego envia la foto para la noticia\n' +
      '   (o envia la foto con la URL en el caption)\n\n' +
      `Si envías varias noticias seguidas, la primera se publica de inmediato y las siguientes se programan automáticamente (mínimo ${site.publishSpacingMinutes} min entre sí) para no amontonar publicaciones en el mismo horario.\n\n` +
      '/tendencias — qué está sonando ahora en RD (Twitter/X + Google)\n' +
      '/cancelar — cancela la operacion actual'
    );
  });

  bot.command('cancelar', ctx => {
    const session = getSession(String(ctx.from.id));
    session.state = 'IDLE';
    session.url = null;
    ctx.reply('Operacion cancelada.');
  });

  bot.command('tendencias', async ctx => {
    const status = await ctx.reply('Buscando tendencias en RD (Twitter/X + Google)...');
    try {
      const { topics, twitterOk, googleOk } = await getTrendingBrief();
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});

      if (!topics.length) {
        return ctx.reply('No se pudieron obtener tendencias ahora mismo. Intenta de nuevo en unos minutos.');
      }

      const lines = topics.map((t, i) => {
        const cruzado = t.crossed ? ' — también suena en Twitter/X' : '';
        const trafico = t.traffic ? ` (${t.traffic} búsquedas)` : '';
        return `${i + 1}. ${t.title}${trafico}${cruzado}`;
      });

      const avisos = [];
      if (!twitterOk) avisos.push('Twitter/X no respondió esta vez');
      if (!googleOk) avisos.push('Google Trends no respondió esta vez');

      await ctx.reply(
        `Tendencias en RD ahora mismo:\n\n${lines.join('\n')}\n\n` +
        `Los marcados "también suena en Twitter/X" tienen doble señal: se buscan y se comentan al mismo tiempo — prioridad alta.\n\n` +
        `Envía la URL de un artículo sobre alguno de estos temas para redactarlo.` +
        (avisos.length ? `\n\n(${avisos.join('; ')}.)` : '')
      );
    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
      await ctx.reply(`Error al buscar tendencias:\n${err.message}`);
    }
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

  // Handle plain text messages — detect URLs, o texto pegado a mano si el
  // scraping automático falló (ver processArticle)
  bot.on('text', ctx => {
    const session = getSession(String(ctx.from.id));
    if (session.state === 'PROCESSING') return ctx.reply('Ya estoy procesando una noticia. Espera.');

    if (session.state === 'WAITING_TEXT_FALLBACK') {
      const pastedText = ctx.message.text.trim();
      // Si en vez del texto llega una URL, el usuario quiere empezar una
      // noticia nueva — salir del modo "pegar texto" y tratarla como URL.
      const fallbackUrl = pastedText.match(URL_REGEX)?.[0];
      if (fallbackUrl && pastedText.length < 300) {
        session.state = 'WAITING_PHOTO';
        session.url = fallbackUrl;
        session.pendingUrl = null;
        session.pendingPhotoFileId = null;
        return ctx.reply('URL guardada. Ahora envia la foto para la noticia.');
      }
      if (pastedText.length < 100) {
        return ctx.reply('Ese texto es muy corto para redactar el artículo. Pega el texto completo de la noticia que te pedí, o /cancelar. (Si quieres empezar con otra noticia, simplemente envía su URL.)');
      }
      const { pendingUrl, pendingPhotoFileId } = session;
      session.state = 'IDLE';
      processArticleCore(ctx, { url: pendingUrl, title: '', text: pastedText, photoFileId: pendingPhotoFileId });
      return;
    }

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
