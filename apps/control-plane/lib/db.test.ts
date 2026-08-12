import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pg = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(),
  query: vi.fn()
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    connect = pg.connect;
    end = pg.end;
    query = pg.query;
  }
}));

const originalDbUrl = process.env.ARBITER_DB_URL;

describe("database migration readiness", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.ARBITER_DB_URL = "postgres://arbiter:arbiter@postgres:5432/arbiter";
    pg.end.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (originalDbUrl === undefined) {
      delete process.env.ARBITER_DB_URL;
    } else {
      process.env.ARBITER_DB_URL = originalDbUrl;
    }
  });

  it("retries migrations after a transient connection failure", async () => {
    pg.query
      .mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }))
      .mockResolvedValue({ rowCount: 1, rows: [] });

    const { closePool, ensureMigrations } = await import("./db");

    await expect(ensureMigrations()).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await expect(ensureMigrations()).resolves.toBeUndefined();

    expect(pg.query).toHaveBeenNthCalledWith(1, expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migrations"));
    expect(pg.query).toHaveBeenNthCalledWith(2, expect.stringContaining("CREATE TABLE IF NOT EXISTS schema_migrations"));
    await closePool();
  });
});
