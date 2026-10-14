import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fakeApi, fixture, memoryMirror, type FakeApi } from "@tihonove/testing";
import {
    all,
    applyDiff,
    checkToken,
    db,
    DEFAULT_API,
    deletion,
    diff,
    envConfig,
    fail,
    fetchEntities,
    load,
    makeRemote,
    metaGet,
    metaSet,
    now,
    open,
    push,
    q,
    resolve,
    resolveInstrument,
    rows,
    sync,
    user,
    uuid,
    ZmError,
    type Account,
    type Diff,
} from "@tihonove/zenmoney";

let api: FakeApi | undefined;
afterEach(async () => {
    await api?.close();
    api = undefined;
});

async function remoteWith(responses: Diff[] = []) {
    api = await fakeApi(responses);
    return makeRemote({ api: api.url, token: "tkn" });
}

describe("helpers", () => {
    test("ZmError is user-facing; fail() throws it", () => {
        expect(new ZmError("x").userFacing).toBe(true);
        expect(() => fail("boom")).toThrow(new ZmError("boom"));
    });

    test("now() is unix seconds, uuid() is a v4 uuid, q() quotes", () => {
        expect(Math.abs(now() - Date.now() / 1000)).toBeLessThan(2);
        expect(Number.isInteger(now())).toBe(true);
        expect(uuid()).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(q("transaction")).toBe('"transaction"');
    });
});

describe("config", () => {
    test("envConfig: defaults relative to cwd", () => {
        expect(envConfig({}, "/home/me")).toEqual({
            api: DEFAULT_API,
            db: "/home/me/zenmoney.db",
            token: undefined,
            tokenFile: "/home/me/.secrets/token",
        });
        expect(DEFAULT_API).toBe("https://api.zenmoney.ru");
    });

    test("envConfig: from variables; relative paths resolve against cwd", () => {
        const env = {
            ZENMONEY_API: "http://api",
            ZENMONEY_DB: "x.db",
            ZENMONEY_TOKEN: " tok \n",
            ZENMONEY_TOKEN_FILE: "/abs/token",
        };
        expect(envConfig(env, "/w")).toEqual({
            api: "http://api",
            db: "/w/x.db",
            token: "tok",
            tokenFile: "/abs/token",
        });
        expect(envConfig({ ZENMONEY_TOKEN: "  " }, "/w").token).toBeUndefined();
    });

    test("envConfig: process.env and process.cwd() by default", () => {
        expect(envConfig().db).toBe(path.resolve(process.env.ZENMONEY_DB || "zenmoney.db"));
    });

    test("makeRemote: explicit token, then token file, else a ZmError", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "zm-store-"));
        const file = path.join(dir, "token");
        writeFileSync(file, "from-file\n");

        expect(makeRemote({ token: "t", tokenFile: file }).token()).toBe("t");
        expect(makeRemote({ tokenFile: file }).token()).toBe("from-file");
        expect(() => makeRemote({ tokenFile: path.join(dir, "missing") }).token()).toThrow(
            new ZmError("no token: run `zm auth` or set ZENMONEY_TOKEN"),
        );
        expect(() => makeRemote().token()).toThrow(ZmError);
        expect(makeRemote().api).toBe(DEFAULT_API);
        expect(makeRemote({ api: "http://x" }).api).toBe("http://x");
    });

    test("open: a mirror and a remote, options override the environment", () => {
        const ctx = open({ db: ":memory:", api: "http://x", token: "t" });
        expect(ctx.remote.api).toBe("http://x");
        expect(ctx.remote.token()).toBe("t");
        expect(all(ctx.con, "account")).toEqual([]);
    });
});

describe("api", () => {
    test("diff posts to /v8/diff/ with the bearer token and stored timestamp", async () => {
        const remote = await remoteWith([{ tag: [], serverTimestamp: 42 }]);
        const con = memoryMirror();
        metaSet(con, "serverTimestamp", 7);
        const before = now();

        await diff(con, remote, { tag: [] });

        const [request] = api!.requests;
        expect(request!.url).toBe("/v8/diff/");
        expect(request!.auth).toBe("Bearer tkn");
        expect(request!.contentType).toBe("application/json");
        expect(request!.body.serverTimestamp).toBe(7);
        expect(request!.body.tag).toEqual([]);
        expect(request!.body.currentClientTimestamp).toBeGreaterThanOrEqual(before);
        expect(metaGet(con, "serverTimestamp")).toBe("42");
    });

    test("diff with full=true asks for everything; a fresh mirror starts at 0", async () => {
        const remote = await remoteWith();
        const con = memoryMirror();
        metaSet(con, "serverTimestamp", 7);
        await diff(con, remote, {}, true);
        await diff(db(":memory:"), remote);
        expect(api!.requests.map((r) => r.body.serverTimestamp)).toEqual([0, 0]);
    });

    test("a non-2xx answer becomes a ZmError with the status and body", async () => {
        const remote = await remoteWith();
        api!.status = 401;
        await expect(diff(memoryMirror(), remote)).rejects.toThrow(new ZmError("API 401: nope"));
        api!.errorBody = "x".repeat(600);
        await expect(diff(memoryMirror(), remote)).rejects.toThrow(
            new ZmError(`API 401: ${"x".repeat(500)}`),
        );
    });

    test("checkToken: the root user, null if rejected; network errors propagate", async () => {
        const users = fixture("account.json").user!;
        const child = { ...users[0]!, id: 9, parent: 1 };
        const remote = await remoteWith([{ user: [child, users[0]!] }, { user: [child] }, {}]);

        expect((await checkToken(remote))!.id).toBe(1);
        expect((await checkToken(remote, "other"))!.id).toBe(9);
        expect(api!.requests[1]!.auth).toBe("Bearer other");
        expect(api!.requests[0]!.body.forceFetch).toEqual(["user"]);
        expect(api!.requests[0]!.url).toBe("/v8/diff/");
        expect(await checkToken(remote)).toBeNull();

        api!.status = 403;
        expect(await checkToken(remote)).toBeNull();

        const dead = makeRemote({ api: "http://127.0.0.1:1", token: "t" });
        await expect(checkToken(dead)).rejects.toThrow(TypeError);
    });

    test("sync applies the server diff; full drops the mirror first", async () => {
        const remote = await remoteWith([{ tag: [] }, { tag: [] }]);
        const con = memoryMirror();
        metaSet(con, "serverTimestamp", 5);

        await sync(con, remote);
        expect(all(con, "tag").length).toBe(4);
        expect(api!.requests[0]!.body.serverTimestamp).toBe(5);

        await sync(con, remote, { full: true });
        expect(all(con, "tag")).toEqual([]);
        expect(all(con, "transaction")).toEqual([]);
        expect(api!.requests[1]!.body.serverTimestamp).toBe(0);
    });

    test("a failed full sync leaves an empty mirror that the next sync downloads again", async () => {
        const remote = await remoteWith();
        const con = memoryMirror();
        metaSet(con, "serverTimestamp", 5);
        api!.status = 500;
        await expect(sync(con, remote, { full: true })).rejects.toThrow(ZmError);
        expect(all(con, "tag")).toEqual([]);
        expect(metaGet(con, "serverTimestamp")).toBe("0");
    });

    test("push applies the accepted payload to the mirror, then the server answer", async () => {
        const tag = { ...fixture("account.json").tag![0]!, id: "t-new", title: "New" };
        const fromServer = { ...tag, title: "Renamed by server" };
        const remote = await remoteWith([{ tag: [fromServer], serverTimestamp: 50 }]);
        const con = memoryMirror();

        await push(con, remote, {
            tag: [tag],
            deletion: [{ id: "tx-food", object: "transaction", stamp: 1, user: 1 }],
            serverTimestamp: 7,
        });

        expect(load(con, "tag", "t-new")!.title).toBe("Renamed by server");
        expect(load(con, "transaction", "tx-food")).toBeNull();
        expect(metaGet(con, "serverTimestamp")).toBe("50");
    });

    test("a rejected push leaves the mirror alone", async () => {
        const remote = await remoteWith();
        api!.status = 500;
        const con = memoryMirror();
        await expect(
            push(con, remote, {
                deletion: [{ id: "tx-food", object: "transaction", stamp: 1, user: 1 }],
            }),
        ).rejects.toThrow(ZmError);
        expect(load(con, "transaction", "tx-food")).not.toBeNull();
    });

    test("fetchEntities: a fresh server copy of whole kinds, the mirror untouched", async () => {
        const remote = await remoteWith([{ reminder: [] }]);
        const before = now();
        expect(await fetchEntities(remote, ["reminder", "account"])).toMatchObject({
            reminder: [],
        });
        const [request] = api!.requests;
        expect(request!.url).toBe("/v8/diff/");
        expect(request!.body.forceFetch).toEqual(["reminder", "account"]);
        expect(request!.body.serverTimestamp).toBeGreaterThanOrEqual(before);
        expect(request!.body.currentClientTimestamp).toBeGreaterThanOrEqual(before);
    });

    test("push sends the payload", async () => {
        const remote = await remoteWith([{ tag: [] }]);
        const counts = await push(memoryMirror(), remote, { deletion: [] });
        expect(api!.requests[0]!.body.deletion).toEqual([]);
        expect(counts).toEqual({});
    });
});

describe("mirror", () => {
    test("db creates tables, meta and views; reopening keeps data", () => {
        const file = path.join(mkdtempSync(path.join(tmpdir(), "zm-store-")), "m.db");
        applyDiff(db(file), fixture("account.json"));
        const con = db(file);
        expect(all(con, "transaction").length).toBe(5);
        expect(rows(con, "SELECT title FROM v_accounts ORDER BY title")).toEqual([
            { title: "Black" },
            { title: "Old card" },
            { title: "Revolut Savings" },
            { title: "Revolut €" },
        ]);
    });

    test("applyDiff: counts, budget keys, deletions, timestamp", () => {
        const con = db(":memory:");
        const counts = applyDiff(con, { ...fixture("account.json"), serverTimestamp: 99 });
        expect(counts).toEqual({
            instrument: 3,
            user: 1,
            account: 4,
            tag: 4,
            budget: 1,
            transaction: 5,
        });
        expect(rows(con, "SELECT id, changed FROM budget")).toEqual([
            { id: "tag-food:2026-10-01", changed: 1 },
        ]);
        expect(metaGet(con, "serverTimestamp")).toBe("99");

        const deleted = applyDiff(con, {
            deletion: [
                { id: "tx-food", object: "transaction", stamp: 1, user: 1 },
                { id: "x", object: "nonsense" as "tag", stamp: 1, user: 1 },
            ],
        });
        expect(deleted).toEqual({ deletion: 1 });
        expect(load(con, "transaction", "tx-food")).toBeNull();
        expect(metaGet(con, "serverTimestamp")).toBe("99");
    });

    test("applyDiff stores objects without `changed` as NULL", () => {
        const con = db(":memory:");
        applyDiff(con, { tag: [{ id: "t", title: "x" } as never] });
        expect(rows(con, "SELECT id, changed FROM tag")).toEqual([{ id: "t", changed: null }]);
    });

    test("rows with parameters; metaGet of a missing key", () => {
        const con = memoryMirror();
        expect(rows(con, "SELECT title FROM v_tags WHERE id = ?", ["tag-cafe"])).toEqual([
            { title: "Dining" },
        ]);
        expect(metaGet(con, "nope")).toBeNull();
    });

    test("v_tx: kinds, currencies, accounts, category path", () => {
        const con = memoryMirror();
        const tx = rows(
            con,
            "SELECT id, kind, outcome_currency, income_account, tags FROM v_tx ORDER BY id",
        );
        expect(tx).toEqual([
            {
                id: "tx-cafe",
                kind: "expense",
                outcome_currency: "EUR",
                income_account: "Revolut €",
                tags: "Dining",
            },
            {
                id: "tx-food",
                kind: "expense",
                outcome_currency: "EUR",
                income_account: "Revolut €",
                tags: "Groceries",
            },
            {
                id: "tx-gone",
                kind: "expense",
                outcome_currency: "EUR",
                income_account: "Revolut €",
                tags: null,
            },
            {
                id: "tx-salary",
                kind: "income",
                outcome_currency: "EUR",
                income_account: "Revolut €",
                tags: "Bonus",
            },
            {
                id: "tx-save",
                kind: "transfer",
                outcome_currency: "EUR",
                income_account: "Revolut Savings",
                tags: null,
            },
        ]);
    });

    test("load and all", () => {
        const con = memoryMirror();
        expect(load(con, "account", "acc-rev")!.title).toBe("Revolut €");
        expect(load(con, "instrument", 3)!.shortTitle).toBe("EUR");
        expect(load(con, "tag", "missing")).toBeNull();
        expect(
            all(con, "instrument")
                .map((i) => i.shortTitle)
                .sort(),
        ).toEqual(["EUR", "RUB", "USD"]);
    });

    test("user: the root user; an empty mirror is an error", () => {
        const root = fixture("account.json").user![0]!;
        expect(user(memoryMirror({ user: [{ ...root, id: 5, parent: 1 }, root] })).id).toBe(1);
        expect(user(memoryMirror({ user: [{ ...root, id: 5, parent: 1 }] })).id).toBe(5);
        expect(() => user(db(":memory:"))).toThrow(new ZmError("cache empty: run `zm sync` first"));
    });

    test("deletion records", () => {
        const before = now();
        const [d] = deletion(memoryMirror(), "tag", ["tag-food"]);
        expect(d).toMatchObject({ id: "tag-food", object: "tag", user: 1 });
        expect(d!.stamp).toBeGreaterThanOrEqual(before);
    });
});

describe("resolve", () => {
    const accounts = fixture("account.json").account!;
    const acc = (o: Partial<Account>): Account => ({ ...accounts[0]!, ...o });

    test("by id, exact title, then case-insensitive trimmed title", () => {
        const con = memoryMirror();
        expect(resolve(con, "account", "acc-black").title).toBe("Black");
        expect(resolve(con, "tag", "Dining").id).toBe("tag-cafe");
        expect(resolve(con, "account", "  revolut €  ").id).toBe("acc-rev");
        const spaced = memoryMirror({ account: [acc({ id: "sp", title: "  Spaced Out " })] });
        expect(resolve(spaced, "account", "spaced out").id).toBe("sp");
    });

    test("exact title wins over a case-insensitive match", () => {
        const con = memoryMirror({
            account: [acc({ id: "a1", title: "Cash" }), acc({ id: "a2", title: "cash" })],
        });
        expect(resolve(con, "account", "cash").id).toBe("a2");
    });

    test("accounts: non-archived wins; all archived still resolve", () => {
        const con = memoryMirror({
            account: [
                acc({ id: "old", title: "Card", archive: true }),
                acc({ id: "new", title: "Card" }),
            ],
        });
        expect(resolve(con, "account", "Card").id).toBe("new");
        expect(resolve(memoryMirror(), "account", "Old card").id).toBe("acc-old");
    });

    test("not found and ambiguous", () => {
        const con = memoryMirror({
            account: [acc({ id: "a1", title: "Card" }), acc({ id: "a2", title: "card" })],
        });
        expect(() => resolve(con, "account", "Nope")).toThrow(
            new ZmError("account not found: 'Nope'"),
        );
        expect(() => resolve(con, "account", "CARD")).toThrow(
            new ZmError("ambiguous account 'CARD': a1 (Card), a2 (card)"),
        );
        const tags = memoryMirror({
            tag: [
                { ...fixture("account.json").tag![0]!, id: "t2" },
                fixture("account.json").tag![0]!,
            ],
        });
        expect(() => resolve(tags, "tag", "Groceries")).toThrow(
            /^ambiguous tag 'Groceries': t2 \(Groceries\), tag-food/,
        );
    });

    test("tags are not filtered by archive", () => {
        const tag = fixture("account.json").tag![0]!;
        const con = memoryMirror({
            tag: [
                { ...tag, id: "t1", archive: true },
                { ...tag, id: "t2" },
            ],
        });
        expect(() => resolve(con, "tag", "Groceries")).toThrow(/ambiguous/);
    });

    test("instruments: id, code, symbol, title", () => {
        const con = memoryMirror();
        expect(resolveInstrument(con, "2").shortTitle).toBe("RUB");
        expect(resolveInstrument(con, "eur").id).toBe(3);
        expect(resolveInstrument(con, "₽").id).toBe(2);
        expect(resolveInstrument(con, "us dollar").id).toBe(1);
        expect(() => resolveInstrument(con, "99")).toThrow(
            new ZmError("instrument not found/ambiguous: '99'"),
        );
        expect(() => resolveInstrument(con, "XXX")).toThrow(ZmError);
    });

    test("instruments: digits that are not an id fall back to codes; ambiguity is an error", () => {
        const base = fixture("account.json").instrument!;
        const con = memoryMirror({
            instrument: [
                ...base,
                { id: 50, changed: 1, title: "Fifty", shortTitle: "777", symbol: "s", rate: 1 },
            ],
        });
        expect(resolveInstrument(con, "777").id).toBe(50);
        const twins = memoryMirror({ instrument: [...base, { ...base[0]!, id: 70 }] });
        expect(() => resolveInstrument(twins, "EUR")).toThrow(
            new ZmError("instrument not found/ambiguous: 'EUR'"),
        );
    });
});
