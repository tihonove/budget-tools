import { describe, expect, onTestFinished, test } from "vitest";
import { connect, fixture, syncedSandbox, type Sandbox, type TestClient } from "@tihonove/testing";
import { makeSession } from "@tihonove/mcp-kit";
import { createZenmoneyServer, INSTRUCTIONS } from "@tihonove/mcp-zenmoney";
import { load, type Diff } from "@tihonove/zenmoney";

/** A client on a synced sandbox. The first tool call syncs again: queue its answer in `more`. */
async function setup(more: Diff[] = []): Promise<{ sb: Sandbox; mcp: TestClient }> {
    const sb = await syncedSandbox([{}, ...more]);
    const mcp = await connect(
        createZenmoneyServer(makeSession({ con: sb.db(), remote: sb.remote })),
    );
    onTestFinished(async () => {
        await mcp.close();
        await sb.close();
    });
    return { sb, mcp };
}

const sent = (sb: Sandbox, i: number) => sb.api.requests[i]!.body;

describe("server", () => {
    test("name, instructions, tools with annotations", async () => {
        const { mcp } = await setup();
        expect(mcp.client.getServerVersion()).toEqual({ name: "zenmoney", version: "0.1.0" });
        expect(mcp.client.getInstructions()).toBe(INSTRUCTIONS);
        const { tools } = await mcp.client.listTools();
        expect(tools).toMatchSnapshot();
    });
});

describe("reading", () => {
    test("accounts: active, or all", async () => {
        const { mcp } = await setup();
        const active = (await mcp.call("accounts")).value as { title: string }[];
        expect(active.map((a) => a.title)).toEqual(["Black", "Revolut €", "Revolut Savings"]);
        const every = (await mcp.call("accounts", { include_archived: true })).value as {
            title: string;
        }[];
        expect(every.map((a) => a.title)).toEqual([
            "Black",
            "Revolut €",
            "Revolut Savings",
            "Old card",
        ]);
        expect(active[0]).toEqual({
            id: "acc-black",
            title: "Black",
            type: "ccard",
            currency: "RUB",
            balance: 50000,
            in_balance: 1,
            savings: 0,
            archive: 0,
        });
    });

    test("categories", async () => {
        const { mcp } = await setup();
        expect((await mcp.call("categories")).value).toEqual([
            {
                id: "tag-salary",
                title: "Bonus",
                parent: null,
                parent_title: null,
                show_income: 1,
                show_outcome: 1,
            },
            {
                id: "tag-food",
                title: "Groceries",
                parent: null,
                parent_title: null,
                show_income: 1,
                show_outcome: 1,
            },
            {
                id: "tag-fun",
                title: "Hobbies",
                parent: null,
                parent_title: null,
                show_income: 1,
                show_outcome: 1,
            },
            {
                id: "tag-cafe",
                title: "Dining",
                parent: "tag-fun",
                parent_title: "Hobbies",
                show_income: 1,
                show_outcome: 1,
            },
        ]);
    });

    test("transactions: filters and limit", async () => {
        const { sb, mcp } = await setup();
        sb.db().exec(
            `UPDATE "transaction" SET json = json_set(json, '$.comment', 'a note') WHERE id = 'tx-salary'`,
        );
        const ids = async (args: Record<string, unknown> = {}) =>
            ((await mcp.call("transactions", args)).value as { id: string }[]).map((t) => t.id);

        expect(await ids()).toEqual(["tx-cafe", "tx-save", "tx-salary", "tx-food"]);
        expect(await ids({ include_deleted: true })).toEqual([
            "tx-gone",
            "tx-cafe",
            "tx-save",
            "tx-salary",
            "tx-food",
        ]);
        expect(await ids({ limit: 1 })).toEqual(["tx-cafe"]);
        expect(await ids({ since: "2026-10-02" })).toEqual(["tx-cafe", "tx-save"]);
        expect(await ids({ until: "2026-10-01" })).toEqual(["tx-salary", "tx-food"]);
        expect(await ids({ account: "Revolut Savings" })).toEqual(["tx-save"]);
        expect(await ids({ category: "Din" })).toEqual(["tx-cafe"]);
        expect(await ids({ text: "heijn" })).toEqual(["tx-food"]);
        expect(await ids({ text: "note" })).toEqual(["tx-salary"]);
        expect(await ids({ kind: "income" })).toEqual(["tx-salary"]);

        const [cafe] = (await mcp.call("transactions", { limit: 1 })).value as Record<
            string,
            unknown
        >[];
        expect(cafe).toEqual({
            id: "tx-cafe",
            date: "2026-10-03",
            kind: "expense",
            outcome: 7,
            outcome_currency: "EUR",
            outcome_account: "Revolut €",
            income: 0,
            income_currency: "EUR",
            income_account: "Revolut €",
            tags: "Dining",
            payee: "Coffee",
            comment: null,
            deleted: 0,
        });
    });

    test("transactions: 100 by default", async () => {
        const { sb, mcp } = await setup();
        const insert = sb.db().prepare(`INSERT INTO "transaction" VALUES (?, 1, ?)`);
        const base = fixture("account.json").transaction![0]!;
        for (let i = 0; i < 120; i++) insert.run(`x${i}`, JSON.stringify({ ...base, id: `x${i}` }));
        expect(((await mcp.call("transactions")).value as unknown[]).length).toBe(100);
    });

    test("bad arguments are rejected by the schema", async () => {
        const { mcp } = await setup();
        const r = await mcp.call("transactions", { since: "01.10.2026" });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/YYYY-MM-DD/);
    });

    test("one transaction, or an error for an unknown id", async () => {
        const { mcp } = await setup();
        expect((await mcp.call("transaction", { id: "tx-food" })).value).toEqual(
            fixture("account.json").transaction![0],
        );
        expect(await mcp.call("transaction", { id: "nope" })).toEqual({
            isError: true,
            value: "transaction not found: nope",
            text: "transaction not found: nope",
        });
    });

    test("query: read-only SQL; the mirror is writable again afterwards", async () => {
        const { sb, mcp } = await setup([{}]);
        expect((await mcp.call("query", { sql: "SELECT count(*) n FROM tag" })).value).toEqual([
            { n: 4 },
        ]);
        const write = await mcp.call("query", { sql: "DELETE FROM tag" });
        expect(write.isError).toBe(true);
        expect(write.text).toBe("SQL: attempt to write a readonly database");
        expect((await mcp.call("query", { sql: "SELEKT" })).text).toMatch(/^SQL: near "SELEKT"/);
        expect((await mcp.call("query", { sql: "SELECT count(*) n FROM tag" })).value).toEqual([
            { n: 4 },
        ]);
        expect((await mcp.call("add_category", { title: "after a query" })).isError).toBe(false);
        expect(sb.db().prepare("SELECT count(*) n FROM tag").get()).toEqual({ n: 5 });
    });

    test("sync on demand reports what came", async () => {
        const { sb, mcp } = await setup([{ tag: fixture("account.json").tag }]);
        expect((await mcp.call("sync")).value).toEqual({ received: { tag: 4 } });
        expect(sb.api.requests.length).toBe(2);
    });

    test("the first call syncs the session", async () => {
        const { sb, mcp } = await setup();
        await mcp.call("categories");
        expect(sb.api.requests.length).toBe(1);
    });
});

describe("writing", () => {
    test("add_transaction sends it and returns it with the server's answer", async () => {
        const { sb, mcp } = await setup([{}]);
        const r = (
            await mcp.call("add_transaction", {
                kind: "transfer",
                account: "Black",
                amount: 9000,
                date: "2026-10-05",
                to_account: "Revolut €",
                to_amount: 100,
                categories: ["Dining"],
                payee: "P",
                comment: "C",
            })
        ).value as { transaction: Record<string, unknown>; server: unknown };
        expect(r.server).toEqual({});
        expect([
            r.transaction.outcomeAccount,
            r.transaction.income,
            r.transaction.tag,
            r.transaction.payee,
            r.transaction.comment,
        ]).toEqual(["acc-black", 100, ["tag-cafe"], "P", "C"]);
        expect(sent(sb, 1).transaction).toEqual([r.transaction]);
        expect(load(sb.db(), "transaction", r.transaction.id as string)).toEqual(r.transaction);
    });

    test("errors from the library come back as tool errors", async () => {
        const { mcp } = await setup();
        expect(
            await mcp.call("add_transaction", {
                kind: "expense",
                account: "Nope",
                amount: 1,
                date: "2026-10-05",
            }),
        ).toMatchObject({
            isError: true,
            text: "account not found: 'Nope'",
        });
    });

    test("update_transactions", async () => {
        const { sb, mcp } = await setup([{}]);
        const r = (
            await mcp.call("update_transactions", {
                ids: ["tx-food", "tx-cafe"],
                categories: ["Groceries"],
                payee: "",
                comment: "c",
                date: "2026-10-09",
                amount: 5,
            })
        ).value as { transactions: Record<string, unknown>[] };
        expect(
            r.transactions.map((t) => [t.id, t.tag, t.payee, t.comment, t.date, t.outcome]),
        ).toEqual([
            ["tx-food", ["tag-food"], null, "c", "2026-10-09", 5],
            ["tx-cafe", ["tag-food"], null, "c", "2026-10-09", 5],
        ]);
        expect((sent(sb, 1).transaction as unknown[]).length).toBe(2);
    });

    test("update_transactions: move to another account; categories [] clears", async () => {
        const { mcp } = await setup([{}, {}]);
        const moved = (
            await mcp.call("update_transactions", { ids: ["tx-food"], account: "Black" })
        ).value as {
            transactions: Record<string, unknown>[];
        };
        expect(moved.transactions[0]!.outcomeAccount).toBe("acc-black");
        const cleared = (
            await mcp.call("update_transactions", { ids: ["tx-food"], categories: [] })
        ).value as {
            transactions: Record<string, unknown>[];
        };
        expect(cleared.transactions[0]!.tag).toBeNull();
    });

    test("convert_to_transfers", async () => {
        const { sb, mcp } = await setup([{}]);
        const r = (
            await mcp.call("convert_to_transfers", { ids: ["tx-food"], account: "Revolut Savings" })
        ).value as {
            transactions: Record<string, unknown>[];
        };
        expect([r.transactions[0]!.incomeAccount, r.transactions[0]!.income]).toEqual([
            "acc-sav",
            12.5,
        ]);
        expect(sent(sb, 1).transaction).toEqual(r.transactions);
    });

    test("delete_transactions marks them deleted", async () => {
        const { sb, mcp } = await setup([{}]);
        expect((await mcp.call("delete_transactions", { ids: ["tx-food"] })).value).toEqual({
            deleted: ["tx-food"],
            server: {},
        });
        expect((sent(sb, 1).transaction as { deleted: boolean }[])[0]!.deleted).toBe(true);
        expect(sent(sb, 1).deletion).toBeUndefined();
    });

    test("add_category / update_category", async () => {
        const { sb, mcp } = await setup([{}, {}]);
        const added = (
            await mcp.call("add_category", { title: "Movies", parent: "Hobbies", income: false })
        ).value as {
            category: Record<string, unknown>;
        };
        expect([
            added.category.title,
            added.category.parent,
            added.category.showIncome,
            added.category.showOutcome,
        ]).toEqual(["Movies", "tag-fun", false, true]);
        expect(sent(sb, 1).tag).toEqual([added.category]);

        const updated = (
            await mcp.call("update_category", {
                category: "Dining",
                title: "Coffee",
                parent: "",
                outcome: false,
            })
        ).value as {
            category: Record<string, unknown>;
        };
        expect([
            updated.category.title,
            updated.category.parent,
            updated.category.showOutcome,
        ]).toEqual(["Coffee", null, false]);
        expect(sent(sb, 2).tag).toEqual([updated.category]);
    });

    test("add_account / update_account", async () => {
        const { sb, mcp } = await setup([{}, {}]);
        const added = (
            await mcp.call("add_account", {
                title: "Cash",
                currency: "EUR",
                type: "cash",
                balance: 10,
                in_balance: false,
                savings: true,
            })
        ).value as { account: Record<string, unknown> };
        expect([
            added.account.title,
            added.account.type,
            added.account.balance,
            added.account.inBalance,
            added.account.savings,
        ]).toEqual(["Cash", "cash", 10, false, true]);
        expect(sent(sb, 1).account).toEqual([added.account]);

        const updated = (
            await mcp.call("update_account", {
                account: "Black",
                title: "T",
                balance: 1,
                archive: true,
            })
        ).value as {
            account: Record<string, unknown>;
        };
        expect([updated.account.title, updated.account.balance, updated.account.archive]).toEqual([
            "T",
            1,
            true,
        ]);
        expect(sent(sb, 2).account).toEqual([updated.account]);
    });
});
