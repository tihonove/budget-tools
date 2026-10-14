// MCP server for ZenMoney: read and edit accounts, categories and transactions.
// Built on @tihonove/zenmoney; every call runs in the caller's Session (synced mirror, one call at a time).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolCall, type Session } from "@tihonove/mcp-kit";
import {
    ACCOUNT_TYPES,
    load,
    newAccount,
    newTag,
    newTransaction,
    push,
    rows,
    softDeleteTransactions,
    sync,
    toTransfers,
    updateAccount,
    updateTag,
    updateTransactions,
    ZmError,
    type Context,
    type Diff,
    type SqlValue,
} from "@tihonove/zenmoney";

export const INSTRUCTIONS = `ZenMoney (personal finance) of the user who owns the token.
Accounts and categories can be given by title or id. Amounts are positive numbers in the account's currency.
A transaction is an expense (outcome), an income, or a transfer between accounts.
Data is a mirror synced at most a minute ago; call "sync" to refresh now.
Write tools change the user's real data: say what you are going to change before calling them.`;

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const ids = z.array(z.string()).min(1).describe("transaction ids");

async function send(ctx: Context, payload: Diff) {
    const server = await push(ctx.con, ctx.remote, payload);
    return { server };
}

export function createZenmoneyServer(session: Session): McpServer {
    const server = new McpServer(
        { name: "zenmoney", version: "0.1.0" },
        { instructions: INSTRUCTIONS },
    );
    const call = (fn: (ctx: Context) => unknown) => toolCall(() => session.run(fn));

    // -------------------------------------------------------------------------------- reading

    server.registerTool(
        "accounts",
        {
            description:
                "List accounts with balances. Archived accounts only with include_archived.",
            inputSchema: { include_archived: z.boolean().optional() },
            annotations: READ,
        },
        ({ include_archived }) =>
            call(({ con }) =>
                rows(
                    con,
                    "SELECT id, title, type, currency, balance, in_balance, savings, archive FROM v_accounts" +
                        (include_archived ? "" : " WHERE NOT archive") +
                        " ORDER BY archive, type, title",
                ),
            ),
    );

    server.registerTool(
        "categories",
        { description: "List categories (tags) with their parent.", annotations: READ },
        () =>
            call(({ con }) =>
                rows(
                    con,
                    "SELECT id, title, parent, parent_title, show_income, show_outcome FROM v_tags " +
                        "ORDER BY coalesce(parent_title, title), parent IS NOT NULL, title",
                ),
            ),
    );

    server.registerTool(
        "transactions",
        {
            description:
                "Find transactions, newest first. Filters combine; text matches payee or comment, category a substring of the category path.",
            inputSchema: {
                since: date.optional(),
                until: date.optional(),
                account: z.string().optional().describe("account title (either side)"),
                category: z.string().optional(),
                text: z.string().optional(),
                kind: z.enum(["expense", "income", "transfer"]).optional(),
                include_deleted: z.boolean().optional(),
                limit: z.number().int().min(1).max(1000).optional().describe("default 100"),
            },
            annotations: READ,
        },
        (args) =>
            call(({ con }) => {
                const where: string[] = [];
                const params: SqlValue[] = [];
                const add = (clause: string, ...values: string[]) => {
                    where.push(clause);
                    params.push(...values);
                };
                if (!args.include_deleted) add("NOT deleted");
                if (args.since) add("date >= ?", args.since);
                if (args.until) add("date <= ?", args.until);
                if (args.account)
                    add("(outcome_account = ? OR income_account = ?)", args.account, args.account);
                if (args.category) add("tags LIKE ?", `%${args.category}%`);
                if (args.text)
                    add("(payee LIKE ? OR comment LIKE ?)", `%${args.text}%`, `%${args.text}%`);
                if (args.kind) add("kind = ?", args.kind);
                params.push(args.limit ?? 100);
                return rows(
                    con,
                    "SELECT id, date, kind, outcome, outcome_currency, outcome_account, income, income_currency, " +
                        "income_account, tags, payee, comment, deleted FROM v_tx" +
                        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
                        " ORDER BY date DESC, created DESC LIMIT ?",
                    params,
                );
            }),
    );

    server.registerTool(
        "transaction",
        {
            description: "One transaction as stored by ZenMoney (raw JSON).",
            inputSchema: { id: z.string() },
            annotations: READ,
        },
        ({ id }) =>
            call(({ con }) => load(con, "transaction", id) ?? fail(`transaction not found: ${id}`)),
    );

    server.registerTool(
        "query",
        {
            description:
                "Read-only SQL over the mirror. Tables (id, changed, json): account, tag, merchant, budget, reminder, " +
                "instrument, user, \"transaction\" (quote it); use json->>'$.field'. Views: v_accounts, v_tags, v_tx.",
            inputSchema: { sql: z.string() },
            annotations: READ,
        },
        ({ sql }) =>
            call(({ con }) => {
                con.exec("PRAGMA query_only = ON");
                try {
                    return rows(con, sql);
                } catch (e) {
                    throw new ZmError(`SQL: ${(e as Error).message}`);
                } finally {
                    con.exec("PRAGMA query_only = OFF");
                }
            }),
    );

    server.registerTool(
        "sync",
        {
            description:
                "Pull the latest changes from ZenMoney now (normally done automatically, at most a minute old).",
            annotations: { readOnlyHint: true, openWorldHint: true },
        },
        () => call(async (ctx) => ({ received: await sync(ctx.con, ctx.remote) })),
    );

    // -------------------------------------------------------------------------------- writing

    server.registerTool(
        "add_transaction",
        {
            description: "Create an expense, income or transfer.",
            inputSchema: {
                kind: z.enum(["expense", "income", "transfer"]),
                account: z.string().describe("account title or id; for transfers the source"),
                amount: z.number().positive(),
                date,
                to_account: z.string().optional().describe("transfers: the receiving account"),
                to_amount: z
                    .number()
                    .positive()
                    .optional()
                    .describe("transfers between currencies: amount received"),
                categories: z.array(z.string()).optional().describe("category titles or ids"),
                payee: z.string().optional(),
                comment: z.string().optional(),
            },
            annotations: WRITE,
        },
        (a) =>
            call(async (ctx) => {
                const transaction = newTransaction(ctx.con, { ...a, tag: a.categories });
                return { transaction, ...(await send(ctx, { transaction: [transaction] })) };
            }),
    );

    server.registerTool(
        "update_transactions",
        {
            description:
                "Change expenses / incomes: categories (replace; [] = none), payee, comment ('' clears), date, amount, account.",
            inputSchema: {
                ids,
                categories: z.array(z.string()).optional(),
                payee: z.string().optional(),
                comment: z.string().optional(),
                date: date.optional(),
                amount: z.number().positive().optional(),
                account: z.string().optional(),
            },
            annotations: { ...WRITE, idempotentHint: true },
        },
        (a) =>
            call(async (ctx) => {
                const transactions = updateTransactions(ctx.con, a.ids, {
                    ...a,
                    tag: a.categories,
                });
                return { transactions, ...(await send(ctx, { transaction: transactions })) };
            }),
    );

    server.registerTool(
        "convert_to_transfers",
        {
            description:
                "Turn expenses / incomes into transfers with `account` on the other side (same currency only): an expense becomes this account → account, an income account → this account.",
            inputSchema: { ids, account: z.string() },
            annotations: { ...WRITE, idempotentHint: true },
        },
        ({ ids: list, account }) =>
            call(async (ctx) => {
                const transactions = toTransfers(ctx.con, list, account);
                return { transactions, ...(await send(ctx, { transaction: transactions })) };
            }),
    );

    server.registerTool(
        "delete_transactions",
        {
            description:
                "Mark transactions as deleted (ZenMoney keeps them as deleted). Prefer fixing bank transactions instead.",
            inputSchema: { ids },
            annotations: { ...WRITE, destructiveHint: true, idempotentHint: true },
        },
        ({ ids: list }) =>
            call(async (ctx) => {
                const transactions = softDeleteTransactions(ctx.con, list);
                return { deleted: list, ...(await send(ctx, { transaction: transactions })) };
            }),
    );

    server.registerTool(
        "add_category",
        {
            description: "Create a category.",
            inputSchema: {
                title: z.string().min(1),
                parent: z.string().optional(),
                income: z.boolean().optional().describe("shown for incomes, default true"),
                outcome: z.boolean().optional().describe("shown for expenses, default true"),
            },
            annotations: WRITE,
        },
        (a) =>
            call(async (ctx) => {
                const category = newTag(ctx.con, a);
                return { category, ...(await send(ctx, { tag: [category] })) };
            }),
    );

    server.registerTool(
        "update_category",
        {
            description:
                "Rename a category, move it ('' parent = top level), toggle income / expense use.",
            inputSchema: {
                category: z.string(),
                title: z.string().min(1).optional(),
                parent: z.string().optional(),
                income: z.boolean().optional(),
                outcome: z.boolean().optional(),
            },
            annotations: { ...WRITE, idempotentHint: true },
        },
        ({ category: key, ...patch }) =>
            call(async (ctx) => {
                const category = updateTag(ctx.con, key, patch);
                return { category, ...(await send(ctx, { tag: [category] })) };
            }),
    );

    server.registerTool(
        "add_account",
        {
            description: "Create a manual account.",
            inputSchema: {
                title: z.string().min(1),
                currency: z.string().describe("EUR, RUB, … or an instrument id"),
                type: z.enum(ACCOUNT_TYPES).optional().describe("default ccard"),
                balance: z.number().optional(),
                in_balance: z.boolean().optional().describe("counted in the total, default true"),
                savings: z.boolean().optional(),
            },
            annotations: WRITE,
        },
        (a) =>
            call(async (ctx) => {
                const account = newAccount(ctx.con, a);
                return { account, ...(await send(ctx, { account: [account] })) };
            }),
    );

    server.registerTool(
        "update_account",
        {
            description:
                "Rename, set the current balance, archive, include in / exclude from the total.",
            inputSchema: {
                account: z.string(),
                title: z.string().min(1).optional(),
                balance: z.number().optional(),
                archive: z.boolean().optional(),
                in_balance: z.boolean().optional(),
                savings: z.boolean().optional(),
            },
            annotations: { ...WRITE, idempotentHint: true },
        },
        ({ account: key, ...patch }) =>
            call(async (ctx) => {
                const account = updateAccount(ctx.con, key, patch);
                return { account, ...(await send(ctx, { account: [account] })) };
            }),
    );

    return server;
}

function fail(message: string): never {
    throw new ZmError(message);
}
