import { useState, useEffect, useMemo, useRef, useId, createContext, useContext } from "react";
import { marked } from "marked";
import * as Sentry from "@sentry/react";
import translations from "./translations";
import { createApi, isTransientError } from "./api";
import { readInitialLink, rememberLink, tokenLinkFromParams } from "./tokenLinks";
import voterGuideContent from "./guides/voter-guide.md?raw";
import candidateGuideContent from "./guides/candidate-guide.md?raw";
import adminGuideContent from "./guides/admin-guide.md?raw";
import ngoGuideContent from "./guides/ngo-guide.md?raw";

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
const api = createApi({ base: API_BASE });

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

// ─── Markdown Guide ───

function MarkdownGuide({ content, label }) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => marked.parse(content), [content]);
  return (
    <div style={{ marginBottom: "24px", border: `1px solid ${palette.border}`, borderRadius: "10px", overflow: "hidden" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "12px 16px", background: palette.surfaceAlt, border: "none", borderRadius: 0,
          cursor: "pointer", fontFamily: "inherit", fontSize: "13px", fontWeight: 600,
          color: palette.textMuted,
        }}
      >
        <span>? {open ? "Piilota ohje" : label}</span>
        <span style={{ fontSize: "10px" }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          className="markdown-guide"
          dangerouslySetInnerHTML={{ __html: html }}
          style={{ padding: "20px 24px", borderTop: `1px solid ${palette.border}` }}
        />
      )}
    </div>
  );
}

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

function ErrorBanner({ message, onRetry, scrollIntoView = false }) {
  const { t } = useTranslation();
  const ref = useRef(null);
  // For long forms whose submit button sits at the bottom: bring the error into view.
  useEffect(() => {
    if (scrollIntoView) ref.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [message, scrollIntoView]);
  return (
    <div ref={ref} style={{
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

function TextArea({ value, onChange, placeholder, rows = 3, maxLength }) {
  const counterId = useId();
  const textarea = (
    <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} maxLength={maxLength}
      aria-describedby={maxLength ? counterId : undefined}
      style={{
        width: "100%", padding: "12px 14px", borderRadius: "6px", border: `1px solid ${palette.border}`,
        fontFamily: "'Source Serif 4', Georgia, serif", fontSize: "14px", resize: "vertical",
        background: palette.surface, color: palette.text, outline: "none", boxSizing: "border-box",
      }} />
  );
  if (!maxLength) return textarea;
  return (
    <div>
      {textarea}
      <div id={counterId} style={{ textAlign: "right", fontSize: "12px", color: (value ?? "").length >= maxLength ? palette.danger : palette.textLight }}>
        {(value ?? "").length} / {maxLength}
      </div>
    </div>
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
function Header({ view, navigate }) {
  const { t } = useTranslation();
  return (
    <header style={{ background: palette.surface, borderBottom: `1px solid ${palette.border}`, padding: "0 16px", position: "sticky", top: 0, zIndex: 100 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: "56px", gap: "8px" }}>
        <div onClick={() => navigate("home")} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
          <div style={{ width: 28, height: 28, borderRadius: "6px", background: palette.accent, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: "15px", fontFamily: "'Source Serif 4', Georgia, serif" }}>V</div>
          <span style={{ fontFamily: "'Source Serif 4', Georgia, serif", fontWeight: 700, fontSize: "17px", color: palette.text, letterSpacing: "-0.02em" }}>{t.appName}</span>
          <span style={{ fontSize: "11px", color: palette.textLight, fontWeight: 500, marginLeft: "-4px" }}>{t.appYear}</span>
        </div>
        <nav className="app-nav" style={{ display: "flex", gap: "2px", alignItems: "center", overflowX: "auto", scrollbarWidth: "none", minWidth: 0 }}>
          {[{ key: "home", label: t.navHome }, { key: "voter", label: t.navVoter }, { key: "ngo", label: t.navNgo }, { key: "admin", label: t.navAdmin }, { key: "about", label: t.navAbout }].map((item) => (
            <button key={item.key} onClick={() => navigate(item.key)}
              style={{
                padding: "6px 10px", borderRadius: "5px", border: "none", cursor: "pointer", whiteSpace: "nowrap",
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
function HomeView({ navigate, openLink }) {
  const { t } = useTranslation();
  const [tokenInput, setTokenInput] = useState("");
  const go = () => {
    const link = tokenLinkFromInput(tokenInput);
    if (link) openLink(link);
  };
  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "60px 24px", textAlign: "center" }}>
      <h1 style={{ fontSize: "42px", fontWeight: 800, letterSpacing: "-0.03em", marginBottom: "16px", lineHeight: 1.1 }}>{t.homeTitle}</h1>
      <p style={{ fontSize: "17px", color: palette.textMuted, lineHeight: 1.6, maxWidth: 520, margin: "0 auto 48px" }}>
        {t.homeSubtitle}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", maxWidth: 400, margin: "0 auto" }}>
        <Card style={{ cursor: "pointer", textAlign: "left" }} onClick={() => navigate("voter")}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: palette.accent, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{t.homeVoterLabel}</div>
          <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "4px" }}>{t.homeVoterTitle}</div>
          <div style={{ fontSize: "13px", color: palette.textMuted }}>{t.homeVoterDesc}</div>
        </Card>
        <Card style={{ cursor: "pointer", textAlign: "left" }} onClick={() => navigate("ngo")}>
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
            <Button onClick={go} disabled={!tokenInput.trim()} style={{ flexShrink: 0 }}>{t.homeGo}</Button>
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
  const { t, lang } = useTranslation();
  const [adminSecret, setAdminSecret] = useState("");
  const [authed, setAuthed] = useState(false);
  const [parties, setParties] = useState([]);
  const [questionSets, setQuestionSets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [newPartyName, setNewPartyName] = useState("");
  const [newPartyEmail, setNewPartyEmail] = useState("");
  const [partyCandidates, setPartyCandidates] = useState({}); // { [partyId]: candidates } for expanded parties
  const [linksQueued, setLinksQueued] = useState({});         // { [partyId]: { queued, withoutEmail } }
  const [actionLoading, setActionLoading] = useState(null);
  const [reviewState, setReviewState] = useState({}); // { [setId]: { [questionId]: { rejected, reason, duplicateOf } } }
  const [newQuestionText, setNewQuestionText] = useState({}); // { [setId]: string }
  const [mergeSelection, setMergeSelection] = useState([]); // questionIds selected in the merge tool
  const [mergeKeepId, setMergeKeepId] = useState(null);     // which selected question to keep as canonical

  function toggleQuestionReject(setId, questionId) {
    setReviewState((prev) => ({
      ...prev,
      [setId]: {
        ...prev[setId],
        [questionId]: {
          rejected: !(prev[setId]?.[questionId]?.rejected ?? false),
          reason: prev[setId]?.[questionId]?.reason || "",
        },
      },
    }));
  }

  function setRejectionReason(setId, questionId, reason) {
    setReviewState((prev) => ({
      ...prev,
      [setId]: {
        ...prev[setId],
        [questionId]: { ...prev[setId]?.[questionId], reason },
      },
    }));
  }

  function startEdit(setId, questionId, originalStatement) {
    setReviewState((prev) => ({
      ...prev,
      [setId]: {
        ...prev[setId],
        [questionId]: {
          ...prev[setId]?.[questionId],
          // Pre-fill with original if no edit started yet
          editedStatement: prev[setId]?.[questionId]?.editedStatement ?? originalStatement,
          editing: true,
        },
      },
    }));
  }

  function cancelEdit(setId, questionId) {
    setReviewState((prev) => ({
      ...prev,
      [setId]: {
        ...prev[setId],
        [questionId]: { ...prev[setId]?.[questionId], editedStatement: undefined, editing: false },
      },
    }));
  }

  function setEditedStatement(setId, questionId, value) {
    setReviewState((prev) => ({
      ...prev,
      [setId]: {
        ...prev[setId],
        [questionId]: { ...prev[setId]?.[questionId], editedStatement: value },
      },
    }));
  }

  function setDuplicateOf(setId, questionId, targetId) {
    setReviewState((prev) => ({
      ...prev,
      [setId]: {
        ...prev[setId],
        [questionId]: { ...prev[setId]?.[questionId], duplicateOf: targetId || undefined },
      },
    }));
  }

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

  async function finalizeReview(setId, questions) {
    setActionLoading(setId);
    try {
      const reviews = questions.map((q) => {
        const state = reviewState[setId]?.[q.id] ?? {};
        const editedStatement = state.editedStatement?.trim();
        const hasEdit = editedStatement && editedStatement !== q.statement;
        return {
          questionId: q.id,
          rejected: state.rejected ?? false,
          rejectionReason: state.reason ?? "",
          ...(state.duplicateOf ? { duplicateOf: state.duplicateOf } : {}),
          ...(hasEdit ? { editedStatement } : {}),
        };
      });
      await api.reviewQuestionSet(adminSecret, setId, { reviews });
      setReviewState((prev) => { const next = { ...prev }; delete next[setId]; return next; });
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function publishSet(id) {
    setActionLoading(id);
    try {
      await api.unhideQuestionSet(adminSecret, id);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function addQuestion(setId) {
    const text = newQuestionText[setId]?.trim();
    if (!text) return;
    setActionLoading(`add-${setId}`);
    try {
      await api.addQuestion(adminSecret, setId, text);
      setNewQuestionText((prev) => ({ ...prev, [setId]: "" }));
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function removeQuestion(setId, questionId) {
    setActionLoading(`q-${questionId}`);
    try {
      await api.removeQuestion(adminSecret, setId, questionId);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  function toggleMergeSelect(questionId) {
    setMergeSelection((sel) => {
      const next = sel.includes(questionId) ? sel.filter((id) => id !== questionId) : [...sel, questionId];
      setMergeKeepId((k) => (next.includes(k) ? k : next[0] || null));
      return next;
    });
  }

  async function doMerge() {
    if (mergeSelection.length < 2 || !mergeKeepId) return;
    const dropIds = mergeSelection.filter((id) => id !== mergeKeepId);
    setActionLoading("merge");
    try {
      await api.mergeQuestions(adminSecret, mergeKeepId, dropIds);
      setMergeSelection([]);
      setMergeKeepId(null);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function _hideSet(id) {
    setActionLoading(id);
    try {
      await api.hideQuestionSet(adminSecret, id);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function _unhideSet(id) {
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

  async function rotatePartyToken(id) {
    if (import.meta.env.VITE_NODE_ENV !== "development" && !window.confirm(t.adminRotatePartyTokenConfirm)) return;
    setActionLoading(`rotate-${id}`);
    try {
      await api.rotatePartyToken(adminSecret, id);
      await refresh();
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  async function loadPartyCandidates(id) {
    setActionLoading(`candidates-${id}`);
    try {
      const candidates = await api.getPartyCandidatesAdmin(adminSecret, id);
      setPartyCandidates((prev) => ({ ...prev, [id]: candidates }));
    } catch (e) { setError(e.message); }
    finally { setActionLoading(null); }
  }

  function togglePartyCandidates(id) {
    if (partyCandidates[id]) {
      setPartyCandidates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    loadPartyCandidates(id);
  }

  function emailStatus(c) {
    if (!c.lastEmailStatus) return <span style={{ color: palette.textMuted }}>{t.adminEmailNone}</span>;
    const at = new Date(c.lastEmailAt).toLocaleString(lang === "fi" ? "fi-FI" : "en-GB", { dateStyle: "short", timeStyle: "short" });
    return c.lastEmailStatus === "sent"
      ? <span style={{ color: palette.textMuted }}>{t.adminEmailSent(at)}</span>
      : <span style={{ color: palette.danger }}>{t.adminEmailFailed(at, c.lastEmailError)}</span>;
  }

  async function sendPartyCandidateLinks(id) {
    if (import.meta.env.VITE_NODE_ENV !== "development" && !window.confirm(t.adminSendLinksConfirm)) return;
    setActionLoading(`links-${id}`);
    try {
      const result = await api.sendPartyCandidateLinks(adminSecret, id);
      setLinksQueued((prev) => ({ ...prev, [id]: result }));
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
  const staged = questionSets.filter((s) => s.status === "approved" && s.hidden);
  const live = questionSets.filter((s) => s.status === "approved" && !s.hidden);
  const rejected = questionSets.filter((s) => s.status === "rejected");

  // Distinct questions across every set, with the NGOs/sets that share each one.
  // Used both for the inline "duplicate of…" picker and the dedicated merge tool.
  const allQuestionsFlat = (() => {
    const map = new Map(); // id → { id, statement, ngos: [], setTitles: [], approved }
    questionSets.forEach((s) => {
      (s.questions || []).forEach((q) => {
        if (!map.has(q.id)) map.set(q.id, { id: q.id, statement: q.statement, ngos: [], setTitles: [], approved: false });
        const entry = map.get(q.id);
        if (s.ngoName && !entry.ngos.includes(s.ngoName)) entry.ngos.push(s.ngoName);
        if (s.title && !entry.setTitles.includes(s.title)) entry.setTitles.push(s.title);
        if (s.status === "approved") entry.approved = true;
      });
    });
    return [...map.values()];
  })();

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 24px" }}>
      <h2 style={{ fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", marginBottom: "8px" }}>{t.adminPanelTitle}</h2>
      <p style={{ color: palette.textMuted, marginBottom: "16px" }}>{t.adminPanelDesc}</p>
      <MarkdownGuide content={adminGuideContent} label="Ohje kysymysten käsittelyyn" />
      {error && <ErrorBanner message={error} onRetry={refresh} />}

      <section style={{ marginBottom: "40px" }}>
        <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px", display: "flex", alignItems: "center", gap: "10px" }}>
          {t.adminPending} {pending.length > 0 && <Badge color="orange">{pending.length}</Badge>}
        </h3>
        {pending.length === 0 && <p style={{ color: palette.textLight, fontSize: "14px" }}>{t.adminNoPending}</p>}
        {pending.map((qs) => (
          <Card key={qs.id} style={{ marginBottom: "12px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", flexWrap: "wrap", gap: "12px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                  <NgoLogo src={qs.logoUrl} name={qs.ngoName} size={28} />
                  <div style={{ fontWeight: 700, fontSize: "16px" }}>{qs.title}</div>
                </div>
                <div style={{ fontSize: "13px", color: palette.textMuted, marginBottom: "12px" }}>{qs.ngoName} · {qs.ngoEmail} · {qs.questions?.length || 0} {t.adminQuestions}</div>
                <div>
                  {qs.questions?.map((q, i) => {
                    const qState = reviewState[qs.id]?.[q.id] ?? {};
                    const isRejected = qState.rejected ?? false;
                    const isEditing = qState.editing ?? false;
                    const editedStatement = qState.editedStatement;
                    const hasEdit = editedStatement !== undefined && editedStatement.trim() !== q.statement;
                    const isDuplicate = !!qState.duplicateOf;
                    const dupTarget = isDuplicate ? allQuestionsFlat.find((x) => x.id === qState.duplicateOf) : null;
                    // Offer already-approved questions from other sets as merge targets.
                    const currentSetQIds = new Set((qs.questions || []).map((x) => x.id));
                    const mergeTargets = allQuestionsFlat.filter((x) => x.approved && !currentSetQIds.has(x.id));
                    const highlighted = hasEdit || isDuplicate;
                    const bg = isRejected ? palette.dangerLight : highlighted ? palette.infoLight : palette.accentLight;
                    const border = isRejected ? "#f5c6c2" : highlighted ? "#b8d0e8" : "#c6dece";
                    return (
                      <div key={q.id} style={{ marginBottom: "8px", padding: "10px 12px", background: bg, borderRadius: "6px", border: `1px solid ${border}` }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                          <span style={{ color: palette.textLight, fontSize: "13px", flexShrink: 0 }}>{i + 1}.</span>
                          <span style={{ fontSize: "13px", flex: 1 }}>
                            {hasEdit
                              ? <><span style={{ textDecoration: "line-through", color: palette.textLight }}>{q.statement}</span>{" → "}<span style={{ color: palette.info }}>{editedStatement.trim()}</span></>
                              : q.statement}
                          </span>
                          {isDuplicate ? (
                            <button
                              onClick={() => setDuplicateOf(qs.id, q.id, null)}
                              style={{ flexShrink: 0, padding: "3px 10px", fontSize: "12px", fontWeight: 600, borderRadius: "4px", border: `2px solid ${palette.info}`, cursor: "pointer", background: palette.surface, color: palette.info }}
                            >
                              {t.adminCancelDuplicate}
                            </button>
                          ) : isRejected ? (
                            <button
                              onClick={() => toggleQuestionReject(qs.id, q.id)}
                              style={{ flexShrink: 0, padding: "3px 10px", fontSize: "12px", fontWeight: 600, borderRadius: "4px", border: "none", cursor: "pointer", background: palette.danger, color: "#fff" }}
                            >
                              {t.adminQuestionRejected}
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => isEditing ? cancelEdit(qs.id, q.id) : startEdit(qs.id, q.id, q.statement)}
                                style={{ flexShrink: 0, padding: "3px 8px", fontSize: "12px", fontWeight: 600, borderRadius: "4px", border: `1px solid ${palette.border}`, cursor: "pointer", background: palette.surface, color: palette.textMuted }}
                              >
                                {isEditing ? t.adminCancelEdit : t.adminEditQuestion}
                              </button>
                              <button
                                onClick={() => {}}
                                style={{ flexShrink: 0, padding: "3px 10px", fontSize: "12px", fontWeight: 600, borderRadius: "4px", border: `2px solid ${palette.accent}`, cursor: "default", background: palette.surface, color: palette.accent }}
                              >
                                {t.adminQuestionAccepted}
                              </button>
                              <button
                                onClick={() => toggleQuestionReject(qs.id, q.id)}
                                style={{ flexShrink: 0, padding: "3px 10px", fontSize: "12px", fontWeight: 600, borderRadius: "4px", border: `2px solid ${palette.danger}`, cursor: "pointer", background: palette.surface, color: palette.danger }}
                              >
                                {t.adminReject}
                              </button>
                            </>
                          )}
                        </div>
                        {!isRejected && (
                          isDuplicate ? (
                            <div style={{ marginTop: "8px", fontSize: "12px", color: palette.info }}>
                              {t.adminDuplicateOf} "{dupTarget?.statement ?? "—"}"{dupTarget?.ngos?.length ? ` (${dupTarget.ngos.join(", ")})` : ""}
                            </div>
                          ) : mergeTargets.length > 0 && !isEditing ? (
                            <select
                              value=""
                              onChange={(e) => e.target.value && setDuplicateOf(qs.id, q.id, e.target.value)}
                              style={{ marginTop: "8px", width: "100%", boxSizing: "border-box", fontSize: "12px", padding: "5px 6px", borderRadius: "4px", border: `1px solid ${palette.border}`, fontFamily: "inherit", background: palette.surface, color: palette.textMuted }}
                            >
                              <option value="">{t.adminMarkDuplicate} — {t.adminDuplicateOfPlaceholder}</option>
                              {mergeTargets.map((tq) => (
                                <option key={tq.id} value={tq.id}>
                                  {tq.ngos.join(", ")}: {tq.statement.length > 80 ? tq.statement.slice(0, 80) + "…" : tq.statement}
                                </option>
                              ))}
                            </select>
                          ) : null
                        )}
                        {isEditing && (
                          <textarea
                            value={editedStatement ?? q.statement}
                            onChange={(e) => setEditedStatement(qs.id, q.id, e.target.value)}
                            placeholder={t.adminEditQuestionPlaceholder}
                            rows={2}
                            style={{ marginTop: "8px", width: "100%", boxSizing: "border-box", fontSize: "13px", padding: "6px 8px", borderRadius: "4px", border: `1px solid ${palette.border}`, resize: "vertical", fontFamily: "inherit" }}
                          />
                        )}
                        {isRejected && (
                          <textarea
                            value={qState.reason ?? ""}
                            onChange={(e) => setRejectionReason(qs.id, q.id, e.target.value)}
                            placeholder={t.adminRejectionReasonPlaceholder}
                            rows={2}
                            style={{ marginTop: "8px", width: "100%", boxSizing: "border-box", fontSize: "13px", padding: "6px 8px", borderRadius: "4px", border: `1px solid ${palette.border}`, resize: "vertical", fontFamily: "inherit" }}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                <Button variant="primary" size="sm" onClick={() => finalizeReview(qs.id, qs.questions || [])} loading={actionLoading === qs.id}>{t.adminFinalizeReview}</Button>
                <Button variant="danger" size="sm" onClick={() => deleteSet(qs.id)} loading={actionLoading === qs.id}>{t.adminDelete}</Button>
              </div>
            </div>
          </Card>
        ))}
      </section>

      {staged.length > 0 && (
        <section style={{ marginBottom: "40px" }}>
          <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px" }}>{t.adminStaged} <Badge color="orange">{staged.length}</Badge></h3>
          {staged.map((qs) => (
            <Card key={qs.id} style={{ marginBottom: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", flexWrap: "wrap", gap: "12px" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
                    <NgoLogo src={qs.logoUrl} name={qs.ngoName} size={24} />
                    <span style={{ fontWeight: 700, fontSize: "15px" }}>{qs.title}</span>
                  </div>
                  <div style={{ fontSize: "13px", color: palette.textMuted, marginBottom: "12px" }}>{qs.ngoName}</div>
                  <div style={{ marginBottom: "12px" }}>
                    {qs.questions?.map((q, i) => (
                      <div key={q.id} style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", padding: "8px 10px", background: palette.surfaceAlt, borderRadius: "6px" }}>
                        <span style={{ color: palette.textLight, fontSize: "13px", flexShrink: 0 }}>{i + 1}.</span>
                        <span style={{ fontSize: "13px", flex: 1 }}>{q.statement}</span>
                        <Button variant="danger" size="sm" onClick={() => removeQuestion(qs.id, q.id)} loading={actionLoading === `q-${q.id}`}>{t.adminDeleteQuestion}</Button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: "8px" }}>
                    <textarea
                      value={newQuestionText[qs.id] ?? ""}
                      onChange={(e) => setNewQuestionText((prev) => ({ ...prev, [qs.id]: e.target.value }))}
                      placeholder={t.adminNewQuestionPlaceholder}
                      rows={2}
                      style={{ flex: 1, fontSize: "13px", padding: "6px 8px", borderRadius: "4px", border: `1px solid ${palette.border}`, resize: "vertical", fontFamily: "inherit" }}
                    />
                    <Button variant="secondary" size="sm" onClick={() => addQuestion(qs.id)} disabled={!newQuestionText[qs.id]?.trim()} loading={actionLoading === `add-${qs.id}`}>{t.adminAddQuestion}</Button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
                  <Button variant="primary" size="sm" onClick={() => publishSet(qs.id)} loading={actionLoading === qs.id}>{t.adminPublish}</Button>
                  <Button variant="danger" size="sm" onClick={() => deleteSet(qs.id)} loading={actionLoading === qs.id}>{t.adminDelete}</Button>
                </div>
              </div>
            </Card>
          ))}
        </section>
      )}

      <section style={{ marginBottom: "40px" }}>
        <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "16px" }}>{t.adminApproved} <Badge color="green">{live.length}</Badge></h3>
        {live.map((qs) => (
          <Card key={qs.id} style={{ marginBottom: "8px", padding: "16px 24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <NgoLogo src={qs.logoUrl} name={qs.ngoName} size={24} />
                <span style={{ fontWeight: 600 }}>{qs.title}</span>
                <span style={{ color: palette.textMuted, fontSize: "13px" }}>— {qs.ngoName} · {qs.questions?.length || 0} {t.adminQuestions}</span>
              </div>
              <div style={{ display: "flex", gap: "8px", flexShrink: 0, alignItems: "center" }}>
                <Badge color="green">{t.adminPublished}</Badge>
                <Button variant="danger" size="sm" onClick={() => deleteSet(qs.id)} loading={actionLoading === qs.id}>{t.adminDelete}</Button>
              </div>
            </div>
          </Card>
        ))}
      </section>

      {allQuestionsFlat.filter((x) => x.approved).length > 1 && (
        <section style={{ marginBottom: "40px" }}>
          <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "8px" }}>{t.adminMergeTitle}</h3>
          <p style={{ fontSize: "13px", color: palette.textMuted, marginBottom: "16px" }}>{t.adminMergeDesc}</p>
          <Card>
            {allQuestionsFlat.filter((x) => x.approved).map((q) => {
              const selected = mergeSelection.includes(q.id);
              return (
                <div key={q.id} style={{ display: "flex", alignItems: "flex-start", gap: "10px", padding: "8px 0", borderBottom: `1px solid ${palette.border}` }}>
                  <input type="checkbox" checked={selected} onChange={() => toggleMergeSelect(q.id)} style={{ marginTop: "3px", flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "13px" }}>{q.statement}</div>
                    <div style={{ fontSize: "11px", color: palette.textLight }}>{t.adminMergeInSets} {q.setTitles.join(", ")}</div>
                  </div>
                  {selected && (
                    <label style={{ fontSize: "11px", color: palette.textMuted, display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
                      <input type="radio" name="merge-keep" checked={mergeKeepId === q.id} onChange={() => setMergeKeepId(q.id)} />
                      {t.adminMergeKeepLabel}
                    </label>
                  )}
                </div>
              );
            })}
            <div style={{ marginTop: "12px", display: "flex", alignItems: "center", gap: "12px" }}>
              <Button variant="primary" size="sm" onClick={doMerge} disabled={mergeSelection.length < 2 || !mergeKeepId} loading={actionLoading === "merge"}>{t.adminMergeButton}</Button>
              {mergeSelection.length < 2 && <span style={{ fontSize: "12px", color: palette.textLight }}>{t.adminMergeHint}</span>}
            </div>
          </Card>
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
            <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
              <Button variant="ghost" size="sm" onClick={() => togglePartyCandidates(p.id)} loading={actionLoading === `candidates-${p.id}`}>
                {partyCandidates[p.id] ? t.adminHideCandidates : t.adminShowCandidates}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => rotatePartyToken(p.id)} loading={actionLoading === `rotate-${p.id}`}>{t.adminRotatePartyToken}</Button>
            </div>
            {partyCandidates[p.id] && (
              <div style={{ marginTop: "12px", borderTop: `1px solid ${palette.border}`, paddingTop: "12px" }}>
                {partyCandidates[p.id].length === 0 && <p style={{ color: palette.textMuted, fontSize: "13px", margin: 0 }}>{t.partyNoCandidates}</p>}
                {partyCandidates[p.id].map((c) => (
                  <div key={c.id} style={{ marginBottom: "12px" }}>
                    <div style={{ fontSize: "13px", marginBottom: "6px", overflowWrap: "anywhere" }}>
                      <span style={{ fontWeight: 600 }}>{c.name}</span>
                      <span style={{ color: palette.textMuted }}> · {c.constituency} · {c.email || t.partyNoEmail} · {c.answerCount} {t.candidateAnswered}</span>
                      {c.email && <div style={{ fontSize: "12px", marginTop: "2px" }}>{emailStatus(c)}</div>}
                    </div>
                    <CopyField value={candidateLink(c.token)} />
                  </div>
                ))}
                {partyCandidates[p.id].length > 0 && (
                  <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                    <Button variant="secondary" size="sm" onClick={() => sendPartyCandidateLinks(p.id)} loading={actionLoading === `links-${p.id}`} disabled={!!linksQueued[p.id]}>
                      {t.adminSendLinks}
                    </Button>
                    {linksQueued[p.id] && (
                      <>
                        <span style={{ fontSize: "13px", color: palette.textMuted }}>{t.adminLinksQueued(linksQueued[p.id].queued, linksQueued[p.id].withoutEmail)}</span>
                        <Button variant="ghost" size="sm" onClick={() => loadPartyCandidates(p.id)} loading={actionLoading === `candidates-${p.id}`}>{t.adminRefreshEmailStatus}</Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
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
      <MarkdownGuide content={ngoGuideContent} label="Ohje kysymysten lähettämiseen" />
      {error && <ErrorBanner message={error} scrollIntoView />}
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
                <div style={{ flex: 1 }}><TextArea value={q} onChange={(v) => updateQuestion(i, v)} placeholder={t.ngoStatementPlaceholder} rows={2} maxLength={500} /></div>
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

// ─── Candidate & party portals ───

const selectStyle = {
  width: "100%", padding: "10px 14px", borderRadius: "6px", border: `1px solid ${palette.border}`,
  fontFamily: "'Source Serif 4', Georgia, serif", fontSize: "14px",
  background: palette.surface, color: palette.text, outline: "none", boxSizing: "border-box",
};
const labelStyle = { fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" };

const candidateLink = (token) => `${window.location.origin}/?candidateToken=${token}`;
const registrationLink = (token) => `${window.location.origin}/?register=${token}`;

// Distinct questions across approved sets (a question may be shared by several sets).
function distinctQuestions(questionSets) {
  const approved = questionSets.filter((s) => s.status === "approved");
  return [...new Map(approved.flatMap((s) => s.questions || []).map((q) => [q.id, q])).values()];
}

function confirmAction(message) {
  return import.meta.env.VITE_NODE_ENV === "development" || window.confirm(message);
}

function InvalidLink({ legacy = false }) {
  const { t } = useTranslation();
  return (
    <div style={{ maxWidth: 500, margin: "0 auto", padding: "80px 24px", textAlign: "center" }}>
      <h2 style={{ fontSize: "24px", fontWeight: 800, marginBottom: "8px" }}>{legacy ? t.candidateLegacyLink : t.candidateInvalidToken}</h2>
      <p style={{ color: palette.textMuted }}>{legacy ? t.candidateLegacyLinkDesc : t.candidateInvalidTokenDesc}</p>
    </div>
  );
}

// A load that failed for a temporary reason (rate limit, server error,
// network). The link may well be fine, so offer a retry, not InvalidLink.
function LoadFailed({ onRetry }) {
  const { t } = useTranslation();
  return (
    <div style={{ maxWidth: 500, margin: "0 auto", padding: "80px 24px" }}>
      <ErrorBanner message={t.linkLoadFailed} onRetry={onRetry} />
    </div>
  );
}

function ViewCrashed() {
  const { t } = useTranslation();
  return (
    <div style={{ maxWidth: 500, margin: "0 auto", padding: "80px 24px" }}>
      <ErrorBanner message={t.viewCrashed} />
    </div>
  );
}

function CopyField({ value }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable — the field is still selectable */ }
  }
  return (
    <div style={{ display: "flex", gap: "8px" }}>
      <input readOnly value={value} onFocus={(e) => e.target.select()} style={{ ...selectStyle, fontFamily: "monospace", fontSize: "12px" }} />
      <Button variant="secondary" size="sm" onClick={copy} style={{ flexShrink: 0 }}>{copied ? t.copied : t.copy}</Button>
    </div>
  );
}

// Profile fields shared by self-registration and the candidate's own page.
function ProfileFields({ profile, setField }) {
  const { t } = useTranslation();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div>
        <label style={labelStyle}>{t.candidateFullName} *</label>
        <Input value={profile.name} onChange={(v) => setField("name", v)} placeholder={t.candidateFullNamePlaceholder} />
      </div>
      <div>
        <label style={labelStyle}>{t.candidateEmailLabel} *</label>
        <Input value={profile.email} onChange={(v) => setField("email", v)} placeholder={t.candidateEmailPlaceholder} type="email" />
      </div>
      <div>
        <label style={labelStyle}>{t.candidateConstituencyLabel} *</label>
        <select value={profile.constituency} onChange={(e) => setField("constituency", e.target.value)} style={selectStyle}>
          <option value="">{t.candidateConstituencyPlaceholder}</option>
          {FI_CONSTITUENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div>
        <label style={labelStyle}>{t.candidatePhotoUrl}</label>
        <Input value={profile.photoUrl} onChange={(v) => setField("photoUrl", v)} placeholder={t.candidatePhotoUrlPlaceholder} />
        {profile.photoUrl && (
          <div style={{ marginTop: "8px", display: "flex", alignItems: "center", gap: "10px" }}>
            <Avatar src={profile.photoUrl} name={profile.name} size={48} />
            <span style={{ fontSize: "12px", color: palette.textLight }}>{t.preview}</span>
          </div>
        )}
      </div>
      <div>
        <label style={labelStyle}>{t.candidateBio}</label>
        <TextArea value={profile.bio} onChange={(v) => setField("bio", v)} placeholder={t.candidateBioPlaceholder} rows={4} maxLength={1000} />
      </div>
    </div>
  );
}

const EMPTY_PROFILE = { name: "", email: "", constituency: "", photoUrl: "", bio: "" };
const profileComplete = (p) => p.name.trim() && p.email.trim() && p.constituency;
const profilePayload = (p) => ({
  name: p.name.trim(),
  email: p.email.trim(),
  constituency: p.constituency,
  photoUrl: p.photoUrl.trim() || null,
  bio: p.bio.trim() || null,
});

// Party secretary's portal: share the registration link, follow progress,
// re-send personal links and remove sign-ups. Cannot edit candidates' answers.
function PartyView({ partyToken }) {
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [questionCount, setQuestionCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [sent, setSent] = useState({});

  useEffect(() => {
    async function load() {
      setLoading(true);
      setLoadFailed(false);
      try {
        const [overview, qs] = await Promise.all([api.getPartyOverview(partyToken), api.getQuestionSets()]);
        setData(overview);
        setQuestionCount(distinctQuestions(qs).length);
      } catch (e) {
        if (isTransientError(e)) setLoadFailed(true);
        else setInvalid(true);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [partyToken, attempt]);

  async function run(key, fn) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  const rotate = () => {
    if (!confirmAction(t.partyRotateConfirm)) return;
    run("rotate", async () => {
      const { registrationToken } = await api.rotateRegistrationLink(partyToken);
      setData((d) => ({ ...d, party: { ...d.party, registrationToken } }));
    });
  };

  const sendLink = (c) => run(`send-${c.id}`, async () => {
    await api.sendCandidateLink(partyToken, c.id);
    setSent((s) => ({ ...s, [c.id]: true }));
  });

  const remove = (c) => {
    if (!confirmAction(t.partyRemoveConfirm(c.name))) return;
    run(`remove-${c.id}`, async () => {
      await api.removeCandidate(partyToken, c.id);
      setData((d) => ({ ...d, candidates: d.candidates.filter((x) => x.id !== c.id) }));
    });
  };

  if (loading) return <LoadingState />;
  if (invalid) return <InvalidLink />;
  if (loadFailed) return <LoadFailed onRetry={() => setAttempt((n) => n + 1)} />;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "40px 24px" }}>
      <Badge color="blue">{data.party.name}</Badge>
      <h2 style={{ fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", margin: "12px 0 8px" }}>{t.partyPortalTitle}</h2>
      <p style={{ color: palette.textMuted, marginBottom: "24px" }}>{t.partyPortalDesc}</p>
      {error && <ErrorBanner message={error} />}

      <Card style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "14px", fontWeight: 700, marginBottom: "6px" }}>{t.partyRegistrationLinkTitle}</div>
        <p style={{ fontSize: "13px", color: palette.textMuted, margin: "0 0 12px", lineHeight: 1.6 }}>{t.partyRegistrationLinkDesc}</p>
        <CopyField value={registrationLink(data.party.registrationToken)} />
        <div style={{ marginTop: "12px" }}>
          <Button variant="ghost" size="sm" onClick={rotate} loading={busy === "rotate"}>{t.partyRotateLink}</Button>
        </div>
      </Card>

      <h3 style={{ fontSize: "16px", fontWeight: 700, marginBottom: "12px" }}>{t.partyCandidatesTitle} ({data.candidates.length})</h3>
      {data.candidates.length === 0 && <p style={{ color: palette.textMuted, fontSize: "14px" }}>{t.partyNoCandidates}</p>}
      {data.candidates.map((c) => (
        <Card key={c.id} style={{ marginBottom: "8px", padding: "14px 20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
              <Avatar src={c.photoUrl} name={c.name} size={36} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{c.name}</div>
                <div style={{ fontSize: "12px", color: palette.textMuted, overflowWrap: "anywhere" }}>
                  {c.constituency} · {c.email || t.partyNoEmail} · {c.answerCount}/{questionCount} {t.candidateAnswered}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <Button variant="secondary" size="sm" onClick={() => sendLink(c)} disabled={!c.email || sent[c.id]} loading={busy === `send-${c.id}`}>
                {sent[c.id] ? t.partyLinkSent : t.partySendLink}
              </Button>
              <Button variant="danger" size="sm" onClick={() => remove(c)} loading={busy === `remove-${c.id}`}>{t.partyRemoveCandidate}</Button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// Self-registration through the party's shared link. On success the candidate
// continues straight to their own page with their personal token.
function RegisterView({ registrationToken, onRegistered }) {
  const { t } = useTranslation();
  const [partyName, setPartyName] = useState(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setLoadFailed(false);
      try {
        const r = await api.getRegistration(registrationToken);
        setPartyName(r.party.name);
      } catch (e) {
        if (isTransientError(e)) setLoadFailed(true);
        else setInvalid(true);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [registrationToken, attempt]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const created = await api.register(registrationToken, profilePayload(profile));
      onRegistered(created.token);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  if (loading) return <LoadingState />;
  if (invalid) return <InvalidLink />;
  if (loadFailed) return <LoadFailed onRetry={() => setAttempt((n) => n + 1)} />;

  return (
    <div style={{ maxWidth: 600, margin: "0 auto", padding: "40px 24px" }}>
      <Badge color="blue">{partyName}</Badge>
      <h2 style={{ fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", margin: "12px 0 8px" }}>{t.registerTitle}</h2>
      <p style={{ color: palette.textMuted, marginBottom: "16px" }}>{t.registerDesc(partyName)}</p>
      <MarkdownGuide content={candidateGuideContent} label="Ohje vastaamiseen" />
      {error && <ErrorBanner message={error} scrollIntoView />}
      <Card style={{ marginBottom: "16px" }}>
        <ProfileFields profile={profile} setField={(k, v) => setProfile((p) => ({ ...p, [k]: v }))} />
      </Card>
      <Button onClick={submit} loading={saving} disabled={!profileComplete(profile)}>{t.registerSubmit}</Button>
    </div>
  );
}

// The candidate's own page, reached only through their personal link.
function answersFromProfile(me) {
  return Object.fromEntries(
    Object.entries(me.answers || {}).map(([k, v]) => [k, { value: v.value, text: v.explanation || "" }])
  );
}

function CandidateView({ candidateToken, justRegistered, leaveGuardRef }) {
  const { t } = useTranslation();
  const [partyName, setPartyName] = useState("");
  const [questionSets, setQuestionSets] = useState([]);
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [answers, setAnswers] = useState({});
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Counts edits, and the edit count the last successful save covered, so
  // leaving the page with unsaved changes can be warned about.
  const edits = useRef({ made: 0, saved: 0 });
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const syncUnsaved = () => setHasUnsaved(edits.current.made !== edits.current.saved);

  // In-app navigation unmounts the view without unloading the page.
  useEffect(() => {
    leaveGuardRef.current = () => edits.current.made !== edits.current.saved;
    return () => { leaveGuardRef.current = null; };
  }, [leaveGuardRef]);

  // Only while there are unsaved changes: in Firefox any beforeunload
  // listener keeps the page out of the back/forward cache.
  useEffect(() => {
    if (!hasUnsaved) return;
    function warn(e) {
      e.preventDefault();
      e.returnValue = ""; // older browsers need this to show the prompt
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasUnsaved]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setLoadFailed(false);
      try {
        const [me, qs] = await Promise.all([api.getOwnProfile(candidateToken), api.getQuestionSets()]);
        setPartyName(me.party.name);
        setQuestionSets(qs);
        setProfile({
          name: me.name, email: me.email || "", constituency: me.constituency || "",
          photoUrl: me.photoUrl || "", bio: me.bio || "",
        });
        setAnswers(answersFromProfile(me));
      } catch (e) {
        if (isTransientError(e)) setLoadFailed(true);
        else setInvalid(true);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [candidateToken, attempt]);

  const approvedSets = questionSets.filter((s) => s.status === "approved");
  const allQuestions = distinctQuestions(questionSets);

  function setAnswer(qId, field, val) {
    if (answers[qId]?.[field] === val) return;
    edits.current.made++;
    setHasUnsaved(true);
    setAnswers((a) => ({ ...a, [qId]: { ...a[qId], [field]: val } }));
  }

  function setProfileField(k, v) {
    edits.current.made++;
    setHasUnsaved(true);
    setProfile((p) => ({ ...p, [k]: v }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    // Edits made while the save is in flight aren't covered by it, and
    // explanations for unrated questions aren't sent at all.
    const unsent = Object.values(answers).some((a) => a.value === undefined && a.text?.trim());
    const editsSaved = unsent ? edits.current.saved : edits.current.made;
    try {
      const apiAnswers = {};
      for (const [qId, a] of Object.entries(answers)) {
        if (a.value !== undefined) {
          apiAnswers[qId] = { value: a.value, explanation: a.text || "" };
        }
      }
      const result = await api.saveOwnProfile(candidateToken, profilePayload(profile), apiAnswers);
      // A backend that predates the combined save ignores the answers.
      if (typeof result.saved !== "number") throw new Error(t.candidateAnswersNotSaved);
      const { skipped = [] } = result;
      if (skipped.length > 0) {
        edits.current.saved = editsSaved;
        syncUnsaved();
        // Those questions are gone. Drop them locally rather than refetching
        // the public (edge-cached) question list, and reload own answers
        // (uncached) in case a merge carried one over to the kept question.
        const isSkipped = (qId) => skipped.includes(qId);
        setQuestionSets((sets) => sets.map((s) => ({ ...s, questions: (s.questions || []).filter((q) => !isSkipped(q.id)) })));
        try {
          const me = await api.getOwnProfile(candidateToken);
          setAnswers((prev) => {
            const next = answersFromProfile(me);
            // Keep explanations typed for questions not rated yet (they weren't
            // sent), unless a merge has since given the question a server answer.
            for (const [qId, a] of Object.entries(prev)) {
              if (a.value === undefined && !isSkipped(qId) && next[qId] === undefined) next[qId] = a;
            }
            return next;
          });
        } catch {
          setAnswers((prev) => Object.fromEntries(Object.entries(prev).filter(([qId]) => !isSkipped(qId))));
        }
        setError(t.candidateAnswersSkipped(skipped.length));
        return;
      }
      edits.current.saved = editsSaved;
      syncUnsaved();
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState />;
  if (invalid) return <InvalidLink />;
  if (loadFailed) return <LoadFailed onRetry={() => setAttempt((n) => n + 1)} />;

  if (saved) {
    return (
      <div style={{ maxWidth: 500, margin: "0 auto", padding: "80px 24px", textAlign: "center" }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: palette.accentLight, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px", fontSize: "28px" }}>✓</div>
        <h2 style={{ fontSize: "24px", fontWeight: 800, marginBottom: "8px" }}>{t.candidateSavedTitle}</h2>
        <p style={{ color: palette.textMuted, marginBottom: "24px" }}>{t.candidateSavedDesc(profile.name, partyName)}</p>
        <Button variant="secondary" onClick={() => setSaved(false)}>{t.candidateContinueEditing}</Button>
      </div>
    );
  }

  const answeredCount = Object.values(answers).filter((a) => a.value !== undefined).length;
  const canSave = profileComplete(profile);

  return (
    <div style={{ maxWidth: 740, margin: "0 auto", padding: "40px 24px" }}>
      {justRegistered && (
        <div style={{ padding: "16px 20px", borderRadius: "8px", background: palette.accentLight, border: "1px solid #C5D9CC", marginBottom: "24px" }}>
          <div style={{ fontSize: "14px", fontWeight: 700, marginBottom: "6px" }}>{t.candidateLinkTitle}</div>
          <p style={{ fontSize: "13px", color: palette.text, margin: "0 0 12px", lineHeight: 1.6 }}>{t.candidateLinkDesc}</p>
          <CopyField value={candidateLink(candidateToken)} />
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: "24px", flexWrap: "wrap", gap: "12px" }}>
        <div>
          <Badge color="blue">{partyName}</Badge>
          <h2 style={{ fontSize: "24px", fontWeight: 800, margin: "8px 0 4px" }}>{t.candidateAnswerTitle}</h2>
          <p style={{ color: palette.textMuted, fontSize: "14px" }}>{answeredCount} / {allQuestions.length} {t.candidateAnsweredCount}</p>
        </div>
        <Button onClick={save} loading={saving} disabled={!canSave}>{t.candidateSaveAnswers}</Button>
      </div>
      <MarkdownGuide content={candidateGuideContent} label="Ohje vastaamiseen" />
      {error && <ErrorBanner message={error} scrollIntoView />}

      <Card style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "14px", fontWeight: 700, marginBottom: "16px" }}>{t.candidateProfile}</div>
        <ProfileFields profile={profile} setField={setProfileField} />
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
                <TextArea value={answers[q.id]?.text || ""} onChange={(v) => setAnswer(q.id, "text", v)} placeholder={t.candidateExplainPlaceholder} rows={2} maxLength={500} />
              </div>
            </Card>
          ))}
        </section>
      ))}

      <div style={{ textAlign: "center", paddingBottom: "40px" }}>
        <Button size="lg" onClick={save} loading={saving} disabled={!canSave}>
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
  try { localStorage.setItem(STORAGE_KEYS.consent, value ? "true" : "false"); } catch { /* ignore */ }
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
  } catch { /* ignore */ }
}

function clearSavedAnswers() {
  try {
    [STORAGE_KEYS.answers, STORAGE_KEYS.weights, STORAGE_KEYS.sets].forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

function revokeConsent() {
  try {
    Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
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
  const [questionCount, setQuestionCount] = useState(0);
  const [expandedCandidate, setExpandedCandidate] = useState(null);
  // Full candidate records (incl. answer explanations) fetched lazily on first
  // expand — the match response only carries answer values to keep it small.
  const [candidateDetails, setCandidateDetails] = useState({});
  const [profileCandidate, setProfileCandidate] = useState(null);
  const [constituency, setConstituency] = useState("");
  const [error, setError] = useState(null);
  const [consentGiven, setConsentGiven] = useState(() => loadConsent());
  const [includeInResearch, setIncludeInResearch] = useState(true);

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
  // A single question can belong to several selected sets (NGOs that posed the
  // same statement). Show it exactly once, and remember every NGO — among the
  // selected sets — that asked it, for attribution in the quiz.
  const { activeQuestions, ngosByQuestion } = useMemo(() => {
    const seen = new Map(); // questionId → question (first occurrence)
    const ngos = {};        // questionId → [ngoName, ...]
    approvedSets
      .filter((s) => selectedSetIds.has(s.id))
      .forEach((s) => {
        (s.questions || []).forEach((q) => {
          if (!seen.has(q.id)) seen.set(q.id, q);
          if (!ngos[q.id]) ngos[q.id] = [];
          if (s.ngoName && !ngos[q.id].includes(s.ngoName)) ngos[q.id].push(s.ngoName);
        });
      });
    return { activeQuestions: [...seen.values()], ngosByQuestion: ngos };
  }, [approvedSets, selectedSetIds]);

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
      const { results: matchResults, questionCount: scoredCount } = await api.voterMatch({
        answers: voterAnswers,
        weights,
        questionSetIds: [...selectedSetIds],
        constituency: constituency || null,
        includeInResearch,
      });
      setResults(matchResults ?? []);
      setQuestionCount(scoredCount ?? 0);
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
    const allAnswered = activeQuestions.length > 0 && activeQuestions.every((q) => voterAnswers[q.id] !== undefined);
    return (
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 24px" }}>
        <h2 style={{ fontSize: "28px", fontWeight: 800, letterSpacing: "-0.02em", marginBottom: "8px" }}>{t.voterSelectTitle}</h2>
        <p style={{ color: palette.textMuted, marginBottom: "16px" }}>{t.voterSelectDesc}</p>
        <MarkdownGuide content={voterGuideContent} label="Ohje vaalikoneen käyttöön" />
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
        <div style={{ marginTop: "20px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {hasSaved && allAnswered ? (
            <>
              <Button size="lg" onClick={() => setStep("weight")} disabled={selectedSetIds.size === 0}>
                {t.voterContinueToResults}
              </Button>
              <Button size="lg" variant="ghost" onClick={startAnswering} disabled={selectedSetIds.size === 0}>
                {t.voterReviewAnswers} ({activeQuestions.length} {t.voterQuestions})
              </Button>
            </>
          ) : (
            <Button size="lg" onClick={startAnswering} disabled={selectedSetIds.size === 0 || activeQuestions.length === 0}>
              {t.voterStart} ({activeQuestions.length} {t.voterQuestions})
            </Button>
          )}
        </div>
      </div>
    );
  }

  // Answering
  if (step === "answer") {
    const q = activeQuestions[currentQ];
    const askedBy = ngosByQuestion[q.id] || [];
    const progress = (currentQ / activeQuestions.length) * 100;
    return (
      <div style={{ maxWidth: 600, margin: "0 auto", padding: "40px 24px" }}>
        <div style={{ marginBottom: "24px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px", color: palette.textMuted, marginBottom: "8px" }}>
            <span>{askedBy.join(" · ")}</span><span>{currentQ + 1} / {activeQuestions.length}</span>
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
        <div style={{ marginTop: "24px", background: palette.surfaceAlt, border: `1px solid ${palette.border}`, borderRadius: "8px", padding: "14px 16px", fontSize: "13px", color: palette.textMuted, lineHeight: 1.65 }}>
          <p style={{ margin: "0 0 12px 0" }}>{t.voterResearchNotice}</p>
          <label style={{ display: "flex", alignItems: "flex-start", gap: "10px", cursor: "pointer" }}>
            <input type="checkbox" checked={!includeInResearch} onChange={(e) => setIncludeInResearch(!e.target.checked)} style={{ marginTop: "2px", flexShrink: 0 }} />
            <span>{t.voterResearchOptOut}</span>
          </label>
        </div>
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
            <div style={{ display: "flex", alignItems: "center", gap: "16px", cursor: "pointer" }} onClick={() => {
              setExpandedCandidate(isExpanded ? null : c.id);
              if (!isExpanded && !candidateDetails[c.id]) {
                api.getCandidate(c.id)
                  .then((full) => setCandidateDetails((prev) => ({ ...prev, [c.id]: full })))
                  .catch(() => {}); // explanations are progressive enhancement; values already shown
              }
            }}>
              <div style={{ position: "relative", flexShrink: 0 }}>
                <Avatar src={c.photoUrl} name={c.name} size={52} />
                <div style={{ position: "absolute", bottom: -4, right: -4, background: matchColor, color: "#fff", fontWeight: 800, fontSize: "11px", borderRadius: "10px", padding: "2px 6px", border: `2px solid ${palette.surface}` }}>{c.match}%</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: "16px" }}>{c.name}</span>
                  <Badge>{c.partyName}</Badge>
                  {c.constituency && <Badge color="blue">{c.constituency}</Badge>}
                  {questionCount > 0 && (
                    <span style={{ fontSize: "12px", color: palette.textLight }}>{t.voterAnsweredOf(c.answeredCount, questionCount)}</span>
                  )}
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
                  // A question the candidate skipped counts as full disagreement in
                  // the match, so show it rather than leaving the score unexplained.
                  if (!ca && va === undefined) return null;
                  const agree = ca && ca.value === va;
                  const close = ca && Math.abs(ca.value - va) <= 1;
                  const explanation = candidateDetails[c.id]?.answers?.[q.id]?.explanation;
                  return (
                    <div key={q.id} style={{ marginBottom: "16px" }}>
                      <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "6px" }}>{q.statement}</div>
                      <div style={{ display: "flex", gap: "16px", fontSize: "13px", flexWrap: "wrap" }}>
                        <span style={{ color: palette.textMuted }}>{t.voterYou}: <strong style={{ color: palette.text }}>{labels[va]}</strong></span>
                        <span style={{ color: agree ? palette.accent : close ? palette.warn : palette.danger }}>
                          {t.voterCandidate}: <strong>{ca ? labels[ca.value] : t.voterCandidateNoAnswer}</strong>{agree && " ✓"}
                        </span>
                      </div>
                      {explanation && (
                        <div style={{ marginTop: "6px", padding: "8px 12px", background: palette.surfaceAlt, borderRadius: "6px", fontSize: "13px", color: palette.textMuted, fontStyle: "italic", borderLeft: `3px solid ${palette.border}` }}>"{explanation}"</div>
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
        <Button variant="ghost" onClick={() => { clearSavedAnswers(); setStep("select"); setVoterAnswers({}); setWeights({}); setConstituency(""); setExpandedCandidate(null); setResults([]); setCandidateDetails({}); }}>{t.voterStartOver}</Button>
      </div>
      {profileCandidate && (
        <CandidateProfile candidate={profileCandidate} onClose={() => setProfileCandidate(null)} activeQuestions={activeQuestions} voterAnswers={voterAnswers} />
      )}
    </div>
  );
}

// ─── App ───

// The home page accepts either a pasted link (any of the above) or a bare
// party token, which is what party secretaries have historically been given.
function tokenLinkFromInput(value) {
  const text = value.trim();
  if (!text) return null;
  if (text.includes("?")) {
    try {
      const link = tokenLinkFromParams(new URL(text, window.location.origin).searchParams);
      if (link) return link;
    } catch { /* not a URL — fall through to a bare token */ }
  }
  return { view: "party", token: text };
}

// Null where storage is blocked; even reading the property can throw then.
const sessionStore = (() => {
  try { return window.sessionStorage; } catch { return null; }
})();

// Read once per page load: a second read (StrictMode runs state initializers
// twice) would find the URL already scrubbed and forget the link.
let pageLoadLink;
function readPageLoadLink() {
  if (pageLoadLink !== undefined) return pageLoadLink;
  const navigationType = window.performance?.getEntriesByType?.("navigation")[0]?.type
    // Browsers without Navigation Timing Level 2 (Safari before 15).
    ?? (window.performance?.navigation?.type === 1 ? "reload" : undefined);
  pageLoadLink = readInitialLink(window.location.search, sessionStore, navigationType);
  // Tokens are bearer secrets delivered as magic links. Scrub them from the
  // address bar once read so they don't linger in browser history,
  // bookmarks, or anything else that copies the URL. The open link is kept
  // in the tab's sessionStorage instead, so a reload can reopen it.
  if (tokenLinkFromParams(new URLSearchParams(window.location.search))) {
    window.history.replaceState({}, "", window.location.pathname);
  }
  return pageLoadLink;
}

export default function App() {
  const [initialLink] = useState(readPageLoadLink);

  const [view, setView] = useState(initialLink?.view || "home");
  const [token, setToken] = useState(initialLink?.token || null);
  const [justRegistered, setJustRegistered] = useState(Boolean(initialLink?.justRegistered));
  const [lang, setLang] = useState(DEFAULT_LANG);
  // Set by CandidateView while mounted: true when it has unsaved changes.
  const leaveGuardRef = useRef(null);
  // Bumped to reset the error boundary when navigating after a crash, even
  // to the view that crashed.
  const crashed = useRef(false);
  const [boundaryResets, setBoundaryResets] = useState(0);

  function openLink(link) {
    rememberLink(sessionStore, link);
    setToken(link.token);
    setJustRegistered(Boolean(link.justRegistered));
    setView(link.view);
  }

  function navigate(next) {
    if (leaveGuardRef.current?.() && !confirmAction(t.candidateUnsavedConfirm)) return;
    rememberLink(sessionStore, null);
    if (crashed.current) {
      crashed.current = false;
      setBoundaryResets((n) => n + 1);
    }
    setToken(null);
    setJustRegistered(false);
    setView(next);
  }

  const t = translations[lang] || translations.fi;
  const langValue = useMemo(() => ({ lang, t, setLang }), [lang, t]);

  return (
    <LanguageContext.Provider value={langValue}>
      <div style={{ minHeight: "100vh", background: palette.bg, fontFamily: "'Source Serif 4', Georgia, serif", color: palette.text }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } } .app-nav::-webkit-scrollbar { display: none; }`}</style>
        <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet" />
        <Header view={view} navigate={navigate} />
        {/* A render error would otherwise unmount the whole app, and with the
            link remembered for reloads, crash again on every reload. */}
        <Sentry.ErrorBoundary
          key={`${view}:${token}:${boundaryResets}`}
          fallback={<ViewCrashed />}
          onError={() => { crashed.current = true; rememberLink(sessionStore, null); }}
        >
          {view === "home" && <HomeView navigate={navigate} openLink={openLink} />}
          {view === "about" && <AboutView />}
          {view === "admin" && <AdminView />}
          {view === "ngo" && <NgoView />}
          {view === "party" && <PartyView partyToken={token} />}
          {view === "legacy" && <InvalidLink legacy />}
          {view === "register" && (
            <RegisterView
              registrationToken={token}
              onRegistered={(candidateToken) => openLink({ view: "candidate", token: candidateToken, justRegistered: true })}
            />
          )}
          {view === "candidate" && <CandidateView key={token} candidateToken={token} justRegistered={justRegistered} leaveGuardRef={leaveGuardRef} />}
          {view === "voter" && <VoterView />}
        </Sentry.ErrorBoundary>
      </div>
    </LanguageContext.Provider>
  );
}
