// Zerro's envelope math on small hand-made accounts; every number is worked out by hand.
import { describe, expect, test } from "vitest";
import {
    addFx,
    compute,
    getActivity,
    getEnvelopes,
    getMonthList,
    isoToday,
    makeConverter,
    nextMonth,
    round,
    subFx,
    type EnvMetrics,
} from "@tihonove/zerro";
import { account, state, tx } from "./build.ts";

const TODAY = "2026-10-13";

describe("helpers", () => {
    test("round to cents", () => {
        expect([round(1.236), round(-1.234), round(2)]).toEqual([1.24, -1.23, 2]);
    });

    test("addFx / subFx", () => {
        expect(addFx({ EUR: 0.1 }, { EUR: 0.2, RUB: 1 })).toEqual({ EUR: 0.3, RUB: 1 });
        expect(addFx()).toEqual({});
        expect(subFx({ EUR: 1, USD: 2 }, { EUR: 0.3, RUB: 2 })).toEqual({
            EUR: 0.7,
            USD: 2,
            RUB: -2,
        });
    });

    test("nextMonth / isoToday", () => {
        expect([nextMonth("2026-09"), nextMonth("2026-10"), nextMonth("2026-12")]).toEqual([
            "2026-10",
            "2026-11",
            "2027-01",
        ]);
        expect(isoToday()).toBe(new Date().toISOString().slice(0, 10));
    });
});

describe("makeConverter", () => {
    test("current instrument rates", () => {
        const convert = makeConverter(state(), TODAY);
        expect(convert({ EUR: 1, RUB: 100 }, "EUR", "2026-10")).toBe(2);
        expect(convert({ EUR: 9 }, "USD", "2026-10")).toBe(10);
        expect(convert({}, "EUR", "2026-10")).toBe(0);
    });

    test("saved monthly rates: the month's, else the closest earlier, else the earliest", () => {
        const convert = makeConverter(
            state({
                model: {
                    fxRates: {
                        "2026-08": { rates: { EUR: 110 } },
                        "2026-11": { rates: { EUR: 120, RUB: 0 } },
                    },
                },
            }),
            TODAY,
        );
        expect(convert({ RUB: 110 }, "EUR", "2026-08")).toBe(1);
        expect(convert({ RUB: 110 }, "EUR", "2026-09")).toBe(1); // August's
        expect(convert({ RUB: 110 }, "EUR", "2026-07")).toBe(1); // before all: the earliest
        expect(convert({ RUB: 100 }, "EUR", "2026-10")).toBe(1); // today's month: current rates
        expect(convert({ RUB: 120 }, "EUR", "2026-12")).toBe(1); // November's; RUB 0 = not saved
    });

    test("a saved rate for the current month wins over the instruments", () => {
        const s = state({ model: { fxRates: { "2026-10": { rates: { EUR: 200 } } } } });
        expect(makeConverter(s, TODAY)({ RUB: 200 }, "EUR", "2026-10")).toBe(1);
    });
});

describe("getActivity", () => {
    const s = state({
        accounts: [
            account("eur", "Card €"),
            account("eur2", "Card 2"),
            account("rub", "Card ₽", { instrument: 2 }),
            account("sav", "Savings", { inBalance: false }),
            account("debt", "Debts", { type: "debt" }),
        ],
        merchants: { m: { id: "m", changed: 1, user: 1, title: "Shop" } },
        model: { envelopeMeta: { "tag#fun": { id: "tag#fun", keepIncome: true } } },
    });
    const a = tx("a", "2026-10-01", { outcome: 10, tag: ["food"] });
    const b = tx("b", "2026-10-01", { income: 100, tag: ["salary"] });
    const c = tx("c", "2026-10-02", { income: 5, tag: ["fun"] });
    const d = tx("d", "2026-10-02", { outcome: 30, income: 30, incomeAccount: "sav" });
    const e = tx("e", "2026-10-03", { outcome: 20, income: 20, outcomeAccount: "sav" });
    const f = tx("f", "2026-10-03", {
        outcome: 1,
        income: 100,
        incomeAccount: "rub",
        incomeInstrument: 2,
    });
    const g = tx("g", "2026-10-04", { outcome: 50, income: 50, incomeAccount: "eur2" });
    const g2 = tx("g2", "2026-09-04", { outcome: 50, income: 50, incomeAccount: "eur2" });
    const fee = tx("fee", "2026-10-04", { outcome: 10, income: 9, incomeAccount: "eur2" });
    const swap = tx("swap", "2026-10-04", {
        outcome: 100,
        income: 100,
        incomeAccount: "rub",
        incomeInstrument: 2,
    });
    const h = tx("h", "2026-10-04", { outcome: 9, outcomeAccount: "sav", incomeAccount: "sav" });
    const i = tx("i", "2026-10-05", { outcome: 7, incomeAccount: "debt", merchant: "m" });
    const j = tx("j", "2026-10-05", { income: 3, outcomeAccount: "debt", payee: "Ann" });
    const k = tx("k", "2026-10-06", {
        outcome: 4,
        outcomeInstrument: 99,
        incomeInstrument: 99,
        tag: ["food"],
    });
    const r = { ...s, transactions: [g2, a, b, c, d, e, f, g, fee, swap, h, i, j, k] };

    test("buckets: transfer fees, general income, envelope activity", () => {
        const activity = getActivity(r, getEnvelopes(r).byId);
        expect(Object.keys(activity)).toEqual(["2026-10"]); // a no-op transfer alone makes no month
        expect(activity["2026-10"]).toEqual({
            total: { EUR: -21, RUB: 200, "99": -4 },
            transferFees: { total: { RUB: 200, EUR: -102 }, transactions: [f, fee, swap] },
            generalIncome: {
                total: { EUR: 123 },
                byEnv: {
                    "tag#salary": { total: { EUR: 100 }, transactions: [b] },
                    "account#sav": { total: { EUR: 20 }, transactions: [e] },
                    "payee#ann": { total: { EUR: 3 }, transactions: [j] },
                },
            },
            envActivity: {
                total: { EUR: -42, "99": -4 },
                byEnv: {
                    "tag#food": { total: { EUR: -10, "99": -4 }, transactions: [a, k] },
                    "tag#fun": { total: { EUR: 5 }, transactions: [c] },
                    "account#sav": { total: { EUR: -30 }, transactions: [d] },
                    "merchant#m": { total: { EUR: -7 }, transactions: [i] },
                },
            },
        });
    });
});

describe("getMonthList", () => {
    const dates = (...ds: string[]) =>
        state({ transactions: ds.map((d, i) => tx(`t${i}`, d, { outcome: 1 })) });

    test("from the first transaction between 2000 and today to a month after today", () => {
        expect(getMonthList(dates("1999-12-31", "2026-08-15", "2027-01-01"), {}, TODAY)).toEqual([
            "2026-08",
            "2026-09",
            "2026-10",
            "2026-11",
        ]);
        expect(getMonthList(dates("2026-10-13"), {}, TODAY)).toEqual(["2026-10", "2026-11"]);
        expect(getMonthList(dates("2026-10-14"), {}, TODAY)).toEqual(["2026-10", "2026-11"]);
        expect(getMonthList(dates("2026-12-05"), {}, TODAY)).toEqual(["2026-10", "2026-11"]);
        expect(getMonthList(state(), {}, TODAY)).toEqual(["2026-10", "2026-11"]);
        const long = getMonthList(dates("2000-01-01"), {}, TODAY);
        expect([long[0], long.length]).toEqual(["2000-01", 323]);
    });

    test("budgets in the future extend the list", () => {
        expect(getMonthList(state(), { "2027-01": {}, "2026-12": {} }, TODAY).at(-1)).toBe(
            "2027-02",
        );
        expect(getMonthList(state(), { "2026-01": {} }, TODAY).at(-1)).toBe("2026-11");
    });
});

describe("compute", () => {
    // Budgets: Sep food 100, fun 10, cafe 20; Oct food 50, cafe 15; Nov fun 30.
    // Sep: salary +2000, food -30, cafe -50. Oct: food -200. Nov (future): cafe -15.
    const scenario = (meta = {}) =>
        state({
            accounts: [account("eur", "Card €", { balance: 1000 })],
            transactions: [
                tx("salary", "2026-09-01", { income: 2000, tag: ["salary"] }),
                tx("food-sep", "2026-09-05", { outcome: 30, tag: ["food"] }),
                tx("cafe-sep", "2026-09-06", { outcome: 50, tag: ["cafe"] }),
                tx("food-oct", "2026-10-02", { outcome: 200, tag: ["food"] }),
                tx("cafe-nov", "2026-11-02", { outcome: 15, tag: ["cafe"] }),
            ],
            model: {
                envelopeMeta: meta,
                budgets: {
                    "2026-09": { "tag#food": 100, "tag#fun": 10, "tag#cafe": 20 },
                    "2026-10": { "tag#food": 50, "tag#cafe": 15 },
                    "2026-11": { "tag#fun": 30 },
                },
            },
        });

    const pick = (m: EnvMetrics) => ({
        leftover: m.leftover,
        budgeted: m.budgeted,
        activity: m.activity,
        available: m.available,
        childrenOverspend: m.childrenOverspend,
        totalLeftover: m.totalLeftover,
        totalBudgeted: m.totalBudgeted,
        totalActivity: m.totalActivity,
        totalAvailable: m.totalAvailable,
        transactions: m.transactions.map((t) => t.id),
    });

    test("months, envelopes and budgets", () => {
        const r = compute(scenario(), { today: TODAY });
        expect(r.months).toEqual(["2026-09", "2026-10", "2026-11", "2026-12"]);
        expect(r.userFx).toBe("EUR");
        expect(r.groups[0]!.name).toBe("Categories");
        expect(Object.keys(r.envelopes).length).toBe(5);
        expect(r.budgets["2026-11"]).toEqual({ "tag#fun": 30 });
        expect(r.activity["2026-11"]!.total).toEqual({ EUR: -15 });
        expect(r.convert({ RUB: 100 }, "EUR", "2026-10")).toBe(1);
    });

    test("September: a child's overspend is covered by its parent", () => {
        const sep = compute(scenario(), { today: TODAY }).metrics["2026-09"]!;
        expect(sep["tag#food"]).toEqual({
            id: "tag#food",
            name: "Groceries",
            parent: null,
            currency: "EUR",
            leftover: { EUR: 0 },
            budgeted: { EUR: 100 },
            activity: { EUR: -30 },
            available: { EUR: 70 },
            transactions: [expect.objectContaining({ id: "food-sep" })],
            childrenOverspend: {},
            totalLeftover: { EUR: 0 },
            totalBudgeted: { EUR: 100 },
            totalActivity: { EUR: -30 },
            totalAvailable: { EUR: 70 },
        });
        expect([sep["tag#cafe"]!.parent, pick(sep["tag#cafe"]!)]).toEqual([
            "tag#fun",
            {
                leftover: { EUR: 0 },
                budgeted: { EUR: 20 },
                activity: { EUR: -50 },
                available: { EUR: -30 },
                childrenOverspend: {},
                totalLeftover: { EUR: 0 },
                totalBudgeted: { EUR: 20 },
                totalActivity: { EUR: -50 },
                totalAvailable: { EUR: -30 },
                transactions: ["cafe-sep"],
            },
        ]);
        expect(pick(sep["tag#fun"]!)).toEqual({
            leftover: { EUR: 0 },
            budgeted: { EUR: 10 },
            activity: {},
            available: { EUR: -20 },
            childrenOverspend: { EUR: -30 },
            totalLeftover: { EUR: 0 },
            totalBudgeted: { EUR: 30 },
            totalActivity: { EUR: -50 },
            totalAvailable: { EUR: -20 },
            transactions: [],
        });
        expect(sep["tag#salary"]!.available).toEqual({ EUR: 0 }); // income is not envelope money
    });

    test("October: positive balances carry, negative ones reset; a child's surplus counts for the parent", () => {
        const oct = compute(scenario(), { today: TODAY }).metrics["2026-10"]!;
        expect(pick(oct["tag#food"]!)).toMatchObject({
            leftover: { EUR: 70 },
            available: { EUR: -80 },
        });
        expect(pick(oct["tag#cafe"]!)).toMatchObject({
            leftover: { EUR: 0 },
            available: { EUR: 15 },
        });
        expect(pick(oct["tag#fun"]!)).toEqual({
            leftover: { EUR: 0 },
            budgeted: { EUR: 0 },
            activity: {},
            available: { EUR: 0 },
            childrenOverspend: {},
            totalLeftover: { EUR: 0 },
            totalBudgeted: { EUR: 15 },
            totalActivity: {},
            totalAvailable: { EUR: 15 },
            transactions: [],
        });
    });

    test("November: a child at exactly zero counts as overspend (Zerro: not > 0)", () => {
        const nov = compute(scenario(), { today: TODAY }).metrics["2026-11"]!;
        expect(pick(nov["tag#cafe"]!)).toMatchObject({
            leftover: { EUR: 15 },
            available: { EUR: 0 },
        });
        expect(pick(nov["tag#fun"]!)).toMatchObject({
            childrenOverspend: { EUR: 0 },
            available: { EUR: 30 },
            totalAvailable: { EUR: 30 },
            totalActivity: { EUR: -15 },
            totalLeftover: { EUR: 15 },
        });
        expect(nov["tag#food"]!.leftover).toEqual({ EUR: 0 });
    });

    test("carryNegatives keeps a negative balance", () => {
        const meta = { "tag#food": { id: "tag#food" as const, carryNegatives: true } };
        const nov = compute(scenario(meta), { today: TODAY }).metrics["2026-11"]!;
        expect(nov["tag#food"]!.leftover).toEqual({ EUR: -80 });
    });

    test("an envelope in another currency converts everything into it", () => {
        const s = state({
            transactions: [tx("t", "2026-10-01", { outcome: 1, tag: ["food"] })],
            model: {
                envelopeMeta: { "tag#food": { id: "tag#food", currency: "RUB" } },
                budgets: { "2026-10": { "tag#food": 150 } },
            },
        });
        const food = compute(s, { today: TODAY }).metrics["2026-10"]!["tag#food"]!;
        expect([food.budgeted, food.activity, food.available]).toEqual([
            { RUB: 150 },
            { EUR: -1 },
            { RUB: 50 },
        ]);
    });

    test("totals, from today's funds backwards", () => {
        const t = compute(scenario(), { today: TODAY }).totals;
        expect(t["2026-12"]).toEqual({
            month: "2026-12",
            fundsStart: { EUR: 1000 },
            fundsChange: {},
            fundsEnd: { EUR: 1000 },
            transferFees: {},
            generalIncome: {},
            envActivity: {},
            budgeted: { EUR: 0 },
            positiveBudgeted: {},
            available: { EUR: 30 },
            overspend: {},
            budgetedInFuture: {},
            freeFunds: { EUR: 970 },
            toBeBudgeted: { EUR: 970 },
            toBeBudgetedState: "positive",
        });
        expect(t["2026-11"]).toMatchObject({
            fundsStart: { EUR: 1015 },
            fundsEnd: { EUR: 1000 },
            budgeted: { EUR: 30 },
            positiveBudgeted: { EUR: 30 },
            overspend: {},
            budgetedInFuture: {},
        });
        expect(t["2026-10"]).toMatchObject({
            fundsStart: { EUR: 1200 },
            fundsChange: { EUR: -200 },
            fundsEnd: { EUR: 1000 },
            budgeted: { EUR: 65 },
            available: { EUR: -65 },
            overspend: { EUR: -80 },
            budgetedInFuture: { EUR: 30 },
            freeFunds: { EUR: 1065 },
            toBeBudgeted: { EUR: 1035 },
        });
        expect(t["2026-09"]).toEqual({
            month: "2026-09",
            fundsStart: { EUR: -720 },
            fundsChange: { EUR: 1920 },
            fundsEnd: { EUR: 1200 },
            transferFees: {},
            generalIncome: { EUR: 2000 },
            envActivity: { EUR: -80 },
            budgeted: { EUR: 130 },
            positiveBudgeted: { EUR: 130 },
            available: { EUR: 50 },
            overspend: { EUR: -20 },
            budgetedInFuture: { EUR: 95 },
            freeFunds: { EUR: 1150 },
            toBeBudgeted: { EUR: 1055 },
            toBeBudgetedState: "positive",
        });
    });

    const budgetOnly = (balance: number, budgets: Record<string, Record<string, number>>) =>
        compute(state({ accounts: [account("eur", "Card", { balance })], model: { budgets } }), {
            today: TODAY,
        }).totals["2026-10"]!;

    test("to be budgeted: negative when envelopes hold more than there is", () => {
        expect(budgetOnly(10, { "2026-10": { "tag#food": 100 } })).toMatchObject({
            freeFunds: { EUR: -90 },
            toBeBudgeted: { EUR: -90 },
            toBeBudgetedState: "negative",
        });
    });

    test("to be budgeted: allocated at exactly zero, also counting future budgets", () => {
        expect(budgetOnly(100, { "2026-10": { "tag#food": 100 } })).toMatchObject({
            freeFunds: { EUR: 0 },
            toBeBudgeted: {},
            toBeBudgetedState: "allocated",
        });
        expect(
            budgetOnly(100, { "2026-10": { "tag#food": 60 }, "2026-11": { "tag#food": 40 } }),
        ).toMatchObject({
            freeFunds: { EUR: 40 },
            budgetedInFuture: { EUR: 40 },
            toBeBudgeted: {},
            toBeBudgetedState: "allocated",
        });
    });

    test("negative budgets are not 'positive budgeted'", () => {
        expect(budgetOnly(100, { "2026-10": { "tag#food": -5 } })).toMatchObject({
            budgeted: { EUR: -5 },
            positiveBudgeted: {},
        });
    });

    test("funds of accounts in an unknown currency are keyed by the instrument id", () => {
        const s = state({
            accounts: [
                account("x", "X", { instrument: 99, balance: 5 }),
                account("o", "Off", { inBalance: false, balance: 7 }),
            ],
        });
        expect(compute(s, { today: TODAY }).totals["2026-10"]!.fundsEnd).toEqual({ "99": 5 });
    });

    test("today defaults to the real date", () => {
        expect(compute(state()).months[0]).toBe(isoToday().slice(0, 7));
    });
});
