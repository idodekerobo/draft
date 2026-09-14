// Shared scaffolding for disposable-Postgres release gates
// (retrieval.test.ts, synthesis-consumption.test.ts, slack-backfill.test.ts):
// the "require DRAFT_INTEGRATION_TEST_DATABASE_URL, never fall back to the
// linked project" gate, and workspace/organization/team fixture creation +
// cleanup, which were otherwise hand-rolled near-identically in each file.
import { afterAll, afterEach, describe, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";

export interface WorkspaceFixture {
  organizationId: string;
  workspaceId: string;
}

export interface DbIntegrationTestContext {
  /** Non-null only when DRAFT_INTEGRATION_TEST_DATABASE_URL is set. */
  sql: SQL | null;
  describeWithDatabase: typeof describe;
  /** Throws if the disposable database URL wasn't provided. */
  db(): SQL;
  createWorkspace(): Promise<WorkspaceFixture>;
}

// gateLabel names the release gate in the thrown/described error (e.g.
// "retrieval", "synthesis consumption"); slugPrefix seeds unique,
// recognizable organization/team/workspace slugs for this suite's rows.
export function setupDbIntegrationTest(gateLabel: string, slugPrefix: string): DbIntegrationTestContext {
  const testDatabaseUrl = process.env.DRAFT_INTEGRATION_TEST_DATABASE_URL;
  const requireDatabase = process.env.DRAFT_REQUIRE_DB_INTEGRATION_TESTS === "1";
  const describeWithDatabase = testDatabaseUrl ? describe : describe.skip;
  const sql = testDatabaseUrl ? new SQL(testDatabaseUrl, { max: 8 }) : null;

  if (requireDatabase && !testDatabaseUrl) {
    describe(`${gateLabel} release gate`, () => {
      test("requires an explicit disposable Postgres URL", () => {
        throw new Error(`DRAFT_INTEGRATION_TEST_DATABASE_URL is required by the ${gateLabel} release gate`);
      });
    });
  }

  function db(): SQL {
    if (!sql) throw new Error("DRAFT_INTEGRATION_TEST_DATABASE_URL is required");
    return sql;
  }

  const organizationIds = new Set<string>();

  async function createWorkspace(): Promise<WorkspaceFixture> {
    const suffix = randomUUID();
    const [organization] = await db()<[{ id: string }]>`
      insert into organizations (slug, name)
      values (${`${slugPrefix}-org-${suffix}`}, 'Contract test')
      returning id
    `;
    const [team] = await db()<[{ id: string }]>`
      insert into teams (organization_id, slug, name)
      values (${organization.id}, ${`${slugPrefix}-team-${suffix}`}, 'Contract test')
      returning id
    `;
    const [workspace] = await db()<[{ id: string }]>`
      insert into workspaces (organization_id, team_id, slug, name)
      values (${organization.id}, ${team.id}, ${`${slugPrefix}-workspace-${suffix}`}, 'Contract test')
      returning id
    `;
    organizationIds.add(organization.id);
    return { organizationId: organization.id, workspaceId: workspace.id };
  }

  afterEach(async () => {
    if (!sql || organizationIds.size === 0) return;
    const ids = [...organizationIds];
    organizationIds.clear();
    await sql`delete from organizations where id = any(${sql.array(ids, "uuid")})`;
  });

  afterAll(async () => {
    await sql?.close();
  });

  return { sql, describeWithDatabase, db, createWorkspace };
}
