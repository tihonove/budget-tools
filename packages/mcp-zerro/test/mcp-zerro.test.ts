import { describe, expect, onTestFinished, test } from "vitest";
import {
    connect,
    echoPushed,
    fixture,
    sandbox,
    type Response,
    type Sandbox,
    type TestClient,
} from "@tihonove/testing";
import { makeSession } from "@tihonove/mcp-kit";
import { createZerroServer, INSTRUCTIONS } from "@tihonove/mcp-zerro";
import { getEnvelopes, loadState, monthReportFor, readModel } from "@tihonove/zerro";
import { account, dataAcc, reminder } from "../../zerro/test/build.ts";

const TODAY = "2026-10-13";

/**
 * A client on a sandbox with Zerro data. The session's first call syncs (an empty answer is queued);
 * `responses` answer what comes after: for a write — sync, push, then the server copy check.
 */
async function setup(responses: Response[] = []): Promise<{ sb: Sandbox; mcp: TestClient }> {
    const data = fixture("account.json");
    const sb = await sandbox([
        {
            ...data,
            account: [...data.account!, dataAcc, account("sav", "Deposit", { inBalance: false })],
            reminder: [
                reminder("b", {
                    type: "budgets",
                    month: "2026-10",
                    payload: { "tag#tag-food": 400 },
                }),
                reminder("g", {
                    type: "goals",
                    month: "2026-10",
                    payload: { "tag#tag-food": { type: "monthly", amount: 500 } },
                }),
                reminder("m", {
                    type: "EnvelopeMeta",
                    payload: { "tag#tag-food": { id: "tag#tag-food", group: "Food" } },
                }),
            ],
        },
        {},
        ...responses,
    ]);
    await sb.zm("sync");
    const mcp = await connect(
        createZerroServer(makeSession({ con: sb.db(), remote: sb.remote }), { today: () => TODAY }),
    );
    onTestFinished(async () => {
        await mcp.close();
        await sb.close();
    });
    return { sb, mcp };
}

/** Answers for one write: sync, push, and the server copy echoing what was pushed. */
const write = (): Response[] => [{}, {}, echoPushed({ account: [dataAcc] })];

describe("server", () => {
    test("name, instructions, tools with annotations", async () => {
        const { mcp } = await setup();
        expect(mcp.client.getServerVersion()).toEqual({ name: "zerro", version: "0.1.0" });
        expect(mcp.client.getInstructions()).toBe(INSTRUCTIONS);
        expect((await mcp.client.listTools()).tools).toMatchSnapshot();
    });

    test("the real date by default", async () => {
        const sb = await sandbox([fixture("account.json")]);
        onTestFinished(() => sb.close());
        await sb.zm("sync");
        const mcp = await connect(
            createZerroServer(makeSession({ con: sb.db(), remote: sb.remote })),
        );
        onTestFinished(() => mcp.close());
        const report = (await mcp.call("month")).value as { summary: { month: string } };
        expect(report.summary.month).toBe(new Date().toISOString().slice(0, 7));
    });
});

describe("reading", () => {
    test("month: this month by default, as monthReportFor builds it", async () => {
        const { sb, mcp } = await setup();
        expect((await mcp.call("month")).value).toEqual(
            monthReportFor(sb.db(), "2026-10", { today: TODAY }),
        );
        expect((await mcp.call("month", { month: "2026-10", all: true })).value).toEqual(
            monthReportFor(sb.db(), "2026-10", { all: true, today: TODAY }),
        );
        const food = (
            (await mcp.call("month")).value as {
                envelopes: { id: string; goalNeed: number | null }[];
            }
        ).envelopes.find((e) => e.id === "tag#tag-food");
        expect(food!.goalNeed).toBe(100);
    });

    test("month: no data, or a bad month", async () => {
        const { mcp } = await setup();
        expect(await mcp.call("month", { month: "1999-01" })).toMatchObject({
            isError: true,
            text: "no data for 1999-01; months: 2026-10..2026-11",
        });
        const bad = await mcp.call("month", { month: "2026-1" });
        expect(bad.isError).toBe(true);
        expect(bad.text).toMatch(/YYYY-MM/);
    });

    test("envelopes in display order", async () => {
        const { sb, mcp } = await setup();
        const list = (await mcp.call("envelopes")).value as Record<string, unknown>[];
        expect(list[0]!.id).toBe("tag#null");
        const { byId } = getEnvelopes(loadState(sb.db()));
        expect(list.map((e) => byId[e.id as keyof typeof byId]!.index)).toEqual(
            list.map((_, i) => i),
        );
        expect(list.find((e) => e.id === "tag#tag-food")).toEqual({
            id: "tag#tag-food",
            name: "Groceries",
            parent: null,
            group: "Food",
            visibility: "visible",
            currency: "EUR",
            keepIncome: false,
            carryNegatives: false,
            comment: "",
        });
        expect(list.map((e) => e.id)).toContain("account#sav");
        expect(list.find((e) => e.id === "tag#tag-cafe")!.parent).toBe("tag#tag-fun");
    });

    test("model: the stored model without the helper account", async () => {
        const { sb, mcp } = await setup();
        const { dataAccount: _, ...expected } = readModel(sb.db());
        expect((await mcp.call("model")).value).toEqual(expected);
    });

    test("sync on demand", async () => {
        const { mcp } = await setup([{ tag: fixture("account.json").tag }]);
        expect((await mcp.call("sync")).value).toEqual({ received: { tag: 4 } });
    });
});

describe("writing", () => {
    test("set_budget: set, then add", async () => {
        const { sb, mcp } = await setup([...write(), ...write()]);
        expect((await mcp.call("set_budget", { envelope: "Dining", amount: 50 })).value).toEqual({
            id: "tag#tag-cafe",
            month: "2026-10",
            budgeted: 50,
        });
        expect(readModel(sb.db()).budgets["2026-10"]).toEqual({
            "tag#tag-food": 400,
            "tag#tag-cafe": 50,
        });
        expect(
            (
                await mcp.call("set_budget", {
                    envelope: "Groceries",
                    amount: 25,
                    add: true,
                    month: "2026-10",
                })
            ).value,
        ).toEqual({
            id: "tag#tag-food",
            month: "2026-10",
            budgeted: 425,
        });
    });

    test("move_money", async () => {
        const { mcp } = await setup(write());
        expect(
            (await mcp.call("move_money", { amount: 100, from: "Groceries", to: "Dining" })).value,
        ).toEqual({
            month: "2026-10",
            from: { id: "tag#tag-food", budgeted: 300 },
            to: { id: "tag#tag-cafe", budgeted: 100 },
        });
    });

    test("set_goal: a goal with a deadline; off stops it", async () => {
        const { sb, mcp } = await setup([...write(), ...write()]);
        expect(
            (
                await mcp.call("set_goal", {
                    envelope: "Dining",
                    type: "targetBalance",
                    amount: 300,
                    end: "2026-12",
                    month: "2026-11",
                })
            ).value,
        ).toEqual({
            id: "tag#tag-cafe",
            month: "2026-11",
            goal: { type: "targetBalance", amount: 300, end: "2026-12-01" },
        });
        expect(
            (
                await mcp.call("set_goal", {
                    envelope: "Groceries",
                    off: true,
                    type: "monthly",
                    amount: 1,
                })
            ).value,
        ).toEqual({
            id: "tag#tag-food",
            month: "2026-10",
            goal: null,
        });
        expect(readModel(sb.db()).goals["2026-10"]).toEqual({ "tag#tag-food": null });
    });

    test("set_goal: the deadline must be a month", async () => {
        const { mcp } = await setup();
        const bad = await mcp.call("set_goal", {
            envelope: "Dining",
            type: "targetBalance",
            amount: 1,
            end: "2026-12-31",
        });
        expect(bad.isError).toBe(true);
        expect(bad.text).toMatch(/YYYY-MM/);
    });

    test("set_goal: a goal needs a type and an amount", async () => {
        const { mcp } = await setup();
        expect(await mcp.call("set_goal", { envelope: "Dining", amount: 5 })).toMatchObject({
            isError: true,
            text: "goal type must be one of monthly, monthlySpend, targetBalance, incomePercent",
        });
        expect((await mcp.call("set_goal", { envelope: "Dining", type: "monthly" })).text).toBe(
            "goal amount is required",
        );
    });

    test("envelope_settings: every field; '' clears group and comment", async () => {
        const { sb, mcp } = await setup([...write(), ...write()]);
        const r = (
            await mcp.call("envelope_settings", {
                envelope: "Dining",
                group: "Leisure",
                index: 3,
                comment: "coffee",
                visibility: "hidden",
                currency: "usd",
                carry_negatives: true,
                keep_income: false,
            })
        ).value;
        expect(r).toEqual({
            id: "tag#tag-cafe",
            meta: {
                id: "tag#tag-cafe",
                group: "Leisure",
                index: 3,
                comment: "coffee",
                visibility: "hidden",
                currency: "USD",
                carryNegatives: true,
                keepIncome: false,
            },
        });
        const cleared = (
            await mcp.call("envelope_settings", { envelope: "Dining", group: "", comment: "" })
        ).value as {
            meta: Record<string, unknown>;
        };
        expect(cleared.meta).toEqual({
            id: "tag#tag-cafe",
            index: 3,
            visibility: "hidden",
            currency: "USD",
            carryNegatives: true,
            keepIncome: false,
        });
        expect(readModel(sb.db()).envelopeMeta["tag#tag-cafe"]).toEqual(cleared.meta);
    });

    test("envelope_settings: nothing to change", async () => {
        const { mcp } = await setup();
        expect(await mcp.call("envelope_settings", { envelope: "Dining" })).toMatchObject({
            isError: true,
            text: "nothing to change",
        });
    });

    test("errors: unknown envelope; the server did not keep the write", async () => {
        const { mcp } = await setup([{}, {}, {}]);
        expect(await mcp.call("set_budget", { envelope: "No such", amount: 1 })).toMatchObject({
            isError: true,
            text: "envelope not found: 'No such'",
        });
        expect(await mcp.call("set_budget", { envelope: "Dining", amount: 1 })).toMatchObject({
            isError: true,
            text: "written, but the server copy differs — check in Zerro",
        });
    });
});
