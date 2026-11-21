// Small knowledge base of known piston-engine symptom patterns.
// Used to ground the AI diagnosis and as the fallback when Workers AI is unavailable.
// Advisory only: a licensed mechanic makes the call.

export const PATTERNS = [
  {
    id: "exhaust-valve",
    matches: (f) => f.key.endsWith("_rough") && f.key.startsWith("egt"),
    cause: "Exhaust valve sticking or burning",
    why: "Slow, rhythmic EGT oscillation on a single cylinder is a classic early sign of a sticking or burning exhaust valve.",
    actions: ["Borescope inspection of the affected cylinder's exhaust valve", "Differential compression test", "Check valve guide clearance (wobble test) if borescope is inconclusive"],
    parts: ["Exhaust valve (on condition)", "Cylinder gasket set"],
    urgency: "next_flight_check",
  },
  {
    id: "induction-leak",
    matches: (f) => /egt\d_dev/.test(f.key) || f.key === "egt_spread",
    cause: "Induction leak or clogged fuel injector on one cylinder",
    why: "A cylinder running hotter or colder EGT than the others points to an uneven fuel/air mixture: an intake gasket/hose leak (lean, hot) or a partially clogged injector nozzle.",
    actions: ["Inspect intake tubes, hoses and intake gaskets for leaks or damage", "Clean / flow-test fuel injector nozzles", "Run a GAMI lean test and compare to baseline"],
    parts: ["Intake gasket", "Intake hose / clamps", "Injector nozzle (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "cht-cooling",
    matches: (f) => /cht\d_dev/.test(f.key) || f.key === "cht_spread",
    cause: "Cylinder cooling problem (baffling) or CHT probe fault",
    why: "One cylinder head running consistently hotter than the rest usually means damaged or misaligned baffles, or a failing CHT probe giving false readings.",
    actions: ["Inspect engine baffles and seals around the affected cylinder", "Check CHT probe and connector, swap probe to confirm", "Compression test if probe checks good"],
    parts: ["Baffle seal material", "CHT probe (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "oil-pressure",
    matches: (f) => f.key === "oilp_mean",
    cause: "Low oil pressure trend",
    why: "Oil pressure drifting down at similar power settings can mean low oil quantity, a pressure relief valve issue, a failing sender, or increasing internal wear.",
    actions: ["Verify oil quantity and look for leaks", "Check oil pressure sender against a mechanical gauge", "Cut open oil filter and send oil sample for analysis"],
    parts: ["Oil filter", "Oil pressure sender (on condition)"],
    urgency: "ground_until_checked",
  },
  {
    id: "oil-temp",
    matches: (f) => f.key === "oilt_mean",
    cause: "High oil temperature trend",
    why: "Rising oil temperature at similar power can point to a blocked oil cooler, vernatherm (oil thermostat) failure, or reduced cooling airflow.",
    actions: ["Inspect oil cooler and cooler air ducting for blockage", "Check vernatherm operation", "Verify oil quantity and grade"],
    parts: ["Vernatherm (on condition)", "Oil cooler hose (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "fuel-flow",
    matches: (f) => f.key === "ff_per_krpm",
    cause: "Fuel flow out of line with power",
    why: "Fuel flow that doesn't match RPM compared to the rest of the fleet can mean a fuel flow transducer issue, fuel servo / carburetor problem, or an induction restriction.",
    actions: ["Compare indicated fuel flow against fuel actually added at refuel", "Inspect fuel flow transducer", "Inspect air filter and induction for restrictions"],
    parts: ["Air filter", "Fuel flow transducer (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "ignition",
    matches: (f) => f.key === "rpm_rough",
    cause: "Rough running: ignition or spark plug fouling",
    why: "Increased RPM roughness in cruise often comes from a fouled spark plug, magneto timing drift or an ignition lead problem.",
    actions: ["Run-up mag check and note RPM drop per magneto", "Inspect, clean and gap spark plugs", "Check magneto timing and ignition leads"],
    parts: ["Spark plugs (on condition)", "Ignition lead (on condition)"],
    urgency: "next_flight_check",
  },
  {
    id: "electrical",
    matches: (f) => f.key === "volt_mean",
    cause: "Charging system weak",
    why: "Bus voltage trending lower in flight usually means a weakening alternator, voltage regulator problem, or a loose alternator belt.",
    actions: ["Check alternator belt tension", "Test alternator output and voltage regulator", "Load-test the battery"],
    parts: ["Alternator belt (on condition)", "Voltage regulator (on condition)"],
    urgency: "next_inspection",
  },
];

export function patternsFor(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    for (const p of PATTERNS) {
      if (p.matches(f) && !seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
      }
    }
  }
  return out;
}
