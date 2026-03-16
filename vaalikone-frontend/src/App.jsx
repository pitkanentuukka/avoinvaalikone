import { useState, useEffect, useMemo, useCallback, createContext, useContext } from "react";
import translations from "./translations";

// ─── API Configuration ───
// Override with VITE_API_BASE env var at build time; defaults to same-origin /api (proxy)
const API_BASE = import.meta.env.VITE_API_BASE || "/api";

// ─── Language ───
const DEFAULT_LANG = import.meta.env.VITE_DEFAULT_LANG || "fi";
const LanguageContext = createContext({ lang: DEFAULT_LANG, t: translations[DEFAULT_LANG], setLang: () => {} });

function useTranslation() {
  return useContext(LanguageContext);
}

// ─── API Client ───
function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function mapKeys(obj, fn) {
  if (Array.isArray(obj)) return obj.map((item) => mapKeys(item, fn));
  if (obj && typeof obj === "object" && !(obj instanceof Date)) {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [fn(k), mapKeys(v, fn)])
    );
  }
  return obj;
}

const toCamel = (data) => mapKeys(data, snakeToCamel);
const toSnake = (data) => mapKeys(data, camelToSnake);

async function apiFetch(path, options = {}) {
  const { body, adminSecret, ...rest } = options;
  const headers = { "Content-Type": "application/json", ...rest.headers };
  if (adminSecret) headers["Authorization"] = `Bearer ${adminSecret}`;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Server error" }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  const data = await res.json();
  return toCamel(data);
}

const api = {
  // Public
  getQuestionSets: () => apiFetch("/question-sets"),
  getCandidates: () => apiFetch("/candidates"),
  getCandidate: (id) => apiFetch(`/candidates/${id}`),
  submitQuestionSet: (data) => apiFetch("/question-sets", { method: "POST", body: data }),
  voterMatch: (data) => apiFetch("/voter/match", { method: "POST", body: data }),

  // Party-token gated
  getPartyCandidates: (token) => apiFetch(`/candidates/party/${token}`),
  createCandidate: (token, data) =>
    apiFetch(`/candidates/party/${token}`, { method: "POST", body: data }),
  updateCandidate: (token, id, data) =>
    apiFetch(`/candidates/party/${token}/candidates/${id}`, { method: "PUT", body: data }),
  saveAnswers: (token, id, answers) =>
    apiFetch(`/candidates/party/${token}/candidates/${id}/answers`, {
      method: "PUT",
      body: { answers },
    }),

  // Admin
  getParties: (secret) => apiFetch("/admin/parties", { adminSecret: secret }),
  createParty: (secret, data) =>
    apiFetch("/admin/parties", { method: "POST", body: data, adminSecret: secret }),
  deleteParty: (secret, id) =>
    apiFetch(`/admin/parties/${id}`, { method: "DELETE", adminSecret: secret }),
  getAllQuestionSets: (secret) => apiFetch("/admin/question-sets", { adminSecret: secret }),
  approveQuestionSet: (secret, id) =>
    apiFetch(`/admin/question-sets/${id}/approve`, { method: "PATCH", adminSecret: secret }),
  rejectQuestionSet: (secret, id) =>
    apiFetch(`/admin/question-sets/${id}/reject`, { method: "PATCH", adminSecret: secret }),
  hideQuestionSet: (secret, id) =>
    apiFetch(`/admin/question-sets/${id}/hide`, { method: "PATCH", adminSecret: secret }),
  unhideQuestionSet: (secret, id) =>
    apiFetch(`/admin/question-sets/${id}/unhide`, { method: "PATCH", adminSecret: secret }),
  deleteQuestionSet: (secret, id) =>
    apiFetch(`/admin/question-sets/${id}`, { method: "DELETE", adminSecret: secret }),
};

// ─── Finnish constituencies ───
const FI_CONSTITUENCIES = [
  "Helsingin vaalipiiri",
  "Uudenmaan vaalipiiri",
  "Varsinais-Suomen vaalipiiri",
  "Satakunnan vaalipiiri",
  "Ahvenanmaan maakunnan vaalipiiri",
  "Hämeen vaalipiiri",
  "Pirkanmaan vaalipiiri",
  "Kaakkois-Suomen vaalipiiri",
  "Savo-Karjalan vaalipiiri",
  "Vaasan vaalipiiri",
  "Keski-Suomen vaalipiiri",
  "Oulun vaalipiiri",
  "Lapin vaalipiiri",
];

// ─── Constants ───
function useLabels() {
  const { t } = useTranslation();
  return useMemo(() => [t.stronglyDisagree, t.disagree, t.neutral, t.agree, t.stronglyAgree], [t]);
}

function useWeightLabels() {
  const { t } = useTranslation();
  return useMemo(() => [t.notImportant, t.somewhat, t.important, t.veryImportant], [t]);
}

const palette = {
  bg: "#FAF9F6", surface: "#FFFFFF", surfaceAlt: "#F3F1ED",
  border: "#E2DFD8", borderHover: "#C8C3BA",
  text: "#1A1A1A", textMuted: "#6B6560", textLight: "#9B958E",
  accent: "#2D5A3D", accentLight: "#E8F0EB", accentHover: "#3A7350",
  warn: "#C4652A", warnLight: "#FDF0E8",
  danger: "#A63D2F", dangerLight: "#FCEAE8",
  info: "#2A5C8C", infoLight: "#E8F0F8",
};

// ─── Shared UI Components ───

function Spinner({ size = 20 }) {
  return (
    <div style={{
      width: size, height: size, border: `2.5px solid ${palette.border}`,
      borderTopColor: palette.accent, borderRadius: "50%",
      animation: "spin 0.7s linear infinite", display: "inline-block",
    }} />
  );
}

function LoadingState({ text }) {
  const { t } = useTranslation();
  return (
    <div style={{ padding: "60px 24px", textAlign: "center" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <Spinner size={28} />
      <div style={{ marginTop: "12px", color: palette.textMuted, fontSize: "14px" }}>{text || t.loading}</div>
    </div>
  );
}

function ErrorBanner({ message, onRetry }) {
  const { t } = useTranslation();
  return (
    <div style={{
      padding: "14px 20px", borderRadius: "8px", background: palette.dangerLight,
      border: `1px solid #E8C0BA`, color: palette.danger, fontSize: "14px",
      display: "flex", justifyContent: "space-between", alignItems: "center",
      marginBottom: "20px",
    }}>
      <span>{message}</span>
      {onRetry && (
        <button onClick={onRetry} style={{
          background: "none", border: `1px solid ${palette.danger}`, borderRadius: "4px",
          padding: "4px 12px", color: palette.danger, cursor: "pointer", fontSize: "12px",
          fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 600,
        }}>{t.retry}</button>
      )}
    </div>
  );
}

function Badge({ children, color = "default" }) {
  const colors = {
    default: { bg: palette.surfaceAlt, text: palette.textMuted, border: palette.border },
    green: { bg: palette.accentLight, text: palette.accent, border: "#C5D9CC" },
    orange: { bg: palette.warnLight, text: palette.warn, border: "#E8D0BE" },
    blue: { bg: palette.infoLight, text: palette.info, border: "#B8D0E8" },
  };
  const c = colors[color] || colors.default;
  return (
    <span style={{
      display: "inline-block", padding: "3px 10px", borderRadius: "4px", fontSize: "12px",
      fontWeight: 600, letterSpacing: "0.03em", textTransform: "uppercase",
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>{children}</span>
  );
}

function Button({ children, onClick, variant = "primary", size = "md", disabled, loading, style: extra }) {
  const base = {
    cursor: disabled || loading ? "not-allowed" : "pointer", border: "none", borderRadius: "6px",
    fontWeight: 600, fontFamily: "'Source Serif 4', Georgia, serif", transition: "all 0.15s",
    opacity: disabled || loading ? 0.5 : 1, letterSpacing: "0.01em",
    padding: size === "sm" ? "7px 14px" : size === "lg" ? "14px 28px" : "10px 20px",
    fontSize: size === "sm" ? "13px" : size === "lg" ? "16px" : "14px",
    display: "inline-flex", alignItems: "center", gap: "8px",
  };
  const variants = {
    primary: { background: palette.accent, color: "#fff" },
    secondary: { background: "transparent", color: palette.accent, border: `1.5px solid ${palette.accent}` },
    ghost: { background: "transparent", color: palette.textMuted, border: `1px solid ${palette.border}` },
    danger: { background: palette.danger, color: "#fff" },
  };
  return (
    <button onClick={onClick} disabled={disabled || loading} style={{ ...base, ...variants[variant], ...extra }}>
      {loading && <Spinner size={14} />}{children}
    </button>
  );
}

function Card({ children, style: extra, onClick }) {
  return (
    <div onClick={onClick} style={{
      background: palette.surface, border: `1px solid ${palette.border}`, borderRadius: "10px",
      padding: "24px", cursor: onClick ? "pointer" : "default",
      transition: "border-color 0.15s, box-shadow 0.15s", ...extra,
    }}>{children}</div>
  );
}

function ScaleInput({ value, onChange }) {
  const labels = useLabels();
  return (
    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
      {labels.map((label, i) => (
        <button key={i} onClick={() => onChange(i)} style={{
          padding: "8px 14px", borderRadius: "6px", border: `1.5px solid ${value === i ? palette.accent : palette.border}`,
          background: value === i ? palette.accentLight : "transparent",
          color: value === i ? palette.accent : palette.textMuted,
          fontWeight: value === i ? 700 : 500, fontSize: "13px", cursor: "pointer",
          fontFamily: "'Source Serif 4', Georgia, serif", transition: "all 0.15s",
        }}>{label}</button>
      ))}
    </div>
  );
}

function TextArea({ value, onChange, placeholder, rows = 3 }) {
  return (
    <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows}
      style={{
        width: "100%", padding: "12px 14px", borderRadius: "6px", border: `1px solid ${palette.border}`,
        fontFamily: "'Source Serif 4', Georgia, serif", fontSize: "14px", resize: "vertical",
        background: palette.surface, color: palette.text, outline: "none", boxSizing: "border-box",
      }} />
  );
}

function Input({ value, onChange, placeholder, type = "text" }) {
  return (
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      style={{
        width: "100%", padding: "10px 14px", borderRadius: "6px", border: `1px solid ${palette.border}`,
        fontFamily: "'Source Serif 4', Georgia, serif", fontSize: "14px",
        background: palette.surface, color: palette.text, outline: "none", boxSizing: "border-box",
      }} />
  );
}

function ProgressBar({ value, max = 100, color = palette.accent }) {
  return (
    <div style={{ width: "100%", height: "10px", background: palette.surfaceAlt, borderRadius: "5px", overflow: "hidden" }}>
      <div style={{
        width: `${(value / max) * 100}%`, height: "100%", background: color,
        borderRadius: "5px", transition: "width 0.6s cubic-bezier(0.4, 0, 0.2, 1)",
      }} />
    </div>
  );
}

function Avatar({ src, name, size = 48 }) {
  const [err, setErr] = useState(false);
  const initials = name?.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase() || "?";
  if (!src || err) {
    return (
      <div style={{
        width: size, height: size, borderRadius: "50%", background: palette.accentLight,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: 700, fontSize: size * 0.36, color: palette.accent, flexShrink: 0,
        border: `2px solid ${palette.border}`,
      }}>{initials}</div>
    );
  }
  return <img src={src} alt={name} onError={() => setErr(true)} style={{ width: size, height: size, borderRadius: "50%", objectFit: "cover", flexShrink: 0, border: `2px solid ${palette.border}` }} />;
}

function NgoLogo({ src, name, size = 40 }) {
  const [err, setErr] = useState(false);
  if (!src || err) {
    return (
      <div style={{
        width: size, height: size, borderRadius: "8px", background: palette.surfaceAlt,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: 800, fontSize: size * 0.4, color: palette.textLight, flexShrink: 0,
        border: `1px solid ${palette.border}`,
      }}>{name?.[0]?.toUpperCase() || "?"}</div>
    );
  }
  return <img src={src} alt={name} onError={() => setErr(true)} style={{ width: size, height: size, borderRadius: "8px", objectFit: "contain", flexShrink: 0, background: palette.surfaceAlt, padding: "4px", border: `1px solid ${palette.border}` }} />;
}

// ─── Language Selector ───
function LanguageSelector() {
  const { lang, setLang } = useTranslation();
  return (
    <select
      value={lang}
      onChange={(e) => setLang(e.target.value)}
      style={{
        padding: "4px 8px", borderRadius: "4px", border: `1px solid ${palette.border}`,
        background: palette.surface, color: palette.textMuted, fontSize: "13px",
        fontFamily: "'Source Serif 4', Georgia, serif", cursor: "pointer", outline: "none",
      }}
    >
      <option value="fi">Suomi</option>
      <option value="en">English</option>
    </select>
  );
}

// ─── Candidate Profile Modal ───
function CandidateProfile({ candidate, onClose, activeQuestions, voterAnswers }) {
  const { t } = useTranslation();
  const labels = useLabels();
  if (!candidate) return null;
  const hasVoterAnswers = voterAnswers && Object.keys(voterAnswers).length > 0;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: palette.bg, borderRadius: "14px", maxWidth: 600, width: "100%", maxHeight: "85vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
        <div style={{ background: `linear-gradient(135deg, ${palette.accent}, ${palette.accentHover})`, padding: "36px 32px 28px", borderRadius: "14px 14px 0 0", color: "#fff", position: "relative" }}>
          <button onClick={onClose} style={{ position: "absolute", top: 12, right: 16, background: "rgba(255,255,255,0.2)", border: "none", color: "#fff", width: 32, height: 32, borderRadius: "50%", cursor: "pointer", fontSize: "16px", fontWeight: 700 }}>×</button>
          <div style={{ display: "flex", gap: "20px", alignItems: "center" }}>
            <Avatar src={candidate.photoUrl} name={candidate.name} size={80} />
            <div>
              <div style={{ fontSize: "24px", fontWeight: 800, marginBottom: "4px" }}>{candidate.name}</div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                <Badge color="blue">{candidate.partyName}</Badge>
                {candidate.constituency && <Badge color="blue">{candidate.constituency}</Badge>}
              </div>
            </div>
          </div>
        </div>
        <div style={{ padding: "28px 32px" }}>
          {candidate.bio && (
            <div style={{ marginBottom: "24px" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: palette.textLight, marginBottom: "8px" }}>{t.profileIntro}</div>
              <p style={{ fontSize: "15px", lineHeight: 1.7, color: palette.text, margin: 0 }}>{candidate.bio}</p>
            </div>
          )}
          {activeQuestions && activeQuestions.length > 0 && (
            <div>
              <div style={{ fontSize: "12px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: palette.textLight, marginBottom: "12px" }}>{t.profileAnswers}</div>
              {activeQuestions.map((q) => {
                const ca = candidate.answers?.[q.id];
                if (!ca) return null;
                const va = hasVoterAnswers ? voterAnswers[q.id] : undefined;
                return (
                  <div key={q.id} style={{ marginBottom: "16px", paddingBottom: "16px", borderBottom: `1px solid ${palette.border}` }}>
                    <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>{q.statement}</div>
                    <div style={{ display: "flex", gap: "12px", fontSize: "13px", flexWrap: "wrap", marginBottom: ca.explanation ? "8px" : 0 }}>
                      <span style={{ color: palette.accent, fontWeight: 600 }}>{labels[ca.value]}</span>
                      {va !== undefined && <span style={{ color: palette.textMuted }}>{t.profileYou}: <strong>{labels[va]}</strong></span>}
                    </div>
                    {ca.explanation && (
                      <div style={{ padding: "8px 12px", background: palette.surfaceAlt, borderRadius: "6px", fontSize: "13px", color: palette.textMuted, fontStyle: "italic", borderLeft: `3px solid ${palette.border}` }}>"{ca.explanation}"</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Header ───
function Header({ view, setView, setPartyToken }) {
  const { t } = useTranslation();
  return (
    <header style={{ background: palette.surface, borderBottom: `1px solid ${palette.border}`, padding: "0 32px", position: "sticky", top: 0, zIndex: 100 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: "64px" }}>
        <div onClick={() => { setView("home"); setPartyToken(null); }} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ width: 32, height: 32, borderRadius: "6px", background: palette.accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: "16px", fontFamily: "'Source Serif 4', Georgia, serif" }}>V</div>
          <span style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 700, fontSize: "18px", color: palette.text, letterSpacing: "-0.02em" }}>{t.appName}</span>
          <span style={{ fontSize: "11px", color: palette.textLight, fontWeight: 500, marginLeft: "-4px" }}>{t.appYear}</span>
        </div>
        <nav style={{ display: "flex", gap: "4px", alignItems: "center" }}>
          {[{ key: "home", label: t.navHome }, { key: "voter", label: t.navVoter }, { key: "ngo", label: t.navNgo }, { key: "admin", label: t.navAdmin }, { key: "about", label: t.navAbout }].map((item) => (
            <button key={item.key} onClick={() => { setView(item.key); if (item.key !== "candidate") setPartyToken(null); }}
              style={{
                padding: "6px 14px", borderRadius: "5px", border: "none", cursor: "pointer",
                background: view === item.key ? palette.accentLight : "transparent",
                color: view === item.key ? palette.accent : palette.textMuted,
                fontWeight: view === item.key ? 700 : 500, fontSize: "13px",
                fontFamily: "'Source Serif 4', Georgia, serif", transition: "all 0.15s",
              }}>{item.label}</button>
          ))}
          <LanguageSelector />
        </nav>
      </div>
    </header>
  );
}

// ─── Home ───
function HomeView({ setView, setPartyToken }) {
  const { t } = useTranslation();
  const [tokenInput, setTokenInput] = useState("");
  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 24px", textAlign: "center" }}>
      <h1 style={{ fontSize: "42px", fontWeight: 800, letterSpacing: "-0.03em", marginBottom: "16px", lineHeight: 1.1 }}>{t.homeTitle}</h1>
      <p style={{ fontSize: "17px", color: palette.textMuted, lineHeight: 1.6, maxWidth: 520, margin: "0 auto 48px" }}>
        {t.homeSubtitle}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: 400, margin: "0 auto" }}>
        <Card style={{ cursor: "pointer", textAlign: "left" }} onClick={() => setView("voter")}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: palette.accent, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{t.homeVoterLabel}</div>
          <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "4px" }}>{t.homeVoterTitle}</div>
          <div style={{ fontSize: "13px", color: palette.textMuted }}>{t.homeVoterDesc}</div>
        </Card>
        <Card style={{ cursor: "pointer", textAlign: "left" }} onClick={() => setView("ngo")}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: palette.warn, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{t.homeNgoLabel}</div>
          <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "4px" }}>{t.homeNgoTitle}</div>
          <div style={{ fontSize: "13px", color: palette.textMuted }}>{t.homeNgoDesc}</div>
        </Card>
        <Card style={{ textAlign: "left" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: palette.info, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{t.homeCandidateLabel}</div>
          <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "8px" }}>{t.homeCandidateTitle}</div>
          <div style={{ fontSize: "13px", color: palette.textMuted, marginBottom: "12px" }}>{t.homeCandidateDesc}</div>
          <div style={{ display: "flex", gap: "8px" }}>
            <Input value={tokenInput} onChange={setTokenInput} placeholder={t.homeCandidatePlaceholder} />
            <Button onClick={() => { if (tokenInput.trim()) { setPartyToken(tokenInput.trim()); setView("candidate"); } }} disabled={!tokenInput.trim()} style={{ flexShrink: 0 }}>{t.homeGo}</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── About ───
function AboutView() {
  const { t } = useTranslation();
  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "60px 24px" }}>
      <h1 style={{ fontSize: "42px", fontWeight: 800, letterSpacing: "-0.03em", marginBottom: "48px", lineHeight: 1.1, textAlign: "center" }}>{t.aboutTitle}</h1>

      <div style={{ marginBottom: "48px" }}>
        <h2 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "16px", color: palette.accent }}>{t.aboutIntroTitle}</h2>
        <p style={{ fontSize: "16px", lineHeight: 1.8, color: palette.text, margin: 0 }}>{t.aboutIntroText}</p>
      </div>

      <div style={{ marginBottom: "48px", padding: "24px", background: palette.accentLight, borderRadius: "10px", border: `1px solid ${palette.accent}` }}>
        <h2 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "16px", color: palette.accent, marginTop: 0 }}>{t.aboutMultiNgoTitle}</h2>
        <p style={{ fontSize: "16px", lineHeight: 1.8, color: palette.text, margin: 0 }}>{t.aboutMultiNgoText}</p>
      </div>

      <div style={{ marginBottom: "48px" }}>
        <h2 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "16px", color: palette.accent }}>{t.aboutFlexibilityTitle}</h2>
        <p style={{ fontSize: "16px", lineHeight: 1.8, color: palette.text, margin: 0 }}>{t.aboutFlexibilityText}</p>
      </div>

      <div style={{ marginBottom: "48px" }}>
        <h2 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "24px", color: palette.accent }}>{t.aboutHowTitle}</h2>

        <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
          <Card style={{ background: palette.surfaceAlt }}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "8px", color: palette.text }}>{t.aboutHow1Title}</h3>
            <p style={{ fontSize: "14px", lineHeight: 1.7, color: palette.textMuted, margin: 0 }}>{t.aboutHow1Text}</p>
          </Card>

          <Card style={{ background: palette.surfaceAlt }}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "8px", color: palette.text }}>{t.aboutHow2Title}</h3>
            <p style={{ fontSize: "14px", lineHeight: 1.7, color: palette.textMuted, margin: 0 }}>{t.aboutHow2Text}</p>
          </Card>

          <Card style={{ background: palette.surfaceAlt }}>
            <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "8px", color: palette.text }}>{t.aboutHow3Title}</h3>
            <p style={{ fontSize: "14px", lineHeight: 1.7, color: palette.textMuted, margin: 0 }}>{t.aboutHow3Text}</p>
          </Card>
        </div>
      </div>

      <div style={{ marginBottom: "48px" }}>
        <h2 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "16px", color: palette.accent }}>{t.aboutWhyTitle}</h2>
        <p style={{ fontSize: "16px", lineHeight: 1.8, color: palette.text, margin: 0 }}>{t.aboutWhyText}</p>
      </div>

      <div style={{ marginBottom: "48px" }}>
        <h2 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "16px", color: palette.accent }}>{t.aboutTransparencyTitle}</h2>
        <p style={{ fontSize: "16px", lineHeight: 1.8, color: palette.text, margin: 0 }}>{t.aboutTransparencyText}</p>
      </div>

      <div>
        <h2 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "16px", color: palette.accent }}>{t.aboutPrivacyTitle}</h2>
        <p style={{ fontSize: "16px", lineHeight: 1.8, color: palette.text, margin: 0 }}>{t.aboutPrivacyText}</p>
      </div>
    </div>
  );
}

// ─── Admin ───
function AdminView() {
  const { t } = useTranslation();
  const [adminSecret, setAdminSecret] = useState("");
  const [authed, setAuthed] = useState(false);
  const [parties, setParties] = useState([]);
  const [questionSets, setQuestionSets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [newPartyName, setNewPartyName] = useState("");
  const [newPartyEmail, setNewPartyEmail] = useState("");
  const [actionLoading, setActionLoading] = useState(null);

  async function login() {
    setLoading(true);
    setError(null);
    try {
      const p = await api.getParties(adminSecret);
      setParties(p);
      const qs = await api.getAllQuestionSets(adminSecret);
      setQuestionSets(qs);
      setAuthed(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function refresh() {
    try {
      setParties(await api.getParties(adminSecret));
      setQuestionSets(await api.getAllQuestionSets(adminSecret));
    } catch (e) {
      setError(e.message);
    }
  }

  async function approveSet(id) {
    setActionLoading(id);
    try {
      await api.approveQuestionSet(adminSecret, id);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function rejectSet(id) {
    setActionLoading(id);
    try {
      await api.rejectQuestionSet(adminSecret, id);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function hideSet(id) {
    setActionLoading(id);
    try {
      await api.hideQuestionSet(adminSecret, id);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function unhideSet(id) {
    setActionLoading(id);
    try {
      await api.unhideQuestionSet(adminSecret, id);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function deleteSet(id) {
    if (import.meta.env.VITE_NODE_ENV !== "development" && !window.confirm(t.adminDeleteConfirm)) return;
    setActionLoading(id);
    try {
      await api.deleteQuestionSet(adminSecret, id);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function removeParty(id) {
    if (import.meta.env.VITE_NODE_ENV !== "development" && !window.confirm(t.adminDeletePartyConfirm)) return;
    setActionLoading(id);
    try {
      await api.deleteParty(adminSecret, id);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function addParty() {
    if (!newPartyName.trim()) return;
    setActionLoading("new-party");
    try {
      await api.createParty(adminSecret, { name: newPartyName.trim(), email: newPartyEmail.trim() || null });
      setNewPartyName(""); setNewPartyEmail("");
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  if (!authed) {
    return (
      <div style={{ maxWidth: 400, margin: "0 auto", padding: "80px 24px", textAlign: "center" }}>
        <h2 style={{ fontSize: "24px", fontWeight: 800, marginBottom: "8px" }}>{t.adminLoginTitle}</h2>
        <p style={{ color: palette.textMuted, marginBottom: "24px", fontSize: "14px" }}>{t.adminLoginDesc}</p>
        {error && <ErrorBanner message={error} />}
        <Input value={adminSecret} onChange={setAdminSecret} placeholder={t.adminPasswordPlaceholder} type="password" />
        <div style={{ marginTop: "12px" }}>
          <Button onClick={login} loading={loading} disabled={!adminSecret}>{t.adminLogin}</Button>
        </div>
      </div>
    );
  }

  const pending = questionSets.filter((s) => s.status === "pending");
  const approved = questionSets.filter((s) => s.status === "approved" && !s.hidden);
  const hidden = questionSets.filter((s) => s.hidden);
  const rejected = questionSets.filter((s) => s.status === "rejected" && !s.hidden);

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 24px" }}>
      <h2 style={{ fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", marginBottom: "8px" }}>{t.adminPanelTitle}</h2>
      <p style={{ color: palette.textMuted, marginBottom: "36px" }}>{t.adminPanelDesc}</p>
      {error && <ErrorBanner message={error} onRetry={refresh} />}

      <section style={{ marginBottom: "40px" }}>
        <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px", display: "flex", alignItems: "center", gap: "10px" }}>
          {t.adminPending} {pending.length > 0 && <Badge color="orange">{pending.length}</Badge>}
        </h3>
        {pending.length === 0 && <p style={{ color: palette.textLight, fontSize: "14px" }}>{t.adminNoPending}</p>}
        {pending.map((qs) => (
          <Card key={qs.id} style={{ marginBottom: "12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                  <NgoLogo src={qs.logoUrl} name={qs.ngoName} size={28} />
                  <div style={{ fontWeight: 700, fontSize: "16px" }}>{qs.title}</div>
                </div>
                <div style={{ fontSize: "13px", color: palette.textMuted }}>{qs.ngoName} · {qs.questions?.length || 0} {t.adminQuestions}</div>
                <div style={{ marginTop: "12px" }}>
                  {qs.questions?.map((q, i) => (
                    <div key={q.id} style={{ fontSize: "13px", color: palette.text, marginBottom: "4px" }}>
                      <span style={{ color: palette.textLight, marginRight: "6px" }}>{i + 1}.</span>{q.statement}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                <Button variant="primary" size="sm" onClick={() => approveSet(qs.id)} loading={actionLoading === qs.id}>{t.adminApprove}</Button>
                <Button variant="danger" size="sm" onClick={() => rejectSet(qs.id)} loading={actionLoading === qs.id}>{t.adminReject}</Button>
                <Button variant="danger" size="sm" onClick={() => deleteSet(qs.id)} loading={actionLoading === qs.id}>{t.adminDelete}</Button>
              </div>
            </div>
          </Card>
        ))}
      </section>

      <section style={{ marginBottom: "40px" }}>
        <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px" }}>{t.adminApproved} <Badge color="green">{approved.length}</Badge></h3>
        {approved.map((qs) => (
          <Card key={qs.id} style={{ marginBottom: "8px", padding: "16px 24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <NgoLogo src={qs.logoUrl} name={qs.ngoName} size={24} />
                <span style={{ fontWeight: 600 }}>{qs.title}</span>
                <span style={{ color: palette.textMuted, fontSize: "13px" }}>— {qs.ngoName} · {qs.questions?.length || 0} {t.adminQuestions}</span>
              </div>
              <div style={{ display: "flex", gap: "8px", flexShrink: 0, alignItems: "center" }}>
                <Badge color="green">{t.adminPublished}</Badge>
                <Button variant="secondary" size="sm" onClick={() => hideSet(qs.id)} loading={actionLoading === qs.id}>{t.adminHide}</Button>
                <Button variant="danger" size="sm" onClick={() => deleteSet(qs.id)} loading={actionLoading === qs.id}>{t.adminDelete}</Button>
              </div>
            </div>
          </Card>
        ))}
      </section>

      {hidden.length > 0 && (
        <section style={{ marginBottom: "40px" }}>
          <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px" }}>{t.adminHidden} <Badge color="gray">{hidden.length}</Badge></h3>
          {hidden.map((qs) => (
            <Card key={qs.id} style={{ marginBottom: "8px", padding: "16px 24px", opacity: 0.7 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <NgoLogo src={qs.logoUrl} name={qs.ngoName} size={24} />
                  <span style={{ fontWeight: 600 }}>{qs.title}</span>
                  <span style={{ color: palette.textMuted, fontSize: "13px" }}>— {qs.ngoName}</span>
                </div>
                <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                  <Button variant="secondary" size="sm" onClick={() => unhideSet(qs.id)} loading={actionLoading === qs.id}>{t.adminUnhide}</Button>
                  <Button variant="danger" size="sm" onClick={() => deleteSet(qs.id)} loading={actionLoading === qs.id}>{t.adminDelete}</Button>
                </div>
              </div>
            </Card>
          ))}
        </section>
      )}

      {rejected.length > 0 && (
        <section style={{ marginBottom: "40px" }}>
          <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px" }}>{t.adminRejected}</h3>
          {rejected.map((qs) => (
            <Card key={qs.id} style={{ marginBottom: "8px", padding: "16px 24px", opacity: 0.6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
                <div>
                  <span style={{ fontWeight: 600 }}>{qs.title}</span>
                  <span style={{ color: palette.textMuted, fontSize: "13px", marginLeft: "8px" }}>— {qs.ngoName}</span>
                </div>
                <Button variant="danger" size="sm" onClick={() => deleteSet(qs.id)} loading={actionLoading === qs.id}>{t.adminDelete}</Button>
              </div>
            </Card>
          ))}
        </section>
      )}

      <section>
        <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px" }}>{t.adminPartiesTitle}</h3>
        {parties.map((p) => (
          <Card key={p.id} style={{ marginBottom: "8px", padding: "16px 24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
              <div>
                <span style={{ fontWeight: 700 }}>{p.name}</span>
                <span style={{ color: palette.textMuted, fontSize: "13px", marginLeft: "8px" }}>{p.email}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <code style={{ background: palette.surfaceAlt, padding: "4px 10px", borderRadius: "4px", fontSize: "13px", fontFamily: "monospace", color: palette.accent, fontWeight: 600, border: `1px solid ${palette.border}` }}>{p.token}</code>
                <Button variant="danger" size="sm" onClick={() => removeParty(p.id)} loading={actionLoading === p.id}>{t.adminDelete}</Button>
              </div>
            </div>
          </Card>
        ))}
        <Card style={{ marginTop: "16px" }}>
          <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px" }}>{t.adminAddParty}</div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: "180px" }}><Input value={newPartyName} onChange={setNewPartyName} placeholder={t.adminPartyNamePlaceholder} /></div>
            <div style={{ flex: 1, minWidth: "180px" }}><Input value={newPartyEmail} onChange={setNewPartyEmail} placeholder={t.adminPartyEmailPlaceholder} type="email" /></div>
            <Button onClick={addParty} disabled={!newPartyName.trim()} loading={actionLoading === "new-party"}>{t.adminAdd}</Button>
          </div>
        </Card>
      </section>
    </div>
  );
}

// ─── NGO ───
function NgoView() {
  const { t } = useTranslation();
  const [ngoName, setNgoName] = useState("");
  const [ngoEmail, setNgoEmail] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [title, setTitle] = useState("");
  const [questions, setQuestions] = useState([""]);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showApproved, setShowApproved] = useState(false);
  const [approvedSets, setApprovedSets] = useState(null);
  const [approvedLoading, setApprovedLoading] = useState(false);

  async function openApproved() {
    setShowApproved(true);
    if (approvedSets !== null) return;
    setApprovedLoading(true);
    try {
      const sets = await api.getQuestionSets();
      setApprovedSets(sets);
    } catch {
      setApprovedSets([]);
    } finally {
      setApprovedLoading(false);
    }
  }

  function addQuestion() { setQuestions((q) => [...q, ""]); }
  function updateQuestion(i, val) { setQuestions((q) => q.map((x, j) => (j === i ? val : x))); }
  function removeQuestion(i) { if (questions.length > 1) setQuestions((q) => q.filter((_, j) => j !== i)); }

  async function submit() {
    const validQs = questions.filter((q) => q.trim());
    if (!ngoName.trim() || !title.trim() || validQs.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      await api.submitQuestionSet({
        ngoName: ngoName.trim(),
        ngoEmail: ngoEmail.trim() || null,
        logoUrl: logoUrl.trim() || null,
        title: title.trim(),
        questions: validQs.map((q) => q.trim()),
      });
      setSubmitted(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div style={{ maxWidth: 600, margin: "0 auto", padding: "80px 24px", textAlign: "center" }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: palette.accentLight, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: "28px" }}>✓</div>
        <h2 style={{ fontSize: "24px", fontWeight: 800, marginBottom: "8px" }}>{t.ngoSubmittedTitle}</h2>
        <p style={{ color: palette.textMuted, marginBottom: "24px" }}>{t.ngoSubmittedDesc}</p>
        <Button onClick={() => { setSubmitted(false); setNgoName(""); setNgoEmail(""); setLogoUrl(""); setTitle(""); setQuestions([""]); }}>{t.ngoSubmitAnother}</Button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "40px 24px" }}>
      <h2 style={{ fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", marginBottom: "8px" }}>{t.ngoTitle}</h2>
      <p style={{ color: palette.textMuted, marginBottom: "16px" }}>
        {t.ngoDesc}
      </p>
      <div style={{ background: palette.accentLight, border: `1px solid ${palette.accent}`, borderRadius: "8px", padding: "12px 16px", marginBottom: "24px", fontSize: "14px", color: palette.text }}>
        {t.ngoCheckBefore}{" "}
        <button onClick={openApproved} style={{ background: "none", border: "none", padding: 0, color: palette.accent, fontWeight: 600, cursor: "pointer", fontSize: "14px", textDecoration: "underline" }}>
          {t.ngoViewApproved}
        </button>
      </div>
      {showApproved && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }} onClick={() => setShowApproved(false)}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: palette.bg, borderRadius: "14px", maxWidth: 620, width: "100%", maxHeight: "80vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}>
            <div style={{ padding: "24px 28px", borderBottom: `1px solid ${palette.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700 }}>{t.ngoApprovedTitle}</h3>
              <button onClick={() => setShowApproved(false)} style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: palette.textLight, lineHeight: 1 }}>×</button>
            </div>
            <div style={{ padding: "20px 28px" }}>
              {approvedLoading && <div style={{ color: palette.textMuted, textAlign: "center", padding: "32px 0" }}>{t.ngoApprovedLoading}</div>}
              {!approvedLoading && approvedSets && approvedSets.length === 0 && (
                <div style={{ color: palette.textMuted, textAlign: "center", padding: "32px 0" }}>{t.ngoNoApproved}</div>
              )}
              {!approvedLoading && approvedSets && approvedSets.map((qs) => (
                <div key={qs.id} style={{ marginBottom: "24px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
                    <NgoLogo src={qs.logoUrl} name={qs.ngoName} size={24} />
                    <div style={{ fontWeight: 700, fontSize: "15px" }}>{qs.title}</div>
                  </div>
                  <div style={{ fontSize: "12px", color: palette.textMuted, marginBottom: "10px" }}>{qs.ngoName} · {(qs.questions || []).length} {t.ngoStatements}</div>
                  <ol style={{ margin: 0, paddingLeft: "20px" }}>
                    {(qs.questions || []).map((q) => (
                      <li key={q.id} style={{ fontSize: "14px", color: palette.text, marginBottom: "4px" }}>{q.statement}</li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {error && <ErrorBanner message={error} />}
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>{t.ngoOrgName}</label>
            <Input value={ngoName} onChange={setNgoName} placeholder={t.ngoOrgNamePlaceholder} />
          </div>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>{t.ngoContactEmail}</label>
            <Input value={ngoEmail} onChange={setNgoEmail} placeholder={t.ngoContactEmailPlaceholder} type="email" />
          </div>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>{t.ngoLogoUrl}</label>
            <Input value={logoUrl} onChange={setLogoUrl} placeholder={t.ngoLogoUrlPlaceholder} />
            {logoUrl && (
              <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "8px" }}>
                <NgoLogo src={logoUrl} name={ngoName} size={36} />
                <span style={{ fontSize: "12px", color: palette.textLight }}>{t.preview}</span>
              </div>
            )}
          </div>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>{t.ngoSetTitle}</label>
            <Input value={title} onChange={setTitle} placeholder={t.ngoSetTitlePlaceholder} />
          </div>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "10px" }}>{t.ngoStatementsLabel} ({questions.filter((q) => q.trim()).length})</label>
            {questions.map((q, i) => (
              <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "8px", alignItems: "start" }}>
                <span style={{ color: palette.textLight, fontSize: "13px", marginTop: "10px", minWidth: "20px" }}>{i + 1}.</span>
                <div style={{ flex: 1 }}><TextArea value={q} onChange={(v) => updateQuestion(i, v)} placeholder={t.ngoStatementPlaceholder} rows={2} /></div>
                {questions.length > 1 && (
                  <button onClick={() => removeQuestion(i)} style={{ background: "none", border: "none", color: palette.textLight, cursor: "pointer", fontSize: "18px", marginTop: "8px" }}>×</button>
                )}
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={addQuestion}>{t.ngoAddStatement}</Button>
          </div>
          <Button size="lg" onClick={submit} loading={loading} disabled={!ngoName.trim() || !title.trim() || questions.filter((q) => q.trim()).length === 0}>
            {t.ngoSubmit}
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ─── Candidate ───
function CandidateView({ partyToken, initialCandidateId }) {
  const { t } = useTranslation();
  const [partyData, setPartyData] = useState(null);
  const [questionSets, setQuestionSets] = useState([]);
  const [selectedCandidate, setSelectedCandidate] = useState(null);
  const [candidateName, setCandidateName] = useState("");
  const [candidatePhoto, setCandidatePhoto] = useState("");
  const [candidateBio, setCandidateBio] = useState("");
  const [candidateEmail, setCandidateEmail] = useState("");
  const [candidateConstituency, setCandidateConstituency] = useState("");
  const [answers, setAnswers] = useState({});
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [pd, qs] = await Promise.all([
          api.getPartyCandidates(partyToken),
          api.getQuestionSets(),
        ]);
        setPartyData(pd);
        setQuestionSets(qs);
        if (initialCandidateId && pd.candidates) {
          const match = pd.candidates.find((c) => c.id === initialCandidateId);
          if (match) {
            const full = await api.getCandidate(match.id);
            setSelectedCandidate(full);
            setCandidateName(full.name);
            setCandidatePhoto(full.photoUrl || "");
            setCandidateBio(full.bio || "");
            setCandidateEmail(full.email || "");
            setCandidateConstituency(full.constituency || "");
            setAnswers(
              Object.fromEntries(
                Object.entries(full.answers || {}).map(([k, v]) => [k, { value: v.value, text: v.explanation || "" }])
              )
            );
          }
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [partyToken, initialCandidateId]);

  const approvedSets = questionSets.filter((s) => s.status === "approved");
  const allQuestions = approvedSets.flatMap((s) => s.questions || []);

  async function selectExisting(c) {
    setError(null);
    try {
      const full = await api.getCandidate(c.id);
      setSelectedCandidate(full);
      setCandidateName(full.name);
      setCandidatePhoto(full.photoUrl || "");
      setCandidateBio(full.bio || "");
      setCandidateEmail(full.email || "");
      setCandidateConstituency(full.constituency || "");
      setAnswers(
        Object.fromEntries(
          Object.entries(full.answers || {}).map(([k, v]) => [k, { value: v.value, text: v.explanation || "" }])
        )
      );
    } catch (e) {
      setError(e.message);
    }
  }

  function startNew() {
    setSelectedCandidate("new");
    setCandidateEmail("");
    setAnswers({});
  }

  function setAnswer(qId, field, val) {
    setAnswers((a) => ({ ...a, [qId]: { ...a[qId], [field]: val } }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      let candidateId;
      if (selectedCandidate === "new") {
        const created = await api.createCandidate(partyToken, {
          name: candidateName.trim(),
          photoUrl: candidatePhoto.trim() || null,
          bio: candidateBio.trim() || null,
          email: candidateEmail.trim() || null,
          constituency: candidateConstituency.trim() || null,
        });
        candidateId = created.id;
      } else {
        candidateId = selectedCandidate.id;
        await api.updateCandidate(partyToken, candidateId, {
          name: candidateName.trim(),
          photoUrl: candidatePhoto.trim() || null,
          bio: candidateBio.trim() || null,
          constituency: candidateConstituency.trim() || null,
        });
      }

      const apiAnswers = {};
      for (const [qId, a] of Object.entries(answers)) {
        if (a.value !== undefined) {
          apiAnswers[qId] = { value: a.value, explanation: a.text || "" };
        }
      }
      await api.saveAnswers(partyToken, candidateId, apiAnswers);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState />;

  if (error && !partyData) {
    return (
      <div style={{ maxWidth: 500, margin: "0 auto", padding: "80px 24px", textAlign: "center" }}>
        <h2 style={{ fontSize: "24px", fontWeight: 800, marginBottom: "8px" }}>{t.candidateInvalidToken}</h2>
        <p style={{ color: palette.textMuted }}>{t.candidateInvalidTokenDesc(partyToken)}</p>
      </div>
    );
  }

  if (saved) {
    return (
      <div style={{ maxWidth: 500, margin: "0 auto", padding: "80px 24px", textAlign: "center" }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: palette.accentLight, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: "28px" }}>✓</div>
        <h2 style={{ fontSize: "24px", fontWeight: 800, marginBottom: "8px" }}>{t.candidateSavedTitle}</h2>
        <p style={{ color: palette.textMuted }}>{t.candidateSavedDesc(candidateName, partyData?.party?.name)}</p>
      </div>
    );
  }

  if (!selectedCandidate) {
    return (
      <div style={{ maxWidth: 600, margin: "0 auto", padding: "40px 24px" }}>
        <Badge color="blue">{partyData?.party?.name}</Badge>
        <h2 style={{ fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", margin: "12px 0 8px" }}>{t.candidatePortalTitle}</h2>
        <p style={{ color: palette.textMuted, marginBottom: "28px" }}>{t.candidatePortalDesc}</p>
        {partyData?.candidates?.length > 0 && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "10px" }}>{t.candidateExisting}</div>
            {partyData.candidates.map((c) => (
              <Card key={c.id} onClick={() => selectExisting(c)} style={{ marginBottom: "8px", padding: "14px 20px", cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <Avatar src={c.photoUrl} name={c.name} size={36} />
                    <span style={{ fontWeight: 600 }}>{c.name}</span>
                  </div>
                  <span style={{ fontSize: "13px", color: palette.textMuted }}>{c.answerCount}/{allQuestions.length} {t.candidateAnswered}</span>
                </div>
              </Card>
            ))}
          </div>
        )}
        <Button variant="secondary" onClick={startNew}>{t.candidateRegister}</Button>
      </div>
    );
  }

  const answeredCount = Object.values(answers).filter((a) => a.value !== undefined).length;

  return (
    <div style={{ maxWidth: 740, margin: "0 auto", padding: "40px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "24px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <Badge color="blue">{partyData?.party?.name}</Badge>
          <h2 style={{ fontSize: "24px", fontWeight: 800, margin: "8px 0 4px" }}>{t.candidateAnswerTitle}</h2>
          <p style={{ color: palette.textMuted, fontSize: "14px" }}>{answeredCount} / {allQuestions.length} {t.candidateAnsweredCount}</p>
        </div>
        <Button onClick={save} loading={saving} disabled={!candidateName.trim() || answeredCount === 0}>{t.candidateSaveAnswers}</Button>
      </div>
      {error && <ErrorBanner message={error} />}

      <Card style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "14px", fontWeight: 700, marginBottom: "16px" }}>{t.candidateProfile}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>{t.candidateFullName} {selectedCandidate === "new" && "*"}</label>
            <Input value={candidateName} onChange={setCandidateName} placeholder={t.candidateFullNamePlaceholder} />
          </div>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>{t.candidatePhotoUrl}</label>
            <Input value={candidatePhoto} onChange={setCandidatePhoto} placeholder={t.candidatePhotoUrlPlaceholder} />
            {candidatePhoto && (
              <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "10px" }}>
                <Avatar src={candidatePhoto} name={candidateName} size={48} />
                <span style={{ fontSize: "12px", color: palette.textLight }}>{t.preview}</span>
              </div>
            )}
          </div>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>{t.candidateBio}</label>
            <TextArea value={candidateBio} onChange={setCandidateBio} placeholder={t.candidateBioPlaceholder} rows={4} />
          </div>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>{t.candidateEmailLabel}</label>
            <Input value={candidateEmail} onChange={setCandidateEmail} placeholder={t.candidateEmailPlaceholder} type="email" />
          </div>
          <div>
            <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>{t.candidateConstituencyLabel}</label>
            <select value={candidateConstituency} onChange={(e) => setCandidateConstituency(e.target.value)} style={{
              width: "100%", padding: "10px 14px", borderRadius: "6px", border: `1px solid ${palette.border}`,
              fontFamily: "'Source Serif 4', Georgia, serif", fontSize: "14px",
              background: palette.surface, color: palette.text, outline: "none", boxSizing: "border-box",
            }}>
              <option value="">{t.candidateConstituencyPlaceholder}</option>
              {FI_CONSTITUENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
      </Card>

      {approvedSets.map((qs) => (
        <section key={qs.id} style={{ marginBottom: "32px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <NgoLogo src={qs.logoUrl} name={qs.ngoName} size={24} />
            <h3 style={{ fontSize: "15px", fontWeight: 700, margin: 0 }}>{qs.title}</h3>
          </div>
          <p style={{ fontSize: "12px", color: palette.textLight, marginBottom: "16px", marginLeft: "34px" }}>{qs.ngoName}</p>
          {(qs.questions || []).map((q, qi) => (
            <Card key={q.id} style={{ marginBottom: "12px" }}>
              <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "12px" }}>
                <span style={{ color: palette.textLight, marginRight: "6px" }}>{qi + 1}.</span>{q.statement}
              </div>
              <ScaleInput value={answers[q.id]?.value} onChange={(v) => setAnswer(q.id, "value", v)} />
              <div style={{ marginTop: "12px" }}>
                <TextArea value={answers[q.id]?.text || ""} onChange={(v) => setAnswer(q.id, "text", v)} placeholder={t.candidateExplainPlaceholder} rows={2} />
              </div>
            </Card>
          ))}
        </section>
      ))}

      <div style={{ textAlign: "center", paddingBottom: "40px" }}>
        <Button size="lg" onClick={save} loading={saving} disabled={!candidateName.trim() || answeredCount === 0}>
          {t.candidateSaveAnswers} ({answeredCount}/{allQuestions.length})
        </Button>
      </div>
    </div>
  );
}

// ─── Voter storage (localStorage, GDPR-gated) ───
const STORAGE_KEYS = {
  consent: "vaalikone_consent",
  answers: "vaalikone_answers",
  weights: "vaalikone_weights",
  sets: "vaalikone_selected_sets",
};

function loadConsent() {
  try { return localStorage.getItem(STORAGE_KEYS.consent) === "true"; } catch { return false; }
}

function saveConsent(value) {
  try { localStorage.setItem(STORAGE_KEYS.consent, value ? "true" : "false"); } catch {}
}

function loadSavedAnswers() {
  try {
    return {
      answers: JSON.parse(localStorage.getItem(STORAGE_KEYS.answers) || "{}"),
      weights: JSON.parse(localStorage.getItem(STORAGE_KEYS.weights) || "{}"),
      sets: JSON.parse(localStorage.getItem(STORAGE_KEYS.sets) || "null"),
    };
  } catch { return { answers: {}, weights: {}, sets: null }; }
}

function persistAnswers(answers, weights, sets) {
  try {
    localStorage.setItem(STORAGE_KEYS.answers, JSON.stringify(answers));
    localStorage.setItem(STORAGE_KEYS.weights, JSON.stringify(weights));
    localStorage.setItem(STORAGE_KEYS.sets, JSON.stringify([...sets]));
  } catch {}
}

function clearSavedAnswers() {
  try {
    [STORAGE_KEYS.answers, STORAGE_KEYS.weights, STORAGE_KEYS.sets].forEach((k) => localStorage.removeItem(k));
  } catch {}
}

function revokeConsent() {
  try {
    Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
  } catch {}
}

// ─── Voter ───
function VoterView() {
  const { t } = useTranslation();
  const labels = useLabels();
  const weightLabels = useWeightLabels();
  const [questionSets, setQuestionSets] = useState([]);
  const [selectedSetIds, setSelectedSetIds] = useState(new Set());
  const [step, setStep] = useState("loading");
  const [voterAnswers, setVoterAnswers] = useState({});
  const [weights, setWeights] = useState({});
  const [currentQ, setCurrentQ] = useState(0);
  const [results, setResults] = useState([]);
  const [expandedCandidate, setExpandedCandidate] = useState(null);
  const [profileCandidate, setProfileCandidate] = useState(null);
  const [constituency, setConstituency] = useState("");
  const [error, setError] = useState(null);
  const [consentGiven, setConsentGiven] = useState(() => loadConsent());

  useEffect(() => {
    async function load() {
      try {
        const qs = await api.getQuestionSets();
        setQuestionSets(qs);
        const allIds = new Set(qs.map((s) => s.id));
        if (loadConsent()) {
          const saved = loadSavedAnswers();
          setVoterAnswers(saved.answers);
          setWeights(saved.weights);
          if (saved.sets) {
            const validIds = new Set(saved.sets.filter((id) => allIds.has(id)));
            setSelectedSetIds(validIds.size > 0 ? validIds : allIds);
          } else {
            setSelectedSetIds(allIds);
          }
          setStep("select");
        } else {
          setSelectedSetIds(allIds);
          setStep("consent");
        }
      } catch (e) {
        setError(e.message);
        setStep("consent");
      }
    }
    load();
  }, []);

  const approvedSets = questionSets;
  const activeQuestions = approvedSets.filter((s) => selectedSetIds.has(s.id)).flatMap((s) => s.questions || []);

  function toggleSet(id) {
    setSelectedSetIds((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      if (consentGiven) persistAnswers(voterAnswers, weights, next);
      return next;
    });
  }

  function startAnswering() {
    const firstUnanswered = activeQuestions.findIndex((q) => voterAnswers[q.id] === undefined);
    setCurrentQ(firstUnanswered === -1 ? 0 : firstUnanswered);
    setStep("answer");
  }

  function answerQuestion(value) {
    const qId = activeQuestions[currentQ].id;
    setVoterAnswers((a) => {
      const next = { ...a, [qId]: value };
      if (consentGiven) persistAnswers(next, weights, selectedSetIds);
      return next;
    });
    if (currentQ < activeQuestions.length - 1) setCurrentQ((c) => c + 1);
    else setStep("weight");
  }

  async function finishWeighting() {
    setStep("loading-results");
    setError(null);
    try {
      const { results: matchResults } = await api.voterMatch({
        answers: voterAnswers,
        weights,
        questionSetIds: [...selectedSetIds],
        constituency: constituency || null,
      });
      setResults(matchResults);
      setStep("results");
    } catch (e) {
      setError(e.message);
      setStep("results");
    }
  }

  if (step === "loading" || step === "loading-results") return <LoadingState text={step === "loading-results" ? t.voterCalculating : t.loading} />;

  // GDPR consent
  if (step === "consent") {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "40px 24px" }}>
        <h2 style={{ fontSize: "26px", fontWeight: 800, letterSpacing: "-0.02em", marginBottom: "12px" }}>{t.voterConsentTitle}</h2>
        <p style={{ color: palette.textMuted, lineHeight: 1.7, marginBottom: "16px" }}>
          {t.voterConsentDesc}
        </p>
        <div style={{ background: palette.surfaceAlt, border: `1px solid ${palette.border}`, borderRadius: "10px", padding: "16px 20px", marginBottom: "24px", fontSize: "13px", lineHeight: 1.7, color: palette.textMuted }}>
          <strong style={{ color: palette.text, display: "block", marginBottom: "6px" }}>{t.voterConsentWhat}</strong>
          <ul style={{ margin: 0, paddingLeft: "18px" }}>
            <li>{t.voterConsentItem1}</li>
            <li>{t.voterConsentItem2}</li>
            <li>{t.voterConsentItem3}</li>
          </ul>
          <div style={{ marginTop: "10px" }}>
            <strong style={{ color: palette.text }}>{t.voterConsentPurpose}</strong> {t.voterConsentPurposeDesc}
          </div>
          <div style={{ marginTop: "6px" }}>
            <strong style={{ color: palette.text }}>{t.voterConsentStorage}</strong> {t.voterConsentStorageDesc}
          </div>
          <div style={{ marginTop: "6px" }}>
            {t.voterConsentRevoke}
          </div>
        </div>
        {error && <ErrorBanner message={error} />}
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <Button size="lg" onClick={() => {
            saveConsent(true);
            setConsentGiven(true);
            persistAnswers(voterAnswers, weights, selectedSetIds);
            setStep("select");
          }}>{t.voterConsentAllow}</Button>
          <Button variant="secondary" size="lg" onClick={() => {
            saveConsent(false);
            setConsentGiven(false);
            setStep("select");
          }}>{t.voterConsentDeny}</Button>
        </div>
      </div>
    );
  }

  // Set selection
  if (step === "select") {
    const hasSaved = consentGiven && Object.keys(voterAnswers).length > 0;
    return (
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
        <h2 style={{ fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", marginBottom: "8px" }}>{t.voterSelectTitle}</h2>
        <p style={{ color: palette.textMuted, marginBottom: "28px" }}>{t.voterSelectDesc}</p>
        {hasSaved && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: palette.accentLight, border: `1px solid ${palette.accent}`, borderRadius: "8px", padding: "10px 16px", marginBottom: "20px", fontSize: "13px" }}>
            <span style={{ color: palette.accent, fontWeight: 600 }}>{t.voterPrefilled}</span>
            <button onClick={() => {
              clearSavedAnswers();
              revokeConsent();
              setConsentGiven(false);
              setVoterAnswers({});
              setWeights({});
            }} style={{ background: "none", border: "none", color: palette.textLight, cursor: "pointer", fontSize: "12px", fontFamily: "inherit", textDecoration: "underline" }}>
              {t.voterDeleteSaved}
            </button>
          </div>
        )}
        {error && <ErrorBanner message={error} />}
        <div style={{ marginBottom: "24px" }}>
          <label style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>{t.voterConstituencyLabel}</label>
          <p style={{ fontSize: "13px", color: palette.textMuted, marginBottom: "8px", marginTop: 0 }}>{t.voterConstituencyDesc}</p>
          <select value={constituency} onChange={(e) => setConstituency(e.target.value)} style={{
            width: "100%", padding: "10px 14px", borderRadius: "6px", border: `1px solid ${palette.border}`,
            fontFamily: "'Source Serif 4', Georgia, serif", fontSize: "14px",
            background: palette.surface, color: palette.text, outline: "none", boxSizing: "border-box",
          }}>
            <option value="">{t.voterConstituencyAll}</option>
            {FI_CONSTITUENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {approvedSets.length === 0 && <p style={{ color: palette.textLight }}>{t.voterNoSets}</p>}
        {approvedSets.map((qs) => (
          <Card key={qs.id} onClick={() => toggleSet(qs.id)} style={{
            marginBottom: "10px", cursor: "pointer",
            border: `1.5px solid ${selectedSetIds.has(qs.id) ? palette.accent : palette.border}`,
            background: selectedSetIds.has(qs.id) ? palette.accentLight : palette.surface,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
                <NgoLogo src={qs.logoUrl} name={qs.ngoName} size={44} />
                <div>
                  <div style={{ fontWeight: 700, fontSize: "15px" }}>{qs.title}</div>
                  <div style={{ fontSize: "13px", color: palette.textMuted, marginTop: "2px" }}>{qs.ngoName} · {(qs.questions || []).length} {t.voterQuestions}</div>
                </div>
              </div>
              <div style={{
                width: 24, height: 24, borderRadius: "6px",
                border: `2px solid ${selectedSetIds.has(qs.id) ? palette.accent : palette.border}`,
                background: selectedSetIds.has(qs.id) ? palette.accent : "transparent",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "#fff", fontSize: "14px", fontWeight: 800,
              }}>{selectedSetIds.has(qs.id) ? "✓" : ""}</div>
            </div>
          </Card>
        ))}
        <div style={{ marginTop: "20px" }}>
          <Button size="lg" onClick={startAnswering} disabled={selectedSetIds.size === 0 || activeQuestions.length === 0}>
            {t.voterStart} ({activeQuestions.length} {t.voterQuestions})
          </Button>
        </div>
      </div>
    );
  }

  // Answering
  if (step === "answer") {
    const q = activeQuestions[currentQ];
    const parentSet = approvedSets.find((s) => (s.questions || []).some((sq) => sq.id === q.id));
    const progress = (currentQ / activeQuestions.length) * 100;
    return (
      <div style={{ maxWidth: 600, margin: "0 auto", padding: "40px 24px" }}>
        <div style={{ marginBottom: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", color: palette.textMuted, marginBottom: "8px" }}>
            <span>{parentSet?.title}</span><span>{currentQ + 1} / {activeQuestions.length}</span>
          </div>
          <ProgressBar value={progress} />
        </div>
        <Card style={{ textAlign: "center", padding: "40px 32px" }}>
          <div style={{ fontSize: "19px", fontWeight: 700, lineHeight: 1.5, marginBottom: "32px", maxWidth: 480, margin: "0 auto 32px" }}>"{q.statement}"</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxWidth: 320, margin: "0 auto" }}>
            {labels.map((label, i) => (
              <button key={i} onClick={() => answerQuestion(i)} style={{
                padding: "12px 20px", borderRadius: "8px",
                border: `1.5px solid ${voterAnswers[q.id] === i ? palette.accent : palette.border}`,
                background: voterAnswers[q.id] === i ? palette.accentLight : palette.surface,
                color: voterAnswers[q.id] === i ? palette.accent : palette.text,
                fontWeight: voterAnswers[q.id] === i ? 700 : 500, fontSize: "14px", cursor: "pointer",
                fontFamily: "'Source Serif 4', Georgia, serif", transition: "all 0.15s", textAlign: "center",
              }}>{label}</button>
            ))}
          </div>
          <div style={{ marginTop: "20px", display: "flex", justifyContent: "center", gap: "20px" }}>
            {currentQ > 0 && (
              <button onClick={() => setCurrentQ((c) => c - 1)} style={{
                background: "none", border: "none", color: palette.textLight,
                cursor: "pointer", fontSize: "13px", fontFamily: "'Source Serif 4', Georgia, serif",
              }}>{t.voterPrevious}</button>
            )}
            {voterAnswers[q.id] !== undefined && (
              <button onClick={() => {
                if (currentQ < activeQuestions.length - 1) setCurrentQ((c) => c + 1);
                else setStep("weight");
              }} style={{
                background: "none", border: "none", color: palette.textMuted,
                cursor: "pointer", fontSize: "13px", fontFamily: "'Source Serif 4', Georgia, serif",
              }}>{t.voterSkip}</button>
            )}
          </div>
        </Card>
      </div>
    );
  }

  // Weighting
  if (step === "weight") {
    return (
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
        <h2 style={{ fontSize: "24px", fontWeight: 800, marginBottom: "8px" }}>{t.voterWeightTitle}</h2>
        <p style={{ color: palette.textMuted, marginBottom: "28px", fontSize: "14px" }}>{t.voterWeightDesc}</p>
        {activeQuestions.map((q, i) => (
          <Card key={q.id} style={{ marginBottom: "10px", padding: "16px 20px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>
              <span style={{ color: palette.textLight }}>{i + 1}.</span> {q.statement}
            </div>
            <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
              {weightLabels.map((label, wi) => (
                <button key={wi} onClick={() => setWeights((w) => { const next = { ...w, [q.id]: wi }; if (consentGiven) persistAnswers(voterAnswers, next, selectedSetIds); return next; })} style={{
                  padding: "5px 10px", borderRadius: "4px", fontSize: "12px",
                  border: `1px solid ${(weights[q.id] ?? 1) === wi ? palette.accent : palette.border}`,
                  background: (weights[q.id] ?? 1) === wi ? palette.accentLight : "transparent",
                  color: (weights[q.id] ?? 1) === wi ? palette.accent : palette.textMuted,
                  fontWeight: (weights[q.id] ?? 1) === wi ? 700 : 400,
                  cursor: "pointer", fontFamily: "'Source Serif 4', Georgia, serif",
                }}>{label}</button>
              ))}
            </div>
          </Card>
        ))}
        <div style={{ marginTop: "20px", display: "flex", gap: "12px" }}>
          <Button size="lg" onClick={finishWeighting}>{t.voterShowResults}</Button>
          <Button variant="ghost" size="lg" onClick={finishWeighting}>{t.voterSkipWeighting}</Button>
        </div>
      </div>
    );
  }

  // Results
  return (
    <div style={{ maxWidth: 740, margin: "0 auto", padding: "40px 24px" }}>
      <h2 style={{ fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", marginBottom: "8px" }}>{t.voterResultsTitle}</h2>
      <p style={{ color: palette.textMuted, marginBottom: "28px" }}>{t.voterResultsDesc}</p>
      {error && <ErrorBanner message={error} />}
      {results.length === 0 && <p style={{ color: palette.textLight }}>{t.voterNoCandidates}</p>}
      {results.map((c) => {
        const isExpanded = expandedCandidate === c.id;
        const matchColor = c.match >= 75 ? palette.accent : c.match >= 50 ? palette.warn : palette.danger;
        return (
          <Card key={c.id} style={{ marginBottom: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "16px", cursor: "pointer" }} onClick={() => setExpandedCandidate(isExpanded ? null : c.id)}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <Avatar src={c.photoUrl} name={c.name} size={52} />
                <div style={{ position: "absolute", bottom: -4, right: -4, background: matchColor, color: "#fff", fontWeight: 800, fontSize: "11px", borderRadius: "10px", padding: "2px 6px", border: `2px solid ${palette.surface}` }}>{c.match}%</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: "16px" }}>{c.name}</span>
                  <Badge>{c.partyName}</Badge>
                  {c.constituency && <Badge color="blue">{c.constituency}</Badge>}
                  {(c.bio || c.photoUrl) && (
                    <button onClick={(e) => { e.stopPropagation(); setProfileCandidate(c); }} style={{
                      background: "none", border: `1px solid ${palette.border}`, borderRadius: "4px",
                      padding: "2px 8px", fontSize: "11px", color: palette.textMuted, cursor: "pointer",
                      fontFamily: "'Source Serif 4', Georgia, serif",
                    }}>{t.profileButton}</button>
                  )}
                </div>
                <ProgressBar value={c.match} color={matchColor} />
              </div>
              <span style={{ color: palette.textLight, fontSize: "20px", flexShrink: 0 }}>{isExpanded ? "−" : "+"}</span>
            </div>
            {isExpanded && (
              <div style={{ marginTop: "20px", paddingTop: "16px", borderTop: `1px solid ${palette.border}` }}>
                {c.bio && (
                  <div style={{ padding: "12px 14px", background: palette.surfaceAlt, borderRadius: "8px", fontSize: "13px", color: palette.textMuted, marginBottom: "16px", lineHeight: 1.6 }}>{c.bio}</div>
                )}
                {activeQuestions.map((q) => {
                  const ca = c.answers?.[q.id];
                  const va = voterAnswers[q.id];
                  if (!ca) return null;
                  const agree = ca.value === va;
                  const close = Math.abs(ca.value - va) <= 1;
                  return (
                    <div key={q.id} style={{ marginBottom: "16px" }}>
                      <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>{q.statement}</div>
                      <div style={{ display: "flex", gap: "16px", fontSize: "13px", flexWrap: "wrap" }}>
                        <span style={{ color: palette.textMuted }}>{t.voterYou}: <strong style={{ color: palette.text }}>{labels[va]}</strong></span>
                        <span style={{ color: agree ? palette.accent : close ? palette.warn : palette.danger }}>
                          {t.voterCandidate}: <strong>{labels[ca.value]}</strong>{agree && " ✓"}
                        </span>
                      </div>
                      {ca.explanation && (
                        <div style={{ marginTop: "6px", padding: "8px 12px", background: palette.surfaceAlt, borderRadius: "6px", fontSize: "13px", color: palette.textMuted, fontStyle: "italic", borderLeft: `3px solid ${palette.border}` }}>"{ca.explanation}"</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
      <div style={{ marginTop: "24px" }}>
        <Button variant="ghost" onClick={() => { clearSavedAnswers(); setStep("select"); setVoterAnswers({}); setWeights({}); setConstituency(""); setExpandedCandidate(null); setResults([]); }}>{t.voterStartOver}</Button>
      </div>
      {profileCandidate && (
        <CandidateProfile candidate={profileCandidate} onClose={() => setProfileCandidate(null)} activeQuestions={activeQuestions} voterAnswers={voterAnswers} />
      )}
    </div>
  );
}

// ─── App ───
export default function App() {
  const _urlParams = new URLSearchParams(window.location.search);
  const _urlPartyToken = _urlParams.get("partyToken") || null;
  const _urlCandidateId = _urlParams.get("candidateId") || null;

  const [view, setView] = useState(_urlPartyToken ? "candidate" : "home");
  const [partyToken, setPartyToken] = useState(_urlPartyToken);
  const [initialCandidateId] = useState(_urlCandidateId);
  const [lang, setLang] = useState(DEFAULT_LANG);

  const t = translations[lang] || translations.fi;
  const langValue = useMemo(() => ({ lang, t, setLang }), [lang, t]);

  return (
    <LanguageContext.Provider value={langValue}>
      <div style={{ minHeight: "100vh", background: palette.bg, fontFamily: "'Source Serif 4', Georgia, serif", color: palette.text }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet" />
        <Header view={view} setView={setView} setPartyToken={setPartyToken} />
        {view === "home" && <HomeView setView={setView} setPartyToken={setPartyToken} />}
        {view === "about" && <AboutView />}
        {view === "admin" && <AdminView />}
        {view === "ngo" && <NgoView />}
        {view === "candidate" && <CandidateView partyToken={partyToken} initialCandidateId={initialCandidateId} />}
        {view === "voter" && <VoterView />}
      </div>
    </LanguageContext.Provider>
  );
}
