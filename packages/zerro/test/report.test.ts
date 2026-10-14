// The month report: summary and rows, which envelopes show up.
import { describe, expect, test } from "vitest";
import { memoryMirror } from "@tihonove/testing";
import { ZmError } from "@tihonove/zenmoney";
import { compute, getGoals, monthReport, monthReportFor } from "@tihonove/zerro";
import { account, dataAcc, reminder, state, tag, tx } from "./build.ts";

const TODAY = "2026-10-13";

describe("monthReport", () => {
    const s = state({
        tags: [
            tag("food", "Groceries"),
            tag("fun", "Hobbies"),
            tag("cafe", "Dining", { parent: "fun" }),
            tag("salary", "Bonus", { showOutcome: false }),
            tag("quiet", "Silent", { showOutcome: false }),
            tag("secret", "Secret"),
            tag("goal", "Vacation", { showOutcome: false }),
        ],
        accounts: [
            account("eur", "Card", { balance: 1000 }),
            account("sav", "Savings", { inBalance: false }),
        ],
        transactions: [
            tx("salary", "2026-10-01", { income: 500, tag: ["salary"] }),
            tx("cafe", "2026-10-02", { outcome: 30, tag: ["cafe"] }),
            tx("secret", "2026-10-03", { outcome: 5, tag: ["secret"] }),
        ],
        model: {
            budgets: { "2026-10": { "tag#food": 100 } },
            goals: {
                "2026-10": {
                    "tag#goal": { type: "monthly", amount: 50 },
                    "tag#food": { type: "monthly", amount: 80 },
                },
            },
            envelopeMeta: {
                "tag#secret": { id: "tag#secret", visibility: "hidden" },
                "account#sav": { id: "account#sav", visibility: "visible" },
            },
        },
    });
    const r = compute(s, { today: TODAY });
    const goals = getGoals(s.model.goals, r)["2026-10"]!;

    test("summary in the user's currency", () => {
        expect(monthReport(r, goals, "2026-10").summary).toEqual({
            month: "2026-10",
            currency: "EUR",
            income: 500,
            budgeted: 100,
            activity: -35,
            available: 65,
            overspend: -35,
            funds: 1000,
            budgetedInFuture: 0,
            toBeBudgeted: 935,
            toBeBudgetedState: "positive",
        });
    });

    test("rows: parents include children; empty 'auto' envelopes and hidden ones are left out", () => {
        expect(monthReport(r, goals, "2026-10").envelopes).toEqual([
            {
                group: "Categories",
                envelope: "Groceries",
                id: "tag#food",
                budgeted: 100,
                activity: 0,
                available: 100,
                goalNeed: 0,
            },
            {
                group: "Categories",
                envelope: "Hobbies",
                id: "tag#fun",
                budgeted: 0,
                activity: -30,
                available: -30,
                goalNeed: null,
            },
            {
                group: "Categories",
                envelope: "  └ Dining",
                id: "tag#cafe",
                budgeted: 0,
                activity: -30,
                available: -30,
                goalNeed: null,
            },
            {
                group: "Categories",
                envelope: "Vacation",
                id: "tag#goal",
                budgeted: 0,
                activity: 0,
                available: 0,
                goalNeed: 50,
            },
        ]);
    });

    test("all: every envelope", () => {
        const ids = monthReport(r, goals, "2026-10", { all: true }).envelopes.map((e) => e.id);
        expect(ids).toEqual([
            "tag#null",
            "tag#salary",
            "tag#food",
            "tag#fun",
            "tag#cafe",
            "tag#secret",
            "tag#quiet",
            "tag#goal",
            "account#sav",
        ]);
    });

    test("an empty category shown in outcomes stays; a leftover alone keeps a row", () => {
        const plain = state({
            tags: [
                tag("food", "Groceries"),
                tag("old", "Old", { showOutcome: false }),
                tag("new", "Fresh", { showOutcome: false }),
            ],
            transactions: [tx("t", "2026-09-01", { outcome: 1, tag: ["food"] })],
            model: {
                budgets: {
                    "2026-09": { "tag#old": 20, "tag#food": 1 },
                    "2026-10": { "tag#new": 5 },
                },
            },
        });
        const rr = compute(plain, { today: TODAY });
        const rows = monthReport(rr, {}, "2026-10").envelopes;
        expect(rows.map((e) => [e.id, e.available])).toEqual([
            ["tag#new", 5],
            ["tag#food", 0],
            ["tag#old", 20],
        ]);
    });
});

describe("monthReportFor", () => {
    const con = memoryMirror({
        account: [...memoryMirrorAccounts(), dataAcc],
        reminder: [
            reminder("b", { type: "budgets", month: "2026-10", payload: { "tag#tag-food": 400 } }),
            reminder("g", {
                type: "goals",
                month: "2026-10",
                payload: { "tag#tag-food": { type: "monthly", amount: 500 } },
            }),
        ],
    });

    test("loads, computes and reports a month (default: today's)", () => {
        const report = monthReportFor(con, undefined, { today: TODAY });
        expect(report.summary).toEqual({
            month: "2026-10",
            currency: "EUR",
            income: 1000,
            budgeted: 400,
            activity: -19.5,
            available: 380.5,
            overspend: -7,
            funds: 1487.5,
            budgetedInFuture: 0,
            toBeBudgeted: 1107,
            toBeBudgetedState: "positive",
        });
        expect(report.envelopes.find((e) => e.id === "tag#tag-food")).toMatchObject({
            available: 387.5,
            goalNeed: 100,
        });
        expect(monthReportFor(con, "2026-11", { today: TODAY, all: true }).envelopes.length).toBe(
            5,
        );
        expect(monthReportFor(con, "2026-11", { today: TODAY }).envelopes.length).toBe(4);
    });

    test("a month outside the data names the months there are", () => {
        expect(() => monthReportFor(con, "1999-01", { today: "2026-12-01" })).toThrow(
            new ZmError("no data for 1999-01; months: 2026-10..2027-01"),
        );
    });

    test("a month outside the data", () => {
        expect(() => monthReportFor(con, "1999-01", { today: TODAY })).toThrow(
            new ZmError("no data for 1999-01; months: 2026-10..2026-11"),
        );
    });

    test("today defaults to the real date", () => {
        const month = new Date().toISOString().slice(0, 7);
        expect(monthReportFor(con).summary.month).toBe(month);
    });
});

function memoryMirrorAccounts() {
    return [
        account("acc-rev", "Revolut €", { balance: 887.5 }),
        account("acc-black", "Black", { instrument: 2, balance: 50000 }),
        account("acc-sav", "Revolut Savings", { type: "checking", balance: 100, savings: true }),
        account("acc-old", "Old card", { archive: true }),
    ];
}
