// Edits of the Zerro model: builders on a mirror, and complete operations through a fake API.
import { describe, expect, onTestFinished, test } from "vitest";
import { echoPushed, fixture, memoryMirror, sandbox, type Response } from "@tihonove/testing";
import { open, ZmError, type Context, type Diff } from "@tihonove/zenmoney";
import {
    applyBudget,
    applyGoal,
    applyMeta,
    applyMove,
    budgetOf,
    patchMeta,
    readModel,
    resolveEnvelope,
    serverModel,
    setBudgets,
    setGoal,
    type Goals,
} from "@tihonove/zerro";
import { dataAcc, reminder, tag } from "./build.ts";

const comments = (d: Diff) => (d.reminder ?? []).map((r) => JSON.parse(r.comment!));

describe("resolveEnvelope", () => {
    const con = memoryMirror({
        tag: [
            ...fixture("account.json").tag!,
            tag("d1", "Twin"),
            tag("d2", "Twin"),
            // Cyrillic on purpose: case-insensitive matching must work beyond ASCII
            tag("k1", "Кино"),
            tag("k2", "кино"),
        ],
    });

    test("by id, exact name, then case-insensitive trimmed name", () => {
        expect(resolveEnvelope(con, "tag#tag-food").name).toBe("Groceries");
        expect(resolveEnvelope(con, "Uncategorized").id).toBe("tag#null");
        expect(resolveEnvelope(con, "  groceries ").id).toBe("tag#tag-food");
        expect(resolveEnvelope(con, "кино").id).toBe("tag#k2");
    });

    test("not found, ambiguous", () => {
        expect(() => resolveEnvelope(con, "Nope")).toThrow(
            new ZmError("envelope not found: 'Nope'"),
        );
        expect(() => resolveEnvelope(con, "Twin")).toThrow(
            new ZmError("ambiguous envelope 'Twin': tag#d1, tag#d2"),
        );
        expect(() => resolveEnvelope(con, "КИНО")).toThrow(
            new ZmError("ambiguous envelope 'КИНО': tag#k1, tag#k2"),
        );
    });
});

describe("builders", () => {
    const con = memoryMirror({
        account: [...fixture("account.json").account!, dataAcc],
        reminder: [
            reminder("b", {
                type: "budgets",
                month: "2026-10",
                payload: { "tag#a": 1, "tag#b": 2 },
            }),
            reminder("m", {
                type: "EnvelopeMeta",
                payload: { "tag#a": { id: "tag#a", index: 3, group: "G" } },
            }),
        ],
    });

    test("setBudgets: sets and removes in the month's stored budgets", () => {
        const diff = setBudgets(con, "2026-10", { "tag#a": 5, "tag#b": 0, "tag#c": 7 });
        expect(diff.reminder![0]!.id).toBe("b");
        expect(comments(diff)).toEqual([
            { type: "budgets", month: "2026-10", payload: { "tag#a": 5, "tag#c": 7 } },
        ]);
        expect(comments(setBudgets(con, "2026-11", { "tag#a": 1 }))[0].payload).toEqual({
            "tag#a": 1,
        });
        expect(() => setBudgets(con, "2026-1", {})).toThrow(
            new ZmError("bad month '2026-1', want YYYY-MM"),
        );
    });

    test("budgetOf", () => {
        const model = readModel(con);
        expect([
            budgetOf(model, "2026-10", "tag#b"),
            budgetOf(model, "2026-10", "tag#x"),
            budgetOf(model, "2027-01", "tag#a"),
        ]).toEqual([2, 0, 0]);
    });

    test("patchMeta: merges into existing settings; undefined removes a field", () => {
        const diff = patchMeta(con, {
            "tag#a": { group: undefined, comment: "c" },
            "tag#b": { carryNegatives: true },
        });
        expect(diff.reminder![0]!.id).toBe("m");
        expect(comments(diff)[0].payload).toEqual({
            "tag#a": { id: "tag#a", index: 3, comment: "c" },
            "tag#b": { carryNegatives: true, id: "tag#b" },
        });
    });

    const goalsMirror = (goals: Goals) =>
        memoryMirror({
            account: [dataAcc],
            reminder: Object.entries(goals).map(([month, payload]) =>
                reminder(`g${month}`, { type: "goals", month, payload }),
            ),
        });
    const monthly = { type: "monthly" as const, amount: 10 };

    test("setGoal: a new goal removes the nearest later stop marker, keeping other envelopes", () => {
        const con2 = goalsMirror({
            "2026-09": { "tag#a": null },
            "2026-11": { "tag#a": null, "tag#b": monthly },
            "2026-12": { "tag#a": null },
        });
        const diff = setGoal(con2, "2026-10", "tag#a", monthly);
        expect(comments(diff)).toEqual([
            { type: "goals", month: "2026-10", payload: { "tag#a": monthly } },
            { type: "goals", month: "2026-11", payload: { "tag#b": monthly } },
        ]);
    });

    test("setGoal: later months in date order, even if stored out of order; only later ones", () => {
        const unsorted = goalsMirror({
            "2026-12": { "tag#a": null },
            "2026-11": { "tag#a": null },
        });
        const diff = setGoal(unsorted, "2026-10", "tag#a", monthly);
        expect(comments(diff).map((c) => c.month)).toEqual(["2026-10"]);
        expect(diff.deletion!.map((d) => d.id)).toEqual(["g2026-11"]);

        const same = goalsMirror({ "2026-10": { "tag#a": null } });
        const replaced = setGoal(same, "2026-10", "tag#a", monthly);
        expect(comments(replaced)).toEqual([
            { type: "goals", month: "2026-10", payload: { "tag#a": monthly } },
        ]);
        expect(replaced.deletion).toBeUndefined();
    });

    test("setGoal: a later goal stops the search; months without the envelope are skipped", () => {
        const stopped = goalsMirror({
            "2026-11": { "tag#a": monthly },
            "2026-12": { "tag#a": null },
        });
        const kept = setGoal(stopped, "2026-10", "tag#a", monthly);
        expect(comments(kept).map((c) => c.month)).toEqual(["2026-10"]);
        expect(kept.deletion).toBeUndefined();

        const skipped = goalsMirror({
            "2026-11": { "tag#b": monthly },
            "2026-12": { "tag#a": null },
        });
        const diff = setGoal(skipped, "2026-10", "tag#a", monthly);
        expect(diff.deletion!.map((d) => d.id)).toEqual(["g2026-12"]); // the month's goals became empty
    });

    test("setGoal: null stops the goal and leaves later markers alone; invalid drafts count as null", () => {
        const con2 = goalsMirror({ "2026-10": { "tag#b": monthly }, "2026-12": { "tag#a": null } });
        const stop = setGoal(con2, "2026-10", "tag#a", null);
        expect(comments(stop)).toEqual([
            { type: "goals", month: "2026-10", payload: { "tag#b": monthly, "tag#a": null } },
        ]);
        expect(stop.deletion).toBeUndefined();
        expect(
            comments(setGoal(con2, "2026-11", "tag#a", { type: "monthly", amount: 0 }))[0].payload,
        ).toEqual({ "tag#a": null });
        expect(() => setGoal(con2, "x", "tag#a", null)).toThrow(
            new ZmError("bad month 'x', want YYYY-MM"),
        );
    });
});

describe("operations", () => {
    /** A sandbox synced with the fixture plus Zerro data; `responses` answer the operation's requests. */
    async function zerro(
        responses: Response[] = [],
    ): Promise<{ ctx: Context; requests: () => Record<string, unknown>[] }> {
        const account = fixture("account.json");
        const sb = await sandbox([
            {
                ...account,
                account: [...account.account!, dataAcc],
                reminder: [
                    reminder("b", {
                        type: "budgets",
                        month: "2026-10",
                        payload: { "tag#tag-food": 400 },
                    }),
                    reminder("m", {
                        type: "EnvelopeMeta",
                        payload: { "tag#tag-food": { id: "tag#tag-food", index: 1 } },
                    }),
                ],
            },
            ...responses,
        ]);
        onTestFinished(() => sb.close());
        await sb.zm("sync");
        sb.api.requests.length = 0;
        const ctx = open({ db: sb.env.ZENMONEY_DB, api: sb.api.url, token: "t" });
        return { ctx, requests: () => sb.api.requests.map((r) => r.body) };
    }
    /** sync, push, then the server's copy echoing the push */
    const roundTrip = (): Response[] => [{}, {}, echoPushed()];

    test("serverModel reads Zerro data from a fresh copy", async () => {
        const { ctx, requests } = await zerro([
            {
                account: [dataAcc],
                reminder: [reminder("x", { type: "UserSettings", payload: { a: 1 } })],
            },
        ]);
        expect(await serverModel(ctx)).toMatchObject({
            dataAccount: dataAcc,
            userSettings: { a: 1 },
        });
        expect(requests()[0]!.forceFetch).toEqual(["account", "reminder"]);
    });

    test("applyBudget: sync, push, verify on the server; the mirror follows", async () => {
        const { ctx, requests } = await zerro(roundTrip());
        const result = await applyBudget(ctx, "Groceries", 600, "2026-10");
        expect([result.id, result.month, result.budgeted]).toEqual([
            "tag#tag-food",
            "2026-10",
            600,
        ]);
        expect(comments(result.diff)).toEqual([
            { type: "budgets", month: "2026-10", payload: { "tag#tag-food": 600 } },
        ]);
        const sent = requests();
        expect(sent.length).toBe(3);
        expect(sent[0]!.reminder).toBeUndefined(); // the sync
        expect(sent[1]!.reminder).toEqual(result.diff.reminder); // the push
        expect(sent[2]!.forceFetch).toEqual(["account", "reminder"]); // the check
        expect(readModel(ctx.con).budgets["2026-10"]).toEqual({ "tag#tag-food": 600 });
    });

    test("applyBudget --add changes the current budget; 0 removes it", async () => {
        const { ctx } = await zerro([...roundTrip(), ...roundTrip()]);
        expect(
            (await applyBudget(ctx, "tag#tag-food", -50.004, "2026-10", { add: true })).budgeted,
        ).toBe(350);
        const removed = await applyBudget(ctx, "Groceries", 0, "2026-10");
        expect(removed.budgeted).toBe(0);
        expect(removed.diff.deletion!.map((d) => d.id)).toEqual(["b"]);
    });

    test("a write the server does not hold is an error", async () => {
        const { ctx } = await zerro([{}, {}, {}]);
        await expect(applyBudget(ctx, "Groceries", 1, "2026-10")).rejects.toThrow(
            new ZmError("written, but the server copy differs — check in Zerro"),
        );
    });

    test("dry run: the diff from the mirror as it is, nothing sent", async () => {
        const { ctx, requests } = await zerro();
        const result = await applyBudget(ctx, "Groceries", 7, "2026-10", {
            dryRun: true,
            add: true,
        });
        expect([result.budgeted, comments(result.diff)[0].payload]).toEqual([
            407,
            { "tag#tag-food": 407 },
        ]);
        expect(requests()).toEqual([]);
    });

    test("validation happens before anything is sent", async () => {
        const { ctx, requests } = await zerro();
        await expect(applyBudget(ctx, "Groceries", 1, "2026-1")).rejects.toThrow(
            new ZmError("bad month '2026-1', want YYYY-MM"),
        );
        await expect(applyMove(ctx, 1, "a", "b", "10/2026")).rejects.toThrow(/bad month/);
        await expect(applyGoal(ctx, "a", null, "")).rejects.toThrow(/bad month/);
        expect(requests()).toEqual([]);
    });

    test("applyMove", async () => {
        const { ctx } = await zerro(roundTrip());
        const result = await applyMove(ctx, 100.001, "Groceries", "Hobbies", "2026-10");
        expect([result.month, result.from, result.to]).toEqual([
            "2026-10",
            { id: "tag#tag-food", budgeted: 300 },
            { id: "tag#tag-fun", budgeted: 100 },
        ]);
        expect(comments(result.diff)[0].payload).toEqual({
            "tag#tag-food": 300,
            "tag#tag-fun": 100,
        });
    });

    test("applyMove: the server must hold both sides; not into the same envelope", async () => {
        const { ctx } = await zerro([
            {},
            {},
            {
                account: [dataAcc],
                reminder: [
                    reminder("b", {
                        type: "budgets",
                        month: "2026-10",
                        payload: { "tag#tag-food": 300 },
                    }),
                ],
            },
        ]);
        await expect(applyMove(ctx, 100, "Groceries", "Hobbies", "2026-10")).rejects.toThrow(
            /server copy differs/,
        );
    });

    test("applyMove: the source side must be on the server too", async () => {
        const onlyTarget = { "tag#tag-food": 400, "tag#tag-fun": 100 };
        const { ctx } = await zerro([
            {},
            {},
            {
                reminder: [
                    reminder("b", { type: "budgets", month: "2026-10", payload: onlyTarget }),
                ],
            },
        ]);
        await expect(applyMove(ctx, 100, "Groceries", "Hobbies", "2026-10")).rejects.toThrow(
            /server copy differs/,
        );
        await expect(
            applyMove(ctx, 1, "Groceries", "tag#tag-food", "2026-10", { dryRun: true }),
        ).rejects.toThrow(new ZmError("cannot move money to the same envelope"));
    });

    test("applyGoal: set, with an end month, and stop", async () => {
        const { ctx } = await zerro([...roundTrip(), ...roundTrip()]);
        const set = await applyGoal(
            ctx,
            "Groceries",
            { type: "targetBalance", amount: 900, end: "2026-12" },
            "2026-10",
        );
        expect([set.id, set.month, set.goal]).toEqual([
            "tag#tag-food",
            "2026-10",
            { type: "targetBalance", amount: 900, end: "2026-12-01" },
        ]);
        const stop = await applyGoal(ctx, "Groceries", null, "2026-11");
        expect(stop.goal).toBeNull();
        expect(readModel(ctx.con).goals).toEqual({
            "2026-10": {
                "tag#tag-food": { type: "targetBalance", amount: 900, end: "2026-12-01" },
            },
            "2026-11": { "tag#tag-food": null },
        });
    });

    test("applyGoal: the server must hold exactly the goal", async () => {
        const { ctx } = await zerro([
            {},
            {},
            {
                reminder: [
                    reminder("g", {
                        type: "goals",
                        month: "2026-10",
                        payload: { "tag#tag-food": { type: "monthly", amount: 1 } },
                    }),
                ],
            },
        ]);
        await expect(
            applyGoal(ctx, "Groceries", { type: "monthly", amount: 2 }, "2026-10"),
        ).rejects.toThrow(/server copy differs/);
    });

    test("applyGoal: a server copy without that month is a clear error", async () => {
        const { ctx } = await zerro([{}, {}, {}]);
        await expect(applyGoal(ctx, "Groceries", null, "2026-10")).rejects.toThrow(
            new ZmError("written, but the server copy differs — check in Zerro"),
        );
    });

    test("applyGoal: validation", async () => {
        const { ctx } = await zerro();
        const goal = (g: object) => applyGoal(ctx, "Groceries", g, "2026-10", { dryRun: true });
        const types = "monthly, monthlySpend, targetBalance, incomePercent";
        await expect(goal({ amount: 1 })).rejects.toThrow(
            new ZmError(`goal type must be one of ${types}`),
        );
        await expect(goal({ type: "weekly", amount: 1 })).rejects.toThrow(
            new ZmError(`goal type must be one of ${types}`),
        );
        await expect(goal({ type: "monthly" })).rejects.toThrow(
            new ZmError("goal amount is required"),
        );
        await expect(goal({ type: "monthly", amount: 0 })).rejects.toThrow(
            new ZmError("goal amount is required"),
        );
        for (const end of ["12/2026", "2026-1", "x2026-12", "2026-12-011"]) {
            await expect(goal({ type: "targetBalance", amount: 1, end })).rejects.toThrow(
                new ZmError(`bad goal end '${end}', want YYYY-MM`),
            );
        }
        expect(
            (await goal({ type: "targetBalance", amount: 1, end: "2026-12-15" })).goal!.end,
        ).toBe("2026-12-15");
        expect((await goal({ type: "monthly", amount: 1, end: undefined })).goal).toEqual({
            type: "monthly",
            amount: 1,
        });
    });

    test("applyMeta: merged settings, a removed field, an upper-cased currency", async () => {
        const { ctx } = await zerro(roundTrip());
        const result = await applyMeta(ctx, "Groceries", {
            group: "Food",
            index: undefined,
            currency: "rub",
            carryNegatives: false,
        });
        expect([result.id, result.meta]).toEqual([
            "tag#tag-food",
            { id: "tag#tag-food", group: "Food", currency: "RUB", carryNegatives: false },
        ]);
        expect(readModel(ctx.con).envelopeMeta["tag#tag-food"]).toEqual(result.meta);
    });

    test("applyMeta: the server must hold the settings", async () => {
        const { ctx } = await zerro([{}, {}, {}]);
        await expect(applyMeta(ctx, "Groceries", { comment: "x" })).rejects.toThrow(
            /server copy differs/,
        );
    });

    test("applyMeta: validation", async () => {
        const { ctx } = await zerro();
        await expect(applyMeta(ctx, "Groceries", {})).rejects.toThrow(
            new ZmError("nothing to change"),
        );
        await expect(applyMeta(ctx, "Groceries", { visibility: "shown" as never })).rejects.toThrow(
            new ZmError("visibility must be one of hidden, visible, auto"),
        );
        for (const visibility of ["hidden", "visible", "auto"] as const) {
            expect(
                (await applyMeta(ctx, "Groceries", { visibility }, { dryRun: true })).meta
                    .visibility,
            ).toBe(visibility);
        }
        expect(
            (await applyMeta(ctx, "Groceries", { currency: "" }, { dryRun: true })).meta,
        ).toEqual({
            id: "tag#tag-food",
            index: 1,
            currency: "",
        });
    });
});
