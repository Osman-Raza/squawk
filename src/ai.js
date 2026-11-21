// Workers AI layer: turns detection findings into a mechanic-ready diagnosis and work order.
import { describeFinding } from "./engine.js";
import { patternsFor } from "./knowledge.js";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const URGENCY = ["monitor", "next_inspection", "next_flight_check", "ground_until_checked"];

export async function diagnose(env, aircraft, assessment) {
  const findings = assessment.findings;
  if (!findings.length) {
    return {
      source: "engine",
      title: `${aircraft.name}: no action needed`,
      summary: "All monitored engine parameters are within the fleet's normal range over recent flights.",
      likely_causes: [],
      actions: ["Continue routine monitoring"],
      parts: [],
      urgency: "monitor",
    };
  }

  const patterns = patternsFor(findings);
  const fallback = fallbackDiagnosis(aircraft, findings, patterns);
  if (!env.AI) return fallback;

  const prompt = buildPrompt(aircraft, assessment, patterns);
  try {
    const res = await env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are a senior A&P/AME maintenance analyst for a general aviation fleet. You turn engine-monitor trend findings into a concise diagnosis and a work order. " +
            "Only use the findings and reference patterns provided. Do not invent readings, numbers, part numbers or causes that are not supported by them. Be specific about which cylinder. Forecasts are estimates if the trend continues; say so. This is advisory; the mechanic decides. " +
            "Reply with ONLY a JSON object, no markdown.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 900,
      temperature: 0.2,
    });
    const text = typeof res === "string" ? res : res?.response ?? "";
    const parsed = parseJson(text);
    if (!parsed) return { ...fallback, note: "AI response unreadable, used rule-based diagnosis" };
    return normalize(parsed, fallback);
  } catch (err) {
    return { ...fallback, note: `Workers AI unavailable (${String(err.message || err).slice(0, 80)}), used rule-based diagnosis` };
  }
}

function buildPrompt(aircraft, assessment, patterns) {
  return `Aircraft: ${aircraft.name} (${aircraft.model})
Overall status: ${assessment.status.toUpperCase()} (risk score ${assessment.score}σ)

Findings from the detection engine (recent flights vs fleet baseline):
${assessment.findings.map((f, i) => `${i + 1}. ${describeFinding(f)} Flagged on ${Math.round(f.persistence * 100)}% of recent flights.`).join("\n")}

${assessment.early?.length ? `Early warnings (still in normal range, but trending toward caution):
${assessment.early.map((f) => `- ${f.label}: ${f.recent_value} ${f.unit} now, reaches caution in about ${f.trend.to_caution} flights if the trend continues.`).join("\n")}

` : ""}Reference patterns that match these findings:
${patterns.map((p) => `- ${p.cause}: ${p.why} Typical actions: ${p.actions.join("; ")}.`).join("\n")}

Return JSON with exactly these keys:
{
  "title": "short work order title naming the aircraft and the main issue",
  "summary": "2-3 sentences in plain English a director of maintenance can read in 10 seconds",
  "likely_causes": [{"cause": "...", "confidence": "high|medium|low", "evidence": "which finding supports it"}],
  "actions": ["ordered inspection / maintenance steps"],
  "parts": ["parts that may be needed, mark (on condition) if only if inspection confirms"],
  "urgency": "monitor | next_inspection | next_flight_check | ground_until_checked"
}`;
}

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalize(p, fallback) {
  const arr = (x) => (Array.isArray(x) ? x.filter(Boolean).slice(0, 8) : []);
  return {
    source: "workers-ai",
    model: MODEL,
    title: String(p.title || fallback.title).slice(0, 140),
    summary: String(p.summary || fallback.summary).slice(0, 800),
    likely_causes: arr(p.likely_causes).map((c) =>
      typeof c === "string" ? { cause: c, confidence: "medium", evidence: "" } : { cause: String(c.cause || ""), confidence: String(c.confidence || "medium"), evidence: String(c.evidence || "") }
    ),
    actions: arr(p.actions).map(String),
    parts: arr(p.parts).map(String),
    urgency: URGENCY.includes(p.urgency) ? p.urgency : fallback.urgency,
  };
}

export function fallbackDiagnosis(aircraft, findings, patterns = patternsFor(findings)) {
  const top = findings[0];
  const main = patterns[0];
  const urgency = patterns.reduce((u, p) => (URGENCY.indexOf(p.urgency) > URGENCY.indexOf(u) ? p.urgency : u), "monitor");
  return {
    source: "engine",
    title: `${aircraft.name}: ${main ? main.cause : top.label}${top.cyl ? ` (cyl ${top.cyl})` : ""}`,
    summary: `${describeFinding(top)} ${main ? main.why : ""}`.trim(),
    likely_causes: patterns.slice(0, 3).map((p, i) => ({ cause: p.cause, confidence: i === 0 ? "medium" : "low", evidence: p.why })),
    actions: [...new Set(patterns.flatMap((p) => p.actions))].slice(0, 6),
    parts: [...new Set(patterns.flatMap((p) => p.parts))].slice(0, 6),
    urgency,
  };
}
