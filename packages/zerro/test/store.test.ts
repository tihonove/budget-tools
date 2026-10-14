// Zerro's hidden store: reading data reminders and building writes in Zerro's format.
import { describe, expect, test } from "vitest";
import { memoryMirror } from "@tihonove/testing";
import { now } from "@tihonove/zenmoney";
import {
    DATA_ACC_NAME,
    dataAccount,
    dataReminders,
    isMonth,
    mergeDiffs,
    readModel,
    STORES,
    writeData,
} from "@tihonove/zerro";
import { account, dataAcc, reminder } from "./build.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("constants match Zerro", () => {
    expect(DATA_ACC_NAME).toBe("🤖 [Zerro Data]");
    expect(STORES).toEqual({
        budgets: "budgets",
        goals: "goals",
        fxRates: "fxRates",
        envelopeMeta: "EnvelopeMeta",
        userSettings: "UserSettings",
    });
});

test("isMonth", () => {
    expect(isMonth("2026-10")).toBe(true);
    for (const bad of [
        "2026-1",
        "2026-10-01",
        "x2026-10",
        "2026-10x",
        202610,
        undefined,
        ["2026-10"],
    ]) {
        expect(isMonth(bad)).toBe(false);
    }
});

describe("reading", () => {
    test("dataAccount: found by title, or null", () => {
        expect(dataAccount(memoryMirror({ account: [account("a", "Card"), dataAcc] }))!.id).toBe(
            "zerro",
        );
        expect(dataAccount(memoryMirror())).toBeNull();
    });

    test("dataReminders: comments with a type; monthly stores need a valid month", () => {
        const con = memoryMirror({
            reminder: [
                reminder("budgets", { type: "budgets", month: "2026-10", payload: { a: 1 } }),
                reminder("no-month", { type: "goals", payload: {} }),
                reminder("bad-month", { type: "fxRates", month: "2026-1", payload: {} }),
                reminder("meta", { type: "EnvelopeMeta", payload: {} }),
                reminder("no-type", { month: "2026-10" }),
                reminder("array", [1]),
                reminder("number", "5"),
                reminder("null-json", "null"),
                reminder("text", "plain reminder"),
                reminder("none", null as never, { comment: null }),
            ],
        });
        const found = dataReminders(con);
        expect(found.map((d) => d.reminder.id)).toEqual(["budgets", "meta"]);
        expect(found[0]).toMatchObject({ type: "budgets", month: "2026-10", payload: { a: 1 } });
    });

    test("readModel: every store, empty payloads as {}, others kept as is", () => {
        const con = memoryMirror({
            account: [dataAcc],
            reminder: [
                reminder("r1", { type: "budgets", month: "2026-10", payload: { "tag#food": 400 } }),
                reminder("r2", { type: "budgets", month: "2026-11" }),
                reminder("r3", { type: "goals", month: "2026-10", payload: { "tag#food": null } }),
                reminder("r4", {
                    type: "fxRates",
                    month: "2026-09",
                    payload: { rates: { EUR: 110 } },
                }),
                reminder("r5", {
                    type: "EnvelopeMeta",
                    payload: { "tag#food": { id: "tag#food" } },
                }),
                reminder("r6", { type: "UserSettings", payload: { preferZmBudgets: true } }),
                reminder("r7", { type: "tagOrder", payload: ["a"] }),
                reminder("r8", { type: "linkedAccounts" }),
            ],
        });
        expect(readModel(con)).toEqual({
            dataAccount: dataAcc,
            budgets: { "2026-10": { "tag#food": 400 }, "2026-11": {} },
            goals: { "2026-10": { "tag#food": null } },
            fxRates: { "2026-09": { rates: { EUR: 110 } } },
            envelopeMeta: { "tag#food": { id: "tag#food" } },
            userSettings: { preferZmBudgets: true },
            other: { tagOrder: ["a"], linkedAccounts: undefined },
        });
    });

    test("readModel of a mirror without Zerro data", () => {
        expect(readModel(memoryMirror())).toEqual({
            dataAccount: null,
            budgets: {},
            goals: {},
            fxRates: {},
            envelopeMeta: {},
            userSettings: {},
            other: {},
        });
    });
});

describe("writeData", () => {
    test("first write: the helper account and a reminder in Zerro's format", () => {
        const before = now();
        const diff = writeData(memoryMirror(), "budgets", { "tag#food": 400 }, "2026-10");
        const [acc] = diff.account!;
        const [rem] = diff.reminder!;
        expect(acc!.id).toMatch(UUID);
        expect(acc!.changed).toBeGreaterThanOrEqual(before);
        expect(acc).toEqual({
            id: acc!.id,
            changed: acc!.changed,
            user: 1,
            instrument: 3,
            title: DATA_ACC_NAME,
            role: null,
            company: null,
            type: "cash",
            syncID: null,
            balance: 0,
            startBalance: 0,
            creditLimit: 0,
            inBalance: false,
            savings: false,
            enableCorrection: false,
            enableSMS: false,
            archive: false,
            private: false,
            capitalization: null,
            percent: null,
            startDate: null,
            endDateOffset: null,
            endDateOffsetInterval: null,
            payoffStep: null,
            payoffInterval: null,
        });
        expect(rem!.id).toMatch(UUID);
        expect(rem!.changed).toBeGreaterThanOrEqual(before);
        expect(rem).toEqual({
            id: rem!.id,
            changed: rem!.changed,
            user: 1,
            incomeAccount: acc!.id,
            outcomeAccount: acc!.id,
            incomeInstrument: 3,
            outcomeInstrument: 3,
            income: 1,
            outcome: 0,
            tag: null,
            merchant: null,
            payee: null,
            comment: '{"type":"budgets","month":"2026-10","payload":{"tag#food":400}}',
            interval: null,
            step: 0,
            points: [0],
            startDate: "2020-01-01",
            endDate: "2020-01-01",
            notify: false,
        });
        expect(Object.keys(diff)).toEqual(["account", "reminder"]);
    });

    test("updates the reminder of that month in place, keeping its own fields", () => {
        const existing = reminder(
            "r1",
            { type: "budgets", month: "2026-10", payload: { "tag#food": 400 } },
            {
                user: 7,
                incomeAccount: "elsewhere",
                incomeInstrument: 2,
                outcomeInstrument: 1,
                interval: "day",
            },
        );
        const con = memoryMirror({
            account: [dataAcc],
            reminder: [{ ...existing, extra: "kept" } as never],
        });

        const diff = writeData(con, "budgets", { "tag#food": 450 }, "2026-10");
        expect(diff.account).toBeUndefined();
        expect(diff.reminder![0]).toMatchObject({
            id: "r1",
            user: 7,
            incomeAccount: "elsewhere",
            outcomeAccount: "elsewhere",
            incomeInstrument: 2,
            outcomeInstrument: 1,
            interval: null,
            extra: "kept",
            comment: '{"type":"budgets","month":"2026-10","payload":{"tag#food":450}}',
        });

        const other = writeData(con, "budgets", { "tag#food": 1 }, "2026-11");
        expect(other.reminder![0]!.id).not.toBe("r1");
        expect(other.reminder![0]!.incomeAccount).toBe("zerro");
    });

    test("another store of the same month is never taken for this one", () => {
        const goals = reminder("goals", { type: "goals", month: "2026-10", payload: { a: null } });
        const budgets = reminder("budgets", {
            type: "budgets",
            month: "2026-10",
            payload: { a: 1 },
        });
        expect(
            writeData(
                memoryMirror({ account: [dataAcc], reminder: [goals, budgets] }),
                "budgets",
                { a: 2 },
                "2026-10",
            ).reminder![0]!.id,
        ).toBe("budgets");
        expect(
            writeData(
                memoryMirror({ account: [dataAcc], reminder: [goals] }),
                "budgets",
                { a: 2 },
                "2026-10",
            ).reminder![0]!.id,
        ).not.toBe("goals");
    });

    test("simple stores have no month and are found without one", () => {
        const con = memoryMirror({
            account: [dataAcc],
            reminder: [
                reminder("old-month", { type: "EnvelopeMeta", month: "2026-10", payload: {} }),
                reminder("meta", { type: "EnvelopeMeta", payload: {} }),
            ],
        });
        const diff = writeData(con, "EnvelopeMeta", { "tag#food": { id: "tag#food" } });
        expect(diff.reminder![0]!.id).toBe("meta");
        expect(diff.reminder![0]!.comment).toBe(
            '{"type":"EnvelopeMeta","payload":{"tag#food":{"id":"tag#food"}}}',
        );
        expect(writeData(con, "UserSettings", {}).reminder![0]!.comment).toBe(
            '{"type":"UserSettings","payload":{}}',
        );
    });

    test("an empty monthly payload deletes that month's reminder", () => {
        const con = memoryMirror({
            account: [dataAcc],
            reminder: [reminder("r1", { type: "goals", month: "2026-10", payload: { a: null } })],
        });
        expect(
            writeData(con, "goals", {}, "2026-10").deletion!.map((d) => [d.id, d.object]),
        ).toEqual([["r1", "reminder"]]);
        expect(writeData(con, "goals", null, "2026-10").deletion).toHaveLength(1);
        expect(writeData(con, "goals", undefined, "2026-12")).toEqual({});
    });

    test("monthly stores need a month", () => {
        expect(() => writeData(memoryMirror(), "fxRates", { x: 1 })).toThrow(
            "month required for fxRates, got 'undefined'",
        );
        expect(() => writeData(memoryMirror(), "budgets", { x: 1 }, "2026")).toThrow(
            "month required for budgets, got '2026'",
        );
    });
});

test("mergeDiffs: the helper account once, reminders and deletions concatenated", () => {
    const a = account("a1", DATA_ACC_NAME);
    const b = account("a2", DATA_ACC_NAME);
    const r = (id: string) => reminder(id, {});
    const del = (id: string) => ({ id, object: "reminder" as const, stamp: 1, user: 1 });
    expect(
        mergeDiffs(
            { reminder: [r("1")] },
            { account: [a], reminder: [r("2")] },
            { account: [b], deletion: [del("x")] },
            { deletion: [del("y")] },
        ),
    ).toEqual({ account: [a], reminder: [r("1"), r("2")], deletion: [del("x"), del("y")] });
    expect(mergeDiffs()).toEqual({});
});
