import type { CSSProperties, ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Fragment } from 'react';
import {
  FiActivity,
  FiBell,
  FiCalendar,
  FiCheckSquare,
  FiChevronLeft,
  FiChevronRight,
  FiDatabase,
  FiExternalLink,
  FiEye,
  FiGrid,
  FiPlay,
  FiRefreshCw,
  FiSearch,
  FiSliders,
} from 'react-icons/fi';

type Report = {
  generatedAt: string;
  sourceCompany: string;
  brief2Min?: string[];
  sidePanel?: {
    scoreThreshold?: number;
    topSignals?: {
      sourceName: string;
      title: string;
      url: string;
      publishedAt: string | null;
      lastSeenAt: string | null;
      relevanceScore: number;
    }[];
    history?: {
      sourceName: string;
      title: string;
      url: string;
      publishedAt: string | null;
      lastSeenAt: string | null;
      relevanceScore: number;
    }[];
  };
  sources: {
    sourceName: string;
    sourceUrl: string;
    latestTitle: string;
    latestUrl: string;
    latestPublishedAt: string | null;
    lastRunMode: string;
    lastSeenAt: string | null;
    isNew: boolean;
    summary: string;
    detailedSummary?: string;
    keyFigures?: string[];
    hallucinationCheck?: string;
    relevance?: 'low' | 'medium' | 'high';
    relevanceScore?: number;
    relevanceReason?: string;
    relevanceExplain?: {
      positiveSignals?: string[];
      negativeSignals?: string[];
      evidence?: string[];
    };
  }[];
  strategicSummary: string;
};

type RunStatus = {
  isRunning: boolean;
  mode: 'manual' | 'test' | null;
  startedAt: string | null;
  steps: string[];
};

type CompanyProfile = {
  sector: string;
  size: 'ETI' | 'Grand Groupe';
};

const emptyReport: Report = {
  generatedAt: '',
  sourceCompany: 'Extia',
  brief2Min: [],
  sidePanel: {
    scoreThreshold: 50,
    topSignals: [],
    history: [],
  },
  sources: [],
  strategicSummary: '',
};

const sourceProfiles: Record<string, CompanyProfile> = {
  Alten: { sector: 'Ingénierie & IT', size: 'Grand Groupe' },
  Aubay: { sector: 'ESN généraliste', size: 'ETI' },
  Astek: { sector: 'Ingénierie & IT', size: 'ETI' },
  Devoteam: { sector: 'Cloud, Data & Cybersécurité', size: 'ETI' },
  Inetum: { sector: 'Transformation digitale', size: 'Grand Groupe' },
  Neosoft: { sector: 'Engineering & Digital', size: 'ETI' },
  Open: { sector: 'Transformation digitale', size: 'ETI' },
  SII: { sector: 'Ingénierie & IT', size: 'Grand Groupe' },
  'Sopra Steria': { sector: 'Conseil & Services numériques', size: 'Grand Groupe' },
  Wavestone: { sector: 'Conseil en transformation', size: 'ETI' },
};

const fallbackScoreFromLevel = (level?: 'low' | 'medium' | 'high') => {
  if (level === 'high') return 82;
  if (level === 'medium') return 58;
  return 22;
};

const ringColorFromScore = (score: number) => {
  const clamped = Math.max(0, Math.min(100, score));
  const mix = (start: [number, number, number], end: [number, number, number], t: number) => {
    const value = start.map((channel, i) => Math.round(channel + (end[i] - channel) * t));
    return `rgb(${value[0]} ${value[1]} ${value[2]})`;
  };

  const low: [number, number, number] = [147, 162, 189]; // #93a2bd
  const mid: [number, number, number] = [215, 171, 77]; // #d7ab4d
  const high: [number, number, number] = [62, 167, 117]; // #3ea775

  if (clamped <= 45) {
    return mix(low, mid, clamped / 45);
  }
  return mix(mid, high, (clamped - 45) / 55);
};

const EMPHASIS_REGEX =
  /\b(?:Extia|IA|data|cloud|cybersécurité|cybersecurite|transformation|recrutement|talent|croissance|revenu|marge|acquisition|partenariat|client|contrat|offre)\b|\b\d{1,3}(?:[.,]\d+)?\s?%|\b20\d{2}\b/gi;

const renderEmphasizedText = (text: string, maxHighlights = 2): ReactNode[] => {
  const content = text || '';
  const nodes: ReactNode[] = [];
  let last = 0;
  let count = 0;
  let match = EMPHASIS_REGEX.exec(content);

  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (start > last) {
      nodes.push(content.slice(last, start));
    }
    if (count < maxHighlights) {
      nodes.push(<strong key={`${start}-${end}-${match[0]}`}>{content.slice(start, end)}</strong>);
      count += 1;
    } else {
      nodes.push(content.slice(start, end));
    }
    last = end;
    match = EMPHASIS_REGEX.exec(content);
  }

  if (last < content.length) {
    nodes.push(content.slice(last));
  }

  EMPHASIS_REGEX.lastIndex = 0;
  return nodes.length ? nodes : [content];
};

const extractHeadline = (summary: string): string => {
  const lines = (summary || '')
    .split('\n')
    .map((line) => line.replace(/^•\s*/, '').trim())
    .filter(Boolean);
  const first = lines[0] || 'Résumé non disponible.';
  const compact = first.split(',').slice(0, 2).join(',').trim();
  if (compact.length <= 110) return compact;
  return `${compact.slice(0, 107).trimEnd()}...`;
};

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return '-';
  return new Date(value).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const normalizeInlineText = (value: string) => value.replace(/\s+/g, ' ').trim();

const parseBriefItem = (item: string) => {
  const raw = normalizeInlineText(item || '');
  const match = raw.match(/^([^()]+)\((\d{1,3})\/100\)\s*:\s*(.+)$/);
  if (!match) {
    return {
      company: 'Signal',
      score: 0,
      text: raw,
    };
  }
  return {
    company: normalizeInlineText(match[1]),
    score: Math.max(0, Math.min(100, Number(match[2]))),
    text: normalizeInlineText(match[3]),
  };
};

function App() {
  const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
  const apiUrl = useCallback((path: string) => (apiBaseUrl ? `${apiBaseUrl}${path}` : path), [apiBaseUrl]);
  const parseResponseSafely = async (response: Response) => {
    const text = await response.text();
    const contentType = response.headers.get('content-type') || '';
    if (!text) return {};
    if (!contentType.includes('application/json')) {
      if (response.status === 504) {
        return {
          error:
            "Timeout Netlify (HTTP 504) : le run est trop long pour une requete synchrone. Recharge le dashboard dans quelques secondes.",
        };
      }
      return { error: `Réponse API non JSON (HTTP ${response.status}). Vérifie VITE_API_BASE_URL.` };
    }
    try {
      return JSON.parse(text);
    } catch {
      return { error: `Réponse JSON invalide (HTTP ${response.status}).` };
    }
  };

  const [report, setReport] = useState<Report>(emptyReport);
  const [loading, setLoading] = useState(false);
  const [runningMode, setRunningMode] = useState<'manual' | 'test' | null>(null);
  const [error, setError] = useState('');
  const [runStatus, setRunStatus] = useState<RunStatus>({
    isRunning: false,
    mode: null,
    startedAt: null,
    steps: [],
  });
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [sectorFilter, setSectorFilter] = useState('all');
  const [sizeFilter, setSizeFilter] = useState('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarView, setSidebarView] = useState<'dashboard' | 'critical' | 'history'>('dashboard');
  const fetchJsonWithTimeout = async (url: string, init?: RequestInit, timeoutMs = 120000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(apiUrl(url), { ...(init || {}), signal: controller.signal });
      const data = await parseResponseSafely(response);
      return { response, data };
    } finally {
      clearTimeout(timer);
    }
  };


  const toReport = (data: unknown): Report => {
    if (!data || typeof data !== 'object') {
      return emptyReport;
    }
    const obj = data as Partial<Report> & { error?: string };
    if (obj.error) {
      throw new Error(obj.error);
    }
    return {
      generatedAt: typeof obj.generatedAt === 'string' ? obj.generatedAt : '',
      sourceCompany: typeof obj.sourceCompany === 'string' ? obj.sourceCompany : 'Extia',
      strategicSummary: typeof obj.strategicSummary === 'string' ? obj.strategicSummary : '',
      brief2Min: Array.isArray(obj.brief2Min) ? obj.brief2Min.filter((item) => typeof item === 'string') : [],
      sidePanel:
        obj.sidePanel && typeof obj.sidePanel === 'object'
          ? {
              scoreThreshold:
                typeof obj.sidePanel.scoreThreshold === 'number' ? obj.sidePanel.scoreThreshold : 50,
              topSignals: Array.isArray(obj.sidePanel.topSignals) ? obj.sidePanel.topSignals : [],
              history: Array.isArray(obj.sidePanel.history) ? obj.sidePanel.history : [],
            }
          : emptyReport.sidePanel,
      sources: Array.isArray(obj.sources) ? obj.sources : [],
    };
  };

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(apiUrl('/api/dashboard'));
      const data = await parseResponseSafely(response);
      if (!response.ok) {
        throw new Error((data as { error?: string }).error || 'Erreur API dashboard');
      }
      setReport(toReport(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setLoading(false);
    }
  }, [apiUrl]);

  useEffect(() => {
    if (runningMode === null) {
      return;
    }
    let cancelled = false;
    let consecutiveFailures = 0;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl('/api/run-status'));
        if (!res.ok) {
          throw new Error(`run-status http ${res.status}`);
        }
        const data = (await parseResponseSafely(res)) as RunStatus;
        if (!cancelled) {
          consecutiveFailures = 0;
          setRunStatus(data);
        }
      } catch {
        consecutiveFailures += 1;
        if (!cancelled && consecutiveFailures >= 3) {
          setRunStatus((prev) => ({
            ...prev,
            steps: [
              ...prev.steps,
              `${new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} - Impossible de lire le statut du workflow.`,
            ].slice(-40),
          }));
        }
      }
    };
    poll().catch(() => undefined);
    const id = setInterval(() => {
      poll().catch(() => undefined);
    }, 900);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [runningMode, apiUrl]);

  const runAnalysis = async (mode: 'manual' | 'test') => {
    setRunningMode(mode);
    setError('');
    try {
      const previousGeneratedAt = report.generatedAt || '';
      const pollDashboardUntilUpdated = async () => {
        const startedAt = Date.now();
        const timeoutMs = 5 * 60 * 1000;
        while (Date.now() - startedAt < timeoutMs) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const { response: dashboardRes, data: dashboardData } = await fetchJsonWithTimeout('/api/dashboard', undefined, 45000);
          if (!dashboardRes.ok) continue;
          const nextReport = toReport(dashboardData);
          setReport(nextReport);
          if (nextReport.generatedAt && nextReport.generatedAt !== previousGeneratedAt) {
            return;
          }
        }
        throw new Error('Run lance en background mais resultat non disponible pour le moment. Recharge dans 1 minute.');
      };

      const bgEndpoint =
        mode === 'manual'
          ? '/.netlify/functions/run-analysis-background'
          : '/.netlify/functions/run-test-background';

      const { response: bgResponse, data: bgData } = await fetchJsonWithTimeout(bgEndpoint, { method: 'POST' }, 45000);
      if (bgResponse.ok || bgResponse.status === 202) {
        await pollDashboardUntilUpdated();
        return;
      }

      const endpoint = mode === 'manual' ? '/api/run-analysis' : '/api/run-test';
      const { response, data } = await fetchJsonWithTimeout(endpoint, { method: 'POST' });
      if (!response.ok) {
        if (response.status === 504) {
          throw new Error('Timeout Netlify (504): la function longue depasse la limite. Le mode background doit etre utilise.');
        }
        throw new Error(
          (bgData as { error?: string }).error ||
            (data as { error?: string }).error ||
            'Erreur API run',
        );
      }

      const directReport = (data as { report?: unknown; queued?: boolean }).report;
      const isQueued = (data as { queued?: boolean }).queued !== false;
      if (!isQueued && directReport) {
        setReport(toReport(directReport));
        return;
      }

      const jobId = (data as { jobId?: string }).jobId;
      if (!jobId) {
        await loadDashboard();
        return;
      }

      const startedAt = Date.now();
      const timeoutMs = 5 * 60 * 1000;
      while (Date.now() - startedAt < timeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        const jobRes = await fetch(apiUrl(`/api/run-jobs/${jobId}`));
        const jobData = (await parseResponseSafely(jobRes)) as {
          status?: string;
          error?: string;
          report?: unknown;
        };
        if (!jobRes.ok) {
          if (jobRes.status === 404 && (jobData.error || '').toLowerCase().includes('job not found')) {
            await loadDashboard();
            return;
          }
          throw new Error(jobData.error || 'Erreur suivi job');
        }
        if (jobData.status === 'completed') {
          setReport(toReport(jobData.report));
          return;
        }
        if (jobData.status === 'failed') {
          throw new Error(jobData.error || 'Le job a échoué.');
        }
      }
      throw new Error('Le job a dépassé le temps limite.');
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      setError(
        isAbort
          ? 'Le run a depasse le temps limite. Reessaie.'
          : err instanceof Error
            ? err.message
            : 'Erreur inconnue',
      );
    } finally {
      setRunningMode(null);
    }
  };

  useEffect(() => {
    loadDashboard().catch(() => undefined);
  }, [loadDashboard]);

  const getProfile = (sourceName: string): CompanyProfile => {
    return sourceProfiles[sourceName] || { sector: 'Autre', size: 'ETI' };
  };

  const availableSectors = [
    'all',
    ...Array.from(new Set(report.sources.map((source) => getProfile(source.sourceName).sector))).sort(),
  ];
  const availableSizes = [
    'all',
    ...Array.from(new Set(report.sources.map((source) => getProfile(source.sourceName).size))),
  ];

  const filteredSources = report.sources.filter((source) => {
    const profile = getProfile(source.sourceName);
    const sectorOk = sectorFilter === 'all' || profile.sector === sectorFilter;
    const sizeOk = sizeFilter === 'all' || profile.size === sizeFilter;
    const query = searchQuery.trim().toLowerCase();
    const searchOk = !query || source.sourceName.toLowerCase().includes(query);
    return sectorOk && sizeOk && searchOk;
  });

  const sideThreshold = 50;
  const criticalSources = report.sources.filter((source) => {
    const score =
      typeof source.relevanceScore === 'number' && source.relevanceScore > 0
        ? source.relevanceScore
        : fallbackScoreFromLevel(source.relevance);
    return score >= sideThreshold;
  });
  const criticalBriefItems = criticalSources
    .sort((a, b) => {
      const scoreA =
        typeof a.relevanceScore === 'number' && a.relevanceScore > 0
          ? a.relevanceScore
          : fallbackScoreFromLevel(a.relevance);
      const scoreB =
        typeof b.relevanceScore === 'number' && b.relevanceScore > 0
          ? b.relevanceScore
          : fallbackScoreFromLevel(b.relevance);
      return scoreB - scoreA;
    })
    .slice(0, 5)
    .map((source) => {
      const score =
        typeof source.relevanceScore === 'number' && source.relevanceScore > 0
          ? source.relevanceScore
          : fallbackScoreFromLevel(source.relevance);
      const firstBullet =
        source.summary
          .split('\n')
          .map((line) => line.replace(/^•\s*/, '').trim())
          .find(Boolean) || source.latestTitle;
      return `${source.sourceName} (${score}/100) : ${firstBullet}`;
    });
  const fallbackHistorySignals = report.sources
    .map((source) => ({
      sourceName: source.sourceName,
      title: source.latestTitle,
      url: source.latestUrl,
      publishedAt: source.latestPublishedAt,
      lastSeenAt: source.lastSeenAt,
      relevanceScore:
        typeof source.relevanceScore === 'number' && source.relevanceScore > 0
          ? source.relevanceScore
          : fallbackScoreFromLevel(source.relevance),
    }))
    .sort((a, b) => new Date(b.lastSeenAt || 0).getTime() - new Date(a.lastSeenAt || 0).getTime())
    .filter((item, index, arr) => arr.findIndex((candidate) => candidate.url === item.url) === index)
    .slice(0, 40);
  const historySignals = (report.sidePanel?.history?.length ? report.sidePanel.history : fallbackHistorySignals).slice(0, 40);
  const tableSources = sidebarView === 'critical' ? criticalSources : filteredSources;

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="app-sidebar">
        <div className="sidebar-brand">
          <img src="/radex-logo.png" alt="Radex logo" className="brand-logo" />
          {!sidebarCollapsed ? <strong>Radex</strong> : null}
        </div>
        <button
          type="button"
          className="sidebar-collapse-btn"
          onClick={() => setSidebarCollapsed((prev) => !prev)}
          aria-label={sidebarCollapsed ? 'Etendre le menu' : 'Compacter le menu'}
        >
          {sidebarCollapsed ? <FiChevronRight /> : <FiChevronLeft />}
        </button>
        <nav className="sidebar-nav">
          <button
            type="button"
            className={`sidebar-nav-item ${sidebarView === 'dashboard' ? 'active' : ''}`}
            onClick={() => setSidebarView('dashboard')}
          >
            <FiGrid />
            {!sidebarCollapsed ? <span>Dashboard</span> : null}
          </button>
          <button
            type="button"
            className={`sidebar-nav-item ${sidebarView === 'critical' ? 'active' : ''}`}
            onClick={() => setSidebarView('critical')}
          >
            <FiSliders />
            {!sidebarCollapsed ? <span>Actus critiques</span> : null}
          </button>
          <button
            type="button"
            className={`sidebar-nav-item ${sidebarView === 'history' ? 'active' : ''}`}
            onClick={() => setSidebarView('history')}
          >
            <FiCheckSquare />
            {!sidebarCollapsed ? <span>Historique</span> : null}
          </button>
        </nav>
      </aside>
      <main className="layout">
      <header className="header">
        <div className="actions">
          <button onClick={loadDashboard} disabled={loading}>
            <FiRefreshCw />
            {loading ? 'Chargement...' : 'Actualiser'}
          </button>
          <button
            className="primary"
            onClick={() => runAnalysis('manual')}
            disabled={runningMode !== null}
          >
            <FiPlay />
            {runningMode === 'manual' ? 'Run manuel...' : 'Lancer run manuel'}
          </button>
          <button onClick={() => runAnalysis('test')} disabled={runningMode !== null}>
            <FiEye />
            {runningMode === 'test' ? 'Mode test...' : 'Mode test (dernier article)'}
          </button>
        </div>
      </header>

      {error ? <p className="error">Erreur: {error}</p> : null}
      {sidebarView === 'history' ? (
        <section className="card side-inline-card">
          <h3>Historique (sans doublons)</h3>
          <div className="side-list">
            {historySignals.length ? (
              historySignals.map((item) => (
                <article key={`history-${item.sourceName}-${item.url}`} className="side-list-item">
                  <p className="side-list-title">{item.sourceName} - {item.title}</p>
                  <p className="side-list-meta">{formatDateTime(item.publishedAt || item.lastSeenAt)}</p>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    Voir
                  </a>
                </article>
              ))
            ) : (
              <article className="side-list-item">Pas encore d&apos;historique.</article>
            )}
          </div>
        </section>
      ) : null}
      {runningMode !== null ? (
        <section className="card loader-card">
          <div className="radar-loader" aria-label="Chargement en cours">
            <div className="radar-ring ring-1" />
            <div className="radar-ring ring-2" />
            <div className="radar-ring ring-3" />
            <div className="radar-sweep" />
            <div className="radar-core">
              <img src="/radex-logo.png" alt="" className="radar-core-logo" />
            </div>
          </div>
          <p className="loader-title">Analyse en cours...</p>
          <p className="loader-subtitle">La moulinette IA scrape, vérifie et synthétise les actus.</p>
        </section>
      ) : null}
      {runningMode !== null ? (
        <section className="card">
          <h3>Étapes du workflow IA</h3>
          <p>
            Mode: <strong>{runStatus.mode || runningMode}</strong>
          </p>
          <div className="steps-box">
            {runStatus.steps.length ? (
              runStatus.steps.map((step) => (
                <p key={step} className="step-line">
                  {step}
                </p>
              ))
            ) : (
              <p className="step-line">Initialisation du workflow...</p>
            )}
          </div>
        </section>
      ) : null}

      {sidebarView !== 'critical' ? (
        <section className="kpi-grid">
          <article className="card">
            <FiActivity className="card-icon" />
            <p>Sources suivies</p>
            <h2>{report.sources.length}</h2>
          </article>
          <article className="card">
            <FiBell className="card-icon" />
            <p>Nouveaux articles détectés</p>
            <h2>{report.sources.filter((item) => item.isNew).length}</h2>
          </article>
          <article className="card">
            <FiCalendar className="card-icon" />
            <p>Dernière exécution</p>
            <h2>{formatDateTime(report.generatedAt)}</h2>
          </article>
        </section>
      ) : null}

      <section className="card brief-card">
        <h3>{sidebarView === 'critical' ? 'Brief actus critiques' : 'Brief'}</h3>
        {sidebarView === 'critical' ? <p>Seuil critique: score &gt;= {sideThreshold}</p> : null}
        <ul>
          {(
            sidebarView === 'critical'
              ? criticalBriefItems.length
                ? criticalBriefItems
                : ['Aucune actu critique (score >= 50) pour le moment.']
              : report.brief2Min?.length
                ? report.brief2Min
                : ['Aucun signal critique pour le moment.']
          ).map((item) => {
            const parsed = parseBriefItem(item);
            const ringColor = ringColorFromScore(parsed.score);
            const ringStyle = {
              background: `conic-gradient(${ringColor} ${parsed.score}%, rgba(141, 156, 186, 0.25) 0)`,
              color: ringColor,
            } as CSSProperties;
            return (
              <li key={item} className="brief-item">
                <span className="brief-company-card">{parsed.company}</span>
                <span className="brief-score-ring" style={ringStyle}>
                  <span className="brief-score-value">{parsed.score}</span>
                </span>
                <span className="brief-text">{parsed.text}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="table-wrap">
        <div className="table-filters">
          <label>
            Secteur
            <select value={sectorFilter} onChange={(e) => setSectorFilter(e.target.value)}>
              <option value="all">Tous</option>
              {availableSectors
                .filter((value) => value !== 'all')
                .map((sector) => (
                  <option key={sector} value={sector}>
                    {sector}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Taille d&apos;entreprise
            <select value={sizeFilter} onChange={(e) => setSizeFilter(e.target.value)}>
              <option value="all">Toutes</option>
              {availableSizes
                .filter((value) => value !== 'all')
                .map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
            </select>
          </label>
          <div className={`company-search ${searchOpen ? 'open' : ''}`}>
            <button
              type="button"
              className="search-toggle"
              aria-label="Rechercher une entreprise"
              onClick={() => setSearchOpen((prev) => !prev)}
            >
              <FiSearch />
            </button>
            <input
              type="text"
              placeholder="Nom d'entreprise"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onBlur={() => {
                if (!searchQuery.trim()) {
                  setSearchOpen(false);
                }
              }}
            />
          </div>
          <p>{tableSources.length} source(s) affichée(s)</p>
        </div>
        {sidebarView === 'critical' ? (
          <div className="table-section-title">
            <strong>Tableau des actus critiques</strong>
          </div>
        ) : null}
        <table>
          <thead>
            <tr>
              <th><span className="th-wrap"><FiDatabase />Source</span></th>
              <th><span className="th-wrap"><FiActivity />Dernier titre</span></th>
              <th><span className="th-wrap"><FiExternalLink />Lien article</span></th>
              <th><span className="th-wrap"><FiBell />Nouveau</span></th>
              <th><span className="th-wrap"><FiPlay />Mode du dernier run</span></th>
              <th><span className="th-wrap"><FiCalendar />Dernière détection</span></th>
              <th>Pertinence</th>
              <th>Synthèse</th>
              <th>Détails</th>
            </tr>
          </thead>
          <tbody>
            {tableSources.map((source) => (
              <Fragment key={source.sourceName}>
                <tr>
                  <td className="company-name-cell">
                    <span className="company-name-card">{source.sourceName}</span>
                  </td>
                  <td>{source.latestTitle}</td>
                  <td>
                    <a href={source.latestUrl} target="_blank" rel="noreferrer">
                      Ouvrir
                    </a>
                  </td>
                  <td>
                    <span className={`pill ${source.isNew ? 'high' : 'low'}`}>
                      {source.isNew ? 'Oui' : 'Non'}
                    </span>
                  </td>
                  <td>{source.lastRunMode}</td>
                  <td>{formatDateTime(source.lastSeenAt)}</td>
                  <td>
                    {(() => {
                      const score =
                        typeof source.relevanceScore === 'number' && source.relevanceScore > 0
                          ? source.relevanceScore
                          : fallbackScoreFromLevel(source.relevance);
                      const ringColor = ringColorFromScore(score);
                      const ringStyle = {
                        background: `conic-gradient(${ringColor} ${Math.max(0, Math.min(100, score))}%, rgba(141, 156, 186, 0.25) 0)`,
                        color: ringColor,
                      } as CSSProperties;
                      return (
                        <div className="relevance-cell">
                          <span className="score-ring" style={ringStyle}>
                            <span className="score-ring-value">{score}</span>
                          </span>
                        </div>
                      );
                    })()}
                  </td>
                  <td className="bullet-cell">
                    <div className="mini-headline-card">
                      <p className="mini-headline">{renderEmphasizedText(extractHeadline(source.summary), 1)}</p>
                    </div>
                    {source.summary.split('\n').map((line) => (
                      <p key={`${source.sourceName}-${line}`}>{renderEmphasizedText(line, 2)}</p>
                    ))}
                  </td>
                  <td>
                    <button
                      className="details-btn"
                      onClick={() =>
                        setExpandedSource((prev) => (prev === source.sourceName ? null : source.sourceName))
                      }
                    >
                      {expandedSource === source.sourceName ? 'Masquer' : 'Détails'}
                    </button>
                  </td>
                </tr>
                {expandedSource === source.sourceName ? (
                  <tr>
                    <td colSpan={9} className="details-row">
                      <p>
                        <strong>Synthèse détaillée :</strong>{' '}
                        {renderEmphasizedText(source.detailedSummary || 'Non disponible', 4)}
                      </p>
                      <p>
                        <strong>Chiffres clés :</strong>{' '}
                        {source.keyFigures?.length
                          ? source.keyFigures.join(' | ')
                          : 'Aucun chiffre détecté (source à vérifier)'}
                      </p>
                      <p>
                        <strong>Justification pertinence :</strong>{' '}
                        {source.relevanceReason || 'Aucune justification disponible.'}
                      </p>
                      <div className="score-explain">
                        <p><strong>Pourquoi ce score ?</strong></p>
                        <p>
                          <strong>Signaux + :</strong>{' '}
                          {source.relevanceExplain?.positiveSignals?.length
                            ? source.relevanceExplain.positiveSignals.join(' | ')
                            : 'Aucun signal positif explicite.'}
                        </p>
                        <p>
                          <strong>Signaux - :</strong>{' '}
                          {source.relevanceExplain?.negativeSignals?.length
                            ? source.relevanceExplain.negativeSignals.join(' | ')
                            : 'Aucun signal négatif explicite.'}
                        </p>
                        <p>
                          <strong>Preuves article :</strong>{' '}
                          {source.relevanceExplain?.evidence?.length
                            ? source.relevanceExplain.evidence.join(' | ')
                            : 'Preuves indisponibles.'}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </section>
      </main>
    </div>
  );
}

export default App;
