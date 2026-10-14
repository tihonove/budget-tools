// zerro — read and edit Zerro's envelope model (zerro.app) stored inside ZenMoney.
// CLI front-end over @tihonove/zerro: main(argv, io) → exit code. Reads the zm mirror (zenmoney.db).
import {
    createProgram,
    parseBool,
    parseNumber,
    printRows,
    printTable,
    runProgram,
    type Io,
} from "@tihonove/cli-kit";
import { all, envConfig, open, type Context, type Diff } from "@tihonove/zenmoney";
import { isoToday } from "./calc.ts";
import { getEnvelopes, loadState } from "./envelopes.ts";
import { applyBudget, applyGoal, applyMeta, applyMove, type MetaPatch } from "./ops.ts";
import { monthReportFor, type MonthReport } from "./report.ts";
import { dataReminders, readModel } from "./store.ts";
import { GOAL_TYPES, type Goal, type Month, type Visibility } from "./types.ts";

/** Run zerro with these arguments; returns the exit code. */
export function main(argv: string[], io: Io): Promise<number> {
    return runProgram(program(io), argv, io);
}

/** 1 234,50 — or "·" for zero. */
export const money = (n: number): string =>
    n ? n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "·";

function program(io: Io) {
    const zerro = createProgram("zerro", io).description(
        "Zerro (zerro.app) envelopes stored inside ZenMoney. Reads the zm mirror: run `zm sync` first.",
    );

    const context = (): Context => open(envConfig(io.env, io.cwd));
    const today = () => io.env.ZERRO_TODAY || isoToday();
    const thisMonth = (): Month => today().slice(0, 7);

    zerro
        .command("raw")
        .description("dump the stored model as JSON (budgets, goals, envelope meta, settings)")
        .option("--reminders", "include the underlying ZenMoney reminders")
        .action((opts: { reminders?: boolean }) => {
            const con = context().con;
            const model = readModel(con);
            const titles = new Map(all(con, "tag").map((t) => [`tag#${t.id}`, t.title]));
            const named = <T>(byEnvelope: Record<string, T>) =>
                Object.fromEntries(
                    Object.entries(byEnvelope).map(([id, v]) => [
                        titles.has(id) ? `${titles.get(id)} (${id})` : id,
                        v,
                    ]),
                );
            const byMonth = <T>(stores: Record<string, Record<string, T>>) =>
                Object.fromEntries(
                    Object.keys(stores)
                        .sort()
                        .map((m) => [m, named(stores[m]!)]),
                );

            const out: Record<string, unknown> = {
                dataAccount: model.dataAccount && {
                    id: model.dataAccount.id,
                    title: model.dataAccount.title,
                },
                budgets: byMonth(model.budgets),
                goals: byMonth(model.goals),
                envelopeMeta: named(model.envelopeMeta),
                userSettings: model.userSettings,
                fxRates: model.fxRates,
                other: model.other,
            };
            if (opts.reminders) out.reminders = dataReminders(con).map((d) => d.reminder);
            io.log(JSON.stringify(out, null, 2));
        });

    zerro
        .command("envelopes")
        .description("list envelopes with ids, groups and settings")
        .option("--json", "print JSON")
        .action((opts: { json?: boolean }) => {
            const list = Object.values(getEnvelopes(loadState(context().con)).byId)
                .sort((a, b) => a.index - b.index)
                .map((e) => ({
                    id: e.id,
                    name: (e.parent ? "  └ " : "") + e.name,
                    group: e.group,
                    visibility: e.visibility,
                    currency: e.currency,
                    flags: [e.keepIncome && "keepIncome", e.carryNegatives && "carryNegatives"]
                        .filter(Boolean)
                        .join(" "),
                    comment: e.comment,
                }));
            printRows(io, list, opts.json);
        });

    zerro
        .command("show")
        .description(
            "a month as Zerro shows it: budgeted / activity / available / goal, plus 'to be budgeted'",
        )
        .option("--month <month>", "YYYY-MM, default: this month")
        .option("--all", "include empty envelopes")
        .option("--json", "print JSON")
        .action((opts: { month?: string; all?: boolean; json?: boolean }) => {
            const report = monthReportFor(context().con, opts.month, {
                all: opts.all,
                today: today(),
            });
            if (opts.json) io.log(JSON.stringify(report, null, 2));
            else printReport(io, report);
        });

    /** Print the diff of a dry run, or confirm a verified write. */
    const done = ({ diff }: { diff: Diff }, dryRun?: boolean) =>
        io.log(dryRun ? JSON.stringify(diff, null, 2) : "ok: saved and verified on the server");

    zerro
        .command("budget")
        .description("set how much is budgeted to an envelope in a month")
        .argument("<envelope>", "envelope name or id")
        .argument("<amount>", "amount in the envelope currency; 0 removes the budget", parseNumber)
        .option("--month <month>", "YYYY-MM, default: this month")
        .option("--add", "add the amount to the current budget instead of replacing it")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (key: string, amount: number, opts: BudgetOptions) => {
            const month = opts.month ?? thisMonth();
            const options = { add: opts.add, dryRun: opts.dryRun };
            done(await applyBudget(context(), key, amount, month, options), opts.dryRun);
        });

    zerro
        .command("move")
        .description("move budgeted money between envelopes within a month")
        .argument("<amount>", "amount", parseNumber)
        .argument("<from>", "envelope name or id")
        .argument("<to>", "envelope name or id")
        .option("--month <month>", "YYYY-MM, default: this month")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (amount: number, from: string, to: string, opts: MonthOptions) => {
            const month = opts.month ?? thisMonth();
            const options = { dryRun: opts.dryRun };
            done(await applyMove(context(), amount, from, to, month, options), opts.dryRun);
        });

    zerro
        .command("goal")
        .description("set an envelope's goal from a month on, or stop it with --off")
        .argument("<envelope>", "envelope name or id")
        .argument("[type]", GOAL_TYPES.join(" | "))
        .argument("[amount]", "amount; for incomePercent a share 0..1", parseNumber)
        .option("--end <month>", "targetBalance: reach the amount by this month, YYYY-MM")
        .option("--month <month>", "from this month, YYYY-MM, default: this month")
        .option("--off", "stop the goal from this month")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (key: string, type: string, amount: number, opts: GoalOptions) => {
            const month = opts.month ?? thisMonth();
            const goal = opts.off ? null : ({ type, amount, end: opts.end } as Partial<Goal>);
            done(
                await applyGoal(context(), key, goal, month, { dryRun: opts.dryRun }),
                opts.dryRun,
            );
        });

    zerro
        .command("meta")
        .description("change envelope settings")
        .argument("<envelope>", "envelope name or id")
        .option("--group <name>", "group name; '' = default group")
        .option("--index <n>", "position in the list", parseNumber)
        .option("--comment <text>", "comment; '' removes it")
        .option("--visibility <v>", "hidden | visible | auto")
        .option("--currency <code>", "envelope currency, e.g. EUR")
        .option(
            "--carry-negatives <bool>",
            "a negative balance carries over to the next month",
            parseBool,
        )
        .option("--keep-income <bool>", "income stays in the envelope", parseBool)
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (key: string, opts: MetaOptions) => {
            const { dryRun, ...given } = opts;
            // '' clears a text field: undefined removes it from the settings.
            const patch = Object.fromEntries(
                Object.entries(given).map(([k, v]) => [k, v === "" ? undefined : v]),
            ) as MetaPatch;
            done(await applyMeta(context(), key, patch, { dryRun }), dryRun);
        });

    return zerro;
}

/** The report as a table, like Zerro's budget screen. */
function printReport(io: Io, { summary, envelopes }: MonthReport) {
    io.log(
        `${summary.month}, ${summary.currency}. Income ${money(summary.income)}` +
            ` · Budgeted ${money(summary.budgeted)} · Spent ${money(summary.activity)}` +
            ` · Overspent ${money(summary.overspend)}`,
    );
    io.log(
        `Funds ${money(summary.funds)} · In envelopes ${money(summary.available)}` +
            ` · To be budgeted ${money(summary.toBeBudgeted)} (${summary.toBeBudgetedState})\n`,
    );
    const table: Record<string, string>[] = [];
    let lastGroup: string | null = null;
    for (const row of envelopes) {
        if (row.group !== lastGroup) {
            table.push({
                envelope: `[${row.group}]`,
                budgeted: "",
                activity: "",
                available: "",
                goal: "",
            });
            lastGroup = row.group;
        }
        table.push({
            envelope: row.envelope,
            budgeted: money(row.budgeted),
            activity: money(row.activity),
            available: money(row.available),
            goal: row.goalNeed === null ? "" : row.goalNeed ? `need ${money(row.goalNeed)}` : "ok",
        });
    }
    printTable(io, table, ["envelope", "budgeted", "activity", "available", "goal"]);
}

interface MonthOptions {
    month?: string;
    dryRun?: boolean;
}

interface BudgetOptions extends MonthOptions {
    add?: boolean;
}

interface GoalOptions extends MonthOptions {
    end?: string;
    off?: boolean;
}

interface MetaOptions {
    group?: string;
    index?: number;
    comment?: string;
    visibility?: Visibility;
    currency?: string;
    carryNegatives?: boolean;
    keepIncome?: boolean;
    dryRun?: boolean;
}
