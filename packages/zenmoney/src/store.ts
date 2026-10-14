// ZenMoney API client + local sqlite mirror (zenmoney.db).
//
// Talks to https://api.zenmoney.ru/v8/diff/ and keeps a full local mirror, so reads are instant
// and writes are built from cached objects. Functions throw ZmError instead of printing, so the
// same code serves the CLIs, the MCP servers and tests.
//
// A context has two halves:
//   con    — the local mirror (DatabaseSync); every read takes it;
//   remote — { api, token() } for sync and push.
// open() builds both from explicit options; envConfig() reads them from an environment:
// ZENMONEY_API, ZENMONEY_DB (default ./zenmoney.db), ZENMONEY_TOKEN / ZENMONEY_TOKEN_FILE
// (default ./.secrets/token).
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
    ENTITIES,
    type Deletion,
    type Diff,
    type Entities,
    type EntityName,
    type Instrument,
    type User,
} from "./types.ts";

export const DEFAULT_API = "https://api.zenmoney.ru";

/** Expected failures (bad input, not found, API refused): shown as a message, without a stack. */
export class ZmError extends Error {
    readonly userFacing = true;
}

export function fail(message: string): never {
    throw new ZmError(message);
}

export const now = (): number => Math.floor(Date.now() / 1000);
export const uuid = (): string => crypto.randomUUID();

/** Quote a table name: "transaction" is a reserved word in SQLite. */
export const q = (name: string): string => `"${name}"`;

// ---------------------------------------------------------------------------------- config

export interface Config {
    api: string;
    /** sqlite file, or ":memory:" */
    db: string;
    token?: string | undefined;
    tokenFile?: string | undefined;
}

/** Context options from an environment (process.env by default); paths resolve against `cwd`. */
export function envConfig(
    env: Record<string, string | undefined> = process.env,
    cwd: string = process.cwd(),
): Config {
    return {
        api: env.ZENMONEY_API || DEFAULT_API,
        db: path.resolve(cwd, env.ZENMONEY_DB || "zenmoney.db"),
        token: env.ZENMONEY_TOKEN?.trim() || undefined,
        tokenFile: path.resolve(cwd, env.ZENMONEY_TOKEN_FILE || path.join(".secrets", "token")),
    };
}

export interface Remote {
    api: string;
    /** The API token; read lazily, so offline commands work without one. */
    token(): string;
}

export function makeRemote({ api = DEFAULT_API, token, tokenFile }: Partial<Config> = {}): Remote {
    return {
        api,
        token() {
            if (token) return token;
            if (tokenFile && existsSync(tokenFile)) return readFileSync(tokenFile, "utf8").trim();
            return fail("no token: run `zm auth` or set ZENMONEY_TOKEN");
        },
    };
}

export interface Context {
    con: DatabaseSync;
    remote: Remote;
}

/** Open a context. Options override envConfig() (the process environment). */
export function open(options: Partial<Config> = {}): Context {
    const config = { ...envConfig(), ...options };
    return { con: db(config.db), remote: makeRemote(config) };
}

// ------------------------------------------------------------------------------------ http

async function apiPost<T>(
    remote: Remote,
    url: string,
    body: unknown,
    token = remote.token(),
): Promise<T> {
    const response = await fetch(remote.api + url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    if (!response.ok) fail(`API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    return (await response.json()) as T;
}

/** The root user a token belongs to, or null if the API rejects the token. */
export async function checkToken(remote: Remote, token = remote.token()): Promise<User | null> {
    try {
        const body = {
            currentClientTimestamp: now(),
            serverTimestamp: now(),
            forceFetch: ["user"],
        };
        const response = await apiPost<Diff>(remote, "/v8/diff/", body, token);
        return rootUser(response.user ?? []);
    } catch (e) {
        if (e instanceof ZmError) return null;
        throw e;
    }
}

const rootUser = (users: User[]): User | null =>
    users.find((u) => u.parent == null) ?? users[0] ?? null;

// -------------------------------------------------------------------------------- local db

const VIEWS = `
CREATE VIEW IF NOT EXISTS v_accounts AS
  SELECT a.id,
         a.json->>'$.title' title,
         a.json->>'$.type' type,
         i.json->>'$.shortTitle' currency,
         a.json->>'$.balance' balance,
         a.json->>'$.archive' archive,
         a.json->>'$.inBalance' in_balance,
         a.json->>'$.savings' savings,
         a.json->>'$.instrument' instrument
  FROM account a
  LEFT JOIN instrument i ON i.id = a.json->>'$.instrument';

CREATE VIEW IF NOT EXISTS v_tags AS
  SELECT t.id,
         t.json->>'$.title' title,
         t.json->>'$.parent' parent,
         p.json->>'$.title' parent_title,
         t.json->>'$.showIncome' show_income,
         t.json->>'$.showOutcome' show_outcome
  FROM tag t
  LEFT JOIN tag p ON p.id = t.json->>'$.parent';

CREATE VIEW IF NOT EXISTS v_tx AS
  SELECT x.id,
         x.json->>'$.date' date,
         x.json->>'$.deleted' deleted,
         CASE WHEN x.json->>'$.income' > 0 AND x.json->>'$.outcome' > 0 THEN 'transfer'
              WHEN x.json->>'$.outcome' > 0 THEN 'expense'
              ELSE 'income' END kind,
         x.json->>'$.outcome' outcome,
         oa.json->>'$.title' outcome_account,
         oi.json->>'$.shortTitle' outcome_currency,
         x.json->>'$.income' income,
         ia.json->>'$.title' income_account,
         ii.json->>'$.shortTitle' income_currency,
         (SELECT group_concat(t.json->>'$.title', ' / ')
            FROM json_each(x.json, '$.tag') j
            JOIN tag t ON t.id = j.value) tags,
         x.json->>'$.payee' payee,
         x.json->>'$.comment' comment,
         x.json->>'$.created' created,
         x.json->>'$.changed' changed
  FROM "transaction" x
  LEFT JOIN account oa ON oa.id = x.json->>'$.outcomeAccount'
  LEFT JOIN account ia ON ia.id = x.json->>'$.incomeAccount'
  LEFT JOIN instrument oi ON oi.id = x.json->>'$.outcomeInstrument'
  LEFT JOIN instrument ii ON ii.id = x.json->>'$.incomeInstrument';
`;

/** Open (and create if needed) the mirror: one table per entity (id, changed, json), meta, views. */
export function db(file: string): DatabaseSync {
    const con = new DatabaseSync(file);
    const tables = ENTITIES.map(
        (e) =>
            `CREATE TABLE IF NOT EXISTS ${q(e)} (id TEXT PRIMARY KEY, changed INTEGER, json TEXT);`,
    );
    for (const sql of [
        ...tables,
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);",
        VIEWS,
    ]) {
        con.exec(sql);
    }
    return con;
}

export type SqlValue = string | number | bigint | null;

/** Run a query; rows as plain objects. */
export function rows(
    con: DatabaseSync,
    sql: string,
    params: SqlValue[] = [],
): Record<string, unknown>[] {
    return con
        .prepare(sql)
        .all(...params)
        .map((r) => ({ ...r }));
}

export function metaGet(con: DatabaseSync, key: string): string | null {
    const row = con.prepare("SELECT value FROM meta WHERE key=?").get(key) as
        { value: string } | undefined;
    return row?.value ?? null;
}

export function metaSet(con: DatabaseSync, key: string, value: string | number): void {
    con.prepare("INSERT OR REPLACE INTO meta VALUES (?,?)").run(key, String(value));
}

/** Budgets have no id: they are keyed by tag and month. */
const objectId = (entity: EntityName, o: Record<string, unknown>): string =>
    entity === "budget" ? `${o.tag}:${o.date}` : String(o.id);

export type Counts = Partial<Record<EntityName | "deletion", number>>;

/** Apply a server diff to the mirror in one transaction; returns how many objects of each kind came. */
export function applyDiff(con: DatabaseSync, diff: Diff): Counts {
    const counts: Counts = {};
    con.exec("BEGIN");
    for (const entity of ENTITIES) {
        const items = (diff[entity] ?? []) as unknown as Record<string, unknown>[];
        const insert = con.prepare(`INSERT OR REPLACE INTO ${q(entity)} VALUES (?,?,?)`);
        for (const o of items)
            insert.run(objectId(entity, o), (o.changed as number) ?? null, JSON.stringify(o));
        if (items.length) counts[entity] = items.length;
    }
    if (diff.deletion) {
        for (const d of diff.deletion) {
            if (!ENTITIES.includes(d.object)) continue;
            con.prepare(`DELETE FROM ${q(d.object)} WHERE id=?`).run(String(d.id));
            counts.deletion = (counts.deletion ?? 0) + 1;
        }
    }
    if (diff.serverTimestamp != null) metaSet(con, "serverTimestamp", diff.serverTimestamp);
    con.exec("COMMIT");
    return counts;
}

/** One /v8/diff/ round trip: sends `payload`, applies the server's answer to the mirror. */
export async function diff(
    con: DatabaseSync,
    remote: Remote,
    payload: Diff = {},
    full = false,
): Promise<Counts> {
    const body = {
        currentClientTimestamp: now(),
        serverTimestamp: full ? 0 : Number(metaGet(con, "serverTimestamp") ?? 0),
        ...payload,
    };
    const response = await apiPost<Diff>(remote, "/v8/diff/", body);
    // The server accepted the payload: keep the mirror in line with it, like Zerro's applyClientPatch.
    // Its timestamp (if any) is not the server's, so it is dropped.
    applyDiff(con, { ...payload, serverTimestamp: undefined });
    return applyDiff(con, response);
}

/** Pull changes; `full` drops the mirror and downloads everything again. */
export async function sync(
    con: DatabaseSync,
    remote: Remote,
    { full = false } = {},
): Promise<Counts> {
    if (full) {
        con.exec("BEGIN");
        for (const e of ENTITIES) con.exec(`DELETE FROM ${q(e)}`);
        metaSet(con, "serverTimestamp", 0);
        con.exec("COMMIT");
    }
    return diff(con, remote, {}, full);
}

/**
 * A fresh server copy of whole entity kinds, without touching the mirror (forceFetch).
 * Useful to check what the server really stores after a push.
 */
export async function fetchEntities(remote: Remote, entities: EntityName[]): Promise<Diff> {
    const body = { currentClientTimestamp: now(), serverTimestamp: now(), forceFetch: entities };
    return apiPost<Diff>(remote, "/v8/diff/", body);
}

/** Send a diff payload (entity arrays and/or deletions); it is applied to the mirror too. */
export function push(con: DatabaseSync, remote: Remote, payload: Diff): Promise<Counts> {
    return diff(con, remote, payload);
}

// ------------------------------------------------------------------------------ lookups

export function load<E extends EntityName>(
    con: DatabaseSync,
    entity: E,
    id: string | number,
): Entities[E] | null {
    const row = con.prepare(`SELECT json FROM ${q(entity)} WHERE id=?`).get(String(id)) as
        { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Entities[E]) : null;
}

export function all<E extends EntityName>(con: DatabaseSync, entity: E): Entities[E][] {
    const result = con.prepare(`SELECT json FROM ${q(entity)}`).all() as { json: string }[];
    return result.map((r) => JSON.parse(r.json) as Entities[E]);
}

/** The root user of the mirror. */
export function user(con: DatabaseSync): User {
    return rootUser(all(con, "user")) ?? fail("cache empty: run `zm sync` first");
}

type Titled = "account" | "tag" | "merchant";

/**
 * Find an account / tag / merchant by id or by title. Exact title first, then case-insensitive.
 * For accounts, non-archived ones win. The match must be unique.
 */
export function resolve<E extends Titled>(con: DatabaseSync, entity: E, key: string): Entities[E] {
    const byId = load(con, entity, key);
    if (byId) return byId;

    const items = all(con, entity);
    let found = items.filter((o) => o.title === key);
    if (found.length === 0) {
        const wanted = key.trim().toLowerCase();
        found = items.filter((o) => o.title.trim().toLowerCase() === wanted);
    }
    if (entity === "account") {
        const active = found.filter((o) => !(o as Entities["account"]).archive);
        if (active.length) found = active;
    }

    if (found.length === 1) return found[0]!;
    if (found.length === 0) fail(`${entity} not found: '${key}'`);
    return fail(
        `ambiguous ${entity} '${key}': ` + found.map((o) => `${o.id} (${o.title})`).join(", "),
    );
}

/** Find a currency by id, code ("EUR"), symbol ("€") or title. */
export function resolveInstrument(con: DatabaseSync, key: string): Instrument {
    const byId = load(con, "instrument", key);
    if (byId) return byId;
    const found = all(con, "instrument").filter(
        (i) =>
            i.shortTitle === key.toUpperCase() ||
            i.symbol === key ||
            i.title.toLowerCase() === key.toLowerCase(),
    );
    if (found.length === 1) return found[0]!;
    return fail(`instrument not found/ambiguous: '${key}'`);
}

/** Deletion records for a push. */
export function deletion(
    con: DatabaseSync,
    entity: EntityName,
    ids: (string | number)[],
): Deletion[] {
    const userId = user(con).id;
    return ids.map((id) => ({ id, object: entity, stamp: now(), user: userId }));
}
