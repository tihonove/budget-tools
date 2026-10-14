// zm CLI, in-process, against a fake API and a temp mirror.
import { describe, expect, onTestFinished, test } from "vitest";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sandbox, syncedSandbox, fixture, type Sandbox } from "@tihonove/testing";
import type { Diff } from "@tihonove/zenmoney";

const json = (r: { code: number; stdout: string; stderr: string }) => {
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    return JSON.parse(r.stdout);
};

async function synced(more: Diff[] = []): Promise<Sandbox> {
    const sb = await syncedSandbox(more);
    onTestFinished(() => sb.close());
    return sb;
}

async function empty(): Promise<Sandbox> {
    const sb = await sandbox();
    onTestFinished(() => sb.close());
    return sb;
}

const bodies = (sb: Sandbox) => sb.api.requests.map((r) => r.body);

describe("help", () => {
    const commands = [
        [],
        ["auth"],
        ["sync"],
        ["status"],
        ["accounts"],
        ["tags"],
        ["instruments"],
        ["tx"],
        ["tx", "list"],
        ["tx", "show"],
        ["tx", "add"],
        ["tx", "update"],
        ["tx", "to-transfer"],
        ["tx", "delete"],
        ["tx", "import"],
        ["tag"],
        ["tag", "add"],
        ["tag", "update"],
        ["tag", "delete"],
        ["account"],
        ["account", "add"],
        ["account", "update"],
        ["account", "delete"],
        ["push"],
        ["sql"],
        ["wipe"],
    ];
    test.each(commands.map((c) => [c.join(" ") || "zm", c]))("%s --help", async (_, command) => {
        const sb = await empty();
        const r = await sb.zm(...command, "--help");
        expect(r.code).toBe(0);
        expect(r.stderr).toBe("");
        expect(r.stdout).toMatchSnapshot();
    });

    test("parse errors come from commander", async () => {
        const sb = await empty();
        expect(await sb.zm("frobnicate")).toEqual({
            code: 1,
            stdout: "",
            stderr: "error: unknown command 'frobnicate'\n",
        });
        expect((await sb.zm("tx", "add", "expense", "--amount", "1")).stderr).toBe(
            "error: required option '--account <title>' not specified\n",
        );
        expect((await sb.zm("tx", "list", "--limit", "x")).stderr).toBe(
            "error: option '--limit <n>' argument 'x' is invalid. Not a number.\n",
        );
    });
});

describe("auth", () => {
    test("validates the token from stdin and saves it with mode 600", async () => {
        const sb = await sandbox([{ user: fixture("account.json").user }], {
            env: { ZENMONEY_TOKEN_FILE: "sec/token" },
        });
        onTestFinished(() => sb.close());
        const r = await sb.zmIn("  new-token \n", "auth");
        expect(r).toEqual({
            code: 0,
            stdout: `token ok: user 1 (test)\nsaved to ${path.join(sb.dir, "sec/token")}\n`,
            stderr: "",
        });
        const file = path.join(sb.dir, "sec/token");
        expect(readFileSync(file, "utf8")).toBe("new-token\n");
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(sb.api.requests[0]!.auth).toBe("Bearer new-token");
    });

    test("a user without login; --no-check skips the API", async () => {
        const root = { ...fixture("account.json").user![0]!, login: null };
        const sb = await sandbox([{ user: [root] }], { env: { ZENMONEY_TOKEN_FILE: "t" } });
        onTestFinished(() => sb.close());
        expect((await sb.zmIn("a", "auth")).stdout).toMatch(/^token ok: user 1\n/);
        expect((await sb.zmIn("b", "auth", "--no-check")).stdout).toBe(
            `saved to ${path.join(sb.dir, "t")}\n`,
        );
        expect(sb.api.requests.length).toBe(1);
        expect(readFileSync(path.join(sb.dir, "t"), "utf8")).toBe("b\n");
    });

    test("empty and rejected tokens are not saved", async () => {
        const sb = await sandbox([], { env: { ZENMONEY_TOKEN_FILE: "t" } });
        onTestFinished(() => sb.close());
        expect(await sb.zmIn(" \n", "auth")).toEqual({
            code: 1,
            stdout: "",
            stderr: "zm: empty token\n",
        });
        sb.api.status = 401;
        expect((await sb.zmIn("bad", "auth")).stderr).toBe(
            `zm: token rejected by ${sb.api.url} (wrong token, or the account lives on api.zenmoney.app` +
                " — try ZENMONEY_API=https://api.zenmoney.app)\n",
        );
        expect(existsSync(path.join(sb.dir, "t"))).toBe(false);
    });
});

describe("sync and status", () => {
    test("sync reports what came, then nothing new", async () => {
        const sb = await sandbox([fixture("account.json")]);
        onTestFinished(() => sb.close());
        expect((await sb.zm("sync")).stdout).toBe(
            "synced: { instrument: 3, user: 1, account: 4, tag: 4, budget: 1, transaction: 5 } | serverTimestamp = 1800000001\n",
        );
        expect((await sb.zm("sync")).stdout).toBe(
            "synced: nothing new | serverTimestamp = 1800000002\n",
        );
        expect(sb.api.requests.map((r) => r.body.serverTimestamp)).toEqual([0, 1800000001]);
        expect(sb.api.requests[0]!.auth).toBe("Bearer test-token");
    });

    test("sync --full drops the mirror", async () => {
        const sb = await synced();
        await sb.zm("sync", "--full");
        expect(sb.api.requests[0]!.body.serverTimestamp).toBe(0);
        expect(json(await sb.zm("accounts", "--json"))).toEqual([]);
    });

    test("status", async () => {
        const sb = await synced();
        expect((await sb.zm("status")).stdout).toBe(
            "user 1 (test), main currency EUR\n" +
                "serverTimestamp 1800000001 (2027-01-15T08:00:01.000Z)\n" +
                "  instrument       3\n" +
                "  user             1\n" +
                "  account          4\n" +
                "  tag              4\n" +
                "  budget           1\n" +
                "  transaction      5\n" +
                "  (of which deleted transactions: 1)\n",
        );
        expect(sb.api.requests).toEqual([]);
    });

    test("status: no login, unknown currency, never synced, nothing deleted", async () => {
        const sb = await empty();
        const db = sb.db();
        const root = { ...fixture("account.json").user![0]!, login: null, currency: 99 };
        db.prepare("INSERT INTO user VALUES ('1', 1, ?)").run(JSON.stringify(root));
        expect((await sb.zm("status")).stdout).toBe(
            "user 1 (?), main currency 99\nserverTimestamp 0 (never)\n  user             1\n",
        );
    });

    test("an empty mirror", async () => {
        const sb = await empty();
        expect(await sb.zm("status")).toEqual({
            code: 1,
            stdout: "",
            stderr: "zm: cache empty: run `zm sync` first\n",
        });
    });
});

describe("reading", () => {
    test("accounts: active by default, --all, table", async () => {
        const sb = await synced();
        expect(
            json(await sb.zm("accounts", "--json")).map((a: { title: string }) => a.title),
        ).toEqual(["Black", "Revolut €", "Revolut Savings"]);
        expect(json(await sb.zm("accounts", "--all", "--json")).at(-1).title).toBe("Old card");
        expect((await sb.zm("accounts")).stdout.split("\n")[0]).toBe(
            "id         title            type      currency  balance  in_balance  savings  archive",
        );
    });

    test("tags: tree and JSON", async () => {
        const sb = await synced();
        expect((await sb.zm("tags")).stdout).toBe(
            "Bonus                                    tag-salary  in out\n" +
                "Groceries                                tag-food  in out\n" +
                "Hobbies                                  tag-fun  in out\n" +
                "    Dining                                   tag-cafe  in out\n",
        );
        const tags = json(await sb.zm("tags", "--json"));
        expect(tags.find((t: { id: string }) => t.id === "tag-cafe")).toEqual({
            id: "tag-cafe",
            title: "Dining",
            parent: "tag-fun",
            parent_title: "Hobbies",
            show_income: 1,
            show_outcome: 1,
        });
    });

    test("tags: flags", async () => {
        const sb = await synced();
        await sb.zm(
            "sql",
            "UPDATE tag SET json = json_set(json, '$.showIncome', json('false')) WHERE id = 'tag-food'",
        );
        await sb.zm(
            "sql",
            "UPDATE tag SET json = json_set(json, '$.showOutcome', json('false')) WHERE id = 'tag-fun'",
        );
        const lines = (await sb.zm("tags")).stdout.split("\n");
        expect(lines[1]).toBe("Groceries                                tag-food     out");
        expect(lines[2]).toBe("Hobbies                                  tag-fun  in ");
    });

    test("instruments with a query", async () => {
        const sb = await synced();
        expect(
            json(await sb.zm("instruments", "--json")).map((i: { code: string }) => i.code),
        ).toEqual(["USD", "RUB", "EUR"]);
        expect(json(await sb.zm("instruments", "ruble", "--json"))).toEqual([
            { id: "2", code: "RUB", title: "Russian ruble", symbol: "₽", rate: 1 },
        ]);
        expect((await sb.zm("instruments", "EUR")).stdout).toBe(
            "id  code  title  symbol  rate\n3   EUR   Euro   €       100 \n",
        );
    });

    test("tx list: newest first, filters, limit", async () => {
        const sb = await synced();
        await sb.zm(
            "sql",
            "UPDATE \"transaction\" SET json = json_set(json, '$.comment', 'a note') WHERE id = 'tx-salary'",
        );
        const ids = async (...args: string[]) =>
            json(await sb.zm("tx", "list", "--json", ...args)).map((x: { id: string }) => x.id);
        expect(await ids()).toEqual(["tx-cafe", "tx-save", "tx-salary", "tx-food"]);
        expect(await ids("--deleted")).toEqual([
            "tx-gone",
            "tx-cafe",
            "tx-save",
            "tx-salary",
            "tx-food",
        ]);
        expect(await ids("--limit", "2")).toEqual(["tx-cafe", "tx-save"]);
        expect(await ids("--kind", "transfer")).toEqual(["tx-save"]);
        expect(await ids("--tag", "Din")).toEqual(["tx-cafe"]);
        expect(await ids("--payee", "heij")).toEqual(["tx-food"]);
        expect(await ids("--payee", "note")).toEqual(["tx-salary"]);
        expect(await ids("--since", "2026-10-02")).toEqual(["tx-cafe", "tx-save"]);
        expect(await ids("--until", "2026-10-02")).toEqual(["tx-save", "tx-salary", "tx-food"]);
        expect(await ids("--account", "Revolut Savings")).toEqual(["tx-save"]);
        const [cafe] = json(await sb.zm("tx", "list", "--json", "--limit", "1"));
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
        });
        expect((await sb.zm("tx", "list", "--kind", "nothing")).stdout).toBe("(empty)\n");
    });

    test("tx show", async () => {
        const sb = await synced();
        const r = await sb.zm("tx", "show", "tx-food", "tx-cafe");
        expect(r.stdout).toBe(
            JSON.stringify(fixture("account.json").transaction![0], null, 2) +
                "\n" +
                JSON.stringify(fixture("account.json").transaction![3], null, 2) +
                "\n",
        );
        expect(await sb.zm("tx", "show", "nope")).toEqual({
            code: 1,
            stdout: "",
            stderr: "zm: not found nope\n",
        });
    });

    test("sql", async () => {
        const sb = await synced();
        expect(json(await sb.zm("sql", "select", "count(*) n", "from budget", "--json"))).toEqual([
            { n: 1 },
        ]);
        expect((await sb.zm("sql", "select 1 as one")).stdout).toBe("one\n1  \n");
    });
});

describe("writing", () => {
    test("tx add: dry run prints the payload and sends nothing", async () => {
        const sb = await synced();
        const payload = json(
            await sb.zm(
                "tx",
                "add",
                "expense",
                "--account",
                "revolut €",
                "--amount",
                "3.2",
                "--date",
                "2026-10-05",
                "--tag",
                "Groceries",
                "--tag",
                "Dining",
                "--payee",
                "Lidl",
                "--comment",
                "c",
                "--dry-run",
            ),
        );
        const [tx] = payload.transaction;
        expect(Object.keys(payload)).toEqual(["transaction"]);
        expect([tx.outcomeAccount, tx.outcome, tx.tag, tx.payee, tx.comment, tx.date]).toEqual([
            "acc-rev",
            3.2,
            ["tag-food", "tag-cafe"],
            "Lidl",
            "c",
            "2026-10-05",
        ]);
        expect(sb.api.requests).toEqual([]);
    });

    test("tx add: transfer options; a real push prints the server answer and the id", async () => {
        const sb = await synced([{ transaction: [] }]);
        const r = await sb.zm(
            "tx",
            "add",
            "transfer",
            "--account",
            "Black",
            "--amount",
            "9000",
            "--to-account",
            "Revolut €",
            "--to-amount",
            "100",
            "--date",
            "2026-10-05",
        );
        const [tx] = bodies(sb)[0]!.transaction as Record<string, unknown>[];
        expect([tx!.outcomeAccount, tx!.outcome, tx!.incomeAccount, tx!.income]).toEqual([
            "acc-black",
            9000,
            "acc-rev",
            100,
        ]);
        expect(r).toEqual({
            code: 0,
            stdout: `ok; server returned: nothing new\nid ${tx!.id}\n`,
            stderr: "",
        });
    });

    test("a push reports what the server returned", async () => {
        const sb = await synced([{ tag: fixture("account.json").tag }]);
        expect(
            (
                await sb.zm(
                    "tx",
                    "add",
                    "income",
                    "--account",
                    "Black",
                    "--amount",
                    "1",
                    "--date",
                    "2026-10-05",
                )
            ).stdout,
        ).toMatch(/^ok; server returned: \{ tag: 4 \}\nid /);
    });

    test("tx add: input errors", async () => {
        const sb = await synced();
        expect(
            (
                await sb.zm(
                    "tx",
                    "add",
                    "expense",
                    "--account",
                    "Nope",
                    "--amount",
                    "1",
                    "--date",
                    "2026-10-05",
                )
            ).stderr,
        ).toBe("zm: account not found: 'Nope'\n");
    });

    test("tx update", async () => {
        const sb = await synced([{}]);
        const dry = json(
            await sb.zm(
                "tx",
                "update",
                "tx-food",
                "tx-cafe",
                "--tag",
                "Dining",
                "--payee",
                "P",
                "--comment",
                "x",
                "--date",
                "2026-10-09",
                "--amount",
                "13",
                "--dry-run",
            ),
        );
        expect(
            dry.transaction.map((t: Record<string, unknown>) => [
                t.id,
                t.tag,
                t.payee,
                t.comment,
                t.date,
                t.outcome,
            ]),
        ).toEqual([
            ["tx-food", ["tag-cafe"], "P", "x", "2026-10-09", 13],
            ["tx-cafe", ["tag-cafe"], "P", "x", "2026-10-09", 13],
        ]);
        const moved = json(
            await sb.zm("tx", "update", "tx-food", "--account", "Black", "--dry-run"),
        ).transaction[0];
        expect(moved.outcomeAccount).toBe("acc-black");
        expect((await sb.zm("tx", "update", "tx-food", "--tag", "")).stdout).toBe(
            "ok; server returned: nothing new\n",
        );
        expect((bodies(sb)[0]!.transaction as { tag: unknown }[])[0]!.tag).toBeNull();
    });

    test("tx to-transfer: ids from arguments or stdin", async () => {
        const sb = await synced([{}]);
        const dry = json(
            await sb.zmIn(
                "  tx-food\n\n  tx-salary  \n",
                "tx",
                "to-transfer",
                "-",
                "--account",
                "Revolut Savings",
                "--dry-run",
            ),
        );
        expect(dry.transaction.map((t: { id: string }) => t.id)).toEqual(["tx-food", "tx-salary"]);
        expect(
            (await sb.zm("tx", "to-transfer", "tx-food", "--account", "Revolut Savings")).stdout,
        ).toBe("ok; server returned: nothing new\n1 transaction(s) converted\n");
        expect((await sb.zm("tx", "to-transfer", "tx-save", "--account", "Black")).stderr).toBe(
            "zm: tx-save is already a transfer\n",
        );
    });

    test("ids from an empty stdin: nothing to do", async () => {
        const sb = await synced();
        expect((await sb.zmIn("  \n", "tx", "delete", "-", "--dry-run")).stdout).toBe(
            '{\n  "transaction": []\n}\n0 transaction(s) would be deleted (dry run)\n',
        );
    });

    test("tx delete: soft or hard, dry run or real", async () => {
        const sb = await synced([{}, {}]);
        const soft = await sb.zm("tx", "delete", "tx-food", "--dry-run");
        expect(soft.stdout).toMatch(/"deleted": true/);
        expect(soft.stdout).toMatch(/\n1 transaction\(s\) would be deleted \(dry run\)\n$/);

        const hard = await sb.zm("tx", "delete", "tx-food", "--hard", "--dry-run");
        expect(
            JSON.parse(hard.stdout.slice(0, hard.stdout.lastIndexOf("}") + 1)).deletion[0],
        ).toMatchObject({
            id: "tx-food",
            object: "transaction",
            user: 1,
        });
        expect(hard.stdout).toMatch(/\n1 transaction\(s\) hard-would be deleted \(dry run\)\n$/);
        expect(sb.api.requests).toEqual([]);

        expect((await sb.zmIn("tx-food tx-cafe", "tx", "delete", "-")).stdout).toBe(
            "ok; server returned: nothing new\n2 transaction(s) deleted\n",
        );
        expect(
            (bodies(sb)[0]!.transaction as { deleted: boolean }[]).map((t) => t.deleted),
        ).toEqual([true, true]);
        expect((await sb.zm("tx", "delete", "tx-food", "--hard")).stdout).toBe(
            "ok; server returned: nothing new\n1 transaction(s) hard-deleted\n",
        );
        expect(bodies(sb)[1]!.deletion).toHaveLength(1);
    });

    test("tx import: JSONL from stdin or a file, comments, single-tag strings, chunks", async () => {
        const sb = await synced([{}, {}]);
        const lines = [
            '{"kind":"expense","account":"Revolut €","amount":1,"date":"2026-10-06","tag":"Groceries"}',
            "  # comment",
            "",
            '{"kind":"expense","account":"Revolut €","amount":2,"date":"2026-10-06","tag":["Dining"]}',
            '{"kind":"income","account":"Black","amount":3,"date":"2026-10-06"}',
        ].join("\n");
        expect((await sb.zmIn(lines, "tx", "import", "-", "--chunk", "2")).stdout).toBe(
            "3 transactions prepared\nok; server returned: nothing new\nok; server returned: nothing new\n",
        );
        const sent = bodies(sb).map((b) =>
            (b.transaction as { tag: string[] | null }[]).map((t) => t.tag),
        );
        expect(sent).toEqual([[["tag-food"], ["tag-cafe"]], [null]]);

        sb.api.requests.length = 0;
        const two = lines.split("\n").slice(0, 4).join("\n");
        await sb.zmIn(two, "tx", "import", "-", "--chunk", "2");
        expect(sb.api.requests.length).toBe(1);

        const file = path.join(sb.dir, "in.jsonl");
        writeFileSync(file, lines);
        const dry = await sb.zm("tx", "import", file, "--dry-run");
        expect(dry.stdout.startsWith("3 transactions prepared\n{\n")).toBe(true);
        expect(sb.api.requests.length).toBe(1);
    });

    test("tag add / update / delete", async () => {
        const sb = await synced([{}]);
        const added = json(
            await sb.zm("tag", "add", "Movies", "--parent", "Hobbies", "--no-income", "--dry-run"),
        ).tag[0];
        expect([added.title, added.parent, added.showIncome, added.showOutcome]).toEqual([
            "Movies",
            "tag-fun",
            false,
            true,
        ]);
        expect(
            json(await sb.zm("tag", "add", "X", "--no-outcome", "--dry-run")).tag[0].showOutcome,
        ).toBe(false);

        const updated = json(
            await sb.zm(
                "tag",
                "update",
                "Dining",
                "--title",
                "Coffee",
                "--parent",
                "",
                "--income",
                "no",
                "--outcome",
                "yes",
                "--dry-run",
            ),
        ).tag[0];
        expect([updated.title, updated.parent, updated.showIncome, updated.showOutcome]).toEqual([
            "Coffee",
            null,
            false,
            true,
        ]);

        const removed = json(
            await sb.zm("tag", "delete", "Dining", "tag-food", "--dry-run"),
        ).deletion;
        expect(removed.map((d: { id: string; object: string }) => [d.id, d.object])).toEqual([
            ["tag-cafe", "tag"],
            ["tag-food", "tag"],
        ]);

        const real = await sb.zm("tag", "add", "Real");
        expect(real.stdout).toMatch(/^ok; server returned: nothing new\nid [0-9a-f-]{36}\n$/);
    });

    test("account add / update / delete", async () => {
        const sb = await synced([{}]);
        const added = json(
            await sb.zm(
                "account",
                "add",
                "Cash",
                "--type",
                "cash",
                "--currency",
                "EUR",
                "--balance",
                "50",
                "--credit-limit",
                "5",
                "--no-in-balance",
                "--savings",
                "--dry-run",
            ),
        ).account[0];
        expect([
            added.title,
            added.type,
            added.instrument,
            added.balance,
            added.startBalance,
            added.creditLimit,
            added.inBalance,
            added.savings,
        ]).toEqual(["Cash", "cash", 3, 50, 50, 5, false, true]);
        const plain = json(await sb.zm("account", "add", "Card", "--currency", "RUB", "--dry-run"))
            .account[0];
        expect([
            plain.type,
            plain.balance,
            plain.creditLimit,
            plain.inBalance,
            plain.savings,
        ]).toEqual(["ccard", 0, 0, true, false]);

        const updated = json(
            await sb.zm(
                "account",
                "update",
                "Revolut €",
                "--title",
                "Rev",
                "--balance",
                "900",
                "--archive",
                "true",
                "--in-balance",
                "false",
                "--savings",
                "true",
                "--dry-run",
            ),
        ).account[0];
        expect([
            updated.title,
            updated.balance,
            updated.startBalance,
            updated.archive,
            updated.inBalance,
            updated.savings,
        ]).toEqual(["Rev", 900, 12.5, true, false, true]);

        const removed = json(await sb.zm("account", "delete", "Black", "--dry-run")).deletion;
        expect(removed.map((d: { id: string; object: string }) => [d.id, d.object])).toEqual([
            ["acc-black", "account"],
        ]);

        expect((await sb.zm("account", "add", "Real", "--currency", "EUR")).stdout).toMatch(
            /\nid [0-9a-f-]{36}\n$/,
        );
        expect(
            (await sb.zm("account", "add", "X", "--type", "wallet", "--currency", "EUR")).stderr,
        ).toBe(
            "zm: bad type 'wallet', one of cash, ccard, checking, loan, deposit, emoney, debt\n",
        );
    });

    test("push: raw payload from stdin or a file", async () => {
        const sb = await synced([{}]);
        const payload = { tag: [{ id: "t1", title: "x" }] };
        expect((await sb.zmIn(JSON.stringify(payload), "push", "-")).stdout).toBe(
            "ok; server returned: nothing new\n",
        );
        expect(bodies(sb)[0]!.tag).toEqual(payload.tag);
        const file = path.join(sb.dir, "p.json");
        writeFileSync(file, JSON.stringify(payload));
        expect(json(await sb.zm("push", file, "--dry-run"))).toEqual(payload);
    });
});

describe("wipe", () => {
    test("nothing selected", async () => {
        const sb = await synced();
        expect(await sb.zm("wipe")).toEqual({
            code: 1,
            stdout: "",
            stderr: "zm: nothing selected: --transactions / --tags / --accounts / --merchants\n",
        });
    });

    test("a dry run unless --yes", async () => {
        const sb = await synced();
        expect(
            (await sb.zm("wipe", "--tags", "--accounts", "--transactions", "--merchants")).stdout,
        ).toBe(
            "will delete 5 transaction(s)\nwill delete 4 tag(s)\nwill delete 4 account(s)\nwill delete 0 merchant(s)\n" +
                "dry run; add --yes to execute\n",
        );
        expect(sb.api.requests).toEqual([]);
    });

    test("--yes deletes in batches of 500; the debt account stays", async () => {
        const sb = await synced();
        const con = sb.db();
        const insert = con.prepare("INSERT INTO tag VALUES (?, 1, '{}')");
        for (let i = 0; i < 996; i++) insert.run(`t${i}`);
        const debt = { ...fixture("account.json").account![0]!, id: "acc-debt", type: "debt" };
        con.prepare("INSERT INTO account VALUES ('acc-debt', 1, ?)").run(JSON.stringify(debt));

        await sb.zm("wipe", "--tags", "--accounts", "--yes");
        const sent = bodies(sb).map((b) => b.deletion as { id: string; object: string }[]);
        expect(sent.map((d) => [d.length, d[0]!.object])).toEqual([
            [500, "tag"],
            [500, "tag"],
            [4, "account"],
        ]);
        expect(sent.flat().map((d) => d.id)).not.toContain("acc-debt");
        expect(
            new Set(
                sent
                    .slice(0, 2)
                    .flat()
                    .map((d) => d.id),
            ).size,
        ).toBe(1000);
    });
});
