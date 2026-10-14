// MCP server for Zerro (zerro.app): envelope budgeting stored inside ZenMoney.
// Built on @tihonove/zerro; every call runs in the caller's Session (synced mirror, one call at a time).
// Writes go through zerro's apply*: sync, build, push, then verify against a fresh server copy.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toolCall, type Session } from "@tihonove/mcp-kit";
import { sync, type Context } from "@tihonove/zenmoney";
import {
    applyBudget,
    applyGoal,
    applyMeta,
    applyMove,
    GOAL_TYPES,
    getEnvelopes,
    isoToday,
    loadState,
    monthReportFor,
    readModel,
    type MetaPatch,
} from "@tihonove/zerro";

export const INSTRUCTIONS = `Zerro envelope budget of the user who owns the ZenMoney token.
Every category is an envelope. Each month money is budgeted (put) into envelopes; spending takes it out;
what is left carries over to the next month (a negative balance is reset unless carryNegatives is on).
"To be budgeted" is the money in the budget not yet put into any envelope.
Envelopes can be given by name or id ("tag#…"). Months are YYYY-MM, default: the current month.
Amounts are in the envelope currency (usually the user's main currency).
Write tools change the real budget, which the user also sees in zerro.app: say what you will change first.`;

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
} as const;

const month = z
    .string()
    .regex(/^\d{4}-\d{2}$/, "YYYY-MM")
    .optional()
    .describe("YYYY-MM, default: the current month");
const envelope = z.string().describe("envelope name or id");

/** A write result without the raw ZenMoney diff. */
const withoutDiff = <T extends { diff: unknown }>({ diff: _, ...rest }: T) => rest;

export interface ZerroServerOptions {
    /** "today" for month defaults, YYYY-MM-DD; default: the real date */
    today?: () => string;
}

export function createZerroServer(
    session: Session,
    { today = isoToday }: ZerroServerOptions = {},
): McpServer {
    const server = new McpServer(
        { name: "zerro", version: "0.1.0" },
        { instructions: INSTRUCTIONS },
    );
    const call = (fn: (ctx: Context) => unknown) => toolCall(() => session.run(fn));
    const thisMonth = (m?: string) => m ?? today().slice(0, 7);

    // -------------------------------------------------------------------------------- reading

    server.registerTool(
        "month",
        {
            description:
                "A month as Zerro shows it: summary (income, budgeted, spent, overspend, to be budgeted) and every envelope " +
                "with budgeted / activity / available and what its goal still needs (goalNeed). Empty envelopes only with all.",
            inputSchema: { month, all: z.boolean().optional() },
            annotations: READ,
        },
        (a) =>
            call(({ con }) =>
                monthReportFor(con, thisMonth(a.month), { all: !!a.all, today: today() }),
            ),
    );

    server.registerTool(
        "envelopes",
        {
            description: "All envelopes in display order with ids, groups and settings.",
            annotations: READ,
        },
        () =>
            call(({ con }) =>
                Object.values(getEnvelopes(loadState(con)).byId)
                    .sort((x, y) => x.index - y.index)
                    .map((e) => ({
                        id: e.id,
                        name: e.name,
                        parent: e.parent,
                        group: e.group,
                        visibility: e.visibility,
                        currency: e.currency,
                        keepIncome: e.keepIncome,
                        carryNegatives: e.carryNegatives,
                        comment: e.comment,
                    })),
            ),
    );

    server.registerTool(
        "model",
        {
            description:
                "The raw stored Zerro model: budgets and goals by month, envelope settings, user settings.",
            annotations: READ,
        },
        () =>
            call(({ con }) => {
                const { dataAccount: _, ...model } = readModel(con);
                return model;
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
        "set_budget",
        {
            description:
                "Set how much is budgeted to an envelope in a month (0 removes it), or with add: change it by amount.",
            inputSchema: { envelope, amount: z.number(), month, add: z.boolean().optional() },
            annotations: WRITE,
        },
        (a) =>
            call(async (ctx) =>
                withoutDiff(
                    await applyBudget(ctx, a.envelope, a.amount, thisMonth(a.month), {
                        add: !!a.add,
                    }),
                ),
            ),
    );

    server.registerTool(
        "move_money",
        {
            description: "Move budgeted money from one envelope to another within a month.",
            inputSchema: { amount: z.number().positive(), from: envelope, to: envelope, month },
            annotations: { ...WRITE, idempotentHint: false },
        },
        (a) =>
            call(async (ctx) =>
                withoutDiff(await applyMove(ctx, a.amount, a.from, a.to, thisMonth(a.month))),
            ),
    );

    server.registerTool(
        "set_goal",
        {
            description:
                "Set an envelope's goal from a month on (it carries over to later months), or stop it with off. Types: " +
                "monthly — budget amount every month; monthlySpend — have amount available every month; " +
                "targetBalance — reach amount in the envelope (by end month if given); incomePercent — budget amount (0..1) of income.",
            inputSchema: {
                envelope,
                type: z.enum(GOAL_TYPES).optional(),
                amount: z.number().positive().optional(),
                end: z
                    .string()
                    .regex(/^\d{4}-\d{2}$/, "YYYY-MM")
                    .optional()
                    .describe("targetBalance: deadline month"),
                month,
                off: z.boolean().optional().describe("stop the goal from this month"),
            },
            annotations: WRITE,
        },
        (a) =>
            call(async (ctx) => {
                const goal = a.off
                    ? null
                    : { type: a.type, amount: a.amount, ...(a.end && { end: a.end }) };
                return withoutDiff(await applyGoal(ctx, a.envelope, goal, thisMonth(a.month)));
            }),
    );

    server.registerTool(
        "envelope_settings",
        {
            description:
                'Change envelope settings: group ("" = default), position, comment ("" removes), visibility, currency, ' +
                "carry_negatives (a negative balance carries over), keep_income (income stays in the envelope).",
            inputSchema: {
                envelope,
                group: z.string().optional(),
                index: z.number().int().optional(),
                comment: z.string().optional(),
                visibility: z.enum(["hidden", "visible", "auto"]).optional(),
                currency: z.string().optional(),
                carry_negatives: z.boolean().optional(),
                keep_income: z.boolean().optional(),
            },
            annotations: WRITE,
        },
        (a) =>
            call(async (ctx) => {
                const patch: MetaPatch = {};
                if (a.group !== undefined) patch.group = a.group || undefined;
                if (a.index !== undefined) patch.index = a.index;
                if (a.comment !== undefined) patch.comment = a.comment || undefined;
                if (a.visibility !== undefined) patch.visibility = a.visibility;
                if (a.currency !== undefined) patch.currency = a.currency;
                if (a.carry_negatives !== undefined) patch.carryNegatives = a.carry_negatives;
                if (a.keep_income !== undefined) patch.keepIncome = a.keep_income;
                return withoutDiff(await applyMeta(ctx, a.envelope, patch));
            }),
    );

    return server;
}
