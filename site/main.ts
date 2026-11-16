import {
  configFrom,
  type Scenario,
  type SimResult,
  scenarioFromTranscript,
  simulate,
} from "./core.js";
import { SCENARIOS } from "./scenarios.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const chipsEl = $("chips");
const descEl = $("desc");
const cfgNote = $("cfg-note");
const pasteEl = $<HTMLTextAreaElement>("paste");
const pasteErr = $("paste-err");
const summaryEl = $("summary");
const barEl = $("bar");
const barFill = $("bar-fill");
const barWarn = $("bar-warn");
const barText = $("bar-text");
const scrub = $<HTMLInputElement>("scrub");
const scrubOut = $("scrub-out");
const tbody = document.querySelector("#table tbody") as HTMLElement;
const tableWrap = document.querySelector(".table-wrap") as HTMLElement;
const handoffWrap = $("handoff-wrap");
const handoffEl = $("handoff");
const handoffPath = $("handoff-path");

const inputs = {
  budget: $<HTMLInputElement>("c-budget"),
  warn: $<HTMLInputElement>("c-warn"),
  lwarn: $<HTMLInputElement>("c-lwarn"),
  lstop: $<HTMLInputElement>("c-lstop"),
};

let current: Scenario = SCENARIOS[0] as Scenario;
let pasted: Scenario | undefined;
let upTo = Number.POSITIVE_INFINITY;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function readConfig() {
  const b = inputs.budget.value.trim();
  const num = (i: HTMLInputElement, d: number) => (i.value.trim() === "" ? d : Number(i.value));
  const lwarn = num(inputs.lwarn, 3);
  let lstop = num(inputs.lstop, 5);
  const notes: string[] = [];
  if (lstop < lwarn) {
    lstop = lwarn;
    notes.push("Loop stop cannot be below loop warn; using the warn value.");
  }
  const { config, notes: n } = configFrom({
    budgetUsd: b === "" ? null : Number(b),
    warnPct: num(inputs.warn, 80),
    loopWarn: lwarn,
    loopStop: lstop,
  });
  for (const x of n) notes.push(x.replace(/^config\.json: /, "").replace(/, default kept$/, ""));
  return { config, notes };
}

function render(): void {
  const { config, notes } = readConfig();
  cfgNote.textContent = notes.length
    ? `${notes.join(" ")} Defaults used for the rest.`
    : "Change a limit and the timeline re-runs.";
  descEl.textContent = current.description;

  const total = current.steps.length;
  scrub.max = String(Math.max(1, total));
  const n = Math.min(Number.isFinite(upTo) ? upTo : total, total);
  scrub.value = String(n);
  scrubOut.textContent = `${n} of ${total}`;

  // Re-simulate the prefix so the handoff and spend are exactly what had happened by call n.
  const res: SimResult = simulate({ ...current, steps: current.steps.slice(0, n) }, config);

  tbody.replaceChildren();
  tableWrap.classList.toggle("no-plan", !res.steps.some((s) => s.planPct !== null));
  for (const s of res.steps) {
    const tr = el("tr", s.verdict);
    tr.append(el("td", "n", String(s.i + 1)));
    const call = el("td", "call");
    call.append(el("code", undefined, s.tool ?? s.event));
    if (s.tool) call.append(el("span", "sum", s.summary ?? ""));
    else if (s.summary) call.append(el("span", "sum", `"${s.summary}"`));
    if (s.message) call.append(el("span", "msg", s.message));
    tr.append(call);
    tr.append(el("td", "num", usd(s.usd)));
    tr.append(el("td", "num plan", s.planPct === null ? "" : `${Math.round(s.planPct)}%`));
    const v = el("td", "v");
    v.append(el("span", `badge ${s.verdict}`, s.verdict.toUpperCase()));
    tr.append(v);
    tbody.append(tr);
  }

  const last = res.steps.at(-1);
  const spent = last?.usd ?? 0;
  const limit = config.task.usd;
  const stops = res.steps.filter((s) => s.verdict === "stop").length;
  const warns = res.steps.filter((s) => s.verdict === "warn").length;
  summaryEl.textContent = `${n} of ${total} steps shown: ${warns} warning${warns === 1 ? "" : "s"}, ${stops} stop${stops === 1 ? "" : "s"}.`;

  const frac = limit ? Math.min(1, spent / limit) : 0;
  barFill.style.width = `${(frac * 100).toFixed(1)}%`;
  barEl.className = `bar ${frac >= 1 ? "stop" : frac >= config.task.warnAt ? "warn" : ""}`;
  barWarn.style.left = `${(config.task.warnAt * 100).toFixed(1)}%`;
  barWarn.hidden = !limit;
  barText.textContent = limit
    ? `${usd(spent)} of ${usd(limit)} task budget (warning at ${Math.round(config.task.warnAt * 100)}%)`
    : `${usd(spent)} spent, no dollar budget set`;

  handoffWrap.hidden = res.handoff === undefined;
  if (res.handoff !== undefined) {
    handoffEl.textContent = res.handoff;
    handoffPath.textContent = res.handoffPath ?? "";
  }
}

function pick(i: number | "paste"): void {
  if (i === "paste") {
    if (!pasted) return;
    current = pasted;
  } else {
    current = SCENARIOS[i] as Scenario;
  }
  upTo = Number.POSITIVE_INFINITY;
  for (const b of chipsEl.querySelectorAll("button"))
    b.setAttribute("aria-pressed", String(b.dataset.id === String(i)));
  render();
}

SCENARIOS.forEach((s, i) => {
  const b = el("button", "chip", s.name);
  b.type = "button";
  b.dataset.id = String(i);
  b.setAttribute("aria-pressed", "false");
  b.addEventListener("click", () => pick(i));
  chipsEl.append(b);
});
const pasteChip = el("button", "chip", "Pasted transcript");
pasteChip.type = "button";
pasteChip.dataset.id = "paste";
pasteChip.hidden = true;
pasteChip.setAttribute("aria-pressed", "false");
pasteChip.addEventListener("click", () => pick("paste"));
chipsEl.append(pasteChip);

for (const i of Object.values(inputs)) i.addEventListener("input", render);
scrub.addEventListener("input", () => {
  upTo = Number(scrub.value);
  render();
});

$("replay").addEventListener("click", () => {
  const r = scenarioFromTranscript(pasteEl.value);
  pasteErr.hidden = !r.error;
  pasteErr.textContent = r.error ?? "";
  if (!r.scenario) return;
  pasted = r.scenario;
  pasteChip.hidden = false;
  pick("paste");
});

async function copy(text: string, btn: HTMLButtonElement): Promise<void> {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => {
    btn.textContent = old;
  }, 1500);
}
$<HTMLButtonElement>("copy-cmd").addEventListener("click", (e) =>
  copy("npx spend-leash init", e.currentTarget as HTMLButtonElement),
);
$<HTMLButtonElement>("copy-handoff").addEventListener("click", (e) =>
  copy(handoffEl.textContent ?? "", e.currentTarget as HTMLButtonElement),
);

pick(0);
