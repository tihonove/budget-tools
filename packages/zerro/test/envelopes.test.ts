// Envelopes: ids, debtors, transaction → envelope, the envelope tree, budgets.
import { describe, expect, test } from "vitest";
import { memoryMirror } from "@tihonove/testing";
import {
    cleanPayee,
    debtAccountId,
    envelopeOf,
    envId,
    getBudgets,
    getDebtors,
    getEnvelopes,
    GROUPS,
    isInBudget,
    loadState,
    NULL_TAG,
    parseEnvId,
    trType,
    type Envelope,
} from "@tihonove/zerro";
import { account, dataAcc, instruments, me, reminder, state, tag, tx } from "./build.ts";

describe("ids and names", () => {
    test("envId / parseEnvId", () => {
        expect(envId("tag", "x")).toBe("tag#x");
        expect(parseEnvId("payee#a#b")).toEqual({ type: "payee", id: "a#b" });
        expect(NULL_TAG).toBe("null");
    });

    test("cleanPayee keeps digits, latin and cyrillic letters, lower-cased", () => {
        expect(cleanPayee("Иван И. (Ёлка)_1 Bob!")).toBe("иваниёлка_1bob");
    });

    test("GROUPS: Zerro's default group names", () => {
        expect(GROUPS).toEqual({
            tag: "Categories",
            account: "Transfers",
            merchant: "Debts",
            payee: "Debts",
        });
    });

    test("isInBudget: in balance, or marked with 📍; never a debt account", () => {
        expect(isInBudget(account("a", "Card"))).toBe(true);
        expect(isInBudget(account("a", "Savings", { inBalance: false }))).toBe(false);
        expect(isInBudget(account("a", "Wallet 📍", { inBalance: false }))).toBe(true);
        expect(isInBudget(account("a", "Debts 📍", { type: "debt" }))).toBe(false);
    });
});

describe("loadState", () => {
    test("reads everything; live transactions sorted by date, then creation", () => {
        const con = memoryMirror({
            instrument: instruments,
            user: [me],
            account: [account("eur", "Card"), dataAcc],
            tag: [tag("food", "Food")],
            merchant: [{ id: "m1", changed: 1, user: 1, title: "Shop" }],
            transaction: [
                tx("late", "2026-10-02", { outcome: 1, created: 1 }),
                tx("second", "2026-10-01", { outcome: 1, created: 20 }),
                tx("first", "2026-10-01", { outcome: 1, created: 10 }),
                tx("tiny", "2026-10-01", { income: 0.0001, created: 30 }),
                tx("tiny-out", "2026-09-30", { outcome: 0.0001, created: 99 }),
                tx("early", "2026-09-29", { outcome: 1, created: 100 }),
                tx("deleted", "2026-10-01", { outcome: 5, deleted: true }),
                tx("empty", "2026-10-01", { income: 0.00009, outcome: 0.00009 }),
            ],
            reminder: [
                reminder("r", { type: "budgets", month: "2026-10", payload: { "tag#food": 1 } }),
            ],
        });
        const s = loadState(con);
        expect(s.userFx).toBe("EUR");
        expect(Object.keys(s.instruments)).toEqual(["1", "2", "3"]);
        expect(s.instruments[3]!.shortTitle).toBe("EUR");
        expect(s.accounts.map((a) => a.id)).toEqual(["eur", "zerro"]);
        expect(s.tags.map((t) => t.id)).toEqual(["food"]);
        expect(s.merchants).toEqual({ m1: { id: "m1", changed: 1, user: 1, title: "Shop" } });
        expect(s.zmBudgets).toHaveLength(1);
        expect(s.transactions.map((t) => t.id)).toEqual([
            "early",
            "tiny-out",
            "first",
            "second",
            "tiny",
            "late",
        ]);
        expect(s.model.budgets).toEqual({ "2026-10": { "tag#food": 1 } });
    });

    test("an unknown user currency falls back to EUR", () => {
        expect(loadState(memoryMirror({ user: [{ ...me, currency: 99 }] })).userFx).toBe("EUR");
        expect(loadState(memoryMirror({ user: [{ ...me, currency: 2 }] })).userFx).toBe("RUB");
    });
});

describe("transaction types and envelopes", () => {
    const debtors = new Map([["bob", { name: "Bob", merchantId: "m-bob" }]]);

    test("trType", () => {
        expect(trType(tx("a", "d", { outcome: 1, incomeAccount: "debt" }), "debt")).toBe(
            "outcomeDebt",
        );
        expect(trType(tx("a", "d", { income: 1, outcomeAccount: "debt" }), "debt")).toBe(
            "incomeDebt",
        );
        expect(trType(tx("a", "d", { income: 1, outcome: 1, incomeAccount: "debt" }))).toBe(
            "transfer",
        );
        expect(trType(tx("a", "d", { outcome: 1 }))).toBe("outcome");
        expect(trType(tx("a", "d", { income: 1 }))).toBe("income");
        expect(trType(tx("a", "d", { income: 1, outcomeAccount: "debt" }), undefined)).toBe(
            "income",
        );
    });

    test("envelopeOf: first category, else no category", () => {
        const m = new Map();
        expect(
            envelopeOf(tx("a", "d", { outcome: 1, tag: ["food", "fun"] }), true, undefined, m),
        ).toBe("tag#food");
        expect(envelopeOf(tx("a", "d", { outcome: 1 }), true, undefined, m)).toBe("tag#null");
        expect(envelopeOf(tx("a", "d", { income: 1, tag: [] }), false, undefined, m)).toBe(
            "tag#null",
        );
    });

    test("envelopeOf: transfers go to the other account", () => {
        const t = tx("a", "d", { outcome: 1, income: 1, outcomeAccount: "x", incomeAccount: "y" });
        expect(envelopeOf(t, true, undefined, new Map())).toBe("account#y");
        expect(envelopeOf(t, false, undefined, new Map())).toBe("account#x");
    });

    test("envelopeOf: debts go to the merchant, or to the payee's debtor", () => {
        const toDebt = { outcome: 1, incomeAccount: "debt" };
        expect(envelopeOf(tx("a", "d", { ...toDebt, merchant: "m1" }), true, "debt", debtors)).toBe(
            "merchant#m1",
        );
        expect(envelopeOf(tx("a", "d", { ...toDebt, payee: "B.o.b" }), true, "debt", debtors)).toBe(
            "merchant#m-bob",
        );
        // Cyrillic on purpose: payee names are mostly Russian
        expect(
            envelopeOf(tx("a", "d", { ...toDebt, payee: "Иван И." }), true, "debt", debtors),
        ).toBe("payee#ивани");
        expect(envelopeOf(tx("a", "d", { ...toDebt }), true, "debt", new Map())).toBe("payee#null");
    });

    test("debtAccountId", () => {
        expect(
            debtAccountId(
                state({ accounts: [account("a", "A"), account("d", "Debt", { type: "debt" })] }),
            ),
        ).toBe("d");
        expect(debtAccountId(state())).toBeUndefined();
    });

    test("getDebtors: from debt transactions only; merchants join payees by clean name", () => {
        const s = state({
            accounts: [account("eur", "Card"), account("debt", "Debts", { type: "debt" })],
            merchants: { "m-bob": { id: "m-bob", changed: 1, user: 1, title: "BOB" } },
            transactions: [
                tx("1", "2026-10-01", { outcome: 1, incomeAccount: "debt", payee: "Bob" }),
                tx("2", "2026-10-02", { income: 1, outcomeAccount: "debt", merchant: "m-bob" }),
                tx("3", "2026-10-03", { outcome: 1, incomeAccount: "debt", payee: "bob!" }),
                tx("4", "2026-10-04", { outcome: 1, incomeAccount: "debt", merchant: "m-gone" }),
                tx("5", "2026-10-05", { outcome: 1, incomeAccount: "debt", payee: "Ann" }),
                tx("6", "2026-10-06", { outcome: 1, incomeAccount: "debt" }),
                tx("7", "2026-10-07", { outcome: 1, payee: "Not a debt" }),
            ],
        });
        expect([...getDebtors(s)]).toEqual([
            ["bob", { name: "Bob", merchantId: "m-bob" }],
            ["mgone", { name: "m-gone", merchantId: "m-gone" }],
            ["ann", { name: "Ann" }],
        ]);
        expect(
            getDebtors(state({ transactions: [tx("1", "d", { outcome: 1, payee: "X" })] })).size,
        ).toBe(0);
    });
});

describe("getEnvelopes", () => {
    const ids = (envs: Record<string, Envelope>) => Object.keys(envs).sort();

    test("categories with the null one, accounts out of the budget, debtors; with Zerro defaults", () => {
        const s = state({
            accounts: [
                account("eur", "Card"),
                account("sav", "Savings", { inBalance: false }),
                account("debt", "Debts", { type: "debt", inBalance: false }),
                dataAcc,
            ],
            merchants: { m: { id: "m", changed: 1, user: 1, title: "Shop" } },
            transactions: [
                tx("1", "2026-10-01", { outcome: 1, incomeAccount: "debt", merchant: "m" }),
                tx("2", "2026-10-01", { outcome: 1, incomeAccount: "debt", payee: "Ann" }),
            ],
        });
        const { byId, groups } = getEnvelopes(s);
        expect(ids(byId)).toEqual([
            "account#sav",
            "merchant#m",
            "payee#ann",
            "tag#cafe",
            "tag#food",
            "tag#fun",
            "tag#null",
            "tag#salary",
        ]);
        expect(byId["tag#null"]).toEqual({
            id: "tag#null",
            type: "tag",
            name: "Uncategorized",
            parent: null,
            children: [],
            indexRaw: undefined,
            index: 0,
            group: "Categories",
            comment: "",
            visibility: "auto",
            currency: "EUR",
            keepIncome: false,
            carryNegatives: false,
        });
        expect(byId["tag#food"]!.visibility).toBe("visible");
        expect(byId["tag#salary"]!.visibility).toBe("auto");
        expect([byId["account#sav"]!.name, byId["account#sav"]!.visibility]).toEqual([
            "Savings",
            "auto",
        ]);
        expect(byId["merchant#m"]!.name).toBe("Shop");
        expect(byId["payee#ann"]!.name).toBe("Ann");
        expect(groups).toEqual([
            { name: "Categories", envelopes: ["tag#null", "tag#salary", "tag#food", "tag#fun"] },
            { name: "Transfers", envelopes: ["account#sav"] },
            { name: "Debts", envelopes: ["merchant#m", "payee#ann"] },
        ]);
        expect(byId["tag#fun"]!.children).toEqual(["tag#cafe"]);
        expect(
            Object.values(byId)
                .map((e) => [e.id, e.index])
                .sort((a, b) => Number(a[1]) - Number(b[1])),
        ).toEqual([
            ["tag#null", 0],
            ["tag#salary", 1],
            ["tag#food", 2],
            ["tag#fun", 3],
            ["tag#cafe", 4],
            ["account#sav", 5],
            ["merchant#m", 6],
            ["payee#ann", 7],
        ]);
    });

    test("settings from EnvelopeMeta", () => {
        const s = state({
            accounts: [account("eur", "Card"), account("sav", "Savings", { inBalance: false })],
            model: {
                envelopeMeta: {
                    "tag#food": {
                        id: "tag#food",
                        group: "Food",
                        index: 1,
                        comment: "c",
                        visibility: "hidden",
                        currency: "RUB",
                        keepIncome: true,
                        carryNegatives: true,
                    },
                    "tag#fun": { id: "tag#fun", index: 0, parent: "tag#food" },
                    "account#sav": { id: "account#sav", parent: "tag#food", group: "X" },
                },
            },
        });
        const { byId, groups } = getEnvelopes(s);
        expect(byId["tag#food"]).toMatchObject({
            indexRaw: 1,
            group: "Food",
            comment: "c",
            visibility: "hidden",
            currency: "RUB",
            keepIncome: true,
            carryNegatives: true,
        });
        expect(byId["tag#fun"]!.parent).toBeNull(); // a tag's parent comes from ZenMoney, not from settings
        expect(byId["account#sav"]).toMatchObject({ parent: "tag#food", group: "Food" }); // follows its parent's group
        expect(groups.map((g) => [g.name, g.envelopes])).toEqual([
            ["Categories", ["tag#fun", "tag#null", "tag#salary"]],
            ["Food", ["tag#food"]],
        ]);
        expect(byId["tag#food"]!.children).toEqual(["account#sav"]);
    });

    test("debtors: merchants before payees, whatever the names and the order they came in", () => {
        const s = state({
            accounts: [account("eur", "Card"), account("debt", "Debts", { type: "debt" })],
            merchants: { m: { id: "m", changed: 1, user: 1, title: "Zed" } },
            transactions: [
                tx("1", "2026-10-01", { outcome: 1, incomeAccount: "debt", payee: "Ann" }),
                tx("2", "2026-10-02", { outcome: 1, incomeAccount: "debt", merchant: "m" }),
            ],
        });
        expect(getEnvelopes(s).groups.at(-1)).toEqual({
            name: "Debts",
            envelopes: ["merchant#m", "payee#ann"],
        });
    });

    test("order: index first, then type, the null category, then name", () => {
        const s = state({
            tags: [tag("b", "Beta"), tag("a", "Alpha"), tag("c", "Gamma")],
            accounts: [account("eur", "Card"), account("sav", "Aaa", { inBalance: false })],
            model: {
                envelopeMeta: {
                    "account#sav": { id: "account#sav", group: "Categories", index: 2 },
                    "tag#c": { id: "tag#c", index: 1 },
                },
            },
        });
        expect(getEnvelopes(s).groups).toEqual([
            {
                name: "Categories",
                envelopes: ["tag#c", "account#sav", "tag#null", "tag#a", "tag#b"],
            },
        ]);
        const typed = state({
            tags: [tag("z", "Zoo")],
            accounts: [account("eur", "Card"), account("sav", "A", { inBalance: false })],
            model: { envelopeMeta: { "account#sav": { id: "account#sav", group: "Categories" } } },
        });
        expect(getEnvelopes(typed).groups[0]!.envelopes).toEqual([
            "tag#null",
            "tag#z",
            "account#sav",
        ]);
    });

    test("structure is flattened to two levels; missing and cyclic parents become top level", () => {
        const s = state({
            tags: [
                tag("top", "Top"),
                tag("mid", "Mid", { parent: "top" }),
                tag("low", "Low", { parent: "mid" }),
                tag("orphan", "Orphan", { parent: "gone" }),
                tag("x", "X", { parent: "y" }),
                tag("y", "Y", { parent: "x" }),
                tag("self", "Self", { parent: "self" }),
            ],
        });
        const { byId, groups } = getEnvelopes(s);
        expect(byId["tag#top"]!.children).toEqual(["tag#low", "tag#mid"]);
        expect([byId["tag#low"]!.parent, byId["tag#mid"]!.parent]).toEqual(["tag#top", "tag#top"]);
        expect([
            byId["tag#orphan"]!.parent,
            byId["tag#x"]!.parent,
            byId["tag#y"]!.parent,
            byId["tag#self"]!.parent,
        ]).toEqual([null, null, null, null]);
        expect(groups[0]!.envelopes).toEqual([
            "tag#null",
            "tag#orphan",
            "tag#self",
            "tag#top",
            "tag#x",
            "tag#y",
        ]);
    });
});

describe("getBudgets", () => {
    const zm = (tagId: string | null, date: string, outcome: number) => ({
        user: 1,
        changed: 1,
        tag: tagId,
        date,
        income: 0,
        incomeLock: true,
        outcome,
        outcomeLock: true,
    });

    test("Zerro's own budgets; zero values dropped", () => {
        const s = state({
            zmBudgets: [zm("food", "2026-10-01", 99), zm("fun", "2026-10-01", 7)],
            model: {
                budgets: {
                    "2026-10": { "tag#food": 400, "tag#fun": 0, "account#sav": 50 },
                    "2026-11": {},
                },
            },
        });
        expect(getBudgets(s)).toEqual({ "2026-10": { "tag#food": 400, "account#sav": 50 } });
    });

    test("preferZmBudgets: categories from ZenMoney budgets, other envelopes from Zerro", () => {
        const s = state({
            zmBudgets: [
                zm("food", "2026-10-01", 99),
                zm(null, "2026-10-01", 5),
                zm("fun", "2026-09-01", 0),
            ],
            model: {
                userSettings: { preferZmBudgets: true },
                budgets: { "2026-10": { "tag#food": 400, "account#sav": 50 } },
            },
        });
        expect(getBudgets(s)).toEqual({
            "2026-10": { "tag#food": 99, "tag#null": 5, "account#sav": 50 },
        });
    });
});
