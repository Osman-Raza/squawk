// Known symptom patterns for piston engines and the airframe channels in the log.
// Used to ground the AI diagnosis and as the fallback when Workers AI is unavailable.
// Worded as possibilities to check, not conclusions. Advisory only: a licensed mechanic makes the call,
// following the aircraft's maintenance manual.

export const PATTERNS = [
  {
    id: "exhaust-valve",
    matches: (f) => /^egt\d_rough$/.test(f.key),
    cause: "Exhaust valve sticking or burning",
    why: "Slow, rhythmic EGT oscillation on a single cylinder is a known early sign of a sticking or burning exhaust valve.",
    actions: ["Borescope inspection of the affected cylinder's exhaust valve", "Differential compression test", "Check valve guide clearance if the borescope is inconclusive"],
    parts: ["Exhaust valve (on condition)", "Cylinder gasket set (on condition)"],
    urgency: "next_flight_check",
  },
  {
    id: "induction-leak",
    matches: (f) => /^egt\d_dev$/.test(f.key) || f.key === "egt_spread",
    cause: "Uneven fuel/air mixture on one cylinder (induction leak or clogged injector)",
    why: "A cylinder running hotter or colder EGT than the others points to an uneven mixture: an intake gasket or hose leak (leaner, hotter) or a partly clogged injector nozzle.",
    actions: ["Inspect intake tubes, hoses and intake gaskets for leaks or damage", "Clean and flow-test fuel injector nozzles (fuel-injected engines)", "Compare a lean-of-peak / GAMI test to the baseline"],
    parts: ["Intake gasket (on condition)", "Intake hose / clamps (on condition)", "Injector nozzle (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "cht-cooling",
    matches: (f) => /^cht\d_dev$/.test(f.key) || f.key === "cht_spread",
    cause: "Cylinder cooling problem (baffling) or a faulty CHT probe",
    why: "One cylinder head running consistently hotter than the rest usually means damaged or misaligned baffles, or a CHT probe giving a false reading.",
    actions: ["Inspect engine baffles and seals around the affected cylinder", "Check the CHT probe and connector, swap probes to confirm", "Compression test if the probe checks good"],
    parts: ["Baffle seal material (on condition)", "CHT probe (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "cht-peak",
    matches: (f) => f.key === "cht_peak",
    cause: "Cylinder heads getting hotter than the fleet at peak (usually in climb)",
    why: "Higher peak head temperatures (already corrected for outside air temperature) can come from reduced cooling airflow, a lean mixture in climb, or a faulty probe.",
    actions: ["Inspect baffles, seals and cowling for gaps or damage", "Review climb technique and mixture settings with pilots", "Check CHT probes on the hottest cylinder"],
    parts: ["Baffle seal material (on condition)", "CHT probe (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "oil-pressure",
    matches: (f) => f.key === "oilp_mean",
    cause: "Oil pressure lower than normal",
    why: "Oil pressure drifting down at similar power can mean low oil quantity, a pressure relief valve issue, a failing sender, or increased internal wear.",
    actions: ["Verify oil quantity and look for leaks", "Check the oil pressure sender against a calibrated mechanical gauge", "Inspect the oil filter and send an oil sample for analysis"],
    parts: ["Oil filter", "Oil pressure sender (on condition)"],
    urgency: "ground_until_checked",
  },
  {
    id: "oil-pressure-fluct",
    matches: (f) => f.key === "oilp_rough",
    cause: "Oil pressure reading fluctuating",
    why: "A jumpy oil pressure reading is often a sender or wiring problem, but can also come from low oil quantity or a pressure relief valve issue.",
    actions: ["Verify oil quantity", "Inspect the oil pressure sender, connector and wiring", "Confirm with a calibrated mechanical gauge"],
    parts: ["Oil pressure sender (on condition)"],
    urgency: "next_flight_check",
  },
  {
    id: "oil-temp",
    matches: (f) => f.key === "oilt_mean",
    cause: "Oil running hotter than normal",
    why: "Higher oil temperature at similar power (already corrected for outside air temperature) can point to a blocked oil cooler, an oil thermostat (vernatherm) problem, or reduced cooling airflow.",
    actions: ["Inspect the oil cooler and its air ducting for blockage", "Check oil thermostat operation", "Verify oil quantity and grade"],
    parts: ["Oil thermostat (on condition)", "Oil cooler hose (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "fuel-flow",
    matches: (f) => f.key === "ff_per_krpm",
    cause: "Fuel flow out of line with power",
    why: "Fuel flow that doesn't match RPM compared to the rest of the fleet can mean a fuel flow transducer issue, a fuel metering problem, or an induction restriction.",
    actions: ["Compare indicated fuel used against fuel actually added at refuelling", "Inspect the fuel flow transducer", "Inspect the air filter and induction for restrictions"],
    parts: ["Air filter (on condition)", "Fuel flow transducer (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "fuel-burn-mismatch",
    matches: (f) => f.key === "fuel_burn_ratio",
    cause: "Tank gauges and fuel flow reading disagree",
    why: "If the tank gauges drop faster or slower than the fuel flow reading says fuel was used, either a gauge or transducer is miscalibrated, or fuel is going somewhere it shouldn't (a leak).",
    actions: ["Check for fuel leaks and stains around tanks, lines and fittings", "Compare fuel added at refuelling to fuel used on the totalizer", "Check calibration of the fuel quantity senders and fuel flow transducer"],
    parts: ["Fuel quantity sender (on condition)", "Fuel flow transducer (on condition)"],
    urgency: "next_flight_check",
  },
  {
    id: "fuel-imbalance",
    matches: (f) => f.key === "fuel_imbalance",
    cause: "Fuel tanks draining unevenly",
    why: "A growing left/right difference can come from fuel selector position, a blocked tank vent, or a quantity sender reading wrong.",
    actions: ["Check fuel tank vents for blockage", "Confirm fuel selector operation", "Check both fuel quantity senders"],
    parts: ["Fuel quantity sender (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "ignition",
    matches: (f) => f.key === "rpm_rough",
    cause: "Rough running: ignition or spark plug fouling",
    why: "More RPM roughness in cruise often comes from a fouled spark plug, magneto timing drift, or an ignition lead problem.",
    actions: ["Run-up magneto check and note the RPM drop per magneto", "Inspect, clean and gap spark plugs", "Check magneto timing and ignition leads"],
    parts: ["Spark plugs (on condition)", "Ignition lead (on condition)"],
    urgency: "next_flight_check",
  },
  {
    id: "electrical",
    matches: (f) => ["volt_mean", "volt2_mean", "amp1_mean", "amp2_mean"].includes(f.key),
    cause: "Charging system out of normal range",
    why: "Bus voltage lower than normal, or charging current out of line with the fleet, usually means a weakening alternator, a voltage regulator problem, a loose belt, or a battery near end of life.",
    actions: ["Check alternator belt tension", "Test alternator output and the voltage regulator", "Load-test the battery"],
    parts: ["Alternator belt (on condition)", "Voltage regulator (on condition)", "Battery (on condition)"],
    urgency: "next_inspection",
  },
  {
    id: "performance",
    matches: (f) => f.key === "ias_per_krpm" || f.key === "climb_fpm",
    cause: "Less performance than the fleet for the same power",
    why: "Lower cruise speed or climb rate at the same power can mean the engine is making less power, or extra drag (rigging, damage, propeller). Weight and altitude also affect it, so it's a prompt to look, not proof.",
    actions: ["Review the engine readings above for signs of power loss", "Static RPM check against the engine data", "Inspect the propeller and airframe for damage or misrigging"],
    parts: [],
    urgency: "next_inspection",
  },
  {
    id: "load-event",
    matches: (f) => f.key === "g_peak",
    cause: "High vertical load recorded (hard landing or strong turbulence)",
    why: "A spike in vertical acceleration well beyond what the fleet normally sees usually means a hard landing or a big turbulence hit. Manufacturers specify an inspection after these events.",
    actions: ["Ask the pilot about the flight and find the moment in the log", "Do the hard landing / overstress inspection from the aircraft maintenance manual", "Inspect landing gear, attach points and the firewall area"],
    parts: [],
    urgency: "ground_until_checked",
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
