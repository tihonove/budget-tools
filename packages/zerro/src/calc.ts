// Zerro's envelope math (src/5-entities/envBalances in ardov/zerro):
// activity → envelope metrics → month totals. Amounts are fx maps: {EUR: 12.5, RUB: 100}.
import type { Transaction } from "@tihonove/zenmoney";
import {
    debtAccountId,
    envelopeOf,
    getBudgets,
    getDebtors,
    getEnvelopes,
    isInBudget,
    trType,
    type Envelope,
    type Group,
    type State,
} from "./envelopes.ts";
import type { Budgets, EnvelopeId, Month } from "./types.ts";

export type Fx = Record<string, number>;

export const round = (n: number): number => Math.round(n * 100) / 100;

export function addFx(...amounts: Fx[]): Fx {
    const sum: Fx = {};
    for (const a of amounts) for (const code in a) sum[code] = round((sum[code] ?? 0) + a[code]!);
    return sum;
}

export function subFx(a: Fx, b: Fx): Fx {
    const diff: Fx = { ...a };
    for (const code in b) diff[code] = round((diff[code] ?? 0) - b[code]!);
    return diff;
}

const monthOf = (date: string): Month => date.slice(0, 7);

export function nextMonth(m: Month): Month {
    const [y, mo] = m.split("-").map(Number) as [number, number];
    return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}

export const isoToday = (): string => new Date().toISOString().slice(0, 10);

export type Converter = (amount: Fx, target: string, month: Month) => number;

/** fx converter by month: saved monthly rates, else the closest saved month, else current instrument rates. */
export function makeConverter(s: State, today: string): Converter {
    const current: Fx = {};
    for (const i of Object.values(s.instruments)) current[i.shortTitle] = i.rate;

    const rates: Record<Month, Fx> = {};
    for (const [month, saved] of Object.entries(s.model.fxRates)) {
        const merged: Fx = {};
        for (const code in current) merged[code] = saved.rates[code] || current[code]!;
        rates[month] = merged;
    }
    rates[monthOf(today)] ??= current;

    const months = Object.keys(rates).sort();
    // This month's rates, else the closest earlier month's, else the earliest known.
    const ratesFor = (m: Month): Fx => rates[months.findLast((d) => d <= m) ?? months[0]!]!;

    return (amount, target, month) => {
        const r = ratesFor(month);
        let result = 0;
        for (const code in amount) result = round(result + (amount[code]! * r[code]!) / r[target]!);
        return result;
    };
}

export interface EnvActivity {
    total: Fx;
    transactions: Transaction[];
}

interface Bucket {
    total: Fx;
    byEnv: Record<EnvelopeId, EnvActivity>;
}

export interface MonthActivity {
    /** all budget money movement of the month */
    total: Fx;
    /** in-budget transfers that change the sum (fees, exchange) */
    transferFees: EnvActivity;
    /** income not kept by envelopes: goes to "to be budgeted" */
    generalIncome: Bucket;
    /** spending (and kept income) by envelope */
    envActivity: Bucket;
}

/** Budget money movement by month and envelope. */
export function getActivity(
    s: State,
    envelopes: Record<EnvelopeId, Envelope>,
): Record<Month, MonthActivity> {
    const inBudget = new Set(s.accounts.filter(isInBudget).map((a) => a.id));
    const debtId = debtAccountId(s);
    const debtors = getDebtors(s);
    const code = (instrument: number) =>
        s.instruments[instrument]?.shortTitle ?? String(instrument);
    const keeping = new Set(
        Object.values(envelopes)
            .filter((e) => e.keepIncome)
            .map((e) => e.id),
    );

    const result: Record<Month, MonthActivity> = {};
    const node = (m: Month) =>
        (result[m] ??= {
            total: {},
            transferFees: { total: {}, transactions: [] },
            generalIncome: { total: {}, byEnv: {} },
            envActivity: { total: {}, byEnv: {} },
        });
    const put = (bucket: Bucket, id: EnvelopeId, t: Transaction, change: Fx) => {
        const env = (bucket.byEnv[id] ??= { total: {}, transactions: [] });
        env.total = addFx(env.total, change);
        env.transactions.push(t);
        bucket.total = addFx(bucket.total, change);
    };

    for (const t of s.transactions) {
        const fromBudget = inBudget.has(t.outcomeAccount);
        const toBudget = inBudget.has(t.incomeAccount);
        if (!fromBudget && !toBudget) continue;
        const type = trType(t, debtId);
        const internal = type === "transfer" && fromBudget && toBudget;
        // A transfer inside the budget without fees or exchange changes nothing.
        if (internal && t.income === t.outcome && t.incomeInstrument === t.outcomeInstrument)
            continue;
        const n = node(monthOf(t.date));

        if (internal) {
            const change = addFx(
                { [code(t.incomeInstrument)]: t.income },
                { [code(t.outcomeInstrument)]: -t.outcome },
            );
            n.transferFees.total = addFx(n.transferFees.total, change);
            n.transferFees.transactions.push(t);
            n.total = addFx(n.total, change);
        } else if (
            type === "outcome" ||
            type === "outcomeDebt" ||
            (type === "transfer" && fromBudget)
        ) {
            const change = { [code(t.outcomeInstrument)]: -t.outcome };
            put(n.envActivity, envelopeOf(t, true, debtId, debtors), t, change);
            n.total = addFx(n.total, change);
        } else {
            const change = { [code(t.incomeInstrument)]: t.income };
            const id = envelopeOf(t, false, debtId, debtors);
            put(keeping.has(id) ? n.envActivity : n.generalIncome, id, t, change);
            n.total = addFx(n.total, change);
        }
    }
    return result;
}

/**
 * Months from the first transaction since 2000 (or today's month, if that is earlier) to one
 * month after the later of today and the last budgeted month.
 */
export function getMonthList(s: State, budgets: Budgets, today: string): Month[] {
    const current = monthOf(today);
    const first = s.transactions.find((t) => t.date >= "2000-01-01");
    const start = [monthOf(first?.date ?? today), current].sort()[0]!;
    const end = nextMonth([...Object.keys(budgets), current].sort().at(-1)!);
    const months: Month[] = [];
    for (let m = start; m <= end; m = nextMonth(m)) months.push(m);
    return months;
}

export interface EnvMetrics {
    id: EnvelopeId;
    name: string;
    parent: EnvelopeId | null;
    currency: string;
    /** from the previous month */
    leftover: Fx;
    budgeted: Fx;
    activity: Fx;
    /** leftover + budgeted + activity + children's overspend, in the envelope currency */
    available: Fx;
    transactions: Transaction[];
    childrenOverspend: Fx;
    totalLeftover: Fx;
    totalBudgeted: Fx;
    totalActivity: Fx;
    /** own available + children's surplus */
    totalAvailable: Fx;
}

export type ToBeBudgetedState = "positive" | "allocated" | "negative";

export interface MonthTotals {
    month: Month;
    fundsStart: Fx;
    fundsChange: Fx;
    fundsEnd: Fx;
    transferFees: Fx;
    generalIncome: Fx;
    envActivity: Fx;
    budgeted: Fx;
    positiveBudgeted: Fx;
    available: Fx;
    overspend: Fx;
    budgetedInFuture: Fx;
    freeFunds: Fx;
    toBeBudgeted: Fx;
    toBeBudgetedState: ToBeBudgetedState;
}

export interface Computed {
    userFx: string;
    envelopes: Record<EnvelopeId, Envelope>;
    groups: Group[];
    months: Month[];
    budgets: Budgets;
    activity: Record<Month, MonthActivity>;
    metrics: Record<Month, Record<EnvelopeId, EnvMetrics>>;
    totals: Record<Month, MonthTotals>;
    convert: Converter;
}

/**
 * The whole computation. `today` (YYYY-MM-DD) fixes "now": current funds belong to its month,
 * and the month list ends a month after it.
 */
export function compute(s: State, { today = isoToday() }: { today?: string } = {}): Computed {
    const { byId: envelopes, groups } = getEnvelopes(s);
    const budgets = getBudgets(s);
    const activity = getActivity(s, envelopes);
    const months = getMonthList(s, budgets, today);
    const convert = makeConverter(s, today);

    const metrics: Computed["metrics"] = {};
    let previous: Record<EnvelopeId, EnvMetrics> = {};
    for (const m of months) {
        const current: Record<EnvelopeId, EnvMetrics> = {};

        const calc = (id: EnvelopeId) => {
            const e = envelopes[id]!;
            let chLeftover: Fx = {};
            let chBudgeted: Fx = {};
            let chActivity: Fx = {};
            let chSurplus: Fx = {};
            let chOverspend: Fx = {};
            for (const childId of e.children) {
                const ch = current[childId]!;
                chLeftover = addFx(chLeftover, ch.leftover);
                chBudgeted = addFx(chBudgeted, ch.budgeted);
                chActivity = addFx(chActivity, ch.activity);
                if (ch.available[ch.currency]! > 0) chSurplus = addFx(chSurplus, ch.available);
                else chOverspend = addFx(chOverspend, ch.available);
            }

            // A negative balance is reset next month unless the envelope carries negatives.
            const before = previous[id]?.available[e.currency] ?? 0;
            const leftover = { [e.currency]: e.carryNegatives ? before : Math.max(before, 0) };
            const budgeted = { [e.currency]: budgets[m]?.[id] ?? 0 };
            const own = activity[m]?.envActivity.byEnv[id];
            const selfActivity = own?.total ?? {};
            const available = {
                [e.currency]: convert(
                    addFx(leftover, budgeted, selfActivity, chOverspend),
                    e.currency,
                    m,
                ),
            };
            current[id] = {
                id,
                name: e.name,
                parent: e.parent,
                currency: e.currency,
                leftover,
                budgeted,
                activity: selfActivity,
                available,
                transactions: own?.transactions ?? [],
                childrenOverspend: chOverspend,
                totalLeftover: addFx(leftover, chLeftover),
                totalBudgeted: addFx(budgeted, chBudgeted),
                totalActivity: addFx(selfActivity, chActivity),
                totalAvailable: addFx(available, chSurplus),
            };
        };

        // Children first: a parent covers its children's overspend.
        for (const group of groups) {
            for (const id of group.envelopes) {
                envelopes[id]!.children.forEach(calc);
                calc(id);
            }
        }
        metrics[m] = current;
        previous = current;
    }

    // Totals run backwards from today's funds.
    const funds = addFx(
        ...s.accounts
            .filter(isInBudget)
            .map((a) => ({ [s.instruments[a.instrument]?.shortTitle ?? a.instrument]: a.balance })),
    );
    const currentMonth = monthOf(today);
    const totals: Computed["totals"] = {};
    let later: MonthTotals | undefined;
    for (const m of [...months].reverse()) {
        const toUsd = (a: Fx) => convert(a, "USD", m);
        // Current and future months hold today's funds; past months end where the next one started.
        const fundsEnd = m >= currentMonth ? funds : later!.fundsStart;
        const fundsChange = activity[m]?.total ?? {};

        let budgeted: Fx = {};
        let positiveBudgeted: Fx = {};
        let available: Fx = {};
        let overspend: Fx = {};
        for (const x of Object.values(metrics[m]!)) {
            if (x.parent) continue;
            budgeted = addFx(budgeted, x.totalBudgeted);
            available = addFx(available, x.totalAvailable);
            if (toUsd(x.totalBudgeted) > 0)
                positiveBudgeted = addFx(positiveBudgeted, x.totalBudgeted);
            if (toUsd(x.available) < 0) overspend = addFx(overspend, x.available);
        }

        const budgetedInFuture = later ? addFx(later.positiveBudgeted, later.budgetedInFuture) : {};
        const freeFunds = subFx(fundsEnd, available);
        const withFuture = subFx(freeFunds, budgetedInFuture);
        const [toBeBudgeted, toBeBudgetedState]: [Fx, ToBeBudgetedState] =
            toUsd(freeFunds) < 0
                ? [freeFunds, "negative"]
                : toUsd(withFuture) > 0
                  ? [withFuture, "positive"]
                  : [{}, "allocated"];

        totals[m] = {
            month: m,
            fundsStart: subFx(fundsEnd, fundsChange),
            fundsChange,
            fundsEnd,
            transferFees: activity[m]?.transferFees.total ?? {},
            generalIncome: activity[m]?.generalIncome.total ?? {},
            envActivity: activity[m]?.envActivity.total ?? {},
            budgeted,
            positiveBudgeted,
            available,
            overspend,
            budgetedInFuture,
            freeFunds,
            toBeBudgeted,
            toBeBudgetedState,
        };
        later = totals[m];
    }
    return {
        userFx: s.userFx,
        envelopes,
        groups,
        months,
        budgets,
        activity,
        metrics,
        totals,
        convert,
    };
}
