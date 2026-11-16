// Built-in demo scenarios: realistic tool calls and token counts on claude-sonnet-5-5.
import { type Scenario, type ScenarioStep, simInput } from "./core.js";

const MODEL = "claude-sonnet-5-5";

interface Usage {
  input: number;
  output: number;
  write: number;
  read: number;
}

type Snap = Pick<ScenarioStep, "snapshot">;

let seq = 0;

/** One assistant transcript line that calls a tool, with usage as Claude Code records it. */
function assistant(text: string, tool: string, input: unknown, u: Usage): string {
  seq++;
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${seq}`,
    message: {
      id: `msg_sim_${seq}`,
      model: MODEL,
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "tool_use", id: `toolu_sim_${seq}`, name: tool, input },
      ],
      usage: {
        input_tokens: u.input,
        output_tokens: u.output,
        cache_creation_input_tokens: u.write,
        cache_read_input_tokens: u.read,
      },
    },
  });
}

function call(text: string, tool: string, input: unknown, u: Usage, extra?: Snap): ScenarioStep {
  return {
    input: simInput("PreToolUse", { tool_name: tool, tool_input: input }),
    transcript: [assistant(text, tool, input, u)],
    ...extra,
  };
}

const prompt = (p: string, extra?: Snap): ScenarioStep => ({
  input: simInput("UserPromptSubmit", { prompt: p }),
  ...extra,
});

const P = "/home/you/project";

// ---- 1. Expensive refactor ----
// A long agentic run: the context grows each turn (cache reads climb) and every turn writes
// new context and a few thousand output tokens.
const FILES = [
  "src/billing/invoice.ts",
  "src/billing/money.ts",
  "src/billing/tax.ts",
  "src/api/checkout.ts",
  "src/api/refunds.ts",
  "src/reports/revenue.ts",
  "src/jobs/dunning.ts",
  "test/billing.test.ts",
];

function refactorTurn(k: number): ScenarioStep {
  const u: Usage = {
    input: 40 + ((k * 17) % 90),
    output: 2400 + ((k * 733) % 2600),
    write: 11000 + ((k * 1370) % 8000),
    read: 70000 + k * 6500,
  };
  const file = FILES[k % FILES.length] as string;
  switch (k % 4) {
    case 0:
      return call(
        `Reading ${file} to find the remaining number-typed amounts.`,
        "Read",
        { file_path: `${P}/${file}` },
        u,
      );
    case 1:
      return call(
        "Replacing the raw number with the Money type.",
        "Edit",
        { file_path: `${P}/${file}`, old_string: "amount: number", new_string: "amount: Money" },
        u,
      );
    case 2:
      return call(
        "Finding other callers that still pass a plain number.",
        "Grep",
        { pattern: "toCents\\(", path: "src" },
        u,
      );
    default:
      return call(
        "Running the type checker to see what is left.",
        "Bash",
        { command: "npx tsc --noEmit" },
        u,
      );
  }
}

const refactor: ScenarioStep[] = [
  prompt("Refactor the billing module to use the new Money type and update every call site."),
];
for (let k = 0; k < 24; k++) refactor.push(refactorTurn(k));
refactor.push(
  prompt("#budget +$2"),
  call(
    "Budget raised; continuing with the remaining call sites.",
    "Edit",
    { file_path: `${P}/src/jobs/dunning.ts`, old_string: "fee: number", new_string: "fee: Money" },
    { input: 55, output: 3100, write: 12500, read: 232000 },
  ),
);

// ---- 2. Test-fix loop ----
const TEST = { command: "npm test", description: "Run the test suite" };
const loopU = (k: number): Usage => ({
  input: 30 + k * 7,
  output: 700 + ((k * 311) % 500),
  write: 2500 + k * 300,
  read: 32000 + k * 2500,
});
const loop: ScenarioStep[] = [
  prompt("The parser tests are failing. Make them pass."),
  call("Running the tests to see the failure.", "Bash", TEST, loopU(0)),
  call(
    "Reading the parser to look for the bug.",
    "Read",
    { file_path: `${P}/src/parser.ts` },
    loopU(1),
  ),
  call("Trying again.", "Bash", TEST, loopU(2)),
  call("Checking the test file.", "Read", { file_path: `${P}/test/parser.test.ts` }, loopU(3)),
  call("Running the tests again.", "Bash", TEST, loopU(4)),
  call("Same failure; running once more.", "Bash", TEST, loopU(5)),
  call("Let me run it one more time to be sure.", "Bash", TEST, loopU(6)),
  call("Running the tests once more.", "Bash", TEST, loopU(7)),
];

// ---- 3. Near the 5-hour limit ----
const RESETS = "2026-11-16T15:30:00Z";
const plan = (pct: number): Snap => ({
  snapshot: { fiveHourPct: pct, fiveHourResetsAt: RESETS, model: MODEL },
});
const planU = (k: number): Usage => ({
  input: 60 + k * 9,
  output: 1800 + ((k * 523) % 1500),
  write: 6500 + k * 900,
  read: 55000 + k * 4200,
});
const nearLimit: ScenarioStep[] = [
  prompt("Add pagination to the orders endpoint and update the client.", plan(90)),
  call(
    "Reading the orders handler.",
    "Read",
    { file_path: `${P}/src/api/orders.ts` },
    planU(0),
    plan(91),
  ),
  call(
    "Adding limit and cursor parameters.",
    "Edit",
    {
      file_path: `${P}/src/api/orders.ts`,
      old_string: "export async function listOrders()",
      new_string: "export async function listOrders(cursor?: string, limit = 50)",
    },
    planU(1),
    plan(92),
  ),
  call(
    "Updating the client call.",
    "Edit",
    {
      file_path: `${P}/src/client/orders.ts`,
      old_string: "fetch('/orders')",
      new_string: "fetch(`/orders?limit=${limit}`)",
    },
    planU(2),
    plan(94),
  ),
  call("Running the tests.", "Bash", { command: "npm test -- orders" }, planU(3), plan(96)),
  prompt("Keep going, finish the client tests.", plan(96)),
  call(
    "Writing the pagination test.",
    "Write",
    {
      file_path: `${P}/test/orders.pagination.test.ts`,
      content: "import { listOrders } from '../src/api/orders';",
    },
    planU(4),
    plan(97),
  ),
];

export const SCENARIOS: Scenario[] = [
  {
    name: "Expensive refactor",
    description:
      "A long refactor runs up the $2 task budget: a warning at 80%, a hard stop with a handoff file, then #budget +$2 lets the next call through.",
    steps: refactor,
  },
  {
    name: "Test-fix loop",
    description:
      "The same failing npm test call keeps repeating with no edits in between: a warning at 3 identical calls, a stop at 5.",
    steps: loop,
  },
  {
    name: "Near the 5-hour limit",
    description:
      "The status line reports the 5-hour window climbing from 90% to 96%: one plan stop with a handoff, then the next prompt shows a notice and work continues.",
    steps: nearLimit,
  },
];
