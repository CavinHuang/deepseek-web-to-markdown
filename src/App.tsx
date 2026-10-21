import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  CircleHelp,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Info,
  KeyRound,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  StopCircle,
  Trash2,
  Wallet,
  X,
  Zap,
} from 'lucide-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { clearArticles, deleteArticle, getArticles, saveArticle, type Article } from './lib/db';
import { downloadArticlesIndividually, downloadText, downloadZip, safeFilename } from './lib/download';
import { DEFAULT_API_BASE_URL, fetchAccountBalance, fetchWebpageAsMarkdown } from './lib/deepseek';

type Settings = {
  apiKey: string;
  builtinAccessToken: string;
  apiBaseUrl: string;
  delayMs: number;
};

type PreviewMode = 'split' | 'edit' | 'preview';
type PreviewTheme =
  | 'classic'
  | 'paper'
  | 'focus'
  | 'report'
  | 'contrast'
  | 'mist'
  | 'forest'
  | 'salt'
  | 'sand'
  | 'night';
type ToastKind = 'success' | 'error' | 'warning' | 'info';
type ToastItem = { id: number; message: string; kind: ToastKind };

const SETTINGS_KEY = 'deepseek-web-markdown-settings-v1';
const ONBOARD_DISMISSED_KEY = 'wisemind.deepseek.web2md.onboard.dismissed';
const PREVIEW_THEME_KEY = 'wisemind.deepseek.web2md.mdTheme';
const WISEMIND_HOME = 'https://www.wisemindai.app/';
const DEEPSEEK_API_KEYS_URL = 'https://platform.deepseek.com/api_keys';
// 有意偏离目标站：目标站抽屉的「请求地址」显示并默认 https://api.deepseek.com/v1/tools/fetch，
// 但本仓库前端默认走同源 /api 代理（见 README「Same-origin API service」），浏览器直连上游会被
// CORS 拦截，因此默认值保持 /api，仅提示文案格式与目标站一致（默认：<地址>）。
const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  builtinAccessToken: '',
  apiBaseUrl: DEFAULT_API_BASE_URL,
  delayMs: 250,
};

const PREVIEW_THEMES: Array<{ value: PreviewTheme; label: string }> = [
  { value: 'classic', label: '经典阅读' },
  { value: 'paper', label: '纸张阅读' },
  { value: 'focus', label: '专注阅读' },
  { value: 'report', label: '报告阅读' },
  { value: 'contrast', label: '高对比阅读' },
  { value: 'mist', label: '晨雾阅读' },
  { value: 'forest', label: '林间阅读' },
  { value: 'salt', label: '海盐阅读' },
  { value: 'sand', label: '暖砂阅读' },
  { value: 'night', label: '夜航阅读' },
];

function isPreviewTheme(value: unknown): value is PreviewTheme {
  return PREVIEW_THEMES.some((theme) => theme.value === value);
}

function loadPreviewTheme(): PreviewTheme {
  try {
    const raw = localStorage.getItem(PREVIEW_THEME_KEY);
    return isPreviewTheme(raw) ? raw : 'classic';
  } catch {
    return 'classic';
  }
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      builtinAccessToken: typeof parsed.builtinAccessToken === 'string' ? parsed.builtinAccessToken : '',
      apiBaseUrl: typeof parsed.apiBaseUrl === 'string' && parsed.apiBaseUrl.trim() ? parsed.apiBaseUrl : DEFAULT_API_BASE_URL,
      delayMs: Math.max(250, Math.min(10000, Number(parsed.delayMs) || 250)),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeUrls(input: string): { urls: string[]; invalid: string[] } {
  const lines = input.split(/[\n\r]+/).map((line) => line.trim()).filter(Boolean);
  const urls: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    try {
      const url = new URL(line);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
      url.hash = '';
      const normalized = url.toString();
      if (!seen.has(normalized)) {
        urls.push(normalized);
        seen.add(normalized);
      }
    } catch {
      invalid.push(line);
    }
  }
  return { urls, invalid };
}

function canonicalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

function App() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedArticleIds, setSelectedArticleIds] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isTesting, setIsTesting] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState('');
  const [balanceStatus, setBalanceStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>('split');
  const [previewTheme, setPreviewTheme] = useState<PreviewTheme>(() => loadPreviewTheme());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [isExporting, setIsExporting] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(() => {
    try {
      return localStorage.getItem(ONBOARD_DISMISSED_KEY) !== '1';
    } catch {
      return true;
    }
  });
  const [onboardDontShow, setOnboardDontShow] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  // 防抖期间尚未落盘的编辑按文章 id 暂存；切换文章/关闭页面前会先补写，避免丢字。
  const pendingSavesRef = useRef(new Map<string, Article>());
  const stopRef = useRef(false);
  const toastIdRef = useRef(0);

  const hasCredential = Boolean(settings.apiKey.trim() || settings.builtinAccessToken.trim());
  const activeArticle = articles.find((article) => article.id === activeId) ?? null;
  const filteredArticles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return articles;
    return articles.filter((article) => `${article.title} ${article.url} ${article.markdown}`.toLowerCase().includes(query));
  }, [articles, searchQuery]);
  const selectedArticles = useMemo(
    () => articles.filter((article) => selectedArticleIds.includes(article.id)),
    [articles, selectedArticleIds],
  );
  const allVisibleArticlesSelected = filteredArticles.length > 0
    && filteredArticles.every((article) => selectedArticleIds.includes(article.id));
  const previewHtml = useMemo(() => {
    const source = activeArticle?.markdown ?? '';
    return DOMPurify.sanitize(String(marked.parse(source, { gfm: true, breaks: false })), {
      USE_PROFILES: { html: true },
    });
  }, [activeArticle?.markdown]);
  const hasPreviewContent = Boolean(activeArticle?.markdown.trim());
  const progressPercent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;

  useEffect(() => {
    let cancelled = false;
    getArticles()
      .then((saved) => {
        if (cancelled) return;
        setArticles(saved);
        setActiveId(saved[0]?.id ?? null);
      })
      .catch((error: unknown) => {
        if (!cancelled) showToast(error instanceof Error ? error.message : '读取本地文章失败。', 'error');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Initial hydration only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeArticle || isLoading) return;
    pendingSavesRef.current.set(activeArticle.id, activeArticle);
    // 抢救在其他文章上遗留的待保存编辑：450ms 防抖被切换打断时，定时器会被清除，
    // 这里立即把旧文章的最新内容补写进 IndexedDB，避免关闭页面后丢失。
    for (const [id, pending] of pendingSavesRef.current) {
      if (id === activeArticle.id) continue;
      pendingSavesRef.current.delete(id);
      saveArticle(pending).catch(() => showToast('本地保存失败，请检查浏览器存储空间。', 'error'));
    }
    const timer = window.setTimeout(() => {
      const pending = pendingSavesRef.current.get(activeArticle.id);
      pendingSavesRef.current.delete(activeArticle.id);
      if (pending) {
        saveArticle(pending).catch(() => showToast('本地保存失败，请检查浏览器存储空间。', 'error'));
      }
    }, 450);
    return () => window.clearTimeout(timer);
    // Only persist fields that are editable in the workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeArticle?.id, activeArticle?.title, activeArticle?.markdown, activeArticle?.url, isLoading]);

  // 页面关闭/刷新前的兜底 flush；pagehide 里 IndexedDB 仍可写入（unload 中不可靠）。
  useEffect(() => {
    const flushPendingSaves = () => {
      for (const [, pending] of pendingSavesRef.current) {
        void saveArticle(pending).catch(() => {});
      }
      pendingSavesRef.current.clear();
    };
    window.addEventListener('pagehide', flushPendingSaves);
    return () => window.removeEventListener('pagehide', flushPendingSaves);
  }, []);

  useEffect(() => () => {
    controllerRef.current?.abort();
  }, []);

  // 导出下拉：点击外部或按 Escape 时收起（此前纯 CSS :focus-within 无法做到）。
  useEffect(() => {
    if (!exportOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExportOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [exportOpen]);

  function showToast(message: string, kind: ToastKind = 'info') {
    const id = ++toastIdRef.current;
    setToasts((current) => [...current, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 3600);
  }

  function updateSettings<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => ({ ...current, [key]: value }));
  }

  function changePreviewTheme(theme: PreviewTheme) {
    setPreviewTheme(theme);
    try {
      localStorage.setItem(PREVIEW_THEME_KEY, theme);
    } catch {
      // 持久化失败时仍允许本次会话内切换主题。
    }
  }

  function dismissOnboard() {
    if (onboardDontShow) {
      try {
        localStorage.setItem(ONBOARD_DISMISSED_KEY, '1');
      } catch {
        // 忽略持久化失败，仅本次关闭引导。
      }
    }
    setOnboardOpen(false);
  }

  function openConfiguration() {
    setOnboardOpen(false);
    setSettingsOpen(true);
  }

  async function refreshBalance(next: Settings = settings): Promise<{ ok: boolean; message: string }> {
    if (!next.apiKey.trim() && !next.builtinAccessToken.trim()) {
      setBalanceStatus('idle');
      setBalance(null);
      setBalanceError('');
      return { ok: false, message: '请先配置 API Key' };
    }
    setIsTesting(true);
    try {
      const result = await fetchAccountBalance(next.apiKey, next.apiBaseUrl, next.builtinAccessToken);
      const label = result.amount ? `${result.amount} ${result.currency ?? 'CNY'}` : result.available ? '账号可用' : '暂无可用额度';
      setBalanceStatus('ok');
      setBalanceError('');
      setBalance(label);
      return { ok: true, message: label };
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接失败。';
      setBalanceStatus('error');
      setBalance(null);
      setBalanceError(message);
      return { ok: false, message };
    } finally {
      setIsTesting(false);
    }
  }

  async function testConnection() {
    if (!settings.builtinAccessToken.trim() && !settings.apiKey.trim()) {
      showToast('请填写 API Key', 'warning');
      return;
    }
    const result = await refreshBalance();
    if (result.ok) showToast('连接成功，已读取账号状态。', 'success');
    else showToast(result.message, 'error');
  }

  function persistSettings() {
    if (!settings.apiKey.trim() && !settings.builtinAccessToken.trim()) {
      showToast('请填写 API Key', 'warning');
      return;
    }
    const next: Settings = { ...settings, delayMs: Math.max(250, Math.min(10000, Number(settings.delayMs) || 250)) };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      setSettings(next);
      setSettingsOpen(false);
      showToast('配置已保存。下一步：在左侧输入文章链接并开始抓取', 'success');
      if (next.apiKey.trim() || next.builtinAccessToken.trim()) void refreshBalance(next);
    } catch {
      showToast('配置保存失败，请检查浏览器存储设置。', 'error');
    }
  }

  function clearApiKey() {
    const cleared: Settings = { ...settings, apiKey: '', builtinAccessToken: '' };
    setSettings(cleared);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(cleared));
    } catch {
      showToast('配置保存失败，请检查浏览器存储设置。', 'error');
    }
    setBalance(null);
    setBalanceStatus('idle');
    setBalanceError('');
    showToast('已清空 API Key', 'success');
  }

  async function startCapture() {
    if (isRunning) return;
    const { urls, invalid } = normalizeUrls(urlInput);
    for (const text of invalid) showToast(`${text}… 无效的 URL`, 'warning');
    if (urls.length === 0) {
      showToast('请至少输入一个有效链接', 'warning');
      return;
    }
    const findReusable = (url: string) => articles.find(
      (article) => canonicalizeUrl(article.url) === canonicalizeUrl(url) && !article.error,
    );
    const needsApiKey = urls.some((url) => !findReusable(url));
    if (needsApiKey && !hasCredential) {
      setSettingsOpen(true);
      showToast('请先配置 DeepSeek API Key', 'warning');
      return;
    }

    stopRef.current = false;
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsRunning(true);
    setProgress({ done: 0, total: urls.length, failed: 0 });
    let completed = 0;
    let failed = 0;
    let volatileCount = 0;

    try {
      for (let index = 0; index < urls.length; index += 1) {
        if (stopRef.current) break;
        const url = urls[index];
        try {
          const existing = findReusable(url);
          if (existing) {
            setActiveId(existing.id);
          } else {
            const result = await fetchWebpageAsMarkdown(url, settings.apiKey, settings.apiBaseUrl, controller.signal, settings.builtinAccessToken);
            if (stopRef.current) break;
            // 服务端缓存未能持久化（X-Cache: VOLATILE）时提示用户：重启后同 URL 可能再次扣费。
            if (result.cacheStatus === 'VOLATILE') volatileCount += 1;
            const now = new Date().toISOString();
            const article: Article = {
              id: makeId(),
              url,
              title: result.title,
              markdown: result.markdown,
              createdAt: now,
              updatedAt: now,
            };
            await saveArticle(article);
            setArticles((current) => [article, ...current.filter((item) => canonicalizeUrl(item.url) !== canonicalizeUrl(article.url))]);
            setActiveId(article.id);
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') break;
          failed += 1;
          const message = error instanceof Error ? error.message : '未知错误';
          showToast(message, 'error');
          const now = new Date().toISOString();
          const failedArticle: Article = {
            id: makeId(),
            url,
            title: '',
            markdown: '',
            createdAt: now,
            updatedAt: now,
            error: message,
          };
          try {
            await saveArticle(failedArticle);
            setArticles((current) => [failedArticle, ...current.filter((item) => canonicalizeUrl(item.url) !== canonicalizeUrl(url))]);
            setActiveId(failedArticle.id);
          } catch {
            showToast('失败结果未能写入本地文章库。', 'error');
          }
        }
        completed += 1;
        setProgress({ done: completed, total: urls.length, failed });
        if (index + 1 < urls.length && !stopRef.current) {
          await new Promise((resolve) => window.setTimeout(resolve, Math.max(250, Number(settings.delayMs) || 250)));
        }
      }
      if (stopRef.current) showToast(`已停止抓取（${completed}/${urls.length}），已自动保存到本机`, 'info');
      else if (failed > 0) showToast(`抓取完成（${completed}/${urls.length}，失败 ${failed}），已自动保存到本机`, 'warning');
      else showToast(`抓取完成（${completed}/${urls.length}），已自动保存到本机`, 'success');
      if (volatileCount > 0) {
        showToast(`另有 ${volatileCount} 个结果未能持久保存缓存，服务重启后可能再次扣费；请检查服务器缓存目录权限。`, 'warning');
      }
      setUrlInput((current) => current.trim());
    } finally {
      setIsRunning(false);
      controllerRef.current = null;
      stopRef.current = false;
    }
  }

  function stopCapture() {
    stopRef.current = true;
    controllerRef.current?.abort();
  }

  async function removeArticle(article: Article) {
    if (!window.confirm(`确定从本地删除「${article.url}」？\n删除后刷新也无法恢复（除非你另有导出文件）。`)) return;
    try {
      pendingSavesRef.current.delete(article.id);
      await deleteArticle(article.id);
      const remaining = articles.filter((item) => item.id !== article.id);
      setArticles(remaining);
      setSelectedArticleIds((current) => current.filter((id) => id !== article.id));
      if (activeId === article.id) setActiveId(remaining[0]?.id ?? null);
      showToast('已从本地删除该文章', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败。', 'error');
    }
  }

  async function removeAllArticles() {
    if (!articles.length) {
      showToast('本地还没有文章', 'warning');
      return;
    }
    if (!window.confirm(`确定清空本地文章库中的 ${articles.length} 篇文章吗？此操作无法撤销。`)) return;
    try {
      pendingSavesRef.current.clear();
      await clearArticles();
      setArticles([]);
      setSelectedArticleIds([]);
      setActiveId(null);
      showToast('本地文章库已清空。', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '清空失败。', 'error');
    }
  }

  function toggleArticleSelection(id: string) {
    setSelectedArticleIds((current) => current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id]);
  }

  function toggleVisibleArticleSelection() {
    const visibleIds = filteredArticles.map((article) => article.id);
    if (allVisibleArticlesSelected) {
      setSelectedArticleIds((current) => current.filter((id) => !visibleIds.includes(id)));
      return;
    }
    setSelectedArticleIds((current) => [...new Set([...current, ...visibleIds])]);
  }

  function clearArticleSelection() {
    setSelectedArticleIds([]);
  }

  async function removeSelectedArticles() {
    if (!selectedArticles.length || isRunning) return;
    if (!window.confirm(`确定删除选中的 ${selectedArticles.length} 篇文章吗？此操作无法撤销。`)) return;

    const removedIds: string[] = [];
    const failedCount = { value: 0 };
    for (const article of selectedArticles) {
      try {
        pendingSavesRef.current.delete(article.id);
        await deleteArticle(article.id);
        removedIds.push(article.id);
      } catch {
        failedCount.value += 1;
      }
    }

    if (removedIds.length) {
      const remaining = articles.filter((article) => !removedIds.includes(article.id));
      setArticles(remaining);
      setSelectedArticleIds((current) => current.filter((id) => !removedIds.includes(id)));
      if (activeId && removedIds.includes(activeId)) setActiveId(remaining[0]?.id ?? null);
    }
    if (failedCount.value) {
      showToast(`已删除 ${removedIds.length} 篇，另有 ${failedCount.value} 篇删除失败，请重试。`, 'error');
    } else {
      showToast(`已删除选中的 ${removedIds.length} 篇文章。`, 'success');
    }
  }

  function updateActiveArticle(patch: Partial<Pick<Article, 'title' | 'markdown'>>) {
    if (!activeId) return;
    setArticles((current) => current.map((article) => {
      if (article.id !== activeId) return article;
      const next: Article = { ...article, ...patch, updatedAt: new Date().toISOString() };
      // 用户为「抓取失败」的文章补写了正文即视为已修复，清空失败标记。
      if (patch.markdown && patch.markdown.trim()) delete next.error;
      return next;
    }));
  }

  function downloadArticleFile(article: Article) {
    downloadText(`${safeFilename(article.title)}.md`, article.markdown);
    showToast('Markdown 文件已开始下载。', 'success');
  }

  async function exportCurrent() {
    if (!activeArticle) return;
    downloadArticleFile(activeArticle);
  }

  async function exportAll() {
    if (!articles.length || isExporting) return;
    setIsExporting(true);
    try {
      await downloadArticlesIndividually(articles);
      showToast(`已发起 ${articles.length} 个 Markdown 文件的下载。`, 'success');
    } catch {
      showToast('批量下载失败，请尝试导出 ZIP。', 'error');
    } finally {
      setIsExporting(false);
    }
  }

  async function exportZip() {
    if (!articles.length || isExporting) return;
    setIsExporting(true);
    try {
      await downloadZip(articles);
      showToast(`已打包 ${articles.length} 篇文章。`, 'success');
    } catch {
      showToast('ZIP 打包失败，请稍后重试。', 'error');
    } finally {
      setIsExporting(false);
    }
  }

  async function exportSelected() {
    if (!selectedArticles.length || isExporting) return;
    setIsExporting(true);
    try {
      await downloadArticlesIndividually(selectedArticles);
      showToast(`已发起 ${selectedArticles.length} 个选中 Markdown 文件的下载。`, 'success');
    } catch {
      showToast('选中文章批量下载失败，请尝试导出 ZIP。', 'error');
    } finally {
      setIsExporting(false);
    }
  }

  async function exportSelectedZip() {
    if (!selectedArticles.length || isExporting) return;
    setIsExporting(true);
    try {
      await downloadZip(selectedArticles);
      showToast(`已将选中的 ${selectedArticles.length} 篇文章打包为 ZIP。`, 'success');
    } catch {
      showToast('选中文章 ZIP 打包失败，请稍后重试。', 'error');
    } finally {
      setIsExporting(false);
    }
  }

  async function copyMarkdown() {
    if (!activeArticle) return;
    try {
      await navigator.clipboard.writeText(activeArticle.markdown);
      showToast('Markdown 已复制到剪贴板。', 'success');
    } catch {
      showToast('复制失败，请手动选择文本', 'error');
    }
  }

  const balanceBadgeLabel = balanceStatus === 'ok' ? '成功' : balanceStatus === 'error' ? '失败' : '未配置';

  return (
    <div className="app-shell">
      {!hasCredential && !onboardOpen && (
        <div className="setup-banner">
          <span className="setup-banner-icon" aria-hidden="true">#</span>
          <div className="setup-banner-copy">
            <strong>第一步：先配置 DeepSeek API Key</strong>
            <span>没有 Key 无法抓取网页。配置完成后，再在左侧粘贴文章链接并点击「开始抓取」。</span>
          </div>
          <div className="setup-banner-actions">
            <button className="button button-gradient" onClick={() => setSettingsOpen(true)}>
              <KeyRound size={14} /> 去配置 API Key
            </button>
            <button className="button button-ghost" onClick={() => setOnboardOpen(true)}>查看引导</button>
          </div>
        </div>
      )}

      <header className="topbar">
        <div className="brand">
          <a className="brand-mark" href={WISEMIND_HOME} target="_blank" rel="noreferrer" aria-label="WiseMindAI 官网">W</a>
          <div className="brand-copy">
            <h1>DeepSeek 网页转 Markdown</h1>
            <p>
              配置 Key → 输入链接 → 抓取编辑 → 导出 ·{' '}
              <a className="brand-link" href={WISEMIND_HOME} target="_blank" rel="noreferrer">WiseMindAI 出品</a>
            </p>
          </div>
        </div>
        <div className="topbar-right">
          <a className="workbench-link" href={WISEMIND_HOME} target="_blank" rel="noreferrer">
            <ExternalLink size={11} /> 打开工作台
          </a>
          <button className="button button-ghost button-guide button-compact" onClick={() => setOnboardOpen(true)}>
            <CircleHelp size={13} /> 使用引导
          </button>
          {hasCredential ? (
            <button className="button button-ghost button-compact" onClick={() => setSettingsOpen(true)}>
              <KeyRound size={13} /> API 配置 <span className="badge badge-ok">已配置</span>
            </button>
          ) : (
            <button className="button button-gradient button-compact" onClick={() => setSettingsOpen(true)}>
              <KeyRound size={13} /> 配置 API Key <span className="badge badge-miss">未配置</span>
            </button>
          )}
          <div className={`export-dropdown ${exportOpen ? 'open' : ''}`} ref={exportMenuRef}>
            <button
              className="button button-export"
              onClick={() => setExportOpen((value) => !value)}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
            >
              <Download size={14} /> 导出
            </button>
            <div className="export-menu" role="menu">
              <button role="menuitem" onClick={() => { setExportOpen(false); void exportCurrent(); }} disabled={!activeArticle}>导出当前 Markdown</button>
              <button role="menuitem" onClick={() => { setExportOpen(false); void exportAll(); }} disabled={!articles.length || isExporting}>逐个导出全部 .md</button>
              <button role="menuitem" onClick={() => { setExportOpen(false); void exportZip(); }} disabled={!articles.length || isExporting}>打包导出 ZIP</button>
            </div>
          </div>
        </div>
        <div className={`balance-dock ${balanceOpen ? 'open' : ''}`}>
          <button className="balance-bar" onClick={() => setBalanceOpen((value) => !value)} title="展开余额面板" aria-expanded={balanceOpen}>
            <span className="balance-bar-chip"><Wallet size={14} /></span>
            <span className="balance-bar-text">余额</span>
          </button>
          <div className="balance-panel" role="dialog" aria-label="DeepSeek 余额">
            <div className="balance-panel-head">
              <span className="balance-panel-icon"><Wallet size={14} /></span>
              <strong>DeepSeek 余额</strong>
              <span className={`balance-badge badge-${balanceStatus}`}>{balanceBadgeLabel}</span>
              <button className="balance-collapse" onClick={() => setBalanceOpen(false)} aria-label="收起余额面板"><ChevronRight size={15} /></button>
            </div>
            <div className="balance-detail">
              {balanceStatus === 'ok' && <div className="balance-amount">{balance ?? '账号可用'}</div>}
              {balanceStatus === 'error' && (
                <>
                  <div className="balance-amount">—</div>
                  <p className="balance-error-text">余额查询失败：{balanceError || '请稍后重试。'}</p>
                </>
              )}
              {balanceStatus === 'idle' && <p className="balance-hint">{hasCredential ? '点击右侧按钮查询余额。' : '配置 API Key 后可查询'}</p>}
            </div>
            <div className="balance-detail-actions">
              <button className="icon-button" onClick={() => void refreshBalance()} disabled={isTesting || !hasCredential} title="刷新余额" aria-label="刷新余额">
                {isTesting ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
              </button>
            </div>
            <div className="balance-pricing-block">
              <strong>Fetch 计价</strong>
              <p>每 1,000 次成功请求 <em>5 元</em></p>
              <p>约 0.005 元/次；无正文或失败不计费</p>
            </div>
          </div>
        </div>
      </header>

      <main className="layout-main">
        <aside className="sidebar">
          <section className="panel capture-panel">
            <div className="panel-heading">
              <div className="panel-title-wrap">
                <h2>文章链接</h2>
                <span className="count-pill">{articles.length}</span>
              </div>
              <p className="panel-desc">每行一个 URL，支持批量抓取</p>
            </div>
            <label className="sr-only" htmlFor="url-input">文章链接</label>
            <textarea
              id="url-input"
              className="url-textarea"
              value={urlInput}
              onChange={(event) => setUrlInput(event.target.value)}
              placeholder={'https://example.com/article-1\nhttps://example.com/article-2'}
              disabled={isRunning}
              spellCheck={false}
            />
            <div className="capture-actions">
              <button className="button button-gradient button-full" onClick={startCapture} disabled={isRunning}>
                <Zap size={15} /> 开始抓取
              </button>
              <button className="button button-ghost button-full" onClick={stopCapture} disabled={!isRunning}>
                <StopCircle size={15} /> 停止
              </button>
            </div>
            {isRunning && progress.total > 0 && (
              <div className="progress-block">
                <div className="progress-copy">
                  <span>已完成 {progress.done}/{progress.total}{progress.failed > 0 ? ` · 失败 ${progress.failed}` : ''}</span>
                  <span>{progressPercent}%</span>
                </div>
                <div className="progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
              </div>
            )}
          </section>

          <section className="panel library-panel">
            <div className="library-divider">
              <span>———— 文章列表 ————</span>
              <button
                className="library-clear"
                onClick={() => void removeAllArticles()}
                disabled={isRunning}
                title="清空全部本地文章"
              >
                清空
              </button>
            </div>
            <div className="library-alert">
              {articles.length > 0
                ? `本地已保存 ${articles.length} 篇。刷新页面会自动恢复；不会自动删除。除非你手动删除，或清空浏览器缓存/站点数据。`
                : '文章自动保存在本机，刷新可恢复；仅手动删除或清空浏览器缓存后才会消失。'}
            </div>
            {articles.length > 0 && (
              <>
                <div className="search-box">
                  <Search size={14} />
                  <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索标题、链接或正文" aria-label="搜索文章" />
                  {searchQuery && <button className="clear-search" onClick={() => setSearchQuery('')} aria-label="清除搜索"><X size={12} /></button>}
                </div>
                <div className="selection-toolbar">
                  <label className="select-visible-label">
                    <input
                      type="checkbox"
                      checked={allVisibleArticlesSelected}
                      onChange={toggleVisibleArticleSelection}
                      disabled={!filteredArticles.length || isRunning}
                      aria-label={allVisibleArticlesSelected ? '取消选择当前列表' : '选择当前列表'}
                    />
                    <span>{searchQuery ? '全选搜索结果' : '全选文章'}</span>
                  </label>
                  <span className="selection-count">{selectedArticles.length} 已选</span>
                  {selectedArticles.length > 0 && (
                    <div className="selection-actions">
                      <button className="selection-action" onClick={() => void exportSelected()} disabled={isExporting} title="逐篇导出选中文章" aria-label="逐篇导出选中文章">导出</button>
                      <button className="selection-action" onClick={() => void exportSelectedZip()} disabled={isExporting} title="将选中文章打包为 ZIP" aria-label="导出选中文章 ZIP">ZIP</button>
                      <button className="selection-action danger" onClick={() => void removeSelectedArticles()} disabled={isRunning} title="删除选中文章" aria-label="删除选中文章">删除</button>
                      <button className="selection-clear" onClick={clearArticleSelection} title="清除选择" aria-label="清除选择"><X size={11} /></button>
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="article-list">
              {isLoading ? (
                <div className="list-empty"><LoaderCircle className="spin" size={20} /><span>正在读取本地文章</span></div>
              ) : filteredArticles.length === 0 ? (
                <div className="list-empty">
                  <span className="empty-file-icon"><FileText size={20} /></span>
                  <span>{searchQuery ? '没有匹配的文章，试试其他关键词' : '抓取后的文章会出现在这里'}</span>
                </div>
              ) : filteredArticles.map((article) => (
                <div key={article.id} className={`article-row ${activeId === article.id ? 'active' : ''} ${selectedArticleIds.includes(article.id) ? 'is-selected' : ''}`}>
                  <input
                    type="checkbox"
                    className="article-checkbox"
                    checked={selectedArticleIds.includes(article.id)}
                    onChange={() => toggleArticleSelection(article.id)}
                    disabled={isRunning}
                    aria-label={`选择文章 ${article.title || (article.error ? '抓取失败' : '未命名文章')}`}
                  />
                  <button className="article-select" onClick={() => setActiveId(article.id)}>
                    <span className={`article-status ${article.error ? 'is-error' : ''}`} aria-hidden="true" />
                    <span className="article-meta">
                      {/* 目标站失败卡标题保持墨色，仅错误详情为红色，故标题不加 is-error。 */}
                      <strong title={article.error ? '抓取失败' : article.title}>
                        {article.error ? '抓取失败' : article.title || '未命名文章'}
                      </strong>
                      <span title={article.url}>{hostOf(article.url)}</span>
                      {article.error && <em className="article-error">{article.error}</em>}
                    </span>
                  </button>
                  <button className="row-action" onClick={() => downloadArticleFile(article)} aria-label="导出该文章" title="导出该文章 .md"><ArrowDownToLine size={14} /></button>
                  <button className="row-action row-delete" onClick={() => void removeArticle(article)} aria-label="删除该文章" title="删除该文章"><X size={14} /></button>
                </div>
              ))}
            </div>
          </section>

          <div className="wm-promo">
            <strong>导出后，去 WiseMindAI 继续用</strong>
            <p>把 Markdown 导入本地 AI 学习工作台：知识库、对话、批注与复习都在一处，读得更快、记得更牢。</p>
            <a className="button button-gradient button-mini" href={WISEMIND_HOME} target="_blank" rel="noreferrer">打开 WiseMindAI ↗</a>
          </div>
        </aside>

        <section className="editor-panel" aria-label="文章工作区">
          <div className="editor-toolbar">
            <div className="editor-title-block">
              {activeArticle ? (
                <>
                  <input
                    className="editor-title-input"
                    value={activeArticle.title}
                    onChange={(event) => updateActiveArticle({ title: event.target.value })}
                    aria-label="文章标题"
                    placeholder="未命名文章"
                  />
                  <span className="editor-url" title={activeArticle.url}>{activeArticle.url}</span>
                </>
              ) : (
                <span className="editor-title-placeholder">尚未选择文章</span>
              )}
            </div>
            <div className="toolbar-actions">
              <div className="tabs-box" role="group" aria-label="编辑视图">
                <button className={previewMode === 'split' ? 'selected' : ''} onClick={() => setPreviewMode('split')}><Columns2 size={14} /> 分栏</button>
                <button className={previewMode === 'edit' ? 'selected' : ''} onClick={() => setPreviewMode('edit')}><Pencil size={14} /> 编辑</button>
                <button className={previewMode === 'preview' ? 'selected' : ''} onClick={() => setPreviewMode('preview')}><Eye size={14} /> 预览</button>
              </div>
              <button
                className="icon-button"
                onClick={() => { if (activeArticle) void removeArticle(activeArticle); }}
                disabled={!activeArticle || isRunning}
                title="删除当前文章"
                aria-label="删除当前文章"
              >
                <Trash2 size={15} />
              </button>
              <button className="icon-button" onClick={() => void copyMarkdown()} disabled={!activeArticle} title="复制 Markdown" aria-label="复制 Markdown"><Copy size={15} /></button>
              <button className="icon-button" onClick={() => void exportCurrent()} disabled={!activeArticle} title="导出当前 Markdown" aria-label="导出当前 Markdown"><Download size={15} /></button>
            </div>
          </div>
          <div className="workspace-body">
            <div className={`document-workspace mode-${previewMode} theme-${previewTheme}`}>
              {(previewMode === 'edit' || previewMode === 'split') && (
                <div className="markdown-editor-column">
                  <div className="column-heading">
                    <span>Markdown 原文</span>
                    <span className="word-count">{(activeArticle?.markdown.length ?? 0).toLocaleString()} 字</span>
                  </div>
                  <textarea
                    className="markdown-editor"
                    value={activeArticle?.markdown ?? ''}
                    onChange={(event) => updateActiveArticle({ markdown: event.target.value })}
                    aria-label="Markdown 原文编辑器"
                    placeholder="抓取结果会显示在这里，也可以直接粘贴 Markdown 编辑…"
                    disabled={!activeArticle}
                    spellCheck={false}
                  />
                </div>
              )}
              {(previewMode === 'preview' || previewMode === 'split') && (
                <div className="markdown-preview-column">
                  <div className="column-heading">
                    <span>预览</span>
                    <label className="theme-select-wrap">
                      <span className="theme-label">主题</span>
                      <select
                        value={previewTheme}
                        onChange={(event) => changePreviewTheme(event.target.value as PreviewTheme)}
                        aria-label="预览主题"
                      >
                        {PREVIEW_THEMES.map((theme) => (
                          <option key={theme.value} value={theme.value}>{theme.label}</option>
                        ))}
                      </select>
                      <ChevronDown size={11} />
                    </label>
                  </div>
                  {hasPreviewContent ? (
                    <article className="markdown-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                  ) : (
                    <div className="preview-empty">暂无内容</div>
                  )}
                </div>
              )}
            </div>
            {!activeArticle && (
              <div className="workspace-guide">
                <div className="workspace-guide-card">
                  <span className="workspace-guide-icon"><FileText size={22} /></span>
                  <strong>按三步开始：配置 Key → 输入链接 → 抓取</strong>
                  <p>未配置 API Key 时，请先点击右上角绿色「配置 API Key」按钮</p>
                  {hasCredential ? (
                    <button className="button button-gradient" onClick={() => document.getElementById('url-input')?.focus()}>
                      <ArrowRight size={14} /> 去输入文章链接
                    </button>
                  ) : (
                    <button className="button button-gradient" onClick={() => setSettingsOpen(true)}>
                      <KeyRound size={14} /> 配置 API Key
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </main>

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="drawer-heading">
              <div>
                <h2 id="settings-title">DeepSeek API 配置</h2>
                <p>与应用内「网页读取 · DeepSeek」一致：POST Fetch，返回 title + Markdown</p>
              </div>
              <button className="icon-button drawer-close" onClick={() => setSettingsOpen(false)} aria-label="关闭配置"><X size={16} /></button>
            </div>
            <div className="notice notice-warning"><AlertTriangle size={14} /><span><strong>必须先填写 API Key</strong>Key 仅保存在本机浏览器的 localStorage，不会上传到 WiseMindAI 服务器。</span></div>
            <div className="form-field">
              <div className="field-label-row">
                <label htmlFor="api-key">API Key <span className="required-mark">*</span></label>
                <button type="button" className="text-toggle" onClick={() => setShowApiKey((value) => !value)}>{showApiKey ? '隐藏' : '显示'}</button>
              </div>
              <div className="key-field-row">
                <div className="key-input-wrap">
                  <input
                    id="api-key"
                    type={showApiKey ? 'text' : 'password'}
                    value={settings.apiKey}
                    onChange={(event) => updateSettings('apiKey', event.target.value)}
                    placeholder="sk-…"
                    autoComplete="off"
                  />
                </div>
                <button type="button" className="button key-clear" onClick={() => updateSettings('apiKey', '')} aria-label="清空输入">
                  <Trash2 size={13} /> 清空
                </button>
              </div>
              <div className="field-hint">
                <a href={DEEPSEEK_API_KEYS_URL} target="_blank" rel="noreferrer">前往 DeepSeek 获取 Key</a>
                <label htmlFor="api-base-url">请求地址</label>
              </div>
              <input
                id="api-base-url"
                className="text-input"
                value={settings.apiBaseUrl}
                onChange={(event) => updateSettings('apiBaseUrl', event.target.value)}
                placeholder={DEFAULT_API_BASE_URL}
              />
              <div className="field-hint">默认：{DEFAULT_API_BASE_URL}</div>
              <details className="advanced-token">
                <summary>内置 API 访问 Token（授权用户）</summary>
                <input
                  id="builtin-token"
                  className="text-input"
                  type="password"
                  value={settings.builtinAccessToken}
                  onChange={(event) => updateSettings('builtinAccessToken', event.target.value)}
                  placeholder="由服务方提供的访问 Token"
                  autoComplete="off"
                />
                <div className="field-hint">填写后抓取将使用服务端内置 Key，无需自己的 API Key；Token 与 Key 一样只保存在本机浏览器。填错会被拒绝且不会回退。</div>
              </details>
            </div>
            <div className="form-field">
              <label htmlFor="delay-ms">并发间隔（ms）</label>
              <input
                id="delay-ms"
                className="text-input"
                type="number"
                min={250}
                max={10000}
                step={50}
                value={settings.delayMs}
                onChange={(event) => updateSettings('delayMs', Number(event.target.value))}
              />
              <div className="field-hint">账号 Fetch QPS 上限约 5，建议 ≥ 250ms</div>
            </div>
            <div className="notice notice-warning"><CircleDollarSign size={14} /><span><strong>Fetch 计价：每 1,000 次成功请求 5 元</strong>约 0.005 元/次。无正文或失败通常不计费。顶部会显示账号余额，可随时点刷新。</span></div>
            <div className="notice notice-info"><Info size={14} /><span><strong>浏览器 CORS 说明</strong>直接在浏览器打开本页请求 DeepSeek 时，可能被 CORS 拦截。若失败，可用本地代理改写请求地址，或在支持跨域的环境中打开本工具。</span></div>
            <div className="request-sample">
              <span>请求示例</span>
              <pre>{`{
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "Authorization": "Bearer <API_KEY>"
  },
  "body": { "url": "https://example.com" }
}`}</pre>
            </div>
            {balanceStatus === 'ok' && <div className="connection-result success"><CheckCircle2 size={14} /> 连接成功：{balance ?? '账号可用'}</div>}
            {balanceStatus === 'error' && <div className="connection-result error"><AlertCircle size={14} /> {balanceError || '连接失败，请检查 Key 与网络。'}</div>}
            <div className="drawer-actions">
              <button className="danger-text" onClick={clearApiKey}><Trash2 size={13} /> 清空 API Key</button>
              <div className="drawer-actions-right">
                <button className="button button-outline" onClick={() => void testConnection()} disabled={isTesting}>✓ 测试连接</button>
                <button className="button button-primary" onClick={persistSettings}>✓ 保存配置</button>
              </div>
            </div>
          </section>
        </div>
      )}

      {onboardOpen && (
        <div className="onboard-backdrop" role="presentation">
          <section className="onboard-card" role="dialog" aria-modal="true" aria-labelledby="onboard-title">
            <div className="onboard-head">
              <span className="brand-mark brand-mark-small" aria-hidden="true">W</span>
              <div>
                <h2 id="onboard-title">开始使用前，先完成三步</h2>
                <p>本工具通过 DeepSeek Fetch 把网页转成可编辑的 Markdown。首次使用请按顺序操作。</p>
              </div>
            </div>
            <ol className="onboard-steps">
              <li className="onboard-step is-required">
                <span className="step-index">1</span>
                <div className="step-body">
                  <div className="step-head">
                    <strong>配置 DeepSeek API Key</strong>
                    <span className="badge-required">必做</span>
                  </div>
                  <p>打开「配置 API Key」，粘贴你的 Key 并保存。没有 Key 无法抓取任何网页。可在 <a href={DEEPSEEK_API_KEYS_URL} target="_blank" rel="noreferrer">DeepSeek 控制台</a> 免费创建。</p>
                </div>
              </li>
              <li className="onboard-step">
                <span className="step-index">2</span>
                <div className="step-body">
                  <strong>输入文章链接</strong>
                  <p>在左侧文本框粘贴一个或多个 URL，每行一条，支持批量。</p>
                </div>
              </li>
              <li className="onboard-step">
                <span className="step-index">3</span>
                <div className="step-body">
                  <strong>开始抓取并编辑</strong>
                  <p>点击「开始抓取」。在右侧分栏编辑 / 预览 Markdown，再导出单个文件或 ZIP 包。</p>
                </div>
              </li>
            </ol>
            <div className="notice notice-info"><Info size={14} /><span><strong>抓取与编辑的内容会自动保存在本机浏览器</strong>，刷新页面后仍可继续编辑。只有你手动删除，或清空浏览器缓存/站点数据时才会消失。</span></div>
            <div className="onboard-promo">
              <strong>下一步：在 WiseMindAI 里用起来</strong>
              <p>导出的 Markdown 可直接放进本地 AI 学习工作台，做知识库检索、对话与复习，比单独存文件更高效。</p>
              <a className="onboard-promo-link" href={WISEMIND_HOME} target="_blank" rel="noreferrer">了解 WiseMindAI <ExternalLink size={11} /></a>
            </div>
            <div className="onboard-actions">
              <label className="onboard-remember">
                <input type="checkbox" checked={onboardDontShow} onChange={(event) => setOnboardDontShow(event.target.checked)} />
                <span>下次不再自动弹出</span>
              </label>
              <div className="onboard-actions-right">
                <button className="button button-ghost" onClick={dismissOnboard}>稍后再说</button>
                <button className="button button-gradient" onClick={openConfiguration}><KeyRound size={14} /> 去配置 API Key</button>
              </div>
            </div>
          </section>
        </div>
      )}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast toast-${item.kind}`} role="status">
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
