import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "finance_tracker_data";
const INCOME_SOURCES = ["Dropshipping", "GB Hosting", "Reselling", "Miscellaneous"];
const CURRENCY_TYPES = ["BTC", "USDT", "USD"];
const EXPENSE_CATEGORIES = ["Rent", "Utilities", "Groceries", "Transport", "Internet", "Other"];

const initialState = {
  entries: [],
  expenses: [],
  monthlyBudget: {},
  openingBalance: { btc: 0, usdt: 0, usd: 0, set: false, date: null },
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState;
    const parsed = JSON.parse(raw);
    return { ...initialState, ...parsed, openingBalance: parsed.openingBalance || initialState.openingBalance };
  } catch { return initialState; }
}

function saveState(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function formatUSD(n) {
  if (n == null || isNaN(n)) return "$—";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatBTC(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(6) + " BTC";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function monthKey(dateStr) {
  return dateStr ? dateStr.slice(0, 7) : today().slice(0, 7);
}

export default function App() {
  const [state, setState] = useState(loadState);
  const [btcPrice, setBtcPrice] = useState(null);
  const [btcPulse, setBtcPulse] = useState(false);
  const [tab, setTab] = useState("checkin");
  const [checkinText, setCheckinText] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState(null);
  const [aiError, setAiError] = useState(null);
  const [pendingEntries, setPendingEntries] = useState(null);
  const [manualIncome, setManualIncome] = useState({ source: "Dropshipping", currency: "BTC", amount: "", note: "", date: today() });
  const [manualExpense, setManualExpense] = useState({ category: "Rent", amount: "", note: "", date: today() });
  const [filterSource, setFilterSource] = useState("All");
  const [filterMonth, setFilterMonth] = useState(today().slice(0, 7));
  const [obForm, setObForm] = useState({ btc: "", usdt: "", usd: "" });

  // Fetch BTC price
  const fetchBTC = useCallback(async () => {
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
      const data = await res.json();
      const price = data?.bitcoin?.usd;
      if (price) {
        setBtcPrice(price);
        setBtcPulse(true);
        setTimeout(() => setBtcPulse(false), 800);
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchBTC();
    const interval = setInterval(fetchBTC, 60000);
    return () => clearInterval(interval);
  }, [fetchBTC]);

  useEffect(() => { saveState(state); }, [state]);

  // AI check-in parsing
  async function handleAICheckin() {
    if (!checkinText.trim()) return;
    setAiLoading(true);
    setAiResult(null);
    setAiError(null);
    setPendingEntries(null);

    const contextSummary = buildContextSummary();

    const prompt = `You are a financial tracker assistant. Parse the user's daily check-in and extract structured income and expense entries.

Current BTC price: $${btcPrice ? btcPrice.toLocaleString() : "unknown"}
Today's date: ${today()}

Income sources: Dropshipping (primary, ~80%, usually BTC), GB Hosting (~10-15%, usually USDT/USD, sometimes BTC), Reselling (mixed BTC/USDT/USD), Miscellaneous (one-offs, debt collection, etc.)

User's recent context:
${contextSummary}

User check-in: "${checkinText}"

Extract ALL income and expense mentions. For each income entry return:
- source: one of [Dropshipping, GB Hosting, Reselling, Miscellaneous]
- currency: one of [BTC, USDT, USD]
- amount: number (in native currency units)
- usdEquivalent: number (convert BTC using current price, USDT/USD as-is)
- note: brief description

For each expense entry return:
- category: one of [Rent, Utilities, Groceries, Transport, Internet, Other]
- amount: number in USD
- note: brief description

Also return:
- summary: 1-2 sentence natural language summary of what was logged
- flags: array of any unusual things, missing info, or suggestions

Respond ONLY with valid JSON in this exact shape:
{
  "income": [...],
  "expenses": [...],
  "summary": "...",
  "flags": [...]
}`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.REACT_APP_ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json();
      const text = data.content?.find(b => b.type === "text")?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);
      setAiResult(parsed);
      setPendingEntries(parsed);
    } catch (e) {
      setAiError("Could not parse check-in. Try being more specific.");
    } finally {
      setAiLoading(false);
    }
  }

  function confirmAIEntries() {
    if (!pendingEntries) return;
    const dateStr = today();
    const newIncome = (pendingEntries.income || []).map(e => ({
      id: crypto.randomUUID(),
      date: dateStr,
      source: e.source,
      currency: e.currency,
      amount: e.amount,
      usdEquivalent: e.usdEquivalent,
      btcPriceAtEntry: e.currency === "BTC" ? btcPrice : null,
      note: e.note || "",
    }));
    const newExpenses = (pendingEntries.expenses || []).map(e => ({
      id: crypto.randomUUID(),
      date: dateStr,
      category: e.category,
      amount: e.amount,
      note: e.note || "",
    }));
    setState(s => ({
      ...s,
      entries: [...s.entries, ...newIncome],
      expenses: [...s.expenses, ...newExpenses],
    }));
    setCheckinText("");
    setAiResult(null);
    setPendingEntries(null);
    setTab("ledger");
  }

  function addManualIncome() {
    if (!manualIncome.amount) return;
    const amt = parseFloat(manualIncome.amount);
    const usd = manualIncome.currency === "BTC" ? (btcPrice ? amt * btcPrice : null)
      : manualIncome.currency === "USDT" ? amt : amt;
    setState(s => ({
      ...s,
      entries: [...s.entries, {
        id: crypto.randomUUID(),
        date: manualIncome.date,
        source: manualIncome.source,
        currency: manualIncome.currency,
        amount: amt,
        usdEquivalent: usd,
        btcPriceAtEntry: manualIncome.currency === "BTC" ? btcPrice : null,
        note: manualIncome.note,
      }]
    }));
    setManualIncome(m => ({ ...m, amount: "", note: "" }));
  }

  function addManualExpense() {
    if (!manualExpense.amount) return;
    setState(s => ({
      ...s,
      expenses: [...s.expenses, {
        id: crypto.randomUUID(),
        date: manualExpense.date,
        category: manualExpense.category,
        amount: parseFloat(manualExpense.amount),
        note: manualExpense.note,
      }]
    }));
    setManualExpense(m => ({ ...m, amount: "", note: "" }));
  }

  function setOpeningBalance() {
    setState(s => ({
      ...s,
      openingBalance: {
        btc: parseFloat(obForm.btc) || 0,
        usdt: parseFloat(obForm.usdt) || 0,
        usd: parseFloat(obForm.usd) || 0,
        set: true,
        date: today(),
      }
    }));
  }

  function deleteEntry(id) {
    setState(s => ({ ...s, entries: s.entries.filter(e => e.id !== id) }));
  }

  function deleteExpense(id) {
    setState(s => ({ ...s, expenses: s.expenses.filter(e => e.id !== id) }));
  }

  function buildContextSummary() {
    const recent = state.entries.slice(-10);
    if (!recent.length) return "No prior entries.";
    return recent.map(e => `${e.date} | ${e.source} | ${e.amount} ${e.currency} = ${formatUSD(e.usdEquivalent)}`).join("\n");
  }

  // Analytics
  function getMonthEntries(m) {
    return state.entries.filter(e => monthKey(e.date) === m);
  }
  function getMonthExpenses(m) {
    return state.expenses.filter(e => monthKey(e.date) === m);
  }

  // All-time total balance = opening balance + all income - all expenses
  const allTimeBTC = state.entries.filter(e => e.currency === "BTC").reduce((s, e) => s + (e.amount || 0), 0);
  const allTimeUSDT = state.entries.filter(e => e.currency === "USDT").reduce((s, e) => s + (e.amount || 0), 0);
  const allTimeUSDFromIncome = state.entries.filter(e => e.currency === "USD").reduce((s, e) => s + (e.amount || 0), 0);
  const allTimeExpenses = state.expenses.reduce((s, e) => s + (e.amount || 0), 0);

  const totalBTCHoldings = (state.openingBalance?.btc || 0) + allTimeBTC;
  const totalUSDTHoldings = (state.openingBalance?.usdt || 0) + allTimeUSDT;
  const totalUSDHoldings = (state.openingBalance?.usd || 0) + allTimeUSDFromIncome - allTimeExpenses;
  const totalBTCValueUSD = btcPrice ? totalBTCHoldings * btcPrice : null;
  const grandTotalUSD = (totalBTCValueUSD || 0) + totalUSDTHoldings + totalUSDHoldings;

  const filteredEntries = state.entries
    .filter(e => monthKey(e.date) === filterMonth)
    .filter(e => filterSource === "All" || e.source === filterSource)
    .sort((a, b) => b.date.localeCompare(a.date));

  const filteredExpenses = state.expenses
    .filter(e => monthKey(e.date) === filterMonth)
    .sort((a, b) => b.date.localeCompare(a.date));

  const monthIncome = getMonthEntries(filterMonth);
  const monthExpenses = getMonthExpenses(filterMonth);

  const totalIncomeUSD = monthIncome.reduce((s, e) => s + (e.usdEquivalent || 0), 0);
  const totalExpenseUSD = monthExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const netUSD = totalIncomeUSD - totalExpenseUSD;

  const totalBTC = monthIncome.filter(e => e.currency === "BTC").reduce((s, e) => s + (e.amount || 0), 0);
  const btcCurrentValue = btcPrice ? totalBTC * btcPrice : null;

  const bySource = INCOME_SOURCES.map(src => {
    const entries = monthIncome.filter(e => e.source === src);
    const usd = entries.reduce((s, e) => s + (e.usdEquivalent || 0), 0);
    const pct = totalIncomeUSD > 0 ? ((usd / totalIncomeUSD) * 100).toFixed(1) : "0.0";
    return { src, usd, pct, count: entries.length };
  });

  const byExpenseCategory = EXPENSE_CATEGORIES.map(cat => {
    const items = monthExpenses.filter(e => e.category === cat);
    const total = items.reduce((s, e) => s + (e.amount || 0), 0);
    return { cat, total };
  }).filter(x => x.total > 0);

  // Available months
  const allMonths = [...new Set([
    ...state.entries.map(e => monthKey(e.date)),
    ...state.expenses.map(e => monthKey(e.date)),
    today().slice(0, 7)
  ])].sort().reverse();

  const tabStyle = (t) => ({
    padding: "8px 18px",
    background: tab === t ? "#fff" : "transparent",
    color: tab === t ? "#b45309" : "#999",
    border: "none",
    borderBottom: tab === t ? "2px solid #b45309" : "2px solid transparent",
    cursor: "pointer",
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: "12px",
    fontWeight: tab === t ? "700" : "400",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    transition: "all 0.15s",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#ffffff", color: "#1a1a18", fontFamily: "'JetBrains Mono', 'Courier New', monospace" }}>
      {/* Header */}
      <div style={{ borderBottom: "1px solid #dcdcd8", padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#f8f8f6" }}>
        <div>
          <div style={{ fontSize: "11px", letterSpacing: "0.2em", color: "#666662", textTransform: "uppercase" }}>Revenue Ledger</div>
          <div style={{ fontSize: "20px", fontWeight: "700", color: "#b45309", letterSpacing: "-0.02em" }}>FLOWSTATE</div>
        </div>
        <div
          onClick={fetchBTC}
          style={{
            cursor: "pointer",
            background: btcPulse ? "#f0c04022" : "#f0f0ee",
            border: `1px solid ${btcPulse ? "#f0c040" : "#d8d8d4"}`,
            borderRadius: "6px",
            padding: "8px 14px",
            transition: "all 0.3s",
            textAlign: "right"
          }}
        >
          <div style={{ fontSize: "9px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase" }}>BTC / USD</div>
          <div style={{ fontSize: "18px", fontWeight: "700", color: btcPulse ? "#d4a000" : "#1a1a18" }}>
            {btcPrice ? `$${btcPrice.toLocaleString()}` : "Loading…"}
          </div>
        </div>
      </div>

      {/* Summary bar */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "1px", background: "#e0e0dc", borderBottom: "1px solid #e0e0dc" }}>
        {[
          { label: "Income (mo)", value: formatUSD(totalIncomeUSD), color: "#16a34a" },
          { label: "Expenses (mo)", value: formatUSD(totalExpenseUSD), color: "#dc2626" },
          { label: "Net (mo)", value: formatUSD(netUSD), color: netUSD >= 0 ? "#16a34a" : "#dc2626" },
          { label: "BTC held (mo)", value: btcCurrentValue != null ? `${formatBTC(totalBTC)}\n${formatUSD(btcCurrentValue)}` : formatBTC(totalBTC), color: "#b45309" },
          { label: "Total Balance", value: state.openingBalance?.set ? formatUSD(grandTotalUSD) : "Not set", color: "#0369a1" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: "#f8f8f6", padding: "14px 20px" }}>
            <div style={{ fontSize: "9px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "4px" }}>{label}</div>
            <div style={{ fontSize: "16px", fontWeight: "700", color, whiteSpace: "pre-line", lineHeight: 1.3 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid #e0e0dc", background: "#f8f8f6", paddingLeft: "12px" }}>
        {["checkin", "manual", "ledger", "analytics", "settings"].map(t => (
          <button key={t} style={tabStyle(t)} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      <div style={{ maxWidth: "1000px", margin: "0 auto", padding: "24px 20px" }}>

        {/* CHECK-IN TAB */}
        {tab === "checkin" && (
          <div>
            <div style={{ fontSize: "11px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "16px" }}>Daily Check-In — AI Parsed</div>
            <textarea
              value={checkinText}
              onChange={e => setCheckinText(e.target.value)}
              placeholder={`Tell Claude what happened today. Be casual.\n\nExamples:\n"Made 0.04 BTC on dropshipping, got $300 USDT from the GB, sold some sneakers in person for $120, paid rent $1200 and groceries $80"\n\n"Slow day, only collected $50 from an old debt, no other income. Paid electricity $95."`}
              style={{
                width: "100%", minHeight: "140px", background: "#f0f0ee", border: "1px solid #d8d8d4",
                color: "#1a1a18", padding: "14px", borderRadius: "6px", fontSize: "13px",
                fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box",
                lineHeight: 1.6
              }}
            />
            <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
              <button
                onClick={handleAICheckin}
                disabled={aiLoading || !checkinText.trim()}
                style={{
                  background: aiLoading ? "#bbbbb6" : "#f0c040", color: "#ffffff",
                  border: "none", padding: "10px 22px", borderRadius: "5px",
                  fontFamily: "inherit", fontWeight: "700", fontSize: "11px",
                  letterSpacing: "0.1em", textTransform: "uppercase",
                  cursor: aiLoading ? "not-allowed" : "pointer"
                }}
              >
                {aiLoading ? "Parsing…" : "Parse Check-In"}
              </button>
              {aiError && <div style={{ color: "#dc2626", fontSize: "12px", alignSelf: "center" }}>{aiError}</div>}
            </div>

            {aiResult && (
              <div style={{ marginTop: "20px", border: "1px solid #d8d8d4", borderRadius: "6px", overflow: "hidden" }}>
                <div style={{ background: "#f0f0ee", padding: "12px 16px", borderBottom: "1px solid #dcdcd8", fontSize: "12px", color: "#aaa" }}>
                  {aiResult.summary}
                </div>
                {aiResult.flags?.length > 0 && (
                  <div style={{ background: "#1a1200", padding: "10px 16px", borderBottom: "1px solid #dcdcd8" }}>
                    {aiResult.flags.map((f, i) => <div key={i} style={{ fontSize: "11px", color: "#b45309", marginBottom: "2px" }}>⚠ {f}</div>)}
                  </div>
                )}

                {aiResult.income?.length > 0 && (
                  <div style={{ padding: "14px 16px", borderBottom: "1px solid #f0f0ee" }}>
                    <div style={{ fontSize: "10px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "10px" }}>Income</div>
                    {aiResult.income.map((e, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #f0f0ee" }}>
                        <div>
                          <span style={{ color: "#b45309", fontSize: "12px", fontWeight: "700" }}>{e.source}</span>
                          <span style={{ color: "#666662", fontSize: "11px", marginLeft: "10px" }}>{e.note}</span>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ color: "#16a34a", fontSize: "13px", fontWeight: "700" }}>{e.amount} {e.currency}</div>
                          <div style={{ color: "#666662", fontSize: "11px" }}>{formatUSD(e.usdEquivalent)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {aiResult.expenses?.length > 0 && (
                  <div style={{ padding: "14px 16px", borderBottom: "1px solid #f0f0ee" }}>
                    <div style={{ fontSize: "10px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "10px" }}>Expenses</div>
                    {aiResult.expenses.map((e, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #f0f0ee" }}>
                        <div>
                          <span style={{ color: "#dc2626", fontSize: "12px", fontWeight: "700" }}>{e.category}</span>
                          <span style={{ color: "#666662", fontSize: "11px", marginLeft: "10px" }}>{e.note}</span>
                        </div>
                        <div style={{ color: "#dc2626", fontSize: "13px", fontWeight: "700" }}>{formatUSD(e.amount)}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ padding: "12px 16px", display: "flex", gap: "10px" }}>
                  <button
                    onClick={confirmAIEntries}
                    style={{
                      background: "#16a34a", color: "#ffffff", border: "none",
                      padding: "9px 20px", borderRadius: "5px", fontFamily: "inherit",
                      fontWeight: "700", fontSize: "11px", letterSpacing: "0.1em",
                      textTransform: "uppercase", cursor: "pointer"
                    }}
                  >Confirm & Save</button>
                  <button
                    onClick={() => { setAiResult(null); setPendingEntries(null); }}
                    style={{
                      background: "transparent", color: "#666662", border: "1px solid #bbbbb6",
                      padding: "9px 20px", borderRadius: "5px", fontFamily: "inherit",
                      fontSize: "11px", cursor: "pointer"
                    }}
                  >Discard</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* MANUAL TAB */}
        {tab === "manual" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "24px" }}>
            {/* Manual Income */}
            <div>
              <div style={{ fontSize: "11px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "16px" }}>Add Income</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {[
                  { label: "Date", el: <input type="date" value={manualIncome.date} onChange={e => setManualIncome(m => ({ ...m, date: e.target.value }))} style={inputStyle} /> },
                  { label: "Source", el: <select value={manualIncome.source} onChange={e => setManualIncome(m => ({ ...m, source: e.target.value }))} style={inputStyle}>{INCOME_SOURCES.map(s => <option key={s}>{s}</option>)}</select> },
                  { label: "Currency", el: <select value={manualIncome.currency} onChange={e => setManualIncome(m => ({ ...m, currency: e.target.value }))} style={inputStyle}>{CURRENCY_TYPES.map(c => <option key={c}>{c}</option>)}</select> },
                  { label: "Amount", el: <input type="number" step="any" placeholder="0.00" value={manualIncome.amount} onChange={e => setManualIncome(m => ({ ...m, amount: e.target.value }))} style={inputStyle} /> },
                  { label: "Note", el: <input type="text" placeholder="Optional" value={manualIncome.note} onChange={e => setManualIncome(m => ({ ...m, note: e.target.value }))} style={inputStyle} /> },
                ].map(({ label, el }) => (
                  <div key={label}>
                    <div style={{ fontSize: "10px", color: "#666662", marginBottom: "4px", letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</div>
                    {el}
                  </div>
                ))}
                {manualIncome.currency === "BTC" && btcPrice && manualIncome.amount && (
                  <div style={{ fontSize: "11px", color: "#b45309" }}>
                    ≈ {formatUSD(parseFloat(manualIncome.amount) * btcPrice)} @ ${btcPrice.toLocaleString()}
                  </div>
                )}
                <button onClick={addManualIncome} style={primaryBtn}>Add Income</button>
              </div>
            </div>

            {/* Manual Expense */}
            <div>
              <div style={{ fontSize: "11px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "16px" }}>Add Expense</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {[
                  { label: "Date", el: <input type="date" value={manualExpense.date} onChange={e => setManualExpense(m => ({ ...m, date: e.target.value }))} style={inputStyle} /> },
                  { label: "Category", el: <select value={manualExpense.category} onChange={e => setManualExpense(m => ({ ...m, category: e.target.value }))} style={inputStyle}>{EXPENSE_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select> },
                  { label: "Amount (USD)", el: <input type="number" step="any" placeholder="0.00" value={manualExpense.amount} onChange={e => setManualExpense(m => ({ ...m, amount: e.target.value }))} style={inputStyle} /> },
                  { label: "Note", el: <input type="text" placeholder="Optional" value={manualExpense.note} onChange={e => setManualExpense(m => ({ ...m, note: e.target.value }))} style={inputStyle} /> },
                ].map(({ label, el }) => (
                  <div key={label}>
                    <div style={{ fontSize: "10px", color: "#666662", marginBottom: "4px", letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</div>
                    {el}
                  </div>
                ))}
                <button onClick={addManualExpense} style={{ ...primaryBtn, background: "#dc2626" }}>Add Expense</button>
              </div>
            </div>
          </div>
        )}

        {/* LEDGER TAB */}
        {tab === "ledger" && (
          <div>
            {/* Filters */}
            <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap", alignItems: "center" }}>
              <div>
                <div style={filterLabel}>Month</div>
                <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={inputStyle}>
                  {allMonths.map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <div style={filterLabel}>Source</div>
                <select value={filterSource} onChange={e => setFilterSource(e.target.value)} style={inputStyle}>
                  {["All", ...INCOME_SOURCES].map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
            </div>

            {/* Income table */}
            <div style={{ fontSize: "10px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "10px" }}>Income — {filteredEntries.length} entries</div>
            <div style={{ border: "1px solid #e0e0dc", borderRadius: "6px", overflow: "hidden", marginBottom: "24px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "90px 130px 80px 100px 110px 1fr 32px", background: "#f0f0ee", padding: "8px 12px", fontSize: "9px", color: "#888884", letterSpacing: "0.12em", textTransform: "uppercase", gap: "8px" }}>
                <span>Date</span><span>Source</span><span>Currency</span><span>Amount</span><span>USD Equiv</span><span>Note</span><span></span>
              </div>
              {filteredEntries.length === 0 ? (
                <div style={{ padding: "24px", textAlign: "center", color: "#bbbbb6", fontSize: "12px" }}>No income entries for this period.</div>
              ) : filteredEntries.map(e => (
                <div key={e.id} style={{ display: "grid", gridTemplateColumns: "90px 130px 80px 100px 110px 1fr 32px", padding: "9px 12px", borderTop: "1px solid #f0f0ee", fontSize: "12px", gap: "8px", alignItems: "center" }}>
                  <span style={{ color: "#666662" }}>{e.date}</span>
                  <span style={{ color: "#b45309", fontWeight: "700" }}>{e.source}</span>
                  <span style={{ color: e.currency === "BTC" ? "#f0c040" : "#7dd3fc" }}>{e.currency}</span>
                  <span>{e.amount}</span>
                  <span style={{ color: "#16a34a" }}>{formatUSD(e.usdEquivalent)}</span>
                  <span style={{ color: "#888884", fontSize: "11px" }}>{e.note}</span>
                  <button onClick={() => deleteEntry(e.id)} style={{ background: "none", border: "none", color: "#bbbbb6", cursor: "pointer", fontSize: "14px", padding: "0" }}>×</button>
                </div>
              ))}
            </div>

            {/* Expense table */}
            <div style={{ fontSize: "10px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "10px" }}>Expenses — {filteredExpenses.length} entries</div>
            <div style={{ border: "1px solid #e0e0dc", borderRadius: "6px", overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "90px 130px 110px 1fr 32px", background: "#f0f0ee", padding: "8px 12px", fontSize: "9px", color: "#888884", letterSpacing: "0.12em", textTransform: "uppercase", gap: "8px" }}>
                <span>Date</span><span>Category</span><span>Amount</span><span>Note</span><span></span>
              </div>
              {filteredExpenses.length === 0 ? (
                <div style={{ padding: "24px", textAlign: "center", color: "#bbbbb6", fontSize: "12px" }}>No expenses for this period.</div>
              ) : filteredExpenses.map(e => (
                <div key={e.id} style={{ display: "grid", gridTemplateColumns: "90px 130px 110px 1fr 32px", padding: "9px 12px", borderTop: "1px solid #f0f0ee", fontSize: "12px", gap: "8px", alignItems: "center" }}>
                  <span style={{ color: "#666662" }}>{e.date}</span>
                  <span style={{ color: "#dc2626", fontWeight: "700" }}>{e.category}</span>
                  <span style={{ color: "#dc2626" }}>{formatUSD(e.amount)}</span>
                  <span style={{ color: "#888884", fontSize: "11px" }}>{e.note}</span>
                  <button onClick={() => deleteExpense(e.id)} style={{ background: "none", border: "none", color: "#bbbbb6", cursor: "pointer", fontSize: "14px", padding: "0" }}>×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ANALYTICS TAB */}
        {tab === "analytics" && (
          <div>
            <div style={{ display: "flex", gap: "10px", marginBottom: "20px", alignItems: "center" }}>
              <div style={filterLabel}>Month</div>
              <select value={filterMonth} onChange={e => setFilterMonth(e.target.value)} style={inputStyle}>
                {allMonths.map(m => <option key={m}>{m}</option>)}
              </select>
            </div>

            {/* Income by source */}
            <div style={{ fontSize: "11px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "14px" }}>Income by Source</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px", marginBottom: "28px" }}>
              {bySource.map(({ src, usd, pct, count }) => (
                <div key={src} style={{ background: "#f8f8f6", border: "1px solid #e0e0dc", borderRadius: "6px", padding: "14px 16px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                    <span style={{ fontSize: "12px", fontWeight: "700", color: "#b45309" }}>{src}</span>
                    <span style={{ fontSize: "11px", color: "#666662" }}>{count} entries</span>
                  </div>
                  <div style={{ fontSize: "18px", fontWeight: "700", color: "#16a34a", marginBottom: "6px" }}>{formatUSD(usd)}</div>
                  <div style={{ background: "#f0f0ee", borderRadius: "3px", height: "4px", overflow: "hidden" }}>
                    <div style={{ background: "#d4a000", height: "100%", width: `${pct}%`, transition: "width 0.4s" }} />
                  </div>
                  <div style={{ fontSize: "10px", color: "#666662", marginTop: "4px" }}>{pct}% of total</div>
                </div>
              ))}
            </div>

            {/* Expense by category */}
            {byExpenseCategory.length > 0 && (
              <>
                <div style={{ fontSize: "11px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "14px" }}>Expenses by Category</div>
                <div style={{ border: "1px solid #e0e0dc", borderRadius: "6px", overflow: "hidden", marginBottom: "28px" }}>
                  {byExpenseCategory.map(({ cat, total }) => (
                    <div key={cat} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #f0f0ee" }}>
                      <span style={{ fontSize: "12px", color: "#dc2626" }}>{cat}</span>
                      <span style={{ fontSize: "13px", fontWeight: "700", color: "#dc2626" }}>{formatUSD(total)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* BTC position */}
            {totalBTC > 0 && (
              <>
                <div style={{ fontSize: "11px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "14px" }}>BTC Position</div>
                <div style={{ background: "#f8f8f6", border: "1px solid #e0e0dc", borderRadius: "6px", padding: "16px", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "16px" }}>
                  <div>
                    <div style={{ fontSize: "9px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "4px" }}>BTC Earned</div>
                    <div style={{ fontSize: "16px", fontWeight: "700", color: "#b45309" }}>{formatBTC(totalBTC)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "9px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "4px" }}>Current Value</div>
                    <div style={{ fontSize: "16px", fontWeight: "700", color: "#16a34a" }}>{btcCurrentValue != null ? formatUSD(btcCurrentValue) : "—"}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "9px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "4px" }}>BTC Price</div>
                    <div style={{ fontSize: "16px", fontWeight: "700", color: "#1a1a18" }}>{btcPrice ? `$${btcPrice.toLocaleString()}` : "—"}</div>
                  </div>
                </div>
              </>
            )}

            {/* Net summary */}
            <div style={{ marginTop: "24px", background: "#f8f8f6", border: `1px solid ${netUSD >= 0 ? "#16a34a33" : "#dc262633"}`, borderRadius: "6px", padding: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ fontSize: "12px", color: "#666662" }}>Net for {filterMonth}</div>
              <div style={{ fontSize: "24px", fontWeight: "700", color: netUSD >= 0 ? "#16a34a" : "#dc2626" }}>{formatUSD(netUSD)}</div>
            </div>
          </div>
        )}

        {/* SETTINGS TAB */}
        {tab === "settings" && (
          <div>
            <div style={{ fontSize: "11px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "16px" }}>Opening Balance</div>

            {state.openingBalance?.set ? (
              <div style={{ background: "#f8f8f6", border: "1px solid #e0e0dc", borderRadius: "6px", padding: "16px", marginBottom: "20px" }}>
                <div style={{ fontSize: "11px", color: "#666662", marginBottom: "10px" }}>Set on {state.openingBalance.date}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
                  <div>
                    <div style={{ fontSize: "9px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "4px" }}>BTC</div>
                    <div style={{ fontSize: "16px", fontWeight: "700", color: "#b45309" }}>{formatBTC(state.openingBalance.btc)}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "9px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "4px" }}>USDT</div>
                    <div style={{ fontSize: "16px", fontWeight: "700", color: "#0369a1" }}>{state.openingBalance.usdt}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "9px", color: "#666662", letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "4px" }}>USD</div>
                    <div style={{ fontSize: "16px", fontWeight: "700", color: "#16a34a" }}>{formatUSD(state.openingBalance.usd)}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: "12px", color: "#888884", marginBottom: "16px" }}>
                No opening balance set yet. Set it once below — it becomes the baseline for your Total Balance figure, separate from per-stream income tracking.
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px", marginBottom: "12px" }}>
              <div>
                <div style={{ fontSize: "10px", color: "#666662", marginBottom: "4px", letterSpacing: "0.1em", textTransform: "uppercase" }}>BTC</div>
                <input type="number" step="any" placeholder="0.00000000" value={obForm.btc} onChange={e => setObForm(f => ({ ...f, btc: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <div style={{ fontSize: "10px", color: "#666662", marginBottom: "4px", letterSpacing: "0.1em", textTransform: "uppercase" }}>USDT</div>
                <input type="number" step="any" placeholder="0.00" value={obForm.usdt} onChange={e => setObForm(f => ({ ...f, usdt: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <div style={{ fontSize: "10px", color: "#666662", marginBottom: "4px", letterSpacing: "0.1em", textTransform: "uppercase" }}>USD</div>
                <input type="number" step="any" placeholder="0.00" value={obForm.usd} onChange={e => setObForm(f => ({ ...f, usd: e.target.value }))} style={inputStyle} />
              </div>
            </div>
            <button onClick={setOpeningBalance} style={primaryBtn}>{state.openingBalance?.set ? "Update Opening Balance" : "Set Opening Balance"}</button>

            <div style={{ marginTop: "32px", fontSize: "11px", color: "#666662", lineHeight: 1.7 }}>
              Total Balance = Opening Balance + all income since − all expenses since, with BTC re-valued at current market price.
              Per-stream growth tracking (Dropshipping, GB Hosting, etc.) is unaffected by this — it only tracks income logged after this point.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inputStyle = {
  background: "#f0f0ee", border: "1px solid #d8d8d4", color: "#1a1a18",
  padding: "8px 10px", borderRadius: "5px", fontSize: "12px",
  fontFamily: "'JetBrains Mono', monospace", outline: "none", width: "100%",
  boxSizing: "border-box"
};

const primaryBtn = {
  background: "#d4a000", color: "#ffffff", border: "none",
  padding: "10px 20px", borderRadius: "5px", fontFamily: "'JetBrains Mono', monospace",
  fontWeight: "700", fontSize: "11px", letterSpacing: "0.1em",
  textTransform: "uppercase", cursor: "pointer", marginTop: "4px"
};

const filterLabel = {
  fontSize: "9px", color: "#666662", letterSpacing: "0.15em",
  textTransform: "uppercase", marginBottom: "4px"
};
