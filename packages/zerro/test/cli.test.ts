// zerro CLI, in-process, against a fake API and a temp mirror with Zerro data.
import { describe, expect, onTestFinished, test } from "vitest";
import { echoPushed, fixture, sandbox, type Response, type Sandbox } from "@tihonove/testing";
import { money } from "@tihonove/zerro/cli";
import { account, dataAcc, reminder } from "./build.ts";

const TODAY = "2026-10-13";

/** A sandbox synced with the fixture plus Zerro data; `responses` answer later requests. */
async function zerro(responses: Response[] = []): Promise<Sandbox> {
    const data = fixture("account.json");
    const sb = await sandbox(
        [
            {
                ...data,
                account: [
                    ...data.account!,
                    dataAcc,
                    account("sav", "Deposit", { inBalance: false }),
                ],
                reminder: [
                    reminder("b", {
                        type: "budgets",
                        month: "2026-10",
                        payload: { "tag#tag-food": 400 },
                    }),
                    reminder("g", {
                        type: "goals",
                        month: "2026-10",
                        payload: {
                            "tag#tag-food": { type: "monthly", amount: 500 },
                            "tag#tag-salary": { type: "monthly", amount: 10 },
                        },
                    }),
                    reminder("m", {
                        type: "EnvelopeMeta",
                        payload: {
                            "tag#tag-food": {
                                id: "tag#tag-food",
                                group: "Food",
                                comment: "food",
                                keepIncome: true,
                                carryNegatives: true,
                            },
                        },
                    }),
                ],
            },
            ...responses,
        ],
        { env: { ZERRO_TODAY: TODAY } },
    );
    onTestFinished(() => sb.close());
    await sb.zm("sync");
    sb.api.requests.length = 0;
    return sb;
}

/** A table row as printTable pads it. */
const row = (widths: number[], ...cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ") + "\n";

const ok = (r: { code: number; stdout: string; stderr: string }) => {
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    return r.stdout;
};

test("money: ru format, a dot for zero", () => {
    expect([money(1234.5), money(-7), money(0)]).toEqual(["1 234,50", "-7,00", "·"]);
});

describe("help", () => {
    const commands = [
        [],
        ["raw"],
        ["envelopes"],
        ["show"],
        ["budget"],
        ["move"],
        ["goal"],
        ["meta"],
    ];
    test.each(commands.map((c) => [c.join(" ") || "zerro", c]))("%s --help", async (_, command) => {
        const sb = await zerro();
        const r = await sb.zerro(...command, "--help");
        expect(ok(r)).toMatchSnapshot();
    });

    test("parse errors come from commander", async () => {
        const sb = await zerro();
        expect(await sb.zerro("frobnicate")).toEqual({
            code: 1,
            stdout: "",
            stderr: "error: unknown command 'frobnicate'\n",
        });
    });
});

describe("reading", () => {
    test("raw: the stored model with category names; --reminders", async () => {
        const sb = await zerro();
        const raw = JSON.parse(ok(await sb.zerro("raw")));
        expect(raw).toEqual({
            dataAccount: { id: "zerro", title: "🤖 [Zerro Data]" },
            budgets: { "2026-10": { "Groceries (tag#tag-food)": 400 } },
            goals: {
                "2026-10": {
                    "Groceries (tag#tag-food)": { type: "monthly", amount: 500 },
                    "Bonus (tag#tag-salary)": { type: "monthly", amount: 10 },
                },
            },
            envelopeMeta: {
                "Groceries (tag#tag-food)": {
                    id: "tag#tag-food",
                    group: "Food",
                    comment: "food",
                    keepIncome: true,
                    carryNegatives: true,
                },
            },
            userSettings: {},
            fxRates: {},
            other: {},
        });
        const withReminders = JSON.parse(ok(await sb.zerro("raw", "--reminders")));
        expect(withReminders.reminders.map((r: { id: string }) => r.id).sort()).toEqual([
            "b",
            "g",
            "m",
        ]);
    });

    test("raw: ids that are not categories stay as they are; months sorted", async () => {
        const data = fixture("account.json");
        const sb = await sandbox([
            {
                ...data,
                reminder: [
                    reminder("b2", {
                        type: "budgets",
                        month: "2026-11",
                        payload: { "account#sav": 1 },
                    }),
                    reminder("b1", { type: "budgets", month: "2026-09", payload: {} }),
                ],
            },
        ]);
        onTestFinished(() => sb.close());
        await sb.zm("sync");
        const raw = JSON.parse(ok(await sb.zerro("raw")));
        expect(raw.dataAccount).toBeNull();
        expect(raw.budgets).toEqual({ "2026-09": {}, "2026-11": { "account#sav": 1 } });
        expect(Object.keys(raw.budgets)).toEqual(["2026-09", "2026-11"]);
    });

    test("envelopes: table and JSON, in display order", async () => {
        const sb = await zerro();
        const list = JSON.parse(ok(await sb.zerro("envelopes", "--json")));
        expect(list).toEqual([
            {
                id: "tag#null",
                name: "Uncategorized",
                group: "Categories",
                visibility: "auto",
                currency: "EUR",
                flags: "",
                comment: "",
            },
            {
                id: "tag#tag-salary",
                name: "Bonus",
                group: "Categories",
                visibility: "visible",
                currency: "EUR",
                flags: "",
                comment: "",
            },
            {
                id: "tag#tag-fun",
                name: "Hobbies",
                group: "Categories",
                visibility: "visible",
                currency: "EUR",
                flags: "",
                comment: "",
            },
            {
                id: "tag#tag-cafe",
                name: "  └ Dining",
                group: "Categories",
                visibility: "visible",
                currency: "EUR",
                flags: "",
                comment: "",
            },
            {
                id: "tag#tag-food",
                name: "Groceries",
                group: "Food",
                visibility: "visible",
                currency: "EUR",
                flags: "keepIncome carryNegatives",
                comment: "food",
            },
            {
                id: "account#sav",
                name: "Deposit",
                group: "Transfers",
                visibility: "auto",
                currency: "EUR",
                flags: "",
                comment: "",
            },
        ]);
        const widths = [14, 13, 10, 10, 8, 25, 7];
        expect(ok(await sb.zerro("envelopes")).split("\n")[0] + "\n").toBe(
            row(widths, "id", "name", "group", "visibility", "currency", "flags", "comment"),
        );
    });

    test("show: summary lines and a table by group, with goals", async () => {
        const sb = await zerro();
        const w = [12, 8, 8, 9, 11];
        expect(ok(await sb.zerro("show"))).toBe(
            "2026-10, EUR. Income 1\u00a0000,00 · Budgeted 400,00 · Spent -19,50 · Overspent -7,00\n" +
                "Funds 1\u00a0487,50 · In envelopes 380,50 · To be budgeted 1\u00a0107,00 (positive)\n" +
                "\n" +
                row(w, "envelope", "budgeted", "activity", "available", "goal") +
                row(w, "[Categories]", "", "", "", "") +
                row(w, "Bonus", "·", "·", "·", "need 10,00") +
                row(w, "Hobbies", "·", "-7,00", "-7,00", "") +
                row(w, "  └ Dining", "·", "-7,00", "-7,00", "") +
                row(w, "[Food]", "", "", "", "") +
                row(w, "Groceries", "400,00", "-12,50", "387,50", "need 100,00"),
        );
    });

    test("show: --month, --all, --json; a month outside the data", async () => {
        const sb = await zerro();
        const all = ok(await sb.zerro("show", "--month", "2026-11", "--all"));
        expect(all).toMatch(/^2026-11, EUR\./);
        expect(all).toContain("Uncategorized");
        expect(all).toContain("[Transfers]");
        const json = JSON.parse(ok(await sb.zerro("show", "--json")));
        expect(json.summary.toBeBudgeted).toBe(1107);
        expect(json.envelopes.find((e: { id: string }) => e.id === "tag#tag-food")).toEqual({
            group: "Food",
            envelope: "Groceries",
            id: "tag#tag-food",
            budgeted: 400,
            activity: -12.5,
            available: 387.5,
            goalNeed: 100,
        });
        expect(await sb.zerro("show", "--month", "1999-01")).toEqual({
            code: 1,
            stdout: "",
            stderr: "zerro: no data for 1999-01; months: 2026-10..2026-11\n",
        });
    });
});

describe("show details", () => {
    test("a goal that is met shows ok", async () => {
        const budgets = { "tag#tag-food": 400, "tag#tag-salary": 10 };
        const sb = await zerro([
            { reminder: [reminder("b", { type: "budgets", month: "2026-10", payload: budgets })] },
        ]);
        await sb.zm("sync");
        expect(ok(await sb.zerro("show"))).toMatch(/\nBonus +10,00 +· +10,00 +ok +\n/);
    });

    test("ZERRO_TODAY sets the default month", async () => {
        const sb = await sandbox([fixture("account.json")], { env: { ZERRO_TODAY: "2026-11-02" } });
        onTestFinished(() => sb.close());
        await sb.zm("sync");
        expect(JSON.parse(ok(await sb.zerro("show", "--json"))).summary.month).toBe("2026-11");
    });

    test("without ZERRO_TODAY the month is the real current one", async () => {
        const sb = await sandbox([fixture("account.json")]);
        onTestFinished(() => sb.close());
        await sb.zm("sync");
        const month = new Date().toISOString().slice(0, 7);
        expect(JSON.parse(ok(await sb.zerro("show", "--json"))).summary.month).toBe(month);
    });
});

describe("writing", () => {
    const roundTrip = (): Response[] => [{}, {}, echoPushed()];
    const payload = (stdout: string) => JSON.parse(JSON.parse(stdout).reminder[0].comment);

    test("budget: dry run prints the payload; a real write is verified", async () => {
        const sb = await zerro(roundTrip());
        expect(payload(ok(await sb.zerro("budget", "Groceries", "600", "--dry-run")))).toEqual({
            type: "budgets",
            month: "2026-10",
            payload: { "tag#tag-food": 600 },
        });
        expect(
            payload(
                ok(
                    await sb.zerro(
                        "budget",
                        "Hobbies",
                        "5",
                        "--add",
                        "--month",
                        "2026-11",
                        "--dry-run",
                    ),
                ),
            ),
        ).toEqual({
            type: "budgets",
            month: "2026-11",
            payload: { "tag#tag-fun": 5 },
        });
        expect(sb.api.requests).toEqual([]);
        expect(ok(await sb.zerro("budget", "Groceries", "450"))).toBe(
            "ok: saved and verified on the server\n",
        );
        expect(sb.api.requests.length).toBe(3);
    });

    test("move", async () => {
        const sb = await zerro(roundTrip());
        expect(
            payload(ok(await sb.zerro("move", "100", "Groceries", "Hobbies", "--dry-run"))).payload,
        ).toEqual({
            "tag#tag-food": 300,
            "tag#tag-fun": 100,
        });
        expect(
            payload(
                ok(
                    await sb.zerro(
                        "move",
                        "1",
                        "Groceries",
                        "Dining",
                        "--month",
                        "2026-11",
                        "--dry-run",
                    ),
                ),
            ),
        ).toMatchObject({
            month: "2026-11",
            payload: { "tag#tag-food": -1, "tag#tag-cafe": 1 },
        });
        expect(ok(await sb.zerro("move", "100", "Groceries", "Hobbies"))).toBe(
            "ok: saved and verified on the server\n",
        );
    });

    test("goal: set, with an end, stop; errors", async () => {
        const sb = await zerro(roundTrip());
        expect(
            payload(ok(await sb.zerro("goal", "Dining", "monthlySpend", "50", "--dry-run")))
                .payload["tag#tag-cafe"],
        ).toEqual({
            type: "monthlySpend",
            amount: 50,
        });
        expect(
            payload(
                ok(
                    await sb.zerro(
                        "goal",
                        "Dining",
                        "targetBalance",
                        "900",
                        "--end",
                        "2027-03",
                        "--month",
                        "2026-11",
                        "--dry-run",
                    ),
                ),
            ),
        ).toEqual({
            type: "goals",
            month: "2026-11",
            payload: { "tag#tag-cafe": { type: "targetBalance", amount: 900, end: "2027-03-01" } },
        });
        expect(
            payload(ok(await sb.zerro("goal", "Groceries", "--off", "--dry-run"))).payload[
                "tag#tag-food"
            ],
        ).toBeNull();
        expect((await sb.zerro("goal", "Dining", "weekly", "5")).stderr).toBe(
            "zerro: goal type must be one of monthly, monthlySpend, targetBalance, incomePercent\n",
        );
        expect((await sb.zerro("goal", "Dining", "monthly")).stderr).toBe(
            "zerro: goal amount is required\n",
        );
        expect(ok(await sb.zerro("goal", "Dining", "monthly", "20"))).toBe(
            "ok: saved and verified on the server\n",
        );
    });

    test("meta: options become settings; '' removes a field", async () => {
        const sb = await zerro(roundTrip());
        const meta = (stdout: string) => payload(stdout).payload;
        expect(
            meta(
                ok(
                    await sb.zerro(
                        "meta",
                        "Dining",
                        "--group",
                        "Leisure",
                        "--index",
                        "2",
                        "--comment",
                        "coffee",
                        "--visibility",
                        "hidden",
                        "--currency",
                        "rub",
                        "--carry-negatives",
                        "yes",
                        "--keep-income",
                        "no",
                        "--dry-run",
                    ),
                ),
            )["tag#tag-cafe"],
        ).toEqual({
            id: "tag#tag-cafe",
            group: "Leisure",
            index: 2,
            comment: "coffee",
            visibility: "hidden",
            currency: "RUB",
            carryNegatives: true,
            keepIncome: false,
        });
        expect(
            meta(
                ok(
                    await sb.zerro(
                        "meta",
                        "Groceries",
                        "--group",
                        "",
                        "--comment",
                        "",
                        "--dry-run",
                    ),
                ),
            )["tag#tag-food"],
        ).toEqual({
            id: "tag#tag-food",
            keepIncome: true,
            carryNegatives: true,
        });
        expect((await sb.zerro("meta", "Dining")).stderr).toBe("zerro: nothing to change\n");
        expect((await sb.zerro("meta", "Dining", "--visibility", "shown")).stderr).toBe(
            "zerro: visibility must be one of hidden, visible, auto\n",
        );
        expect(ok(await sb.zerro("meta", "Dining", "--comment", "c"))).toBe(
            "ok: saved and verified on the server\n",
        );
    });
});
