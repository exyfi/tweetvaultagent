// Обогащает закладки настоящим содержимым: X-статьи, длинные note-твиты,
// цитируемые посты и родителей треда. Без токенов — только публичный fxtwitter.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const IDS = [...new Set(readFileSync("ids-all.txt", "utf8").split(/[,\n]/).map(s => s.trim()).filter(Boolean))];

async function fx(id) {
  for (const base of [`https://api.fxtwitter.com/i/status/${id}`, `https://api.vxtwitter.com/i/status/${id}`]) {
    try {
      const r = await fetch(base, { headers: { "user-agent": "tweetvault/1.0" } });
      if (!r.ok) continue;
      const j = await r.json();
      if (j.code && j.code !== 200) continue;
      return j.tweet ?? j;
    } catch { /* следующий источник */ }
  }
  return null;
}

function articleText(article) {
  const blocks = article?.content?.blocks ?? [];
  return blocks.map(b => (b.text || "").trim()).filter(Boolean).join("\n");
}

const out = [];
let arts = 0, notes = 0, threads = 0, quotes = 0, fails = 0;

for (const [i, id] of IDS.entries()) {
  const t = await fx(id);
  if (!t) { fails++; continue; }

  const rec = {
    id,
    url: t.url ?? `https://x.com/i/status/${id}`,
    author: t.author?.screen_name ?? null,
    name: t.author?.name ?? null,
    date: t.created_at ?? null,
    likes: t.likes ?? null,
    text: t.text ?? "",
    kind: "tweet",
    full: "",
  };

  if (t.article) {
    rec.kind = "article";
    rec.title = t.article.title ?? "";
    rec.full = articleText(t.article);
    arts++;
  } else if (t.is_note_tweet) {
    rec.kind = "long";
    rec.full = t.text ?? "";
    notes++;
  }

  if (t.quote) {
    rec.quoted = `@${t.quote.author?.screen_name ?? "?"}: ${(t.quote.text ?? "").slice(0, 600)}`;
    if (t.quote.article) {
      rec.quotedArticle = t.quote.article.title ?? "";
      rec.full = rec.full || articleText(t.quote.article);
      if (rec.kind === "tweet") rec.kind = "article";
      arts++;
    }
    quotes++;
  }

  // Поднимаемся вверх по треду того же автора (максимум 6 шагов)
  let parentId = t.replying_to_status;
  let parentHandle = t.replying_to;
  const chain = [];
  let hops = 0;
  while (parentId && parentHandle && parentHandle === rec.author && hops < 6) {
    const p = await fx(parentId);
    if (!p) break;
    chain.unshift(p.text ?? "");
    parentId = p.replying_to_status;
    parentHandle = p.replying_to;
    hops++;
    await new Promise(r => setTimeout(r, 120));
  }
  if (chain.length) { rec.thread = chain.join("\n---\n"); rec.kind = "thread"; threads++; }

  out.push(rec);
  if ((i + 1) % 25 === 0) console.error(`… ${i + 1}/${IDS.length}`);
  await new Promise(r => setTimeout(r, 120));
}

writeFileSync("enriched.json", JSON.stringify(out, null, 1));
console.error(`готово: ${out.length}, статей ${arts}, длинных ${notes}, тредов ${threads}, цитат ${quotes}, провал ${fails}`);
