import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { load } from 'cheerio';
import OpenAI from 'openai';
import PQueue from 'p-queue';
import pg from 'pg';
import { randomUUID } from "node:crypto";

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const app = express();
const port = Number(process.env.PORT ?? 8787);
const isNetlifyRuntime = process.env.NETLIFY === 'true' || Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const { Pool } = pg;
const dbUrl = process.env.SUPABASE_DB_URL;
const pool = dbUrl
  ? new Pool({
      connectionString: dbUrl,
      ssl: {
        rejectUnauthorized: false,
      },
    })
  : null;

const sourceCompany = 'Extia';
const newsSources = [
  { name: 'Alten', url: 'https://www.alten.fr/news-evenements-alten-france/#evenements' },
  { name: 'Aubay', url: 'https://blog.aubay.com/' },
  { name: 'Astek', url: 'https://astekgroup.fr/category/actualites/' },
  { name: 'Devoteam', url: 'https://www.devoteam.com/fr/news-and-pr/' },
  {
    name: 'Inetum',
    url: 'https://www.inetum.com/fr/accueil/nous-connaitre/media-center.html?list-7b6871c90a_page=1',
  },
  { name: 'Neosoft', url: 'https://www.neosoft.fr/nos-publications/blog-tech/' },
  { name: 'Open', url: 'https://www.open.global/publication_Open_blog' },
  { name: 'SII', url: 'https://sii-group.com/fr-FR' },
  { name: 'Sopra Steria', url: 'https://www.soprasteria.fr/espace-media' },
  { name: 'Wavestone', url: 'https://www.wavestone.com/fr/' },
];
const REQUEST_TIMEOUT_MS = 25000;
const MAX_BRIEF_POINTS = 5;
const IMPORTANT_SCORE_THRESHOLD = Number(process.env.IMPORTANT_SCORE_THRESHOLD ?? 50);
const SIDE_PANEL_TOP_LIMIT = 8;
const SIDE_PANEL_HISTORY_LIMIT = 60;
const runStatus = {
  isRunning: false,
  mode: null,
  startedAt: null,
  steps: [],
};
const runQueue = new PQueue({ concurrency: 1 });
const runJobs = new Map();

app.use(cors());
app.use(express.json());

const fallbackReport = () => ({
  generatedAt: new Date().toISOString(),
  sourceCompany,
  strategicSummary: 'Mode local sans connexion Supabase active.',
  brief2Min: ['Aucune donnée exploitable pour le brief 2 minutes.'],
  sidePanel: {
    scoreThreshold: IMPORTANT_SCORE_THRESHOLD,
    topSignals: [],
    history: [],
  },
  sources: newsSources.map((item) => ({
    sourceName: item.name,
    sourceUrl: item.url,
    latestTitle: 'N/A',
    latestUrl: item.url,
    latestPublishedAt: null,
    lastRunMode: 'manual',
    lastSeenAt: new Date().toISOString(),
    isNew: false,
    summary: '• Aucune donnée stockée.',
    detailedSummary: 'Aucune synthèse détaillée disponible.',
    keyFigures: [],
    hallucinationCheck: 'N/A',
    relevance: 'low',
    relevanceScore: 0,
    relevanceReason: 'Pas de donnees disponibles.',
    relevanceExplain: {
      positiveSignals: [],
      negativeSignals: ['Données absentes'],
      evidence: [],
    },
  })),
});

const normalizeText = (value) => value.replace(/\s+/g, ' ').trim();
const sanitizeCompetitiveWording = (value) =>
  normalizeText(
    String(value || '')
      .replace(/\bvis[-\s]*[àa]\s+vis\s+d['’]extia\b/gi, 'dans le contexte concurrentiel')
      .replace(/\bpar rapport [àa]\s+extia\b/gi, 'par rapport au contexte concurrentiel')
      .replace(/\bpour\s+extia\b/gi, 'pour l entreprise cible')
      .replace(/\bextia\b/gi, "l'entreprise cible"),
  );

const sanitizeExplain = (value) => {
  const explain = value && typeof value === 'object' ? value : {};
  const toList = (input) =>
    (Array.isArray(input) ? input : [])
      .map((item) => normalizeText(String(item || '')))
      .filter(Boolean)
      .slice(0, 4);
  return {
    positiveSignals: toList(explain.positive_signals || explain.positiveSignals),
    negativeSignals: toList(explain.negative_signals || explain.negativeSignals),
    evidence: toList(explain.evidence),
  };
};

const absoluteUrl = (baseUrl, maybeUrl) => {
  if (!maybeUrl) return baseUrl;
  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return baseUrl;
  }
};

const generateSummary = async (payload) => {
  const levelFromScore = (score) => {
    if (score >= 70) return 'high';
    if (score >= 45) return 'medium';
    return 'low';
  };
  const normalizeScore = (value) => {
    const n = Number(value);
    if (Number.isNaN(n)) return null;
    return Math.max(0, Math.min(100, Math.round(n)));
  };

  const lowerTitle = payload.title.toLowerCase();
  const blocked = ['aller au contenu principal', 'intelligence artificielle', 'news', 'actualites'];
  if (blocked.includes(lowerTitle) || payload.url === payload.sourceUrl) {
    const relevanceScore = 8;
    return {
      summary: '• Titre trop générique détecté.\n• Vérifie la source ou affine les sélecteurs de scraping.',
      detailedSummary:
        'Le contenu détecté ne correspond pas à un article exploitable. Le système recommande de vérifier la source ou les sélecteurs de scraping.',
      keyFigures: [],
      hallucinationCheck: 'weak: contenu source insuffisant',
      relevance: levelFromScore(relevanceScore),
      relevanceScore,
      relevanceReason: 'Source trop générique: faible valeur concurrentielle exploitable pour Extia.',
      relevanceExplain: {
        positiveSignals: [],
        negativeSignals: ['Titre ou URL trop générique'],
        evidence: [],
      },
    };
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    const relevanceScore = 15;
    return {
      summary: '• Résumé IA indisponible.\n• OPENAI_API_KEY absent.\n• Vérification manuelle recommandée.',
      detailedSummary:
        'Le service IA est indisponible car OPENAI_API_KEY est absent. Aucun enrichissement automatique n’a pu être produit.',
      keyFigures: [],
      hallucinationCheck: 'weak: IA indisponible',
      relevance: levelFromScore(relevanceScore),
      relevanceScore,
      relevanceReason: 'Score provisoire faute de scoring IA (OPENAI_API_KEY absent).',
      relevanceExplain: {
        positiveSignals: [],
        negativeSignals: ['Scoring IA indisponible'],
        evidence: [],
      },
    };
  }

  const client = new OpenAI({ apiKey: key });
  const draftResponse = await client.responses.create({
    model: 'gpt-4.1-mini',
    input: `Tu es analyste veille business.
Tu dois te baser UNIQUEMENT sur les informations ci-dessous.
Objectif unique: scorer la pertinence strategique de cette info pour une equipe strategie business.
Question a trancher: "Cette information concurrente est-elle importante a connaitre pour orienter la strategie ?"
Réponds UNIQUEMENT en JSON valide avec ce format:
{
  "bullets": ["", "", ""],
  "detailed_summary": "",
  "key_figures": [""],
  "relevance_score": 0,
  "relevance_reason": "",
  "relevance_explain": {
    "positive_signals": [""],
    "negative_signals": [""],
    "evidence": [""]
  }
}

Règles:
- bullets: 2 à 4 bullets max, factuels, sans blabla
- si des chiffres pertinents existent dans la source, intègre-les directement dans les bullets
- detailed_summary: 4 à 6 lignes max
- key_figures: 3 à 8 éléments MAX, chaque élément doit EXPLIQUER le chiffre (format "92% : management perçu comme éthique")
- relevance_score: score 0-100 de pertinence strategique business (pas un score de qualite redactionnelle)
- relevance_reason: 1 phrase courte: pourquoi c'est important (ou pas) pour orienter la strategie business
- relevance_explain: mini-rubrique structurée avec:
  * positive_signals: 1-3 signaux strategiques (ce qui justifie de suivre l'info)
  * negative_signals: 1-3 limites (ce qui reduit la valeur strategique)
  * evidence: 1-3 preuves factuelles provenant de l'article
- Barème strict pour relevance_score:
  * 0-20: bruit / communication generique sans valeur strategie
  * 21-40: faible interet, peu decisionnel
  * 41-60: utile a surveiller, impact possible
  * 61-80: important pour ajuster priorites/offres/positionnement
  * 81-100: critique pour la strategie (mouvement majeur, contrat structurant, acquisition, rupture)
- IMPORTANT: ne donne PAS un score élevé à un simple article intéressant.
- Un article purement thought leadership / expertise générale ("cloud, data, IA, cybersécurité") doit rester <= 35.
- Les signaux RH, labels employeur, RSE doivent rester <= 40 sauf preuve d'impact business concurrentiel direct.
- Ne mentionne pas explicitement "Extia" dans la sortie, sauf si c'est une citation directe de l'article.
- n'invente rien

Source: ${payload.sourceName}
Titre: ${payload.title}
URL: ${payload.url}
Date: ${payload.publishedAt ?? 'non disponible'}
Extrait article: ${payload.articleContext || 'non disponible'}
Chiffres extraits automatiquement: ${(payload.figureInsights || []).join(' | ') || 'non disponible'}`,
  });

  const draftRaw = draftResponse.output_text?.trim() || '{}';
  const parseJsonBlock = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        try {
          return JSON.parse(raw.slice(start, end + 1));
        } catch {
          return null;
        }
      }
      return null;
    }
  };
  let draft;
  const parsedDraft = parseJsonBlock(draftRaw);
  if (parsedDraft) {
    draft = parsedDraft;
  } else {
    draft = {
      bullets: ['Informations insuffisantes pour une synthèse fiable.'],
      detailed_summary: 'Le format de sortie IA était invalide; une vérification manuelle est recommandée.',
      key_figures: [],
    };
  }

  const verifyResponse = await client.responses.create({
    model: 'gpt-4.1-mini',
    input: `Tu es un vérificateur anti-hallucination.
Entrée 1 = extrait article source.
Entrée 2 = synthèse candidate.
Corrige la synthèse pour supprimer toute affirmation non supportée par l'extrait.
Recalcule relevance_score avec le barème strict donné, en évaluant UNIQUEMENT la pertinence strategique business a connaitre.
Réponds UNIQUEMENT en JSON valide:
{
  "bullets": [""],
  "detailed_summary": "",
  "key_figures": [""],
  "hallucination_check": "ok|weak + raison courte",
  "relevance_score": 0,
  "relevance_reason": "",
  "relevance_explain": {
    "positive_signals": [""],
    "negative_signals": [""],
    "evidence": [""]
  }
}

Rappel: "article intéressant" != "important pour la strategie business".
Ne mentionne pas explicitement "Extia" dans la sortie, sauf citation directe de l'article.
Si pas d'impact business concurrentiel explicite, le score doit rester bas.

Extrait source:
${payload.articleContext || 'non disponible'}
Chiffres extraits automatiquement:
${(payload.figureInsights || []).join(' | ') || 'non disponible'}

Synthèse candidate:
${JSON.stringify(draft)}`,
  });

  const verifyRaw = verifyResponse.output_text?.trim() || '{}';
  let verified;
  const parsedVerify = parseJsonBlock(verifyRaw);
  if (parsedVerify) {
    verified = parsedVerify;
  } else {
    verified = {
      bullets: Array.isArray(draft.bullets) ? draft.bullets : ['Synthèse à vérifier manuellement.'],
      detailed_summary:
        typeof draft.detailed_summary === 'string'
          ? draft.detailed_summary
          : 'Synthèse non vérifiée automatiquement.',
      key_figures: Array.isArray(draft.key_figures) ? draft.key_figures : [],
      hallucination_check: 'weak: vérification auto invalide',
      relevance_score:
        normalizeScore(draft.relevance_score) ?? (typeof draft.relevance === 'string' ? 45 : 35),
      relevance_reason:
        typeof draft.relevance_reason === 'string' && draft.relevance_reason
          ? draft.relevance_reason
          : 'Score à confirmer: sortie de vérification invalide.',
      relevance_explain: sanitizeExplain(draft.relevance_explain),
    };
  }

  const bullets = Array.isArray(verified.bullets) ? verified.bullets.filter(Boolean).slice(0, 4) : [];
  const relevanceScore = normalizeScore(verified.relevance_score) ?? 35;
  const explainSanitized = sanitizeExplain(verified.relevance_explain);
  return {
    summary: bullets.length ? bullets.map((b) => `• ${b}`).join('\n') : '• Synthèse indisponible.',
    detailedSummary:
      typeof verified.detailed_summary === 'string' && verified.detailed_summary
        ? verified.detailed_summary
        : 'Synthèse détaillée indisponible.',
    keyFigures: Array.isArray(verified.key_figures) ? verified.key_figures.slice(0, 8) : [],
    hallucinationCheck:
      typeof verified.hallucination_check === 'string' ? verified.hallucination_check : 'weak: non vérifié',
    relevance: levelFromScore(relevanceScore),
    relevanceScore,
    relevanceReason:
      typeof verified.relevance_reason === 'string' && verified.relevance_reason
        ? sanitizeCompetitiveWording(verified.relevance_reason)
        : 'Score IA calculé avec justification indisponible.',
    relevanceExplain: {
      positiveSignals: explainSanitized.positiveSignals.map(sanitizeCompetitiveWording),
      negativeSignals: explainSanitized.negativeSignals.map(sanitizeCompetitiveWording),
      evidence: explainSanitized.evidence.map(sanitizeCompetitiveWording),
    },
  };
};

const isUsefulTitle = (title) => {
  const t = title.toLowerCase();
  if (!title || title.length < 18 || title.length > 180) return false;
  const blacklist = [
    'aller au contenu principal',
    'en savoir plus',
    'contactez-nous',
    'nos expertises',
    'nos actualites',
    'découvrir',
    'decouvrir',
    'home',
    'français',
    'francais',
    'linkedin',
  ];
  return !blacklist.some((item) => t.includes(item));
};

const isUsefulLink = (url, sourceUrl) => {
  if (!url) return false;
  if (url === sourceUrl) return false;
  if (url.includes('#')) return false;
  return url.startsWith('http');
};

const parseLatestArticle = (sourceName, sourceUrl, html) => {
  const $ = load(html);
  const candidates = [];

  if (sourceName === 'Aubay') {
    $('article h2 a, .et_pb_post .entry-title a, .post-content h2 a').each((_, el) => {
      const title = normalizeText($(el).text());
      const url = absoluteUrl(sourceUrl, $(el).attr('href'));
      if (isUsefulTitle(title) && isUsefulLink(url, sourceUrl)) {
        candidates.push({ title, url });
      }
    });
  } else if (sourceName === 'Astek') {
    $('a[href]').each((_, el) => {
      const title = normalizeText($(el).text());
      const url = absoluteUrl(sourceUrl, $(el).attr('href'));
      if (isUsefulTitle(title) && isUsefulLink(url, sourceUrl)) {
        candidates.push({ title, url });
      }
    });
  } else if (sourceName === 'Inetum') {
    $('.cmp-list .cmp-teaser a[href*="/media-center/communique-de-presse/"], .cmp-list .cmp-teaser a[href*="/media-center/press-release/"], a[href*="/media-center/communique-de-presse/"], a[href*="/media-center/press-release/"]').each((_, el) => {
      const anchorTitle = normalizeText($(el).text());
      const url = absoluteUrl(sourceUrl, $(el).attr('href'));
      const title = isUsefulTitle(anchorTitle) ? anchorTitle : titleFromUrl(url);
      if (isUsefulTitle(title) && isUsefulLink(url, sourceUrl)) {
        candidates.push({ title, url });
      }
    });
  } else if (sourceName === 'Sopra Steria') {
    $('a[href*="/espace-media/communiques/details/"]').each((_, el) => {
      const anchorText = normalizeText($(el).text());
      const cardTitle = normalizeText(
        $(el).closest('article, li, div').find('h2, h3, h4').first().text(),
      );
      const title = isUsefulTitle(anchorText) ? anchorText : cardTitle;
      const url = absoluteUrl(sourceUrl, $(el).attr('href'));
      if (isUsefulTitle(title) && isUsefulLink(url, sourceUrl)) {
        candidates.push({ title, url });
      }
    });
  } else if (
    sourceName === 'Sopra Steria' ||
    sourceName === 'SII' ||
    sourceName === 'Inetum' ||
    sourceName === 'Open' ||
    sourceName === 'Neosoft'
  ) {
    const blockedPathFragments = [
      '/services',
      '/secteurs',
      '/carrieres',
      '/nous-connaitre',
      '/group',
      '/groupe',
      '/investors',
      '/investisseurs',
      '/contact',
      '/politique',
      '/conditions',
      '/plan-du-site',
      '/cookies',
      '/privacy',
    ];
    $('main a[href], article a[href], .news a[href], .card a[href]').each((_, el) => {
      const href = $(el).attr('href');
      const url = absoluteUrl(sourceUrl, href);
      if (!isUsefulLink(url, sourceUrl)) {
        return;
      }
      const loweredUrl = url.toLowerCase();
      if (blockedPathFragments.some((fragment) => loweredUrl.includes(fragment))) {
        return;
      }

      const anchorText = normalizeText($(el).text());
      const cardTitle = normalizeText(
        $(el).closest('article, li, div').find('h2, h3, h4').first().text(),
      );
      const title = isUsefulTitle(anchorText) ? anchorText : cardTitle;

      if (sourceName === 'Inetum') {
        const looksLikePressRelease =
          loweredUrl.includes('/media-center/communique-de-presse/') ||
          loweredUrl.includes('/media-center/press-release/');
        if (!looksLikePressRelease) {
          return;
        }
      }
      if (sourceName === 'Open' && !loweredUrl.includes('/publications/')) {
        return;
      }
      if (sourceName === 'Sopra Steria' && !loweredUrl.includes('/espace-media/communiques/details/')) {
        return;
      }
      if (sourceName === 'SII') {
        const blockedSii = [
          '/offers',
          '/mentions-legales',
          '/donnees-personnelles',
          '/sii-en-bref',
          '/sii-dans-le-monde',
          '/press',
          '/finance',
          '/offres',
          '/apply',
        ];
        if (blockedSii.some((part) => loweredUrl.includes(part))) {
          return;
        }
        if (!loweredUrl.includes('/fr-fr/')) {
          return;
        }
      }

      if (isUsefulTitle(title)) {
        candidates.push({ title, url });
      }
    });
  } else if (sourceName === 'Wavestone') {
    $('a[href*="/fr/news/"]').each((_, el) => {
      const href = $(el).attr('href');
      const url = absoluteUrl(sourceUrl, href);

      // Anchor text is often "En savoir plus" on Wavestone cards.
      const anchorText = normalizeText($(el).text());
      const fallbackCardTitle = normalizeText(
        $(el).closest('article, li, div').find('h2, h3, h4').first().text(),
      );
      const ariaTitle = normalizeText($(el).attr('aria-label') || '');
      const title = ariaTitle || (anchorText.toLowerCase() === 'en savoir plus' ? fallbackCardTitle : anchorText);

      if (url === sourceUrl || url.includes('/page/')) {
        return;
      }

      if (isUsefulTitle(title) && isUsefulLink(url, sourceUrl)) {
        candidates.push({ title, url });
      }
    });

    // Secondary fallback: collect titles/links from cards directly.
    $('article, li, div').each((_, el) => {
      const cardTitle = normalizeText($(el).find('h2, h3, h4').first().text());
      const href = $(el).find('a[href*="/fr/news/"]').first().attr('href');
      const url = absoluteUrl(sourceUrl, href);
      if (url === sourceUrl || url.includes('/page/')) {
        return;
      }
      if (isUsefulTitle(cardTitle) && isUsefulLink(url, sourceUrl)) {
        candidates.push({ title: cardTitle, url });
      }
    });
  }

  const unique = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = `${item.title.toLowerCase()}|${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique[0] || { title: 'Aucun article exploitable détecté', url: sourceUrl };
};

const parseDevoteamFromMirror = (mirrorText, sourceUrl) => {
  const pattern = /##\s+\[([^\]]+)\]\((https:\/\/www\.devoteam\.com\/fr\/news-and-pr\/[^)]+)\)/g;
  const matches = [...mirrorText.matchAll(pattern)];
  for (const match of matches) {
    const title = normalizeText(match[1] || '');
    const url = absoluteUrl(sourceUrl, match[2] || '');
    if (isUsefulTitle(title) && isUsefulLink(url, sourceUrl)) {
      return { title, url };
    }
  }
  return { title: 'Aucun article exploitable détecté', url: sourceUrl };
};

const parseNeosoftFromMirror = (mirrorText, sourceUrl) => {
  const pattern = /https:\/\/www\.neosoft\.fr\/nos-publications\/blog-tech\/([a-z0-9-]+)\/?/gi;
  const matches = [...mirrorText.matchAll(pattern)];
  for (const match of matches) {
    const slug = (match[1] || '').toLowerCase();
    if (!slug || slug === 'blog-tech') continue;
    const url = `https://www.neosoft.fr/nos-publications/blog-tech/${slug}/`;
    const title = titleFromUrl(url);
    if (isUsefulTitle(title) && isUsefulLink(url, sourceUrl)) {
      return { title, url };
    }
  }
  return { title: 'Aucun article exploitable détecté', url: sourceUrl };
};

const parseInetumFromMirror = (mirrorText, sourceUrl) => {
  const pattern =
    /https:\/\/www\.inetum\.com\/fr\/accueil\/nous-connaitre\/media-center\/communique-de-presse\/([a-z0-9-]+)\.html/gi;
  const matches = [...mirrorText.matchAll(pattern)];
  for (const match of matches) {
    const slug = (match[1] || '').toLowerCase();
    if (!slug) continue;
    const url = `https://www.inetum.com/fr/accueil/nous-connaitre/media-center/communique-de-presse/${slug}.html`;
    const title = titleFromUrl(url);
    if (isUsefulTitle(title) && isUsefulLink(url, sourceUrl)) {
      return { title, url };
    }
  }
  return { title: 'Aucun article exploitable détecté', url: sourceUrl };
};

const titleFromUrl = (url) => {
  try {
    const pathname = new URL(url).pathname;
    const slug = pathname.split('/').filter(Boolean).pop() || '';
    if (!slug) return 'Article récent';
    return slug
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (m) => m.toUpperCase());
  } catch {
    return 'Article récent';
  }
};

const parseWavestoneFromMirror = (mirrorText, sourceUrl) => {
  // Prioritize the dedicated "latest news" block, ignore top navigation/hero links.
  const sectionStartMarkers = [
    'Aucun résultat n’a été trouvé ? Vous pouvez toujours consulter nos 3 dernières nouvelles :',
    '## Nos dernières informations',
    '##  Dernières _actualités_',
  ];
  let newsSection = mirrorText;
  for (const marker of sectionStartMarkers) {
    const idx = mirrorText.indexOf(marker);
    if (idx !== -1) {
      newsSection = mirrorText.slice(idx);
      break;
    }
  }

  const lines = newsSection.split('\n');
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    const linkMatch = line.match(/\[(?:En savoir plus)\]\((https:\/\/www\.wavestone\.com\/fr\/news\/[^)]+)\)/i);
    if (linkMatch) {
      const url = absoluteUrl(sourceUrl, linkMatch[1]);
      let guessedTitle = '';
      for (let back = 1; back <= 8; back += 1) {
        const candidate = normalizeText((lines[i - back] || '').replace(/^[-*#]\s*/, ''));
        if (!candidate) continue;
        const lowered = candidate.toLowerCase();
        if (
          lowered === 'news' ||
          lowered === 'france' ||
          lowered === 'europe' ||
          lowered.startsWith('image ') ||
          lowered.startsWith('en savoir plus') ||
          /^\d{1,2}\s+\w+\s+20\d{2}$/i.test(candidate)
        ) {
          continue;
        }
        guessedTitle = candidate;
        break;
      }
      const title = isUsefulTitle(guessedTitle) ? guessedTitle : titleFromUrl(url);
      entries.push({ title, url });
    }
  }

  if (entries.length > 0) {
    return entries[0];
  }

  const fallbackPattern = /\[([^\]]*)\]\((https:\/\/www\.wavestone\.com\/fr\/news\/[^)]+)\)/g;
  const fallbackMatches = [...mirrorText.matchAll(fallbackPattern)];
  for (const match of fallbackMatches) {
    const rawTitle = normalizeText(match[1] || '');
    const url = absoluteUrl(sourceUrl, match[2] || '');
    const title = rawTitle && rawTitle.toLowerCase() !== 'en savoir plus' ? rawTitle : titleFromUrl(url);
    if (isUsefulTitle(title) && isUsefulLink(url, sourceUrl)) {
      return { title, url };
    }
  }
  return { title: 'Aucun article exploitable détecté', url: sourceUrl };
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const fetchWithRetry = async (url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS, attempts = 2) => {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchWithTimeout(url, options, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('fetch retry failed');
};

const pushStep = (message) => {
  runStatus.steps.push(
    `${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} - ${message}`,
  );
  if (runStatus.steps.length > 40) {
    runStatus.steps = runStatus.steps.slice(-40);
  }
};

const fetchLatestFromSource = async (source) => {
  if (source.name === 'Devoteam' || source.name === 'Wavestone' || source.name === 'Neosoft') {
    pushStep(`Collecte miroir ${source.name}`);
    const mirrorResponse = await fetchWithRetry(
      `https://r.jina.ai/http://${source.url.replace(/^https?:\/\//, '')}`,
      {
        headers: { 'user-agent': 'Extia-Radar/1.0' },
      },
      40000,
      3,
    );
    const mirrorText = await mirrorResponse.text();
    const latest =
      source.name === 'Devoteam'
        ? parseDevoteamFromMirror(mirrorText, source.url)
        : source.name === 'Neosoft'
          ? parseNeosoftFromMirror(mirrorText, source.url)
          : parseWavestoneFromMirror(mirrorText, source.url);
    return {
      ...latest,
      sourceName: source.name,
      sourceUrl: source.url,
      publishedAt: null,
    };
  }

  const response = await fetchWithRetry(source.url, {
    headers: {
      'user-agent': 'Extia-Radar/1.0',
      accept: 'text/html',
    },
  }, REQUEST_TIMEOUT_MS, 2);
  const html = await response.text();
  let latest = parseLatestArticle(source.name, source.url, html);

  if (
    source.name === 'Inetum' &&
    (latest.url === source.url || latest.title.toLowerCase().includes('aucun article exploitable'))
  ) {
    pushStep('Fallback miroir Inetum');
    const mirrorResponse = await fetchWithRetry(
      `https://r.jina.ai/http://${source.url.replace(/^https?:\/\//, '')}`,
      { headers: { 'user-agent': 'Extia-Radar/1.0' } },
      40000,
      3,
    );
    const mirrorText = await mirrorResponse.text();
    latest = parseInetumFromMirror(mirrorText, source.url);
  }

  return {
    ...latest,
    sourceName: source.name,
    sourceUrl: source.url,
    publishedAt: null,
  };
};

const fetchArticleContext = async (articleUrl) => {
  try {
    const mirrorResponse = await fetchWithRetry(
      `https://r.jina.ai/http://${articleUrl.replace(/^https?:\/\//, '')}`,
      {
        headers: { 'user-agent': 'Extia-Radar/1.0' },
      },
      40000,
      3,
    );
    const text = await mirrorResponse.text();
    const lines = text
      .split('\n')
      .map((line) => normalizeText(line))
      .filter((line) => line && line.length > 40);
    const useful = lines
      .filter(
        (line) =>
          !line.toLowerCase().includes('mentions légales') &&
          !line.toLowerCase().includes('politique de cookies') &&
          !line.toLowerCase().includes('contactez-nous') &&
          !line.toLowerCase().includes('vous souhaitez échanger'),
      )
      .slice(0, 14)
      .join(' ');
    return useful.slice(0, 1800);
  } catch {
    return '';
  }
};

const extractKeyFiguresFromText = (text) => {
  if (!text) return [];
  const candidates = new Set();

  const patterns = [/\b\d{1,3}\s?%/g, /\b20\d{2}\b/g];

  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    for (const raw of matches) {
      const value = normalizeText(raw);
      if (!value) continue;
      if (/^\d$/.test(value)) continue;
      candidates.add(value);
    }
  }

  return [...candidates].slice(0, 12);
};

const extractFigureInsightsFromText = (text) => {
  if (!text) return [];
  const lines = text
    .split('\n')
    .map((line) => normalizeText(line))
    .filter(Boolean);

  const picked = [];
  for (const line of lines) {
    if (!/\d{1,3}\s?%/.test(line)) continue;
    const lowered = line.toLowerCase();
    if (
      lowered.includes('cookies') ||
      lowered.includes('politique') ||
      lowered.includes('contact') ||
      lowered.includes('mentions légales')
    ) {
      continue;
    }
    picked.push(line);
  }

  return [...new Set(picked)].slice(0, 8);
};

const filterRelevantFigures = (figures) => {
  const sanitizeFigure = (value) => {
    const cleaned = normalizeText(String(value || ''))
      // Remove markdown links and raw URLs
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      // Remove noisy separators often returned by model
      .replace(/[|[\]{}<>]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return cleaned;
  };

  const cleaned = (figures || [])
    .map((value) => sanitizeFigure(value))
    .filter(Boolean)
    .filter((value) => value.length <= 140)
    .filter((value) => /\d/.test(value))
    .filter(
      (value) =>
        !value.toLowerCase().includes('facebook') &&
        !value.toLowerCase().includes('linkedin') &&
        !value.toLowerCase().includes('twitter') &&
        !value.toLowerCase().includes('youtube'),
    )
    .filter(
      (value) =>
        value.includes('%') ||
        /:\s*\d{1,3}\s?%/.test(value) ||
        /\b\d{1,3}(?:[.,]\d+)?\s?(m€|k€|€|m\$|k\$|\$|milliards?|millions?)\b/i.test(value),
    )
    .filter((value) => !/^(20|03|04|05|06|07|08|09|10)$/.test(value));
  return [...new Set(cleaned)].slice(0, 8);
};

const fetchArticleRawText = async (articleUrl) => {
  try {
    const mirrorResponse = await fetchWithRetry(
      `https://r.jina.ai/http://${articleUrl.replace(/^https?:\/\//, '')}`,
      { headers: { 'user-agent': 'Extia-Radar/1.0' } },
      40000,
      3,
    );
    return await mirrorResponse.text();
  } catch {
    return '';
  }
};

const ensureDb = async () => {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitored_sources (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS source_articles (
      id BIGSERIAL PRIMARY KEY,
      source_id BIGINT NOT NULL REFERENCES monitored_sources(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      article_url TEXT NOT NULL,
      published_at TIMESTAMPTZ NULL,
      summary TEXT NOT NULL,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source_id, title)
    );
  `);

  await pool.query(`
    ALTER TABLE source_articles
    ADD COLUMN IF NOT EXISTS detailed_summary TEXT NOT NULL DEFAULT '';
  `);
  await pool.query(`
    ALTER TABLE source_articles
    ADD COLUMN IF NOT EXISTS key_figures JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);
  await pool.query(`
    ALTER TABLE source_articles
    ADD COLUMN IF NOT EXISTS hallucination_check TEXT NOT NULL DEFAULT 'N/A';
  `);
  await pool.query(`
    ALTER TABLE source_articles
    ADD COLUMN IF NOT EXISTS relevance TEXT NOT NULL DEFAULT 'low';
  `);
  await pool.query(`
    ALTER TABLE source_articles
    ADD COLUMN IF NOT EXISTS relevance_score INTEGER NOT NULL DEFAULT 0;
  `);
  await pool.query(`
    ALTER TABLE source_articles
    ADD COLUMN IF NOT EXISTS relevance_reason TEXT NOT NULL DEFAULT '';
  `);
  await pool.query(`
    ALTER TABLE source_articles
    ADD COLUMN IF NOT EXISTS relevance_explain JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitor_runs (
      id BIGSERIAL PRIMARY KEY,
      mode TEXT NOT NULL,
      strategic_summary TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE source_articles
    DROP CONSTRAINT IF EXISTS source_articles_source_id_title_key;
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_source_articles_source_url
    ON source_articles(source_id, article_url);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_source_articles_relevance_score
    ON source_articles(relevance_score DESC);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_source_articles_last_seen_at
    ON source_articles(last_seen_at DESC);
  `);

  for (const source of newsSources) {
    await pool.query(
      `INSERT INTO monitored_sources(name, url) VALUES($1, $2)
       ON CONFLICT(name) DO UPDATE SET url = EXCLUDED.url`,
      [source.name, source.url],
    );
  }
};

const buildSidePanelDataFromRows = (rows) => {
  const withScore = rows.map((row) => ({
    sourceName: row.sourceName || 'Source',
    title: row.latestTitle || 'Sans titre',
    url: row.latestUrl || '#',
    publishedAt: row.latestPublishedAt || null,
    lastSeenAt: row.lastSeenAt || null,
    relevanceScore: Number.isFinite(Number(row.relevanceScore)) ? Math.max(0, Math.min(100, Number(row.relevanceScore))) : 0,
  }));

  const topSignals = withScore
    .filter((item) => item.title !== 'Source indisponible' && item.relevanceScore >= IMPORTANT_SCORE_THRESHOLD)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, SIDE_PANEL_TOP_LIMIT);

  const seen = new Set();
  const history = withScore
    .sort((a, b) => new Date(b.lastSeenAt || 0).getTime() - new Date(a.lastSeenAt || 0).getTime())
    .filter((item) => {
      const key = `${item.sourceName}::${item.url}`;
      if (!item.url || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, SIDE_PANEL_HISTORY_LIMIT);

  return {
    scoreThreshold: IMPORTANT_SCORE_THRESHOLD,
    topSignals,
    history,
  };
};

const readSidePanelHistoryFromDb = async () => {
  if (!pool) {
    return { scoreThreshold: IMPORTANT_SCORE_THRESHOLD, topSignals: [], history: [] };
  }

  const result = await pool.query(
    `
      WITH ranked AS (
        SELECT
          s.name as source_name,
          a.title,
          a.article_url,
          a.published_at,
          a.last_seen_at,
          a.relevance_score,
          ROW_NUMBER() OVER (
            PARTITION BY s.name, a.article_url
            ORDER BY a.last_seen_at DESC, a.id DESC
          ) as rn
        FROM source_articles a
        JOIN monitored_sources s ON s.id = a.source_id
      )
      SELECT source_name, title, article_url, published_at, last_seen_at, relevance_score
      FROM ranked
      WHERE rn = 1
      ORDER BY last_seen_at DESC
      LIMIT $1
    `,
    [SIDE_PANEL_HISTORY_LIMIT],
  );

  const mapped = result.rows.map((row) => ({
    sourceName: row.source_name,
    latestTitle: row.title,
    latestUrl: row.article_url,
    latestPublishedAt: row.published_at,
    lastSeenAt: row.last_seen_at,
    relevanceScore: Number.isFinite(Number(row.relevance_score)) ? Number(row.relevance_score) : 0,
  }));

  return buildSidePanelDataFromRows(mapped);
};

const buildRunSummary = (rows, mode) => {
  const detected = rows.filter((row) => row.isNew).length;
  if (mode === 'test') {
    return `Mode test exécuté : ${rows.length} source(s) vérifiée(s), sans détection de nouveauté.`;
  }
  return `Run manuel exécuté : ${detected} nouvel(le)(s) article(s) détecté(s) sur ${rows.length} source(s).`;
};

const buildBrief2Min = (rows) => {
  const cleanBullet = (summary) => {
    const line = String(summary || '')
      .split('\n')
      .find((item) => item.trim().startsWith('•'));
    return line ? normalizeText(line.replace(/^•\s*/, '')) : '';
  };

  const top = [...rows]
    .filter((row) => row.latestTitle && row.latestTitle !== 'Source indisponible')
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
    .slice(0, MAX_BRIEF_POINTS);

  if (!top.length) {
    return ['Aucun signal critique exploitable pour le moment.'];
  }

  return top.map((row) => {
    const bullet = cleanBullet(row.summary) || row.latestTitle;
    return `${row.sourceName} (${row.relevanceScore || 0}/100) : ${bullet}`;
  });
};

const runNewsMonitoring = async ({ testMode }) => {
  runStatus.isRunning = true;
  runStatus.mode = testMode ? 'test' : 'manual';
  runStatus.startedAt = new Date().toISOString();
  runStatus.steps = [];
  pushStep(`Démarrage du workflow (${runStatus.mode})`);

  if (!pool) {
    pushStep('Supabase non configuré, fallback local');
    runStatus.isRunning = false;
    return fallbackReport();
  }

  pushStep('Initialisation base de données');
  await ensureDb();
  const mode = testMode ? 'test' : 'manual';
  const processed = [];

  for (const source of newsSources) {
    try {
      pushStep(`Scraping ${source.name}`);
      const latest = await fetchLatestFromSource(source);
      pushStep(`Article détecté pour ${source.name}: ${latest.title}`);
      const sourceResult = await pool.query('SELECT id FROM monitored_sources WHERE name = $1 LIMIT 1', [
        source.name,
      ]);
      const sourceId = sourceResult.rows[0]?.id;
      if (!sourceId) continue;

      const existing = await pool.query(
        `SELECT id, title, article_url
         FROM source_articles
         WHERE source_id = $1
           AND (
             article_url = $2
             OR title = $3
           )
         ORDER BY last_seen_at DESC
         LIMIT 1`,
        [sourceId, latest.url, latest.title],
      );

      const sameUrl = existing.rows[0]?.article_url === latest.url;
      const isNew = testMode ? false : !sameUrl;
      pushStep(`Lecture du contenu article ${source.name}`);
      const articleRawText = await fetchArticleRawText(latest.url);
      const articleContext = await fetchArticleContext(latest.url);
      pushStep(`Synthèse IA pour ${source.name}`);
      let articleFigures = extractKeyFiguresFromText(articleRawText);
      if (!articleFigures.length) {
        articleFigures = extractKeyFiguresFromText(articleContext);
      }
      const figureInsights = extractFigureInsightsFromText(articleRawText);
      const analysis = await generateSummary({
        sourceName: source.name,
        sourceUrl: source.url,
        title: latest.title,
        url: latest.url,
        publishedAt: latest.publishedAt,
        articleContext,
        figureInsights,
      });
      const aiFigures = filterRelevantFigures(analysis.keyFigures || []);
      const fallbackFigures = filterRelevantFigures(figureInsights.length ? figureInsights : articleFigures);
      const mergedKeyFigures = aiFigures.length > 0 ? aiFigures : fallbackFigures;

      if (existing.rowCount > 0) {
        await pool.query(
          `UPDATE source_articles
           SET title = $11, last_seen_at = NOW(), summary = $2, detailed_summary = $3, key_figures = $4, hallucination_check = $5, article_url = $6, relevance = $7, relevance_score = $8, relevance_reason = $9, relevance_explain = $10
           WHERE id = $1`,
          [
            existing.rows[0].id,
            analysis.summary,
            analysis.detailedSummary,
            JSON.stringify(mergedKeyFigures),
            analysis.hallucinationCheck,
            latest.url,
            analysis.relevance,
            analysis.relevanceScore,
            analysis.relevanceReason,
            JSON.stringify(analysis.relevanceExplain || {}),
            latest.title,
          ],
        );
      } else {
        await pool.query(
          `INSERT INTO source_articles(source_id, title, article_url, published_at, summary, detailed_summary, key_figures, hallucination_check, relevance, relevance_score, relevance_reason, relevance_explain)
           VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            sourceId,
            latest.title,
            latest.url,
            latest.publishedAt,
            analysis.summary,
            analysis.detailedSummary,
            JSON.stringify(mergedKeyFigures),
            analysis.hallucinationCheck,
            analysis.relevance,
            analysis.relevanceScore,
            analysis.relevanceReason,
            JSON.stringify(analysis.relevanceExplain || {}),
          ],
        );
      }

      processed.push({
        sourceName: source.name,
        sourceUrl: source.url,
        latestTitle: latest.title,
        latestUrl: latest.url,
        latestPublishedAt: latest.publishedAt,
        lastRunMode: mode,
        lastSeenAt: new Date().toISOString(),
        isNew,
        summary: analysis.summary,
        detailedSummary: analysis.detailedSummary,
        keyFigures: mergedKeyFigures,
        hallucinationCheck: analysis.hallucinationCheck,
        relevance: analysis.relevance,
        relevanceScore: analysis.relevanceScore,
        relevanceReason: analysis.relevanceReason,
        relevanceExplain: analysis.relevanceExplain,
      });
      pushStep(`Source ${source.name} terminée`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erreur inconnue';
      pushStep(`Erreur sur ${source.name}: ${message}`);
      processed.push({
        sourceName: source.name,
        sourceUrl: source.url,
        latestTitle: 'Source indisponible',
        latestUrl: source.url,
        latestPublishedAt: null,
        lastRunMode: mode,
        lastSeenAt: new Date().toISOString(),
        isNew: false,
        summary: `Erreur scraping: ${message}`,
        detailedSummary: `Erreur détaillée: ${message}`,
        keyFigures: [],
        hallucinationCheck: 'weak: scraping error',
        relevance: 'low',
        relevanceScore: 0,
        relevanceReason: 'Erreur de scraping: score non calculable.',
        relevanceExplain: {
          positiveSignals: [],
          negativeSignals: ['Erreur de scraping'],
          evidence: [],
        },
      });
    }
  }

  const strategicSummary = buildRunSummary(processed, mode);
  pushStep('Enregistrement du run en base');
  await pool.query('INSERT INTO monitor_runs(mode, strategic_summary) VALUES($1, $2)', [mode, strategicSummary]);
  pushStep('Workflow terminé');
  runStatus.isRunning = false;

  return {
    generatedAt: new Date().toISOString(),
    sourceCompany,
    strategicSummary,
    brief2Min: buildBrief2Min(processed),
    sidePanel: await readSidePanelHistoryFromDb(),
    sources: processed,
  };
};

const readDashboard = async () => {
  if (!pool) {
    return fallbackReport();
  }
  await ensureDb();

  const latestRun = await pool.query(
    'SELECT id, mode, strategic_summary, created_at FROM monitor_runs ORDER BY id DESC LIMIT 1',
  );

  const rows = await pool.query(`
    SELECT s.name as source_name, s.url as source_url, a.title, a.article_url, a.published_at, a.summary, a.detailed_summary, a.key_figures, a.hallucination_check, a.relevance, a.relevance_score, a.relevance_reason, a.relevance_explain, a.last_seen_at
    FROM monitored_sources s
    LEFT JOIN LATERAL (
      SELECT *
      FROM source_articles x
      WHERE x.source_id = s.id
      ORDER BY x.last_seen_at DESC
      LIMIT 1
    ) a ON true
    ORDER BY s.name ASC
  `);

  const mappedSources = rows.rows.map((row) => ({
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    latestTitle: row.title || 'Aucun article enregistré',
    latestUrl: row.article_url || row.source_url,
    latestPublishedAt: row.published_at,
    lastRunMode: latestRun.rows[0]?.mode || 'manual',
    lastSeenAt: row.last_seen_at || null,
    isNew: false,
    summary: row.summary || 'Pas de résumé disponible.',
    detailedSummary: row.detailed_summary || 'Pas de synthèse détaillée disponible.',
    keyFigures: Array.isArray(row.key_figures) ? row.key_figures : [],
    hallucinationCheck: row.hallucination_check || 'N/A',
    relevance: row.relevance || 'low',
    relevanceScore: Number.isFinite(Number(row.relevance_score)) ? Number(row.relevance_score) : 0,
    relevanceReason: row.relevance_reason || 'Aucune justification disponible.',
    relevanceExplain: sanitizeExplain(row.relevance_explain),
  }));

  return {
    generatedAt: latestRun.rows[0]?.created_at || new Date().toISOString(),
    sourceCompany,
    strategicSummary: latestRun.rows[0]?.strategic_summary || 'Aucun run enregistré.',
    brief2Min: buildBrief2Min(mappedSources),
    sidePanel: await readSidePanelHistoryFromDb(),
    sources: mappedSources,
  };
};

const enqueueRunJob = ({ mode, testMode }) => {
  const jobId = randomUUID();
  runJobs.set(jobId, {
    id: jobId,
    mode,
    status: 'queued',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    report: null,
  });

  runQueue
    .add(async () => {
      const job = runJobs.get(jobId);
      if (!job) return;
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      try {
        const report = await runNewsMonitoring({ testMode });
        job.status = 'completed';
        job.finishedAt = new Date().toISOString();
        job.report = report;
      } catch (error) {
        job.status = 'failed';
        job.finishedAt = new Date().toISOString();
        job.error = error instanceof Error ? error.message : 'Unknown error';
      }
    })
    .catch((error) => {
      const job = runJobs.get(jobId);
      if (!job) return;
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : 'Unknown queue error';
    });

  return jobId;
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/dashboard', async (_req, res) => {
  try {
    const report = await readDashboard();
    res.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

app.get('/api/run-status', (_req, res) => {
  res.json(runStatus);
});

app.get('/api/run-jobs/:id', (req, res) => {
  const job = runJobs.get(req.params.id);
  if (!job) {
    if (isNetlifyRuntime) {
      return res.status(404).json({
        error: 'Job not found',
        hint: 'En mode Netlify Functions, utilise la reponse directe de /api/run-analysis ou /api/run-test.',
      });
    }
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json(job);
});

app.post('/api/run-analysis', async (_req, res) => {
  if (isNetlifyRuntime) {
    try {
      const report = await runNewsMonitoring({ testMode: false });
      return res.status(200).json({ queued: false, status: 'completed', report });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return res.status(500).json({ error: message, status: 'failed' });
    }
  }
  const jobId = enqueueRunJob({ mode: 'manual', testMode: false });
  return res.status(202).json({ queued: true, jobId });
});

app.post('/api/cron/run', async (req, res) => {
  const secret = req.header('x-cron-secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (isNetlifyRuntime) {
    try {
      const report = await runNewsMonitoring({ testMode: false });
      return res.status(200).json({ ok: true, queued: false, status: 'completed', report });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return res.status(500).json({ ok: false, status: 'failed', error: message });
    }
  }

  const jobId = enqueueRunJob({ mode: 'manual', testMode: false });
  return res.status(202).json({ ok: true, queued: true, jobId });
});

app.post('/api/run-test', async (_req, res) => {
  if (isNetlifyRuntime) {
    try {
      const report = await runNewsMonitoring({ testMode: true });
      return res.status(200).json({ queued: false, status: 'completed', report });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return res.status(500).json({ error: message, status: 'failed' });
    }
  }
  const jobId = enqueueRunJob({ mode: 'test', testMode: true });
  return res.status(202).json({ queued: true, jobId });
});

export { app, runNewsMonitoring };

if (!isNetlifyRuntime) {
  app.listen(port, () => {
    console.log(`API server ready on http://localhost:${port}`);
  });
}
