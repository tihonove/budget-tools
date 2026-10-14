// Zerro's goals (src/5-entities/goal in ardov/zerro): which goal applies in a month, and its progress.
import type { Computed } from "./calc.ts";
import { round } from "./calc.ts";
import { GOAL_TYPES, type EnvelopeId, type Goal, type Goals, type Month } from "./types.ts";

/** Zerro's makeGoal: a valid goal, or null (a missing type or amount means "no goal"). */
export function makeGoal(draft: Partial<Goal> | null | undefined): Goal | null {
    const { type, amount, end } = draft ?? {};
    if (!type || !amount || !GOAL_TYPES.includes(type)) return null;
    if (type === "targetBalance" && end)
        return { type, amount, end: end.length === 7 ? `${end}-01` : end };
    return { type, amount };
}

/**
 * The goal in force in a month: set this month, else carried from the previous month.
 * null set in a month stops a goal; a targetBalance goal stops after its end month.
 */
export function goalInMonth(
    month: Month,
    set: Goal | null | undefined,
    previous: Goal | null,
): Goal | null {
    if (set === null) return null;
    const goal = set ?? previous;
    // A YYYY-MM-DD end sorts after its own month: the goal stays in force through that month.
    // Stryker disable next-line EqualityOperator: a YYYY-MM-DD end is never equal to a YYYY-MM month
    if (goal?.end && goal.end < month) return null;
    return goal;
}

export interface GoalProgress {
    /** 0..1 */
    progress: number;
    /** what still has to be budgeted this month */
    needNow: number;
    /** what had to be budgeted at the start of the month */
    needStart: number;
    /** the budget that completes the goal */
    targetBudget: number;
}

export interface GoalContext {
    month: Month;
    leftover: number;
    budgeted: number;
    available: number;
    generalIncome: number;
}

/** Zerro's getProgress. */
export function getProgress(needStart: number, needNow: number): number {
    if (needNow <= 0) return 1;
    // Stryker disable next-line EqualityOperator: at needNow === needStart both branches give 0
    if (needNow >= needStart) return 0;
    return Math.min(round(1 - needNow / needStart), 0.99);
}

/** Calendar months from one YYYY-MM(-DD) to another. */
const monthsBetween = (from: string, to: string): number => {
    const [fy, fm] = from.split("-").map(Number) as [number, number];
    const [ty, tm] = to.split("-").map(Number) as [number, number];
    return (ty - fy) * 12 + (tm - fm);
};

const atLeast0 = (n: number) => Math.max(round(n), 0);

/** Zerro's calcGoals[goal.type]. */
export function goalProgress(goal: Goal, c: GoalContext): GoalProgress {
    const result = (needStart: number, needNow: number, base = needStart): GoalProgress => ({
        needStart,
        needNow,
        targetBudget: needStart,
        progress: getProgress(base, needNow),
    });

    switch (goal.type) {
        case "monthly":
            // "I want to save 1000 every month"
            return result(goal.amount, atLeast0(goal.amount - c.budgeted));

        case "monthlySpend":
            // "I need 1000 for this month": leftover counts
            return result(
                atLeast0(goal.amount - c.leftover),
                atLeast0(goal.amount - c.leftover - c.budgeted),
            );

        case "incomePercent": {
            // "I want to save 30% of my income"
            const needStart = atLeast0(c.generalIncome * Math.min(Math.max(goal.amount, 0), 1));
            return result(needStart, atLeast0(needStart - c.budgeted));
        }

        case "targetBalance": {
            if (!goal.end) {
                // "I want 1000 lying in this envelope"
                return result(
                    atLeast0(goal.amount - c.leftover),
                    atLeast0(goal.amount - c.available),
                    goal.amount,
                );
            }
            // "I want 1000 lying in this envelope by December"
            const monthsLeft = monthsBetween(c.month, goal.end) + 1;
            const needStart = atLeast0((goal.amount - c.leftover) / monthsLeft);
            // (Zerro rounds the sum; a float error here is absorbed by atLeast0's rounding below.)
            const reached = c.leftover + c.budgeted >= goal.amount;
            return result(needStart, reached ? 0 : atLeast0(needStart - c.budgeted));
        }
    }
}

export interface GoalInfo extends GoalProgress {
    id: EnvelopeId;
    goal: Goal;
    month: Month;
    currency: string;
}

/** Goals in force for every month of a computation, with their progress. */
export function getGoals(goals: Goals, r: Computed): Record<Month, Record<EnvelopeId, GoalInfo>> {
    const result: Record<Month, Record<EnvelopeId, GoalInfo>> = {};
    let previous: Record<EnvelopeId, GoalInfo> = {};
    for (const month of r.months) {
        const current: Record<EnvelopeId, GoalInfo> = {};
        const income = r.activity[month]?.generalIncome.total ?? {};
        for (const [id, env] of Object.entries(r.metrics[month]!) as [
            EnvelopeId,
            Computed["metrics"][Month][EnvelopeId],
        ][]) {
            const goal = goalInMonth(month, goals[month]?.[id], previous[id]?.goal ?? null);
            if (!goal) continue;
            const value = (amount: Record<string, number>) =>
                r.convert(amount, env.currency, month);
            current[id] = {
                id,
                goal,
                month,
                currency: env.currency,
                ...goalProgress(goal, {
                    month,
                    leftover: value(env.totalLeftover),
                    budgeted: value(env.totalBudgeted),
                    available: value(env.totalAvailable),
                    generalIncome: value(income),
                }),
            };
        }
        result[month] = current;
        previous = current;
    }
    return result;
}
