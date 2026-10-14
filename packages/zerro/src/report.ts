// A month as Zerro shows it: the summary line and one row per envelope.
import type { DatabaseSync } from "node:sqlite";
import { ZmError } from "@tihonove/zenmoney";
import { compute, isoToday, type Computed, type Fx, type ToBeBudgetedState } from "./calc.ts";
import { loadState } from "./envelopes.ts";
import { getGoals, type GoalInfo } from "./goals.ts";
import { readModel } from "./store.ts";
import type { EnvelopeId, Month } from "./types.ts";

/** Month totals in the user's currency. */
export interface MonthSummary {
    month: Month;
    currency: string;
    /** income that is not kept by envelopes */
    income: number;
    budgeted: number;
    /** spending (negative) and kept income */
    activity: number;
    /** money lying in envelopes */
    available: number;
    /** sum of negative envelope balances */
    overspend: number;
    /** money in budget accounts at the end of the month */
    funds: number;
    budgetedInFuture: number;
    toBeBudgeted: number;
    toBeBudgetedState: ToBeBudgetedState;
}

/** One envelope in a month, in the user's currency. A parent row includes its children. */
export interface EnvelopeRow {
    group: string;
    /** name; children are prefixed with "  └ " */
    envelope: string;
    id: EnvelopeId;
    budgeted: number;
    activity: number;
    available: number;
    /** what the goal still needs this month; null without a goal */
    goalNeed: number | null;
}

export interface MonthReport {
    summary: MonthSummary;
    envelopes: EnvelopeRow[];
}

/**
 * The month's summary and envelope rows in display order. Empty envelopes are left out unless
 * `all` (visible categories always stay, hidden envelopes only with `all`).
 */
export function monthReport(
    r: Computed,
    goals: Record<EnvelopeId, GoalInfo>,
    month: Month,
    { all = false }: { all?: boolean } = {},
): MonthReport {
    const value = (amount: Fx) => r.convert(amount, r.userFx, month);
    const t = r.totals[month]!;
    const summary: MonthSummary = {
        month,
        currency: r.userFx,
        income: value(t.generalIncome),
        budgeted: value(t.budgeted),
        activity: value(t.envActivity),
        available: value(t.available),
        overspend: value(t.overspend),
        funds: value(t.fundsEnd),
        budgetedInFuture: value(t.budgetedInFuture),
        toBeBudgeted: value(t.toBeBudgeted),
        toBeBudgetedState: t.toBeBudgetedState,
    };

    const envelopes: EnvelopeRow[] = [];
    for (const group of r.groups) {
        for (const parentId of group.envelopes) {
            for (const id of [parentId, ...r.envelopes[parentId]!.children]) {
                const e = r.envelopes[id]!;
                const x = r.metrics[month]![id]!;
                const top = id === parentId;
                const row: EnvelopeRow = {
                    group: group.name,
                    envelope: (top ? "" : "  └ ") + e.name,
                    id,
                    budgeted: value(top ? x.totalBudgeted : x.budgeted),
                    activity: value(top ? x.totalActivity : x.activity),
                    available: value(top ? x.totalAvailable : x.available),
                    goalNeed: goals[id]?.needNow ?? null,
                };
                const leftover = value(top ? x.totalLeftover : x.leftover);
                // A budget alone always leaves money (or a hole) somewhere: no need to check it.
                const empty = !row.activity && !row.available && !leftover && row.goalNeed === null;
                const alwaysShown = e.visibility === "visible" && e.type === "tag";
                const hidden = e.visibility === "hidden" || (empty && !alwaysShown);
                if (all || !hidden) envelopes.push(row);
            }
        }
    }
    return { summary, envelopes };
}

/**
 * Load the mirror, compute everything and report one month (default: the month of `today`).
 * Throws a ZmError for a month outside the data.
 */
export function monthReportFor(
    con: DatabaseSync,
    month?: Month,
    { all = false, today = isoToday() }: { all?: boolean; today?: string } = {},
): MonthReport {
    const r = compute(loadState(con), { today });
    const m = month ?? today.slice(0, 7);
    if (!r.metrics[m]) {
        throw new ZmError(`no data for ${m}; months: ${r.months[0]}..${r.months.at(-1)}`);
    }
    return monthReport(r, getGoals(readModel(con).goals, r)[m]!, m, { all });
}
