import { and, asc, desc, eq, ilike, sql, type SQL } from "drizzle-orm";
import * as s from "@nocon/database";
import { playableSql, toSummaries } from "./serialize.js";
import type { Deps } from "./core.js";

export const escapeLike = (v: string) => v.replace(/[%_\\]/g, "\\$&");

/** Full-text condition + rank for media.search. Prefix-matches the last term; short queries fall back to ILIKE. */
export function searchClause(q: string): { cond: SQL; rank: SQL } {
  const term = q.trim().replace(/\s+/g, " ");
  const like = ilike(s.media.title, `%${escapeLike(term)}%`);
  if (term.length < 3) return { cond: like, rank: sql`0::real` };
  const plain = !/["-]|\bor\b/i.test(term);
  const toks = term.split(" ").map((x) => x.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  // plain queries: every term is a prefix match (type-ahead); operators fall back to websearch syntax
  const tsq = plain && toks.length
    ? sql`to_tsquery('simple', ${toks.map((x) => x + ":*").join(" & ")})`
    : sql`websearch_to_tsquery('simple', ${term})`;
  return { cond: sql`(${s.media.search} @@ ${tsq} or ${like})`, rank: sql`ts_rank(${s.media.search}, ${tsq})` };
}

export const mediaOrder = {
  recent: [sql`${s.media.downloadedAt} desc nulls last`, desc(s.media.createdAt)],
  published: [sql`${s.media.publishedAt} desc nulls last`, desc(s.media.createdAt)],
  title: [asc(s.media.title)],
  duration: [sql`${s.media.durationSeconds} desc nulls last`],
} as const;

export async function mediaList(d: Deps, o: { where?: SQL[]; order?: SQL[]; limit?: number; offset?: number; withTotal?: boolean }) {
  const where = o.where?.length ? and(...o.where) : undefined;
  const rows = await d.db.select().from(s.media).where(where)
    .orderBy(...(o.order ?? [...mediaOrder.recent])).limit(o.limit ?? 50).offset(o.offset ?? 0);
  const items = await toSummaries(d, rows);
  if (!o.withTotal) return { items };
  const [{ n }] = (await d.db.select({ n: sql<number>`count(*)::int` }).from(s.media).where(where)) as [{ n: number }];
  return { items, total: n };
}

export const inSource = (sourceId: string) =>
  sql`exists (select 1 from media_sources ms where ms.media_id = "media"."id" and ms.source_id = ${sourceId})`;
export const inCollection = (collectionId: string) =>
  sql`exists (select 1 from collection_items ci where ci.collection_id = ${collectionId} and ci.media_id = "media"."id")`;

export { playableSql, eq };
