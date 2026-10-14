// zm — ZenMoney CLI: parses options, prints results. Runs in-process: main(argv, io) → exit code.
//
// Token: env ZENMONEY_TOKEN, or .secrets/token (create with `zm auth`).
// Get a personal token at https://zerro.app/token
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { inspect } from "node:util";
import {
    collect,
    createProgram,
    parseBool,
    parseNumber,
    printRows,
    runProgram,
    UserError,
    type Io,
} from "@tihonove/cli-kit";
import {
    checkToken,
    deletion,
    envConfig,
    load,
    makeRemote,
    metaGet,
    open,
    push,
    q,
    resolve,
    rows,
    sync,
    user,
    type Context,
    type Counts,
} from "./store.ts";
import {
    newAccount,
    newTag,
    newTransaction,
    softDeleteTransactions,
    toTransfers,
    updateAccount,
    updateTag,
    updateTransactions,
    type NewTransaction,
} from "./objects.ts";
import { ACCOUNT_TYPES, ENTITIES, type Diff, type EntityName, type Transaction } from "./types.ts";

const TOKEN_PAGE = "https://zerro.app/token";

/** What the server sent back, on one line. */
const summary = (counts: Counts): string =>
    Object.keys(counts).length ? inspect(counts, { breakLength: Infinity }) : "nothing new";

/** Run zm with these arguments; returns the exit code. */
export function main(argv: string[], io: Io): Promise<number> {
    return runProgram(program(io), argv, io);
}

function program(io: Io) {
    const zm = createProgram("zm", io)
        .description("ZenMoney CLI with a local mirror (zenmoney.db).")
        .addHelpText("after", "\nToken: ZENMONEY_TOKEN or .secrets/token (zm auth).");

    const context = (): Context => open(envConfig(io.env, io.cwd));
    const mirror = () => context().con;

    /** Push a payload, or print it with --dry-run. */
    async function send(ctx: Context, payload: Diff, dryRun?: boolean) {
        if (dryRun) {
            io.log(JSON.stringify(payload, null, 2));
            return;
        }
        const counts = await push(ctx.con, ctx.remote, payload);
        io.log(`ok; server returned: ${summary(counts)}`);
    }

    /** Ids from arguments, or from stdin when the only argument is "-". */
    const ids = (args: string[]): string[] =>
        args[0] === "-" ? (io.readInput("-").match(/\S+/g) ?? []) : args;

    // ------------------------------------------------------------------------- auth / sync

    zm.command("auth")
        .description("store the API token in .secrets/token")
        .addHelpText(
            "after",
            `\nOpens ${TOKEN_PAGE} in your browser (sign in with ZenMoney there), then asks you to paste\n` +
                "the token. Also accepts the token on stdin: echo TOKEN | zm auth",
        )
        .option("--no-browser", "don't open the token page")
        .option("--no-check", "don't validate the token with the API")
        .action(async (opts: { browser: boolean; check: boolean }) => {
            const config = envConfig(io.env, io.cwd);
            const tokenFile = config.tokenFile!;
            mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });

            const token = (io.isTTY ? await askToken(io, opts.browser) : io.readInput("-")).trim();
            if (!token) throw new UserError("empty token");

            if (opts.check) {
                const owner = await checkToken(makeRemote(config), token);
                if (!owner) {
                    throw new UserError(
                        `token rejected by ${config.api} (wrong token, or the account lives on api.zenmoney.app` +
                            " — try ZENMONEY_API=https://api.zenmoney.app)",
                    );
                }
                io.log(`token ok: user ${owner.id}${owner.login ? ` (${owner.login})` : ""}`);
            }
            writeFileSync(tokenFile, token + "\n");
            chmodSync(tokenFile, 0o600);
            io.log(`saved to ${tokenFile}`);
        });

    zm.command("sync")
        .description("pull changes from the server into zenmoney.db")
        .option("--full", "drop the mirror and download everything again")
        .action(async (opts: { full?: boolean }) => {
            const { con, remote } = context();
            const counts = await sync(con, remote, { full: !!opts.full });
            io.log(
                `synced: ${summary(counts)} | serverTimestamp = ${metaGet(con, "serverTimestamp")}`,
            );
        });

    // --------------------------------------------------------------------------- reading

    zm.command("status")
        .description("show user, sync time, object counts")
        .action(() => {
            const con = mirror();
            const me = user(con);
            const currency = load(con, "instrument", me.currency);
            io.log(
                `user ${me.id} (${me.login ?? "?"}), main currency ${currency?.shortTitle ?? me.currency}`,
            );

            const ts = Number(metaGet(con, "serverTimestamp") ?? 0);
            io.log(`serverTimestamp ${ts} (${ts ? new Date(ts * 1000).toISOString() : "never"})`);
            for (const e of ENTITIES) {
                const { n } = con.prepare(`SELECT count(*) n FROM ${q(e)}`).get() as { n: number };
                if (n) io.log(`  ${e.padEnd(16)} ${n}`);
            }
            const { n: deleted } = con
                .prepare("SELECT count(*) n FROM v_tx WHERE deleted")
                .get() as {
                n: number;
            };
            if (deleted) io.log(`  (of which deleted transactions: ${deleted})`);
        });

    zm.command("accounts")
        .description("list accounts")
        .option("--all", "include archived")
        .option("--json", "print JSON")
        .action((opts: { all?: boolean; json?: boolean }) => {
            const where = opts.all ? "" : "WHERE NOT archive";
            const sql =
                "SELECT id, title, type, currency, balance, in_balance, savings, archive " +
                `FROM v_accounts ${where} ORDER BY archive, type, title`;
            printRows(io, rows(mirror(), sql), opts.json);
        });

    zm.command("tags")
        .description("list categories as a tree")
        .option("--json", "print JSON")
        .action((opts: { json?: boolean }) => {
            const list = rows(
                mirror(),
                "SELECT id, title, parent, parent_title, show_income, show_outcome FROM v_tags " +
                    "ORDER BY coalesce(parent_title, title), parent IS NOT NULL, title",
            );
            if (opts.json) return printRows(io, list, true);
            for (const t of list) {
                const indent = t.parent ? "    " : "";
                const flags = (t.show_income ? "in " : "   ") + (t.show_outcome ? "out" : "");
                io.log(`${indent}${String(t.title).padEnd(40)} ${t.id}  ${flags}`);
            }
        });

    zm.command("instruments")
        .description("list currencies")
        .argument("[query]", "substring of code or title")
        .option("--json", "print JSON")
        .action((query: string | undefined, opts: { json?: boolean }) => {
            const like = `%${query ?? ""}%`;
            const sql =
                "SELECT id, json->>'$.shortTitle' code, json->>'$.title' title, json->>'$.symbol' symbol, " +
                "json->>'$.rate' rate FROM instrument WHERE code LIKE ? OR title LIKE ? ORDER BY id";
            printRows(io, rows(mirror(), sql, [like, like]), opts.json);
        });

    // ------------------------------------------------------------------------ transactions

    const tx = zm.command("tx").description("transactions");

    tx.command("list")
        .description("list transactions from the mirror")
        .option("--since <date>", "from date, YYYY-MM-DD")
        .option("--until <date>", "to date, YYYY-MM-DD")
        .option("--account <title>", "outcome or income account")
        .option("--tag <text>", "substring of the category title")
        .option("--payee <text>", "substring of payee or comment")
        .option("--kind <kind>", "expense | income | transfer")
        .option("--deleted", "include deleted")
        .option("--limit <n>", "how many, newest first", parseNumber, 50)
        .option("--json", "print JSON")
        .action((opts: TxListOptions) => {
            const where: string[] = [];
            const params: string[] = [];
            const add = (clause: string, ...values: string[]) => {
                where.push(clause);
                params.push(...values);
            };
            if (!opts.deleted) add("NOT deleted");
            if (opts.since) add("date >= ?", opts.since);
            if (opts.until) add("date <= ?", opts.until);
            if (opts.account)
                add("(outcome_account = ? OR income_account = ?)", opts.account, opts.account);
            if (opts.tag) add("tags LIKE ?", `%${opts.tag}%`);
            if (opts.payee)
                add("(payee LIKE ? OR comment LIKE ?)", `%${opts.payee}%`, `%${opts.payee}%`);
            if (opts.kind) add("kind = ?", opts.kind);

            const sql =
                "SELECT id, date, kind, outcome, outcome_currency, outcome_account, income, income_currency, " +
                "income_account, tags, payee, comment FROM v_tx" +
                (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
                ` ORDER BY date DESC, created DESC LIMIT ${Number(opts.limit)}`;
            printRows(io, rows(mirror(), sql, params), opts.json);
        });

    tx.command("show")
        .description("print raw transaction JSON")
        .argument("<ids...>")
        .action((list: string[]) => {
            const con = mirror();
            for (const id of list) {
                const found = load(con, "transaction", id) ?? fail(`not found ${id}`);
                io.log(JSON.stringify(found, null, 2));
            }
        });

    tx.command("add")
        .description("add one transaction")
        .argument("<kind>", "expense | income | transfer")
        .requiredOption("--account <title>", "account title or id")
        .requiredOption("--amount <n>", "amount", parseNumber)
        .requiredOption("--date <date>", "YYYY-MM-DD")
        .option("--to-account <title>", "transfers: the receiving account")
        .option("--to-amount <n>", "transfers between currencies: the received amount", parseNumber)
        .option("--tag <title>", "category title or id (repeatable)", collect)
        .option("--payee <text>")
        .option("--comment <text>")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (kind: string, opts: TxAddOptions) => {
            const ctx = context();
            const transaction = newTransaction(ctx.con, {
                kind,
                account: opts.account,
                amount: opts.amount,
                date: opts.date,
                to_account: opts.toAccount,
                to_amount: opts.toAmount,
                tag: opts.tag,
                payee: opts.payee,
                comment: opts.comment,
            });
            await send(ctx, { transaction: [transaction] }, opts.dryRun);
            if (!opts.dryRun) io.log("id", transaction.id);
        });

    tx.command("update")
        .description("update fields of one or more transactions (expense / income)")
        .argument("<ids...>")
        .option("--tag <title>", "replaces categories; '' = none (repeatable)", collect)
        .option("--payee <text>", "'' clears")
        .option("--comment <text>", "'' clears")
        .option("--date <date>", "YYYY-MM-DD")
        .option("--amount <n>", "amount", parseNumber)
        .option("--account <title>", "move to another account")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (list: string[], opts: TxUpdateOptions) => {
            const ctx = context();
            await send(ctx, { transaction: updateTransactions(ctx.con, list, opts) }, opts.dryRun);
        });

    tx.command("to-transfer")
        .description(
            "turn expenses / incomes into transfers with the given account on the other side",
        )
        .addHelpText(
            "after",
            '\nAn expense becomes "this account -> ACCOUNT", an income becomes "ACCOUNT -> this account".\n' +
                "The amount is copied as is, so both accounts must share a currency (use `zm push` otherwise).",
        )
        .argument("<ids...>", "transaction ids; '-' reads them from stdin")
        .requiredOption("--account <title>", "the other side of the transfer")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (list: string[], opts: { account: string; dryRun?: boolean }) => {
            const ctx = context();
            const transactions = toTransfers(ctx.con, ids(list), opts.account);
            await send(ctx, { transaction: transactions }, opts.dryRun);
            if (!opts.dryRun) io.log(`${transactions.length} transaction(s) converted`);
        });

    tx.command("delete")
        .description("delete transactions")
        .argument("<ids...>", "transaction ids; '-' reads them from stdin")
        .option("--hard", "hard delete instead of deleted=true")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (list: string[], opts: { hard?: boolean; dryRun?: boolean }) => {
            const ctx = context();
            const which = ids(list);
            const payload: Diff = opts.hard
                ? { deletion: deletion(ctx.con, "transaction", which) }
                : { transaction: softDeleteTransactions(ctx.con, which) };
            await send(ctx, payload, opts.dryRun);
            const what = opts.dryRun ? "would be deleted (dry run)" : "deleted";
            io.log(`${which.length} transaction(s) ${opts.hard ? "hard-" : ""}${what}`);
        });

    tx.command("import")
        .description("bulk create from JSONL, one transaction per line")
        .addHelpText(
            "after",
            "\nLines (# starts a comment):\n" +
                '  {"kind":"expense","account":"Revolut €","amount":12.5,"date":"2026-10-01","tag":["Meal"],"payee":"..."}\n' +
                '  {"kind":"transfer","account":"Tinkoff","amount":1000,"to_account":"Cash ₽","to_amount":1000,"date":"2026-10-01"}',
        )
        .argument("<file>", "JSONL file; '-' = stdin")
        .option("--chunk <n>", "transactions per request", parseNumber, 500)
        .option("--dry-run", "print the payloads instead of sending them")
        .action(async (file: string, opts: { chunk: number; dryRun?: boolean }) => {
            const ctx = context();
            const transactions: Transaction[] = [];
            for (const line of io.readInput(file).split("\n")) {
                const text = line.trim();
                if (!text || text.startsWith("#")) continue;
                const input = JSON.parse(text) as NewTransaction & { tag?: string | string[] };
                if (typeof input.tag === "string") input.tag = [input.tag];
                transactions.push(newTransaction(ctx.con, input as NewTransaction));
            }
            io.log(`${transactions.length} transactions prepared`);
            for (let i = 0; i < transactions.length; i += opts.chunk) {
                await send(
                    ctx,
                    { transaction: transactions.slice(i, i + opts.chunk) },
                    opts.dryRun,
                );
            }
        });

    // ------------------------------------------------------------------------------- tags

    const tag = zm.command("tag").description("categories");

    tag.command("add")
        .description("create a category")
        .argument("<title>")
        .option("--parent <title>", "parent category")
        .option("--no-income", "not shown for incomes")
        .option("--no-outcome", "not shown for expenses")
        .option("--dry-run", "print the payload instead of sending it")
        .action(
            async (
                title: string,
                opts: { parent?: string; income: boolean; outcome: boolean; dryRun?: boolean },
            ) => {
                const ctx = context();
                const created = newTag(ctx.con, {
                    title,
                    parent: opts.parent,
                    income: opts.income,
                    outcome: opts.outcome,
                });
                await send(ctx, { tag: [created] }, opts.dryRun);
                if (!opts.dryRun) io.log("id", created.id);
            },
        );

    tag.command("update")
        .description("rename / reparent / toggle a category")
        .argument("<tag>", "title or id")
        .option("--title <title>", "new title")
        .option("--parent <title>", "new parent; '' = top level")
        .option("--income <bool>", "shown for incomes", parseBool)
        .option("--outcome <bool>", "shown for expenses", parseBool)
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (key: string, opts: TagUpdateOptions) => {
            const ctx = context();
            await send(ctx, { tag: [updateTag(ctx.con, key, opts)] }, opts.dryRun);
        });

    tag.command("delete")
        .description("hard-delete categories")
        .argument("<tags...>", "titles or ids")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (keys: string[], opts: { dryRun?: boolean }) => {
            const ctx = context();
            const list = keys.map((k) => resolve(ctx.con, "tag", k).id);
            await send(ctx, { deletion: deletion(ctx.con, "tag", list) }, opts.dryRun);
        });

    // --------------------------------------------------------------------------- accounts

    const account = zm.command("account").description("accounts");

    account
        .command("add")
        .description("create an account")
        .argument("<title>")
        .requiredOption("--currency <code>", "EUR / RUB / instrument id")
        .option("--type <type>", ACCOUNT_TYPES.join(" | "), "ccard")
        .option("--balance <n>", "current balance", parseNumber, 0)
        .option("--credit-limit <n>", "credit limit", parseNumber, 0)
        .option("--no-in-balance", "keep out of the total balance")
        .option("--savings", "a savings account")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (title: string, opts: AccountAddOptions) => {
            const ctx = context();
            const created = newAccount(ctx.con, {
                title,
                type: opts.type,
                currency: opts.currency,
                balance: opts.balance,
                in_balance: opts.inBalance,
                savings: !!opts.savings,
                credit_limit: opts.creditLimit,
            });
            await send(ctx, { account: [created] }, opts.dryRun);
            if (!opts.dryRun) io.log("id", created.id);
        });

    account
        .command("update")
        .description("rename / set balance / archive an account")
        .argument("<account>", "title or id")
        .option("--title <title>", "new title")
        .option("--balance <n>", "set the current balance", parseNumber)
        .option("--archive <bool>", "archived", parseBool)
        .option("--in-balance <bool>", "counted in the total balance", parseBool)
        .option("--savings <bool>", "a savings account", parseBool)
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (key: string, opts: AccountUpdateOptions) => {
            const ctx = context();
            const updated = updateAccount(ctx.con, key, {
                title: opts.title,
                balance: opts.balance,
                archive: opts.archive,
                in_balance: opts.inBalance,
                savings: opts.savings,
            });
            await send(ctx, { account: [updated] }, opts.dryRun);
        });

    account
        .command("delete")
        .description("hard-delete accounts")
        .argument("<accounts...>", "titles or ids")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (keys: string[], opts: { dryRun?: boolean }) => {
            const ctx = context();
            const list = keys.map((k) => resolve(ctx.con, "account", k).id);
            await send(ctx, { deletion: deletion(ctx.con, "account", list) }, opts.dryRun);
        });

    // ------------------------------------------------------------------------------- raw

    zm.command("push")
        .description("send a raw diff payload (JSON with entity arrays and/or deletion)")
        .argument("<file>", "JSON file; '-' = stdin")
        .option("--dry-run", "print the payload instead of sending it")
        .action(async (file: string, opts: { dryRun?: boolean }) => {
            await send(context(), JSON.parse(io.readInput(file)) as Diff, opts.dryRun);
        });

    zm.command("sql")
        .description(
            `query the mirror. Tables: ${ENTITIES.join(", ")} (id, changed, json); views: v_accounts, v_tags, v_tx`,
        )
        .argument("<query...>")
        .option("--json", "print JSON")
        .action((query: string[], opts: { json?: boolean }) => {
            printRows(io, rows(mirror(), query.join(" ")), opts.json);
        });

    zm.command("wipe")
        .description("hard-delete EVERYTHING of a kind (dry run unless --yes)")
        .option("--transactions", "all transactions")
        .option("--tags", "all categories")
        .option("--accounts", "all accounts except the debt one")
        .option("--merchants", "all merchants")
        .option("--yes", "actually do it")
        .action(async (opts: WipeOptions) => {
            const ctx = context();
            const idsOf = (sql: string) =>
                (ctx.con.prepare(sql).all() as { id: string }[]).map((r) => r.id);
            const plan: [EntityName, string[]][] = [];
            if (opts.transactions)
                plan.push(["transaction", idsOf('SELECT id FROM "transaction"')]);
            if (opts.tags) plan.push(["tag", idsOf("SELECT id FROM tag")]);
            if (opts.accounts)
                plan.push(["account", idsOf("SELECT id FROM v_accounts WHERE type != 'debt'")]);
            if (opts.merchants) plan.push(["merchant", idsOf("SELECT id FROM merchant")]);
            if (plan.length === 0)
                throw new UserError(
                    "nothing selected: --transactions / --tags / --accounts / --merchants",
                );

            for (const [entity, list] of plan) io.log(`will delete ${list.length} ${entity}(s)`);
            if (!opts.yes) {
                io.log("dry run; add --yes to execute");
                return;
            }
            for (const [entity, list] of plan) {
                for (let i = 0; i < list.length; i += 500) {
                    await send(ctx, {
                        deletion: deletion(ctx.con, entity, list.slice(i, i + 500)),
                    });
                }
            }
        });

    return zm;
}

function fail(message: string): never {
    throw new UserError(message);
}

// Interactive token prompt: needs a real terminal, exercised by hand only.
/* v8 ignore start */
// Stryker disable all
async function askToken(io: Io, openBrowser: boolean): Promise<string> {
    if (openBrowser) {
        const { spawn } = await import("node:child_process");
        const opener =
            process.platform === "darwin"
                ? "open"
                : process.platform === "win32"
                  ? "start"
                  : "xdg-open";
        try {
            spawn(opener, [TOKEN_PAGE], { detached: true, stdio: "ignore" })
                .on("error", () => {})
                .unref();
        } catch {
            // no browser: the URL is printed below anyway
        }
        io.log(`Opening ${TOKEN_PAGE} — sign in with ZenMoney there and copy the token.`);
    } else {
        io.log(`Get the token at ${TOKEN_PAGE}`);
    }
    const question = "Paste token (input hidden): ";
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
        });
        // no echo: print the question only
        (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
            if (s.includes(question)) process.stdout.write(question);
        };
        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write("\n");
            resolve(answer);
        });
    });
}
// Stryker restore all
/* v8 ignore stop */

interface TxListOptions {
    since?: string;
    until?: string;
    account?: string;
    tag?: string;
    payee?: string;
    kind?: string;
    deleted?: boolean;
    limit: number;
    json?: boolean;
}

interface TxAddOptions {
    account: string;
    amount: number;
    date: string;
    toAccount?: string;
    toAmount?: number;
    tag?: string[];
    payee?: string;
    comment?: string;
    dryRun?: boolean;
}

interface TxUpdateOptions {
    tag?: string[];
    payee?: string;
    comment?: string;
    date?: string;
    amount?: number;
    account?: string;
    dryRun?: boolean;
}

interface TagUpdateOptions {
    title?: string;
    parent?: string;
    income?: boolean;
    outcome?: boolean;
    dryRun?: boolean;
}

interface AccountAddOptions {
    currency: string;
    type: string;
    balance: number;
    creditLimit: number;
    inBalance: boolean;
    savings?: boolean;
    dryRun?: boolean;
}

interface AccountUpdateOptions {
    title?: string;
    balance?: number;
    archive?: boolean;
    inBalance?: boolean;
    savings?: boolean;
    dryRun?: boolean;
}

interface WipeOptions {
    transactions?: boolean;
    tags?: boolean;
    accounts?: boolean;
    merchants?: boolean;
    yes?: boolean;
}
