// Zerro's goals: validation, carrying over months, progress per goal type.
import { describe, expect, test } from "vitest";
import {
    compute,
    getGoals,
    getProgress,
    goalInMonth,
    goalProgress,
    makeGoal,
} from "@tihonove/zerro";
import { state, tx } from "./build.ts";

describe("makeGoal", () => {
    test("a type and a non-zero amount make a goal; otherwise none", () => {
        expect(makeGoal({ type: "monthly", amount: 100 })).toEqual({
            type: "monthly",
            amount: 100,
        });
        expect(makeGoal({ type: "monthlySpend", amount: -5, end: "2026-12" })).toEqual({
            type: "monthlySpend",
            amount: -5,
        });
        for (const bad of [
            null,
            undefined,
            {},
            { type: "monthly" as const },
            { type: "monthly" as const, amount: 0 },
            { amount: 5 },
        ]) {
            expect(makeGoal(bad)).toBeNull();
        }
        expect(makeGoal({ type: "bogus" as never, amount: 5 })).toBeNull();
    });

    test("targetBalance keeps an end date; a month becomes its first day", () => {
        expect(makeGoal({ type: "targetBalance", amount: 9, end: "2026-12" })).toEqual({
            type: "targetBalance",
            amount: 9,
            end: "2026-12-01",
        });
        expect(makeGoal({ type: "targetBalance", amount: 9, end: "2026-12-15" })).toEqual({
            type: "targetBalance",
            amount: 9,
            end: "2026-12-15",
        });
        expect(makeGoal({ type: "targetBalance", amount: 9 })).toEqual({
            type: "targetBalance",
            amount: 9,
        });
        expect(makeGoal({ type: "incomePercent", amount: 0.3 })).toEqual({
            type: "incomePercent",
            amount: 0.3,
        });
    });
});

test("goalInMonth: set, carried, stopped, expired after its end month", () => {
    const monthly = { type: "monthly" as const, amount: 1 };
    const dated = { type: "targetBalance" as const, amount: 1, end: "2026-10-01" };
    expect(goalInMonth("2026-10", monthly, null)).toBe(monthly);
    expect(goalInMonth("2026-10", undefined, monthly)).toBe(monthly);
    expect(goalInMonth("2026-10", null, monthly)).toBeNull();
    expect(goalInMonth("2026-10", undefined, null)).toBeNull();
    expect(goalInMonth("2026-10", dated, null)).toBe(dated);
    expect(goalInMonth("2026-11", undefined, dated)).toBeNull();
});

test("getProgress", () => {
    expect(getProgress(100, 0)).toBe(1);
    expect(getProgress(100, -5)).toBe(1);
    expect(getProgress(100, 100)).toBe(0);
    expect(getProgress(100, 120)).toBe(0);
    expect(getProgress(-50, 10)).toBe(0);
    expect(getProgress(100, 70)).toBe(0.3);
    expect(getProgress(30, 20)).toBe(0.33);
    expect(getProgress(10000, 0.01)).toBe(0.99);
});

describe("goalProgress", () => {
    const ctx = { month: "2026-10", leftover: 0, budgeted: 0, available: 0, generalIncome: 0 };
    const p = (needStart: number, needNow: number, progress: number, targetBudget = needStart) => ({
        needStart,
        needNow,
        progress,
        targetBudget,
    });

    test("monthly: budget the amount every month", () => {
        expect(goalProgress({ type: "monthly", amount: 100 }, { ...ctx, budgeted: 30 })).toEqual(
            p(100, 70, 0.3),
        );
        expect(goalProgress({ type: "monthly", amount: 100 }, { ...ctx, budgeted: 120 })).toEqual(
            p(100, 0, 1),
        );
        expect(goalProgress({ type: "monthly", amount: -50 }, ctx)).toEqual(p(-50, 0, 1));
    });

    test("monthlySpend: have the amount, leftover counts", () => {
        expect(
            goalProgress(
                { type: "monthlySpend", amount: 100 },
                { ...ctx, leftover: 40, budgeted: 30 },
            ),
        ).toEqual(p(60, 30, 0.5));
        expect(
            goalProgress({ type: "monthlySpend", amount: 100 }, { ...ctx, leftover: 150 }),
        ).toEqual(p(0, 0, 1));
    });

    test("incomePercent: a share of the month's income, clamped to 0..1", () => {
        const goal = (amount: number) => ({ type: "incomePercent" as const, amount });
        expect(goalProgress(goal(0.5), { ...ctx, generalIncome: 200, budgeted: 20 })).toEqual(
            p(100, 80, 0.2),
        );
        expect(goalProgress(goal(2), { ...ctx, generalIncome: 200 })).toEqual(p(200, 200, 0));
        expect(goalProgress(goal(-1), { ...ctx, generalIncome: 200 })).toEqual(p(0, 0, 1));
        expect(goalProgress(goal(0.5), { ...ctx, generalIncome: -10 })).toEqual(p(0, 0, 1));
    });

    test("targetBalance without a date: progress is against the whole amount", () => {
        const goal = { type: "targetBalance" as const, amount: 100 };
        expect(goalProgress(goal, { ...ctx, leftover: 20, available: 50 })).toEqual(p(80, 50, 0.5));
        expect(goalProgress(goal, { ...ctx, leftover: 120, available: 130 })).toEqual(p(0, 0, 1));
    });

    test("targetBalance by a date: the rest spread over the months left", () => {
        const goal = { type: "targetBalance" as const, amount: 100, end: "2026-12-01" };
        expect(goalProgress(goal, { ...ctx, leftover: 10, budgeted: 10 })).toEqual(p(30, 20, 0.33));
        expect(goalProgress(goal, { ...ctx, month: "2025-12", leftover: 0 })).toEqual(
            p(7.69, 7.69, 0),
        );
        expect(goalProgress(goal, { ...ctx, leftover: 60, budgeted: 40 })).toEqual(p(13.33, 0, 1));
        // reached even while taking money out: nothing more is needed
        expect(goalProgress(goal, { ...ctx, leftover: 120, budgeted: -20 })).toEqual(p(0, 0, 1));
        expect(goalProgress(goal, { ...ctx, leftover: 119, budgeted: -20 })).toEqual(p(0, 20, 0));
    });
});

test("getGoals: goals in force per month, with their progress", () => {
    const s = state({
        transactions: [
            tx("first", "2026-09-02", { outcome: 1, tag: ["food"] }),
            tx("salary", "2026-10-01", { income: 200, tag: ["salary"] }),
        ],
        model: {
            budgets: { "2026-09": { "tag#food": 30 } },
            goals: {
                "2026-09": { "tag#food": { type: "monthly", amount: 100 } },
                "2026-10": { "tag#fun": { type: "incomePercent", amount: 0.1 } },
                "2026-11": { "tag#food": null },
            },
        },
    });
    const r = compute(s, { today: "2026-10-13" });
    const goals = getGoals(s.model.goals, r);
    expect(Object.keys(goals)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(goals["2026-09"]).toEqual({
        "tag#food": {
            id: "tag#food",
            goal: { type: "monthly", amount: 100 },
            month: "2026-09",
            currency: "EUR",
            needStart: 100,
            needNow: 70,
            targetBudget: 100,
            progress: 0.3,
        },
    });
    expect(goals["2026-10"]!["tag#food"]).toMatchObject({
        month: "2026-10",
        needNow: 100,
        progress: 0,
    });
    expect(goals["2026-10"]!["tag#fun"]).toMatchObject({ needStart: 20, needNow: 20 });
    expect(Object.keys(goals["2026-11"]!)).toEqual(["tag#fun"]);
});
