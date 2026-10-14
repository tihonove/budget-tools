import { describe, expect, test } from "vitest";
import { fixture, memoryMirror } from "@tihonove/testing";
import {
    load,
    newAccount,
    newTag,
    newTransaction,
    now,
    softDeleteTransactions,
    toTransfers,
    updateAccount,
    updateTag,
    updateTransactions,
    ZmError,
} from "@tihonove/zenmoney";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newTransaction", () => {
    const base = { account: "Revolut €", amount: 12.5, date: "2026-10-05" };

    test("expense: every field of a fresh transaction", () => {
        const before = now();
        const tx = newTransaction(memoryMirror(), {
            ...base,
            tag: ["Groceries"],
            payee: "Lidl",
            comment: "c",
        });
        expect(tx.id).toMatch(UUID);
        expect(tx.created).toBeGreaterThanOrEqual(before);
        expect(tx).toEqual({
            id: tx.id,
            changed: tx.created,
            created: tx.created,
            user: 1,
            deleted: false,
            hold: null,
            viewed: false,
            qrCode: null,
            incomeInstrument: 3,
            incomeAccount: "acc-rev",
            income: 0,
            incomeBankID: null,
            outcomeInstrument: 3,
            outcomeAccount: "acc-rev",
            outcome: 12.5,
            outcomeBankID: null,
            opIncome: null,
            opIncomeInstrument: null,
            opOutcome: null,
            opOutcomeInstrument: null,
            tag: ["tag-food"],
            merchant: null,
            payee: "Lidl",
            originalPayee: null,
            comment: "c",
            date: "2026-10-05",
            mcc: null,
            latitude: null,
            longitude: null,
            reminderMarker: null,
        });
    });

    test("defaults: expense, no tags, no payee or comment; string amounts", () => {
        const tx = newTransaction(memoryMirror(), { ...base, amount: "3", tag: [] });
        expect([tx.outcome, tx.income, tx.tag, tx.payee, tx.comment]).toEqual([
            3,
            0,
            null,
            null,
            null,
        ]);
    });

    test("income", () => {
        const tx = newTransaction(memoryMirror(), { ...base, kind: "income" });
        expect([tx.income, tx.outcome]).toEqual([12.5, 0]);
    });

    test("transfer, same amount or a received amount in another currency", () => {
        const con = memoryMirror();
        const same = newTransaction(con, {
            ...base,
            kind: "transfer",
            to_account: "Revolut Savings",
        });
        expect([
            same.outcomeAccount,
            same.outcome,
            same.incomeAccount,
            same.income,
            same.incomeInstrument,
        ]).toEqual(["acc-rev", 12.5, "acc-sav", 12.5, 3]);
        const fx = newTransaction(con, {
            ...base,
            account: "Black",
            kind: "transfer",
            to_account: "Revolut €",
            to_amount: "1.5",
        });
        expect([fx.outcomeInstrument, fx.incomeInstrument, fx.income]).toEqual([2, 3, 1.5]);
    });

    test("validation", () => {
        const con = memoryMirror();
        const missing = new ZmError("transaction needs account, amount, date");
        expect(() => newTransaction(con, { ...base, account: "" })).toThrow(missing);
        expect(() => newTransaction(con, { ...base, amount: undefined as never })).toThrow(missing);
        expect(() => newTransaction(con, { ...base, date: "" })).toThrow(missing);
        expect(newTransaction(con, { ...base, amount: 0 }).outcome).toBe(0);
        expect(() => newTransaction(con, { ...base, date: "05.10.2026" })).toThrow(
            new ZmError("bad date '05.10.2026', want YYYY-MM-DD"),
        );
        expect(() => newTransaction(con, { ...base, date: "x2026-10-05" })).toThrow(/bad date/);
        expect(() => newTransaction(con, { ...base, date: "2026-10-05x" })).toThrow(/bad date/);
        expect(() => newTransaction(con, { ...base, kind: "transfer" })).toThrow(
            new ZmError("transfer needs --to-account"),
        );
        expect(() => newTransaction(con, { ...base, kind: "gift" })).toThrow(
            new ZmError("bad kind 'gift'"),
        );
    });
});

describe("updateTransactions", () => {
    test("patches fields and bumps changed; untouched fields stay", () => {
        const con = memoryMirror();
        const [tx] = updateTransactions(con, ["tx-food"], {
            tag: ["Dining", ""],
            comment: "x",
            date: "2026-10-09",
        });
        const original = load(con, "transaction", "tx-food")!;
        expect(tx).toEqual({
            ...original,
            tag: ["tag-cafe"],
            comment: "x",
            date: "2026-10-09",
            changed: tx!.changed,
        });
        expect(tx!.changed).toBeGreaterThan(1);
    });

    test("an empty patch changes nothing but the time", () => {
        const con = memoryMirror();
        con.prepare(
            "UPDATE \"transaction\" SET json = json_set(json, '$.comment', 'keep') WHERE id = 'tx-food'",
        ).run();
        const original = load(con, "transaction", "tx-food")!;
        const [tx] = updateTransactions(con, ["tx-food"], {});
        expect(tx).toEqual({ ...original, changed: tx!.changed });
    });

    test("empty strings clear payee, comment and tags", () => {
        const [tx] = updateTransactions(memoryMirror(), ["tx-food"], {
            tag: [""],
            payee: "",
            comment: "",
        });
        expect([tx!.tag, tx!.payee, tx!.comment]).toEqual([null, null, null]);
    });

    test("amount goes to whichever side is used", () => {
        const con = memoryMirror();
        const [expense, income, transfer] = updateTransactions(
            con,
            ["tx-food", "tx-salary", "tx-save"],
            { amount: 7 },
        );
        expect([expense!.outcome, expense!.income]).toEqual([7, 0]);
        expect([income!.outcome, income!.income]).toEqual([0, 7]);
        expect([transfer!.outcome, transfer!.income]).toEqual([7, 7]);
    });

    test("moving to another account; not for transfers", () => {
        const con = memoryMirror();
        const [tx] = updateTransactions(con, ["tx-food"], { account: "Black" });
        expect([
            tx!.outcomeAccount,
            tx!.incomeAccount,
            tx!.outcomeInstrument,
            tx!.incomeInstrument,
        ]).toEqual(["acc-black", "acc-black", 2, 2]);
        expect(() => updateTransactions(con, ["tx-save"], { account: "Black" })).toThrow(
            new ZmError("for transfers edit the JSON and use `zm push`"),
        );
    });

    test("unknown id", () => {
        expect(() => updateTransactions(memoryMirror(), ["nope"], {})).toThrow(
            new ZmError("not found nope"),
        );
    });
});

describe("toTransfers", () => {
    test("expense → transfer out, income → transfer in", () => {
        const [out, into] = toTransfers(
            memoryMirror(),
            ["tx-food", "tx-salary"],
            "Revolut Savings",
        );
        expect([
            out!.outcomeAccount,
            out!.incomeAccount,
            out!.income,
            out!.incomeInstrument,
        ]).toEqual(["acc-rev", "acc-sav", 12.5, 3]);
        expect([
            into!.outcomeAccount,
            into!.outcome,
            into!.incomeAccount,
            into!.outcomeInstrument,
        ]).toEqual(["acc-sav", 1000, "acc-rev", 3]);
        expect(out!.changed).toBeGreaterThan(1);
    });

    test("already a transfer; different currencies", () => {
        const con = memoryMirror();
        expect(() => toTransfers(con, ["tx-save"], "Black")).toThrow(
            new ZmError("tx-save is already a transfer"),
        );
        expect(() => toTransfers(con, ["tx-food"], "Black")).toThrow(
            new ZmError("tx-food: currencies differ, use zm push"),
        );
    });
});

test("softDeleteTransactions", () => {
    const [tx] = softDeleteTransactions(memoryMirror(), ["tx-food"]);
    expect([tx!.id, tx!.deleted, tx!.outcome]).toEqual(["tx-food", true, 12.5]);
    expect(tx!.changed).toBeGreaterThan(1);
});

describe("tags", () => {
    test("newTag: all fields; flags default to true", () => {
        const tag = newTag(memoryMirror(), { title: "Movies", parent: "Hobbies" });
        expect(tag.id).toMatch(UUID);
        expect(tag).toEqual({
            id: tag.id,
            changed: tag.changed,
            user: 1,
            title: "Movies",
            parent: "tag-fun",
            icon: null,
            picture: null,
            color: null,
            showIncome: true,
            showOutcome: true,
            budgetIncome: true,
            budgetOutcome: true,
            required: null,
            staticId: null,
        });
        const flat = newTag(memoryMirror(), { title: "X", income: false, outcome: false });
        expect([
            flat.parent,
            flat.showIncome,
            flat.budgetIncome,
            flat.showOutcome,
            flat.budgetOutcome,
        ]).toEqual([null, false, false, false, false]);
    });

    test("updateTag", () => {
        const con = memoryMirror();
        const renamed = updateTag(con, "Groceries", {
            title: "Food",
            parent: "Hobbies",
            income: false,
            outcome: false,
        });
        expect([
            renamed.title,
            renamed.parent,
            renamed.showIncome,
            renamed.budgetIncome,
            renamed.showOutcome,
            renamed.budgetOutcome,
        ]).toEqual(["Food", "tag-fun", false, false, false, false]);
        expect(renamed.changed).toBeGreaterThan(1);
        expect(updateTag(con, "Dining", { parent: "" }).parent).toBeNull();
        const same = updateTag(con, "Dining", {});
        expect([same.title, same.parent, same.showIncome, same.showOutcome]).toEqual([
            "Dining",
            "tag-fun",
            true,
            true,
        ]);
    });
});

describe("accounts", () => {
    test("newAccount: all fields, credit card start balance is 0", () => {
        const acc = newAccount(memoryMirror(), { title: "Card", currency: "EUR", balance: 50 });
        expect(acc.id).toMatch(UUID);
        expect(acc).toEqual({
            id: acc.id,
            changed: acc.changed,
            user: 1,
            role: null,
            instrument: 3,
            company: null,
            type: "ccard",
            title: "Card",
            syncID: null,
            balance: 50,
            startBalance: 0,
            creditLimit: 0,
            inBalance: true,
            savings: false,
            enableCorrection: true,
            balanceCorrectionType: "request",
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
    });

    test("newAccount: other types keep the start balance; options", () => {
        const acc = newAccount(memoryMirror(), {
            title: "Cash",
            type: "cash",
            currency: "RUB",
            balance: 10,
            in_balance: false,
            savings: true,
            credit_limit: 5,
        });
        expect([
            acc.type,
            acc.instrument,
            acc.startBalance,
            acc.inBalance,
            acc.savings,
            acc.creditLimit,
        ]).toEqual(["cash", 2, 10, false, true, 5]);
        expect(
            newAccount(memoryMirror(), { title: "Z", type: "cash", currency: "EUR" }).balance,
        ).toBe(0);
        expect(() =>
            newAccount(memoryMirror(), { title: "X", type: "wallet", currency: "EUR" }),
        ).toThrow(
            new ZmError(
                "bad type 'wallet', one of cash, ccard, checking, loan, deposit, emoney, debt",
            ),
        );
    });

    test("updateAccount: balance shifts startBalance by the delta", () => {
        const con = memoryMirror();
        const acc = updateAccount(con, "Revolut €", {
            title: "Rev",
            balance: 900,
            archive: true,
            in_balance: false,
            savings: true,
        });
        expect([
            acc.title,
            acc.balance,
            acc.startBalance,
            acc.archive,
            acc.inBalance,
            acc.savings,
        ]).toEqual(["Rev", 900, 12.5, true, false, true]);
        expect(acc.changed).toBeGreaterThan(1);
        const same = updateAccount(con, "Black", {});
        const original = fixture("account.json").account!.find((a) => a.id === "acc-black")!;
        expect(same).toEqual({ ...original, changed: same.changed });
    });

    test("updateAccount: missing balances count as 0", () => {
        const base = fixture("account.json").account![0]!;
        const con = memoryMirror({
            account: [{ ...base, balance: undefined as never, startBalance: undefined as never }],
        });
        expect(updateAccount(con, base.id, { balance: 5 })).toMatchObject({
            balance: 5,
            startBalance: 5,
        });
    });
});
