// Configuración del sitio. La estructura soporta varios sitios por si algún
// día RDparty suma otra marca; hoy corre solo rdparty.com.

export const SITES = [
  {
    key: 'rdparty',
    nombre: 'RDparty',
    brand: 'RDparty',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    allowedUsers: process.env.TELEGRAM_ALLOWED_USERS || '',
    wpUrl: process.env.WORDPRESS_URL,
    wpUser: process.env.WORDPRESS_USERNAME,
    wpPass: process.env.WORDPRESS_APP_PASSWORD,
    seo: 'yoast',
    editorial:
      'Eres un redactor senior de RDparty.com, portal dominicano de entretenimiento y actualidad: farándula, música, ' +
      'conciertos, cine, eventos, economía y noticias generales. Reescribe artículos en español dominicano con estilo ' +
      'periodístico profesional, cercano y ágil.',
    usaTaxonomiaDeporte: false,
    internalLinkPath: slug => `/category/${slug}/`,
    // Si se procesan varias noticias seguidas, espacia sus publicaciones al
    // menos esto para no amontonar posts con el mismo timestamp en el home.
    publishSpacingMinutes: 20,
  },
].filter(s => s.telegramToken && s.wpUrl && s.wpUser && s.wpPass);
