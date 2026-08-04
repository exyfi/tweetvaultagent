// Hermes — bookmark digester. Cloudflare Worker.
// Telegram bot: voice breakdowns of saved posts + comprehension tests.
// Docs: README.md
//
// Bindings: KV namespace VAULT.
// Secrets:  TELEGRAM_TOKEN, WEBHOOK_SECRET.
// Crons:    "0 7 * * *" (утренняя доза, 10:00 МСК), "0 9 * * 0" (недельный, вс 12:00 МСК).
//
// KV:  index      -> { <id>: {a: added_at, s: surfaced_at|null, v: value?} } — один ключ,
//                    чтобы не упираться в лимит ~50 KV-операций на запрос
//      tweet:<id> -> {id,url,author,name,text,date,added_at,summary,tags}
//      raw:<id>   -> полный ответ fxtwitter (для будущей аннотации)
//      meta       -> {owner_chat_id}
//
// Лимиты держим руками: ≤10 ссылок на сообщение, ≤40 объектов на /import и
// /annotate, /export постранично. Дайджест читает только выбранные твиты.

const HELP =
  "Кинь ссылку на твит ИЛИ любую статью — сохраню и сразу разберу голосом.\n" +
  "Команды: «го» — разбор голосом, «го капитал» / «го себя» — из нужной дорожки, " +
  "/lanes — сколько осталось по целям, /digest — микро-доза, /stats — счётчики.\n" +
  "Кнопки под разбором: у статей и тредов «📝 тест» — 3 вопроса по содержанию, сдал 2 из 3 — " +
  "закладка закрыта как усвоенная; у коротких заметок вместо теста «✅ понял, закрыто». " +
  "«Позже» — вернётся в очередь; «мусор» — снести; «ещё одну» — следующий разбор; " +
  "«деньги / навык / себя / обещания» — следующий из этой дорожки.";

// «Гермес говорит»: разбор одной закладки голосом, по запросу
const SCRIPT_SYSTEM = [
  "Ты разбираешь сохранённый пост для человека с СДВГ. Его цели: свои стартапы, уйти из найма,",
  "заработать капитал, найти нишу, вдолбить навыки, понять себя, знать актуальное — без инфоцыганского шума.",
  "",
  "ГЛАВНОЕ ПРАВИЛО: вытаскивай КОНКРЕТИКУ ИЗ ТЕКСТА, а не общий смысл. Числа, суммы, сроки, проценты,",
  "названия компаний и инструментов, механику «как именно это работает», порядок шагов. Разбор должен быть",
  "невозможно написать, не прочитав текст. Если в пересказе нет ни одного числа или названия, а они есть",
  "в оригинале — ты провалил задачу.",
  "",
  "ЗАПРЕЩЕНО: «автор утверждает», «в этом посте», «ИИ меняет правила игры», «важно учиться использовать»,",
  "«работать умнее» и любые фразы, которые подошли бы к сотне других постов. Никаких эмодзи и разметки —",
  "текст идёт в озвучку. Пиши по-русски, живой устной речью, короткими фразами, на «ты».",
  "",
  "{{PROFILE}}",
  "",
  "«Внедрить» — это действие, которое он физически делает за 30–60 минут и видит результат.",
  "Если из поста внедрить нечего — так и скажи, не выдумывай.",
  "",
  "МЕДИА. Если в исходнике помечено, что в посте есть видео или фото, — их содержимое НЕ",
  "смотрели. Не пересказывай и не выдумывай, что там. Одной фразой скажи, что суть или деталь",
  "в ролике/картинке и её стоит открыть в оригинале; если есть расшифровка звука — тогда",
  "разбирай именно её. Если без медиа пост пустой — так и скажи: смотреть, а не читать.",
  "",
  "Верни JSON: {\"script\": \"...\", \"summary\": \"...\", \"points\": [...], \"steps\": [...], \"quiz\": [...]}.",
  "quiz — только если исходник СОДЕРЖАТЕЛЬНЫЙ (статья, тред, длинный пост). Для короткой",
  "заметки в пару абзацев верни \"quiz\": [] — проверять там нечего, не выдумывай вопросы",
  "про мелочи. Когда исходник длинный: ДВА варианта теста, массив из двух массивов по 3 вопроса",
  "[{\"q\":\"...\",\"o\":[\"...\",\"...\",\"...\"],\"c\":0}]. Вопросы по СОДЕРЖАНИЮ (числа, механика,",
  "главный вывод), не про форму; 3 варианта ответа, ровно один правильный (c — его индекс),",
  "неверные правдоподобны — близкие числа и соседние понятия из того же текста. Вопрос до 120",
  "символов, вариант ответа до 38. Вопросы двух вариантов теста не повторяются.",
  "points — 3–5 строк, самая мякоть: каждая строка это отдельная мысль с числом, названием",
  "или механикой из текста. Не пересказ по порядку, а то, что стоит забрать. До 140 символов строка.",
  "steps — 2–3 строки «как внедрить»: первая выполнима сегодня, дальше по нарастающей.",
  "Каждый шаг начинается с глагола и содержит конкретику: что открыть, что написать, какое число проверить.",
  "РАЗМЕР ШАГА ЧЕСТНЫЙ: двухминутное дело называй двухминутным; 30–60 минут — потолок, а не норма.",
  "Не раздувай мелочь до ритуала («за 30–60 минут проверь один скриншот» — так нельзя).",
  "ДЛЯ КОРОТКОЙ ЗАМЕТКИ: points — пустой массив (мякоть уже в summary), steps — ровно ОДИН шаг одной строкой.",
  "script — текст для озвучки, три хода подряд, без заголовков и без нумерации.",
  "ДЛИНА СОРАЗМЕРНА ИСХОДНИКУ: короткий твит — 90–140 слов, не растягивай и не выдумывай;",
  "статья или тред — 250–350 слов, пройдись по главным ходам текста, а не только по первому.",
  "ДЛЯ ОЗВУЧКИ: все числа, валюты и единицы — словами по-русски («пятьдесят тысяч долларов",
  "в месяц», а не «$50k/mo»); аббревиатуры раскрывай по-русски: MRR — месячная выручка,",
  "ARR — годовая, MVP — минимальный продукт, B2B — би-ту-би. В points и summary наоборот:",
  "цифры оставляй цифрами, так глазами быстрее.",
  "Три хода script:",
  "1) Что конкретно человек сделал или утверждает — с цифрами и названиями из текста.",
  "2) На чём это держится: чей это опыт, какие числа, что проверяемо, а что нет.",
  "   Если держится на обещании без метода — скажи это прямо, это тоже полезный вывод.",
  "3) Как это применить у себя — проговори первый шаг словами, чтобы его можно было начать сразу.",
  "summary — 2–3 предложения связным текстом: что человек сделал, на чём это держится и главные числа.",
  "Это должен быть маленький разбор, а не подпись к ссылке — но без действия, действие живёт в steps.",
].join(" ");

// Режим для постов-обещаний: не пересказывать и не верить, а вскрывать устройство.
const GRIFT_MODE = [
  "",
  "ОСОБЫЙ СЛУЧАЙ: этот пост помечен как обещание без метода. Задача меняется — не пересказать,",
  "а объяснить, как он сделан и что в нём всё-таки есть.",
  "points строй так: (1) что именно обещано и какими словами; (2) каким приёмом держат внимание —",
  "страх опоздать, продажа статуса, ложная точность, чужая мысль под своим именем; (3) что здесь",
  "проверяемо, а что нельзя опровергнуть в принципе; (4) зерно, если оно есть, — какая одна мысль",
  "работает даже без обёртки.",
  "steps — как применить это зерно самому или как узнать тот же приём в ленте за две секунды.",
  "script — тем же тоном: спокойно, без презрения к автору и без оправданий. Читатель хочет ПОНЯТЬ,",
  "почему это цепляет и что забрать, а не услышать «это цыганщина, выкинь».",
].join(" ");

// Полный пересказ статьи без комментариев — по явной просьбе владельца.
const RETELL_SYSTEM = [
  "Перескажи статью ПОЛНОСТЬЮ по-русски для озвучки. Верни JSON {\"script\": \"...\", \"summary\": \"...\"}.",
  "script — 1500–2000 слов: весь ход мысли автора по порядку, все разделы, все упражнения",
  "с их шагами и формулировками, примеры и метафоры автора. НИЧЕГО не выбрасывай по смыслу",
  "и НИЧЕГО не добавляй от себя: ни оценок, ни критики, ни советов — только содержание статьи,",
  "как если бы автор сам рассказывал её вслух по-русски. Связная устная речь, без заголовков",
  "и списков, числа и единицы словами.",
  "summary — 12–16 коротких строк: скелет статьи по порядку, каждый раздел или упражнение",
  "одной строкой. Цифры цифрами. Без разметки и без оценок.",
].join(" ");

async function retellJob(env, chatId, id) {
  try {
    const data = await fetchTweet(id);
    const t = data?.tweet ?? data;
    const title = t?.article?.title ?? t?.text?.slice(0, 60) ?? id;
    const author = t?.author?.screen_name ?? "?";
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `⏳ Полный пересказ «${title}» — минуты две-три, он длинный.`,
    });
    const src = await fullText(env, id, t?.text ?? "");
    const gen = await llmJson(env, [
      { role: "system", content: RETELL_SYSTEM },
      { role: "user", content: `Статья «${title}» (автор @${author}):\n${src.full.slice(0, 40000)}` },
    ], "medium");
    if (!gen?.script) return void (await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Пересказ не собрался — модель молчит." }));

    // Скрипт длиннее лимита одного TTS-запроса — режем и клеим mp3
    const parts = [];
    let cur = "";
    for (const piece of speechify(gen.script).split(/(?<=[.!?])\s+/)) {
      if ((cur + piece).length > 3800) { parts.push(cur); cur = ""; }
      cur += piece + " ";
    }
    if (cur.trim()) parts.push(cur);
    const bufs = [];
    for (const part of parts) {
      const a = await speak(env, part, "audio");
      if (!a) return void (await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Озвучка пересказа упала на середине." }));
      bufs.push(new Uint8Array(a.bytes));
    }
    const total = bufs.reduce((n, b) => n + b.length, 0);
    const joined = new Uint8Array(total);
    let off = 0;
    for (const b of bufs) { joined.set(b, off); off += b.length; }

    const up = await tgUpload(env, "sendAudio", chatId, { bytes: joined.buffer, kind: "audio", mime: "audio/mpeg", name: "retell.mp3" }, {
      title: `${title} · полный пересказ`,
      performer: "Гермес",
    });
    if (!up.ok) return void (await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Телеграм не принял аудио пересказа." }));
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `📖 «${title}» — содержание без купюр:\n\n${gen.summary}\n\nhttps://x.com/i/status/${id}`,
      link_preview_options: { is_disabled: true },
    });
    console.log(`retell done: ${id}, ${parts.length} кусков, ${Math.round(total / 1024)}КБ`);
  } catch (e) {
    console.log(`retell crashed: ${e?.stack ?? e}`);
    await tg(env, "sendMessage", { chat_id: chatId, text: `⚠️ Пересказ упал: ${esc(String(e).slice(0, 120))}` });
  }
}

// Озвучка произвольного длинного текста: режем по предложениям, клеим mp3
async function ttsLong(env, script) {
  const parts = [];
  let cur = "";
  for (const piece of speechify(script).split(/(?<=[.!?])\s+/)) {
    if ((cur + piece).length > 3800) { parts.push(cur); cur = ""; }
    cur += piece + " ";
  }
  if (cur.trim()) parts.push(cur);
  const bufs = [];
  for (const part of parts) {
    const a = await speak(env, part, "audio");
    if (!a) return null;
    bufs.push(new Uint8Array(a.bytes));
  }
  const joined = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of bufs) { joined.set(b, off); off += b.length; }
  return joined;
}

// Задача "speak": готовый текст → аудио + текстовые сообщения (для пересказов статей и т.п.)
async function speakJob(env, chatId, job) {
  try {
    const joined = await ttsLong(env, job.script);
    if (!joined) return void (await tg(env, "sendMessage", { chat_id: chatId, text: `⚠️ Озвучка «${job.title}» не собралась.` }));
    const up = await tgUpload(env, "sendAudio", chatId, { bytes: joined.buffer, kind: "audio", mime: "audio/mpeg", name: "hermes.mp3" }, {
      title: job.title,
      performer: "Гермес",
    });
    if (!up.ok) return void (await tg(env, "sendMessage", { chat_id: chatId, text: `⚠️ Телеграм не принял аудио «${job.title}».` }));
    for (const text of job.texts ?? []) {
      await tg(env, "sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
    }
    console.log(`speak done: ${job.title}`);
  } catch (e) {
    console.log(`speak crashed: ${e?.stack ?? e}`);
    await tg(env, "sendMessage", { chat_id: chatId, text: `⚠️ Озвучка «${job.title}» упала: ${esc(String(e).slice(0, 100))}` });
  }
}

const WEEKLY_CRON = "0 9 * * SUN";
const MAX_LINKS_PER_MSG = 10;
const MAX_BATCH = 40;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === `/tg/${env.WEBHOOK_SECRET}` && request.method === "POST") {
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok");
    }

    if (url.searchParams.get("key") !== env.WEBHOOK_SECRET)
      return new Response("not found", { status: 404 });

    if (url.pathname === "/export") {
      const index = await getIndex(env);
      const ids = Object.keys(index).sort((a, b) => (index[a].a < index[b].a ? -1 : 1));
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(MAX_BATCH, Number(url.searchParams.get("limit")) || MAX_BATCH);
      const page = ids.slice(offset, offset + limit);
      const items = [];
      for (const id of page) {
        const t = await env.VAULT.get(`tweet:${id}`, "json");
        if (t) items.push({ ...t, surfaced_at: index[id].s });
      }
      const next = offset + limit < ids.length ? offset + limit : null;
      return Response.json({ total: ids.length, offset, next_offset: next, items });
    }

    if (url.pathname === "/import" && request.method === "POST") {
      const items = await request.json();
      if (!Array.isArray(items) || items.length > MAX_BATCH)
        return Response.json({ error: `array of at most ${MAX_BATCH} items` }, { status: 400 });
      const index = await getIndex(env);
      let added = 0, skipped = 0;
      for (const t of items) {
        if (!t.id || index[t.id]) { skipped++; continue; }
        await env.VAULT.put(`tweet:${t.id}`, JSON.stringify(normalize(t)));
        index[t.id] = { a: t.added_at ?? new Date().toISOString(), s: t.surfaced_at ?? null };
        added++;
      }
      await putIndex(env, index);
      return Response.json({ added, skipped });
    }

    if (url.pathname === "/annotate" && request.method === "POST") {
      const items = await request.json(); // [{id, summary, tags, value, verdict, apply}]
      if (!Array.isArray(items) || items.length > MAX_BATCH)
        return Response.json({ error: `array of at most ${MAX_BATCH} items` }, { status: 400 });
      const index = await getIndex(env);
      let updated = 0;
      for (const { id, summary, tags, value, verdict, apply } of items) {
        const t = await env.VAULT.get(`tweet:${id}`, "json");
        if (!t) continue;
        if (summary) t.summary = String(summary).slice(0, 300);
        if (tags) t.tags = tags;
        if (value != null) t.value = Math.max(0, Math.min(10, Number(value) || 0));
        if (verdict) t.verdict = String(verdict).slice(0, 20);
        if (apply) t.apply = String(apply).slice(0, 250);
        await env.VAULT.put(`tweet:${id}`, JSON.stringify(t));
        if (index[id] && t.value != null) index[id].v = t.value;
        updated++;
      }
      await putIndex(env, index);
      return Response.json({ updated });
    }

    if (url.pathname === "/queue" && request.method === "POST") {
      // Порядок задаётся снаружи: [{i: id, g: цель}] — приоритет и цели считаются локально
      const items = await request.json();
      if (!Array.isArray(items)) return Response.json({ error: "array of items" }, { status: 400 });
      const queue = items
        .map((q) =>
          typeof q === "string"
            ? { i: q, g: null, n: 0, h: null, t: null }
            : { i: String(q.i), g: q.g ?? null, n: Number(q.n) || 0, h: q.h ?? null, t: q.t ?? null },
        )
        .filter((q) => /^\d{15,20}$/.test(q.i));
      await env.VAULT.put("queue", JSON.stringify(queue));
      return Response.json({ queued: queue.length });
    }

    if (url.pathname === "/ttscheck") {
      const id = await voiceId(env);
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=opus_48000_64`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY },
          body: JSON.stringify({ text: "Проверка связи.", model_id: env.TTS_MODEL ?? "eleven_multilingual_v2" }),
        },
      );
      const type = res.headers.get("content-type") ?? "";
      const detail = res.ok ? `${(await res.arrayBuffer()).byteLength} байт` : (await res.text()).slice(0, 300);
      return Response.json({ voice: id, status: res.status, type, detail });
    }

    if (url.pathname === "/panel") {
      const index = await getIndex(env);
      const queue = normalizeQueue(await getQueue(env));
      const items = queue
        .filter((q) => index[q.i])
        .map((q) => ({ i: q.i, g: q.g, h: q.h, t: q.t, s: !!index[q.i].s, d: index[q.i].d ?? null }));
      const payload = JSON.stringify(items).replace(/</g, "\\u003c");
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Гермес — очередь</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#0e1116;color:#dfe3ea;font:15px/1.45 -apple-system,system-ui,sans-serif}
.wrap{max-width:680px;margin:0 auto;padding:14px}h1{font-size:18px;margin:6px 0 2px}.sub{color:#8a93a3;font-size:13px;margin-bottom:10px}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.tab{border:1px solid #2a3140;border-radius:16px;padding:5px 11px;font-size:13px;cursor:pointer;background:#151a22}
.tab.on{background:#2b5cd9;border-color:#2b5cd9;color:#fff}
.row{display:flex;gap:9px;align-items:flex-start;padding:9px 0;border-bottom:1px solid #1b212c}
.st{width:20px;flex:none;text-align:center}.tt{flex:1;min-width:0}.tt a{color:#dfe3ea;text-decoration:none}.tt a:hover{text-decoration:underline}
.meta{color:#77808f;font-size:12px}.badge{display:inline-block;border-radius:9px;padding:0 7px;font-size:11px;margin-left:6px;background:#232a36;color:#9aa4b5}
button{flex:none;border:0;border-radius:9px;background:#2b5cd9;color:#fff;padding:6px 11px;font-size:13px;cursor:pointer}
button[disabled]{background:#232a36;color:#77808f}.done .tt,.done .meta{opacity:.45}
</style>
<div class="wrap"><h1>Очередь разбора</h1><div class="sub" id="stats"></div><div class="tabs" id="tabs"></div><div id="list"></div></div>
<script>
const ITEMS=${payload};
const KEY=new URLSearchParams(location.search).get("key");
const LANES=[["все",null],["деньги",["launch","niche"]],["навык",["skill"]],["себя",["self"]],["актуальное",["news"]],["обещания",["grift"]]];
const GN={launch:"капитал",niche:"ниша",skill:"навык",self:"себя",news:"актуальное",grift:"обещание"};
let cur=null;
const closed=ITEMS.filter(x=>x.d==="done"||x.d==="do"||x.d==="drop").length;
const heard=ITEMS.filter(x=>x.s&&!x.d).length;
document.getElementById("stats").textContent=\`всего \${ITEMS.length} · закрыто \${closed} · прослушано без решения \${heard} · не тронуто \${ITEMS.length-closed-heard}\`;
const tabs=document.getElementById("tabs");
LANES.forEach(([name,gs],k)=>{const b=document.createElement("div");b.className="tab"+(k===0?" on":"");b.textContent=name;
b.onclick=()=>{cur=gs;[...tabs.children].forEach(c=>c.classList.remove("on"));b.classList.add("on");render()};tabs.appendChild(b)});
function icon(x){if(x.d==="done"||x.d==="do")return "✅";if(x.d==="drop")return "🚱";if(x.d==="later")return "🕒";if(x.s)return "🎧";return "▫️"}
function render(){
  const list=document.getElementById("list");list.innerHTML="";
  ITEMS.filter(x=>!cur||cur.includes(x.g)).forEach(x=>{
    const r=document.createElement("div");r.className="row"+((x.d==="done"||x.d==="do"||x.d==="drop")?" done":"");
    const closedRow=x.d==="done"||x.d==="do"||x.d==="drop";
    r.innerHTML=\`<div class="st">\${icon(x)}</div><div class="tt"><a href="https://x.com/i/status/\${x.i}" target="_blank">\${x.t||("@"+(x.h||x.i))}</a><div class="meta">@\${x.h||"?"}<span class="badge">\${GN[x.g]||x.g||""}</span></div></div>\`;
    const b=document.createElement("button");
    b.textContent=closedRow?"закрыто":(x.s?"ещё раз":"разобрать");
    if(closedRow)b.disabled=true;
    b.onclick=async()=>{b.disabled=true;b.textContent="⏳";
      const res=await fetch(\`/voice?key=\${encodeURIComponent(KEY)}&bg=1&id=\${x.i}\`).then(r=>r.json()).catch(()=>null);
      b.textContent=res&&res.queued?"в очереди ✓":"ошибка";};
    r.appendChild(b);list.appendChild(r);
  });
}
render();
</script>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (url.pathname === "/speak" && request.method === "POST") {
      const meta = await env.VAULT.get("meta", "json");
      if (!meta?.owner_chat_id) return Response.json({ error: "owner unknown" }, { status: 409 });
      const j = await request.json();
      if (!j?.title || !j?.script) return Response.json({ error: "title and script required" }, { status: 400 });
      if (j.script.length > 25000) return Response.json({ error: "script too long" }, { status: 400 });
      await enqueueJob(env, { type: "speak", chatId: meta.owner_chat_id, title: String(j.title).slice(0, 100), script: j.script, texts: (j.texts ?? []).slice(0, 6).map((t) => String(t).slice(0, 3900)) });
      return Response.json({ queued: j.title });
    }

    if (url.pathname === "/retell") {
      const meta = await env.VAULT.get("meta", "json");
      if (!meta?.owner_chat_id) return Response.json({ error: "owner unknown" }, { status: 409 });
      const rid = url.searchParams.get("id");
      if (!/^\d{6,20}$/.test(rid ?? "")) return Response.json({ error: "id required" }, { status: 400 });
      await enqueueJob(env, { type: "retell", chatId: meta.owner_chat_id, id: rid });
      return Response.json({ queued: rid });
    }

    if (url.pathname === "/readurl") {
      const meta = await env.VAULT.get("meta", "json");
      if (!meta?.owner_chat_id) return Response.json({ error: "owner unknown" }, { status: 409 });
      const target = url.searchParams.get("url");
      if (!/^https?:\/\//.test(target ?? "")) return Response.json({ error: "url required" }, { status: 400 });
      await enqueueJob(env, { type: "ingest", chatId: meta.owner_chat_id, url: target });
      return Response.json({ accepted: true });
    }

    if (url.pathname === "/markseen" && request.method === "POST") {
      // Пометить показанным без отправки — лечит «уже слышал» после тестовых прогонов.
      const ids = await request.json();
      if (!Array.isArray(ids)) return Response.json({ error: "array of ids" }, { status: 400 });
      const index = await getIndex(env);
      const now = new Date().toISOString();
      let marked = 0;
      for (const id of ids.map(String)) if (index[id] && !index[id].s) { index[id].s = now; marked++; }
      await putIndex(env, index);
      const queue = normalizeQueue(await getQueue(env));
      const next = pickSpoken(queue, index);
      const nt = next ? await env.VAULT.get(`tweet:${next.i}`, "json") : null;
      return Response.json({ marked, next: nt?.summary ?? next?.i ?? null });
    }

    if (url.pathname === "/quiz") {
      const meta = await env.VAULT.get("meta", "json");
      if (!meta?.owner_chat_id) return Response.json({ error: "owner unknown" }, { status: 409 });
      const qid = url.searchParams.get("id");
      if (!qid) return Response.json({ error: "id required" }, { status: 400 });
      await startQuiz(env, meta.owner_chat_id, qid);
      return Response.json({ started: qid });
    }

    if (url.pathname === "/voice") {
      const meta = await env.VAULT.get("meta", "json");
      if (!meta?.owner_chat_id) return Response.json({ error: "owner unknown" }, { status: 409 });
      const opts = {
        id: url.searchParams.get("id"),
        n: Number(url.searchParams.get("n")) || 0,
        dry: url.searchParams.get("dry") === "1", // прогон без отметки в индексе
      };
      // bg=1 — через очередь: надёжно при любой длине конвейера и рваной сети
      if (url.searchParams.get("bg") === "1") {
        await enqueueJob(env, { type: "spoken", chatId: meta.owner_chat_id, opts });
        return Response.json({ queued: true });
      }
      const sent = await sendSpoken(env, meta.owner_chat_id, opts);
      return Response.json({ sent });
    }

    if (url.pathname === "/digest") {
      const kind = url.searchParams.get("kind") === "weekly" ? "weekly" : "daily";
      const sent = await sendDigest(kind, env);
      return Response.json({ sent });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const kind = event.cron === WEEKLY_CRON ? "weekly" : "daily";
    ctx.waitUntil(sendDigest(kind, env));
  },

  // Консюмер очереди: сюда уходит всё долгое (разбор+озвучка), лимит 15 минут.
  async queue(batch, env) {
    for (const msg of batch.messages) {
      const j = msg.body ?? {};
      try {
        if (j.type === "spoken") await sendSpoken(env, j.chatId, j.opts ?? {});
        else if (j.type === "ingest") await ingestWebArticle(env, j.chatId, j.url);
        else if (j.type === "retell") await retellJob(env, j.chatId, j.id);
        else if (j.type === "speak") await speakJob(env, j.chatId, j);
      } catch (e) {
        console.log(`queue job failed: ${e?.stack ?? e}`);
      }
      msg.ack();
    }
  },
};

// Долгую работу из вебхука только в очередь: waitUntil живёт ~30с, конвейер — 40–60с.
async function enqueueJob(env, job) {
  if (env.JOBS) return env.JOBS.send(job);
  console.log("JOBS binding missing, running inline");
  if (job.type === "spoken") return sendSpoken(env, job.chatId, job.opts ?? {});
  if (job.type === "ingest") return ingestWebArticle(env, job.chatId, job.url);
}

// ---------- KV index ----------

async function getIndex(env) {
  return (await env.VAULT.get("index", "json")) ?? {};
}
async function putIndex(env, index) {
  await env.VAULT.put("index", JSON.stringify(index));
}

// ---------- Telegram ----------

async function tg(env, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.log(`tg ${method} failed: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function handleUpdate(update, env) {
  if (update.callback_query) return void (await handleCallback(update.callback_query, env));

  const msg = update.message; // только личные сообщения: каналы/эхо ботов зацикливаются
  if (!msg || !msg.chat || msg.from?.is_bot) return;

  const meta = (await env.VAULT.get("meta", "json")) ?? { owner_chat_id: null };
  if (meta.owner_chat_id == null) {
    meta.owner_chat_id = msg.chat.id;
    await env.VAULT.put("meta", JSON.stringify(meta));
  }
  if (msg.chat.id !== meta.owner_chat_id) return; // чужих игнорируем

  const text = [msg.text, msg.caption].filter(Boolean).join(" ").trim();
  // /команда и /команда@имябота из меню автодополнения
  const cmd = (text.split(/\s+/)[0] || "").replace(/@[A-Za-z0-9_]+$/, "").toLowerCase();
  const LANE_CMD = { "/money": "капитал", "/niche": "ниша", "/skill": "навык", "/self": "себя", "/news": "актуальное", "/grift": "разбор" };

  if (cmd === "/go")
    return void (await enqueueJob(env, { type: "spoken", chatId: meta.owner_chat_id, opts: {} }));
  if (LANE_CMD[cmd])
    return void (await enqueueJob(env, { type: "spoken", chatId: meta.owner_chat_id, opts: { lane: LANE_CMD[cmd] } }));
  if (cmd === "/panel")
    return void (await tg(env, "sendMessage", {
      chat_id: meta.owner_chat_id,
      text: `🗂 Панель очереди (личная ссылка):\n${env.PUBLIC_URL ?? ""}/panel?key=${env.WEBHOOK_SECRET}`,
      link_preview_options: { is_disabled: true },
    }));
  if (cmd === "/help" || cmd === "/start")
    return void (await tg(env, "sendMessage", { chat_id: meta.owner_chat_id, text: HELP }));

  // «го» — следующая по приоритету; «го капитал» / «го себя» — из нужной дорожки
  const call = /^(?:\/voice|го|дай|давай)(?:\s+(.+))?$/i.exec(text);
  if (call) {
    const word = (call[1] ?? "").trim().toLowerCase().replace(/[уи]$/, "а");
    const lane = word ? Object.keys(LANES).find((k) => k.startsWith(word.slice(0, 5))) ?? null : null;
    // Слово не похоже на дорожку — считаем его ником автора: «го levelsio»
    const author = !lane && word ? call[1].trim().replace(/^@/, "") : null;
    return void (await enqueueJob(env, { type: "spoken", chatId: meta.owner_chat_id, opts: { lane, author } }));
  }
  if (cmd === "/digest") return void (await sendDigest("daily", env, true));
  if (cmd === "/weekly") return void (await sendDigest("weekly", env, true));
  if (cmd === "/lanes" || text === "/дорожки") {
    const index = await getIndex(env);
    const queue = normalizeQueue(await getQueue(env));
    const left = (goals) =>
      queue.filter((q) => goals.includes(q.g) && index[q.i] && !index[q.i].s).length;
    const rows = Object.entries(LANES).map(([name, goals]) => `${name}: ${left(goals)}`);
    return void (await tg(env, "sendMessage", {
      chat_id: meta.owner_chat_id,
      text: `Осталось по дорожкам —\n${rows.join("\n")}\n\nЗвать так: «го капитал», «го себя».`,
    }));
  }
  if (cmd === "/stats" || /^статы?$/i.test(text)) {
    const index = await getIndex(env);
    const queue = normalizeQueue(await getQueue(env));
    const inQ = queue.filter((q) => index[q.i]);
    const heard = inQ.filter((q) => index[q.i].s).length;
    const done = inQ.filter((q) => ["done", "do"].includes(index[q.i].d)).length;
    const drop = inQ.filter((q) => index[q.i].d === "drop").length;
    const later = inQ.filter((q) => index[q.i].d === "later").length;
    const lanes = [
      ["💰 деньги", ["launch", "niche"]],
      ["🧠 навык", ["skill"]],
      ["🫀 себя", ["self"]],
      ["📰 актуальное", ["news"]],
      ["🔍 обещания", ["grift"]],
    ].map(([label, gs]) => {
      const items = inQ.filter((q) => gs.includes(q.g));
      const closed = items.filter((q) => ["done", "do", "drop"].includes(index[q.i].d)).length;
      return `${label}: ${closed}/${items.length}`;
    });
    return void (await tg(env, "sendMessage", {
      chat_id: meta.owner_chat_id,
      text:
        `📊 Очередь разбора: ${inQ.length}\n` +
        `🎧 прослушано: ${heard} · ✅ закрыто: ${done} · 🚱 мусор: ${drop} · 🕒 позже: ${later}\n\n` +
        `Закрыто по дорожкам:\n${lanes.join("\n")}\n\n` +
        `Всего в vault: ${Object.keys(index).length} (вне очереди — шум и «мимо целей»)`,
    }));
  }

  const ids = (await extractTweetIds(text)).slice(0, MAX_LINKS_PER_MSG);
  if (ids.length === 0) {
    const webUrls = (text.match(/https?:\/\/\S+/g) ?? [])
      .map((u) => u.replace(/[)\].,!?]+$/, ""))
      .filter((u) => !/(?:x\.com|twitter\.com)\//i.test(u) && !isShortener(u));
    if (webUrls.length) {
      for (const u of webUrls.slice(0, 2)) await enqueueJob(env, { type: "ingest", chatId: msg.chat.id, url: u });
      return;
    }
    if (text) await tg(env, "sendMessage", { chat_id: msg.chat.id, text: HELP });
    return;
  }

  const index = await getIndex(env);
  let added = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    if (index[id]) { skipped++; continue; }
    const data = await fetchTweet(id);
    if (!data) { failed++; continue; }
    const t = data.tweet ?? data;
    await env.VAULT.put(`raw:${id}`, JSON.stringify(data));
    await env.VAULT.put(`tweet:${id}`, JSON.stringify(normalize({
      id,
      url: t.url ?? `https://x.com/i/status/${id}`,
      author: t.author?.screen_name ?? t.user_screen_name ?? null,
      name: t.author?.name ?? t.user_name ?? null,
      text: t.text ?? "",
      date: t.created_at ?? null,
    })));
    index[id] = { a: new Date().toISOString(), s: null };
    added++;
  }
  if (added) await putIndex(env, index);

  // Одна ссылка = «разбери сейчас»: сохранили — и сразу выпуск, без лишних отчётов.
  if (ids.length === 1 && failed === 0)
    return void (await enqueueJob(env, { type: "spoken", chatId: msg.chat.id, opts: { id: ids[0] } }));

  const parts = [];
  if (added) parts.push(`✓ в vault: ${added}`);
  if (skipped) parts.push(`уже было: ${skipped}`);
  if (failed) parts.push(`⚠️ не прочитал: ${failed}`);
  parts.push(`всего: ${Object.keys(index).length}`);
  await tg(env, "sendMessage", { chat_id: msg.chat.id, text: parts.join(" · ") });
}

// ---------- «Гермес говорит» ----------

// Очередь — заранее посчитанный список id (сигнал первым), кладётся через POST /queue.
// Так воркер не перебирает тысячи записей: один get вместо тысячи подзапросов.
async function getQueue(env) {
  return (await env.VAULT.get("queue", "json")) ?? [];
}

// Очередь хранится как [{i: id, g: цель}]; старый формат (голые id) тоже понимаем.
export function normalizeQueue(queue) {
  return (queue ?? []).map((q) => (typeof q === "string" ? { i: q, g: null, t: null } : q));
}

// Дорожка для «ещё про это» под конкретным разбором
export const GOAL_LANE = { launch: "капитал", niche: "ниша", skill: "навык", self: "себя", news: "актуальное", grift: "разбор" };

export const LANES = {
  капитал: ["launch", "niche"],
  ниша: ["niche"],
  навык: ["skill"],
  себя: ["self"],
  актуальное: ["news"],
  разбор: ["grift"], // посты-обещания: понять приём, а не поверить
};

// lane — дорожка, author — кусок ника («го levelsio»)
export function pickSpoken(queue, index, { lane = null, author = null } = {}) {
  const goals = lane ? LANES[lane] : null;
  const needle = author?.toLowerCase();
  return (
    normalizeQueue(queue).find(
      (q) =>
        index[q.i] &&
        !index[q.i].s &&
        (!goals || goals.includes(q.g)) &&
        (!needle || (q.h ?? "").toLowerCase().includes(needle)),
    ) ?? null
  );
}

// В vault текст обрезан до 2000 символов — для статьи это одно вступление.
// Перед разбором добираем полный текст из fxtwitter: статья, длинный пост, цитата.
function articleText(article) {
  return (article?.content?.blocks ?? [])
    .map((b) => (b.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

// Видео из поста: скачиваем mp4 (fxtwitter отдаёт прямую ссылку) и расшифровываем
// через OpenAI. Иначе разбор судит ролик по подписи — именно так родился фейковый
// разбор capybarin3. Расшифровка кэшируется в KV (vtr:<id>), запись не критична.
function videoUrls(t) {
  const own = t?.media?.videos?.filter((v) => v.type !== "gif").map((v) => v.url) ?? [];
  const vx = (t?.media_extended ?? []).filter((m) => m.type === "video").map((m) => m.url);
  const quoted = t?.quote?.media?.videos?.filter((v) => v.type !== "gif").map((v) => v.url) ?? [];
  return [...new Set([...own, ...vx, ...quoted])];
}

async function transcribeVideo(env, url) {
  try {
    const vres = await fetch(url);
    if (!vres.ok) return null;
    const buf = await vres.arrayBuffer();
    if (buf.byteLength > 24_000_000) return null; // лимит whisper — 25 МБ
    for (const model of ["gpt-4o-mini-transcribe", "whisper-1"]) {
      const form = new FormData();
      form.append("file", new Blob([buf], { type: "video/mp4" }), "video.mp4");
      form.append("model", model);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: form,
      });
      if (res.ok) return (await res.json()).text ?? null;
      console.log(`transcribe ${model}: ${res.status} ${(await res.text()).slice(0, 150)}`);
    }
  } catch (e) {
    console.log(`transcribe error: ${e}`);
  }
  return null;
}

async function fullText(env, id, fallback) {
  const data = await fetchTweet(id);
  const t = data?.tweet ?? data;
  if (!t) return { full: fallback ?? "", mediaNote: "" };
  const parts = [
    t.article ? `${t.article.title ?? ""}\n${articleText(t.article)}` : "",
    t.article ? "" : (t.text ?? ""),
    t.quote ? `\n\nЦитирует @${t.quote.author?.screen_name ?? "?"}: ${t.quote.article ? articleText(t.quote.article) : (t.quote.text ?? "")}` : "",
  ];

  // Медиа не разбираем — но обязаны подсветить, что оно есть и его стоит открыть.
  const vids = videoUrls(t);
  const photos = (t.media?.photos ?? []).length + (t.quote?.media?.photos ?? []).length;
  const dur = t.media?.videos?.[0]?.duration;
  const mm = dur ? `${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, "0")}` : null;
  const mediaBits = [];
  if (vids.length) mediaBits.push(`🎞 видео${mm ? ` ${mm}` : ""}${vids.length > 1 ? ` ×${vids.length}` : ""}`);
  if (photos) mediaBits.push(`🖼 фото ×${photos}`);
  const mediaNote = mediaBits.length ? `${mediaBits.join(" · ")} — открой оригинал` : "";

  if (vids.length) {
    if (env.TRANSCRIBE_VIDEO === "1") {
      let tr = await env.VAULT.get(`vtr:${id}`, "text").catch(() => null);
      if (tr == null) {
        tr = await transcribeVideo(env, vids[0]);
        if (tr) await env.VAULT.put(`vtr:${id}`, tr).catch(() => {});
      }
      if (tr) parts.push(`\n\n[Суть поста — видео. Автоматическая расшифровка звука:]\n${tr.slice(0, 12000)}`);
      else parts.push("\n\n[В посте есть видео, расшифровать не удалось: содержание ролика НЕИЗВЕСТНО.]");
    } else {
      parts.push(`\n\n[В посте есть видео${mm ? ` (${mm})` : ""}. Содержимое ролика НЕ смотрели: не пересказывай его, а одной фразой отметь, что его стоит открыть в оригинале.]`);
    }
  }
  if (photos) parts.push(`\n\n[В посте ${photos} фото/скриншотов — детали могут быть в них, отметь это одной фразой, если текст на них ссылается.]`);

  const full = parts.join("").trim();
  return { full: full.length > (fallback ?? "").length ? full : (fallback ?? ""), mediaNote };
}

// Один вызов chat completions → распарсенный JSON или null.
// У gpt-5-семейства регулируем глубину рассуждения; старые модели параметр не знают.
async function llmJson(env, messages, effort = "medium") {
  const model = env.OPENAI_MODEL ?? "gpt-5.5";
  const body = { model, response_format: { type: "json_object" }, messages };
  if (/^(gpt-5|o\d)/.test(model)) body.reasoning_effort = env.OPENAI_EFFORT ?? effort;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.log(`openai failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const json = await res.json();
  try {
    return JSON.parse(json.choices?.[0]?.message?.content ?? "{}");
  } catch {
    return null;
  }
}

const EDITOR_SYSTEM = [
  "Ты редактор разборов. Тебе дают исходный пост и черновик разбора в JSON",
  "{script, summary, points, steps}. Проверь черновик по чек-листу и перепиши слабое:",
  "(1) ФАКТЫ: каждое число, сумма, срок и название в черновике обязаны быть в исходнике.",
  "Выдуманное — убрать или заменить точным из текста. Если в исходнике есть сильные числа,",
  "а в черновике их нет — верни их.",
  "(2) points: каждая строка несёт число, название или механику; строка без конкретики",
  "переписывается или выбрасывается.",
  "(3) steps: начинаются с глагола, первый выполним за 30–60 минут одним заходом,",
  "привязан к его случаю (соло, вечер после работы, продукт почти готов, аудитории нет).",
  "(4) Пустышки вычеркнуть: «автор утверждает», «в этом посте», «ИИ меняет правила игры»,",
  "«работать умнее», «изучить тему» и всё, что подошло бы к сотне других постов.",
  "(5) script: длина соразмерна исходнику (короткий твит 90–140 слов, статья 250–350), живая",
  "устная русская речь на «ты», три хода — что сделал/утверждает, на чём держится, как применить;",
  "без эмодзи и разметки.",
  "(6) ОЗВУЧКА: в script числа, валюты и единицы — словами по-русски («пятьдесят тысяч долларов",
  "в месяц», не «$50k/mo»), аббревиатуры раскрыты (MRR → месячная выручка). В points и summary",
  "цифры остаются цифрами.",
  "(7) ВИДЕО: если в исходнике сказано, что видео не расшифровано, черновик НЕ имеет права",
  "пересказывать содержание ролика — только слова автора поста; выдумки про видео вычеркнуть.",
  "(8) РАЗМЕР: для короткой заметки points пусты и шаг один; раздутый шаг («за 30–60 минут",
  "проверь скриншот») сожми до честного размера дела.",
  "Верни ТОТ ЖЕ формат JSON {script, summary, points, steps} целиком, уже исправленный.",
].join(" ");

// Портрет читателя лежит в KV под ключом "profile" (см. docs/PROFILE.example.md).
// Без него разбор пишется для абстрактного читателя и получается заметно слабее.
const DEFAULT_PROFILE =
  "Читатель не указан. Пиши разбор для человека, который хочет применить прочитанное " +
  "на практике сегодня, а не пополнить коллекцию заметок.";

async function systemPrompt(env, noise) {
  const profile = (await env.VAULT.get("profile", "text")) ?? DEFAULT_PROFILE;
  const base = SCRIPT_SYSTEM.replace("{{PROFILE}}", profile);
  return noise >= 2 ? `${base} ${GRIFT_MODE}` : base;
}

async function writeScript(env, t, noise = 0) {
  const system = noise >= 2 ? `${SCRIPT_SYSTEM} ${GRIFT_MODE}` : SCRIPT_SYSTEM;
  const source = (t.full ?? t.text ?? "").slice(0, 20000);
  const marks = [
    t.tags?.length ? `разметка: ${t.tags.join(", ")}` : "",
    t.value != null ? `ценность ${t.value}/10` : "",
    t.verdict ? `вердикт: ${t.verdict}` : "",
  ].filter(Boolean).join(" · ");

  // Проход 1: писатель.
  const draft = await llmJson(env, [
    { role: "system", content: system },
    {
      role: "user",
      content:
        `Автор: @${t.author ?? "?"}\n` +
        (t.summary ? `Как это уже помечено: ${t.summary}\n` : "") +
        (marks ? `${marks}\n` : "") +
        (t.apply ? `Предложенное действие из разметки: ${t.apply}\n` : "") +
        `\nТекст поста целиком:\n${source}`,
    },
  ], "medium");
  if (!draft?.script) return null;

  // Тест забираем из того же вызова (статья уже в контексте — отдельный запрос не нужен),
  // редактору его не показываем, чтобы не жечь токены на прогон теста туда-обратно.
  // Порог: короткой заметке тест не положен, что бы модель ни вернула.
  const quiz = source.length >= 900 ? validQuizBank(draft.quiz) : [];
  delete draft.quiz;

  // Проход 2: редактор сверяет черновик с исходником (факты, конкретика, пустышки).
  const edited = await llmJson(env, [
    { role: "system", content: EDITOR_SYSTEM },
    {
      role: "user",
      content: `Исходник:\n${source.slice(0, 9000)}\n\nЧерновик:\n${JSON.stringify(draft)}`,
    },
  ], "low");

  const parsed = edited?.script ? edited : draft; // редактор упал — остаёмся с черновиком
  const lines = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 5) : []);
  return {
    script: String(parsed.script),
    summary: String(parsed.summary ?? draft.summary ?? ""),
    points: lines(parsed.points ?? draft.points),
    steps: lines(parsed.steps ?? draft.steps),
    quiz,
  };
}

function validQuizBank(v) {
  if (!Array.isArray(v)) return [];
  const goodQ = (q) => q?.q && Array.isArray(q.o) && q.o.length === 3 && q.c >= 0 && q.c <= 2;
  return v
    .map((variant) => (Array.isArray(variant) ? variant.filter(goodQ).slice(0, 3) : []))
    .filter((variant) => variant.length === 3)
    .slice(0, 2);
}

// Ключ может быть выдан без права voices_read — тогда список голосов не прочитать,
// поэтому по умолчанию берём голос из настройки, а не из аккаунта.
const DEFAULT_VOICE = "pNInz6obpgDQGcFmaJgB";

async function voiceId(env) {
  if (env.VOICE_ID) return env.VOICE_ID;
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY },
  });
  if (!res.ok) return DEFAULT_VOICE;
  const json = await res.json();
  return json.voices?.[0]?.voice_id ?? DEFAULT_VOICE;
}

// opus — нативное голосовое телеграма, mp3 — обычный аудиофайл.
// Страховка произношения: модель обязана писать числа словами, но если что-то
// проскочило — чиним регекспами до озвучки («$50k» читалось как «50 кей»).
export function speechify(s) {
  // \b не работает с кириллицей (ASCII-границы), поэтому свои look-around'ы.
  const rules = [
    [/\$\s?(\d+(?:[.,]\d+)?)\s*[kк](?![0-9a-zа-яё])/gi, "$1 тысяч долларов"],
    [/\$\s?(\d+(?:[.,]\d+)?)\s*(?:млн|million|m)(?![0-9a-zа-яё])/gi, "$1 миллионов долларов"],
    [/(^|[^0-9a-zа-яё$])(\d+(?:[.,]\d+)?)\s*[kк](?![0-9a-zа-яё])/gi, "$1$2 тысяч"],
    [/\$\s?(\d+(?:[.,]\d+)?)/g, "$1 долларов"],
    [/(^|[^a-zа-яё])(?:mrr|мрр)(?![a-zа-яё])/gi, "$1месячная выручка"],
    [/(^|[^a-zа-яё])arr(?![a-zа-яё])/gi, "$1годовая выручка"],
    [/\s?\/\s?(?:mo|мес|month)(?![a-zа-яё])/gi, " в месяц"],
    [/\s?\/\s?(?:yr|год|year)(?![a-zа-яё])/gi, " в год"],
    [/(^|[^a-zа-яё])в мес\.?(?![a-zа-яё])/gi, "$1в месяц"],
    [/(^|[^a-zа-яё])b2b(?![a-zа-яё0-9])/gi, "$1би-ту-би"],
    [/(^|[^a-zа-яё])b2c(?![a-zа-яё0-9])/gi, "$1би-ту-си"],
    [/(^|[^a-zа-яё])mvp(?![a-zа-яё0-9])/gi, "$1эм-ви-пи"],
  ];
  let t = String(s);
  for (const [re, rep] of rules) t = t.replace(re, rep);
  return t;
}

const FORMATS = {
  voice: ["opus_48000_64", "voice", "audio/ogg", "hermes.ogg"],
  audio: ["mp3_44100_128", "audio", "audio/mpeg", "hermes.mp3"],
};

// Голос: основной провайдер — ElevenLabs (тариф Creator, ~77 разборов/мес на
// multilingual v2). Если квота кончилась или запрос упал — тихий откат на OpenAI
// (~2 цента за разбор), чтобы выпуск пришёл всегда.
async function speakOpenAI(env, text, mode) {
  try {
  const [, kind, mime, name] = FORMATS[mode] ?? FORMATS.voice;
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: env.TTS_MODEL_OPENAI ?? "gpt-4o-mini-tts",
      voice: env.OPENAI_VOICE ?? "onyx",
      input: text,
      response_format: kind === "voice" ? "opus" : "mp3",
      instructions: "Говори по-русски, спокойно и по-дружески, живой разговорной интонацией, чуть быстрее обычного. Не торжественно, без пафоса диктора.",
    }),
  });
  if (res.ok) return { bytes: await res.arrayBuffer(), kind, mime, name, prov: "openai" };
  console.log(`openai tts failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return null;
  } catch (e) { console.log(`openai tts error: ${e}`); return null; }
}

async function speakEleven(env, text, mode) {
  try {
  const id = await voiceId(env);
  if (!id) return null;
  const [format, kind, mime, name] = FORMATS[mode] ?? FORMATS.voice;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=${format}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": env.ELEVENLABS_API_KEY },
      body: JSON.stringify({ text, model_id: env.TTS_MODEL ?? "eleven_multilingual_v2" }),
    },
  );
  if (res.ok) return { bytes: await res.arrayBuffer(), kind, mime, name, prov: "elevenlabs" };
  console.log(`elevenlabs ${format} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return null;
  } catch (e) { console.log(`elevenlabs error: ${e}`); return null; }
}

async function speak(env, text, mode = "voice") {
  if ((env.TTS_PROVIDER ?? "openai") === "openai") return speakOpenAI(env, text, mode);
  return (await speakEleven(env, text, mode)) ?? speakOpenAI(env, text, mode);
}

async function tgUpload(env, method, chatId, audio, extra = {}) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(audio.kind, new Blob([audio.bytes], { type: audio.mime }), audio.name);
  for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    body: form,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) console.log(`tg ${method} failed: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function sendAudioMessage(env, chatId, audio, t) {
  return tgUpload(
    env,
    audio.kind === "voice" ? "sendVoice" : "sendAudio",
    chatId,
    audio,
    audio.kind === "audio"
      ? { title: (t.summary ?? "Гермес говорит").slice(0, 60), performer: "Гермес" }
      : {},
  );
}

function decisionKeyboard(id, hasQuiz = true, lane = null) {
  return {
    inline_keyboard: [
      hasQuiz
        ? [{ text: "📝 тест — закрыть тему", callback_data: `t:${id}` }]
        : [{ text: "✅ понял, закрыто", callback_data: `d:done:${id}` }],
      [
        { text: "🕒 позже", callback_data: `d:later:${id}` },
        { text: "🚱 мусор", callback_data: `d:drop:${id}` },
      ],
      lane
        ? [
            { text: "▶️ ещё про это", callback_data: `more:${lane}` },
            { text: "🎲 любую", callback_data: "more" },
          ]
        : [
            { text: "▶️ ещё одну", callback_data: "more" },
            { text: "💰 деньги", callback_data: "more:капитал" },
          ],
      [
        { text: "🧠 навык", callback_data: "more:навык" },
        { text: "🫀 себя", callback_data: "more:себя" },
        { text: "🔍 обещания", callback_data: "more:разбор" },
      ],
    ],
  };
}

// ---------- Тест на усвоение ----------
// «Прочитано» = сдал тест по содержанию: 3 вопроса, проходной 2. Активное
// вспоминание — единственный честный способ закрыть закладку, а не «прослушал».

const QUIZ_SYSTEM = [
  "Составь проверку усвоения поста: РОВНО 3 вопроса по СОДЕРЖАНИЮ — числа, механика,",
  "главный вывод. Не про форму и не про автора. У каждого вопроса 3 варианта, ровно один",
  "правильный; неверные — правдоподобные (близкие числа, соседние понятия из того же текста).",
  "Вопрос до 120 символов, вариант до 38. По-русски.",
  'Верни JSON {"questions":[{"q":"...","o":["...","...","..."],"c":0}]} где c — индекс правильного.',
].join(" ");

// Всё состояние теста живёт в callback_data кнопок ("q:<id>:<qi><oi>:<ответы>:<правильные>"),
// поэтому ходу теста не нужна ни одна запись в KV — дневной лимит его не ломает.
async function startQuiz(env, chatId, id) {
  const t = await env.VAULT.get(`tweet:${id}`, "json");
  if (!t) return void (await tg(env, "sendMessage", { chat_id: chatId, text: "Не нашёл эту закладку в vault." }));

  // Обычный путь: банк из двух вариантов собран ещё при разборе — отдаём мгновенно,
  // чередуя варианты по числу попыток. LLM здесь не нужен.
  let qs = null;
  if (t.quizBank?.length) {
    const attempt = t.quizAttempts ?? 0;
    qs = t.quizBank[attempt % t.quizBank.length];
    t.quizAttempts = attempt + 1;
    await env.VAULT.put(`tweet:${id}`, JSON.stringify(t)).catch(() => {});
  } else {
    // Запасной путь для старых выпусков без банка: генерим один раз и сохраняем.
    const src = await fullText(env, id, t.text);
    if (src.full.length < 900)
      return void (await tg(env, "sendMessage", {
        chat_id: chatId,
        text: "Тут проверять нечего — короткая заметка. Понял и закрыл?",
        reply_markup: { inline_keyboard: [[{ text: "✅ понял, закрыто", callback_data: `d:done:${id}` }, { text: "🚱 мусор", callback_data: `d:drop:${id}` }]] },
      }));
    const gen = await llmJson(env, [
      { role: "system", content: QUIZ_SYSTEM },
      { role: "user", content: `Текст поста:\n${src.full.slice(0, 12000)}` },
    ], "low");
    qs = (gen?.questions ?? []).filter((q) => q?.q && Array.isArray(q.o) && q.o.length === 3 && q.c >= 0 && q.c <= 2).slice(0, 3);
    if (qs.length === 3) {
      t.quizBank = [qs];
      t.quizAttempts = 1;
      await env.VAULT.put(`tweet:${id}`, JSON.stringify(t)).catch(() => {});
    }
  }
  if (!qs || qs.length < 3) return void (await tg(env, "sendMessage", { chat_id: chatId, text: "Не смог собрать тест — попробуй ещё раз." }));

  const letters = ["А", "Б", "В"];
  const text =
    `📝 Тест: ${(t.summary ?? "").slice(0, 60)}\n\n` +
    qs.map((q, i) => `${i + 1}) ${q.q}\n${q.o.map((o, j) => `${letters[j]}. ${o}`).join("\n")}`).join("\n\n") +
    "\n\nПроходной: 2 из 3.";
  await tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: quizKeyboard(id, qs.map((q) => q.c).join(""), "---"),
  });
}

function quizKeyboard(id, cor, ans) {
  const letters = ["А", "Б", "В"];
  const rows = [];
  for (let qi = 0; qi < 3; qi++) {
    if (ans[qi] !== "-") {
      rows.push([{ text: `${qi + 1} · ответ принят`, callback_data: "noop" }]);
    } else {
      rows.push(letters.map((L, oi) => ({ text: `${qi + 1} · ${L}`, callback_data: `q:${id}:${qi}${oi}:${ans}:${cor}` })));
    }
  }
  return { inline_keyboard: rows };
}

async function handleQuizAnswer(env, cq, chatId, id, qi, oi, ans, cor) {
  if (ans[qi] !== "-")
    return void (await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "На этот вопрос уже отвечено" }));
  const next = ans.substring(0, qi) + String(oi) + ans.substring(qi + 1);
  const correct = String(oi) === cor[qi];
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: correct ? "✅ верно" : "❌ мимо" });

  if (next.includes("-")) {
    await tg(env, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: cq.message.message_id,
      reply_markup: quizKeyboard(id, cor, next),
    });
    return;
  }

  // Все три отвечены — итог считается прямо из кнопки, база не нужна.
  let score = 0;
  const marks = [];
  for (let i = 0; i < 3; i++) {
    const ok = next[i] === cor[i];
    if (ok) score++;
    marks.push(`${i + 1}) ${ok ? "✅" : "❌"}`);
  }
  await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: cq.message.message_id,
    text: `${cq.message.text}\n\nИтог: ${marks.join("  ")} — ${score}/3`,
  });

  const passed = score >= 2;
  const quiz = { r: score };
  if (passed) {
    const t = await env.VAULT.get(`tweet:${id}`, "json");
    if (t) {
      t.decision = "done";
      t.quiz = { score: quiz.r, at: new Date().toISOString() };
      await env.VAULT.put(`tweet:${id}`, JSON.stringify(t)).catch(() => {});
    }
    const index = await getIndex(env);
    if (index[id]) {
      index[id].d = "done";
      if (!index[id].s) index[id].s = new Date().toISOString();
      await putIndex(env, index).catch(() => {});
    }
    const queue = normalizeQueue(await getQueue(env));
    const left = queue.filter((x) => index[x.i] && !index[x.i].s && !index[x.i].d).length;
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `🎉 ${quiz.r}/3 — усвоено, закладка закрыта.\nОсталось в очереди: ${left}`,
      reply_markup: { inline_keyboard: [[{ text: "▶️ ещё одну", callback_data: "more" }, { text: "💰 деньги", callback_data: "more:капитал" }]] },
    });
  } else {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: `${quiz.r}/3 — суть пока мимо. Переслушай выпуск и сдай ещё раз: проходной 2 из 3.`,
      reply_markup: { inline_keyboard: [[{ text: "📝 ещё раз", callback_data: `t:${id}` }, { text: "🚱 мусор", callback_data: `d:drop:${id}` }]] },
    });
  }
}

async function sendSpoken(env, chatId, opts = {}) {
  const index = await getIndex(env);
  const queue = normalizeQueue(await getQueue(env));
  const item = opts.id ? { i: opts.id, n: opts.n ?? 0 } : pickSpoken(queue, index, opts);
  const id = item?.i ?? null;
  if (!id) {
    await tg(env, "sendMessage", {
      chat_id: chatId,
      text: opts.author
        ? `Про «${opts.author}» непоказанного не осталось.`
        : opts.lane
          ? `В дорожке «${opts.lane}» разобрано всё.`
          : "Очередь пуста — сигнал разобран весь.",
    });
    return false;
  }

  const t = await env.VAULT.get(`tweet:${id}`, "json");
  if (!t) return { error: "нет записи в vault", id };

  // Мгновенный отклик: без него 40 секунд сборки выглядят как «кнопка не работает».
  await tg(env, "sendChatAction", { chat_id: chatId, action: "record_voice" });
  const wait = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: `⏳ Собираю разбор (~40 сек): ${String(t.summary ?? "@" + (t.author ?? "?")).slice(0, 70)}\n${t.url ?? ""}`,
    link_preview_options: { is_disabled: true },
  });
  const unwait = async () => {
    if (wait?.result?.message_id)
      await tg(env, "deleteMessage", { chat_id: chatId, message_id: wait.result.message_id });
  };

  try {
  const src = await fullText(env, id, t.text);
  const written = await writeScript(env, { ...t, full: src.full }, item.n ?? 0);
  if (!written) {
    await unwait();
    await tg(env, "sendMessage", { chat_id: chatId, text: "Не смог собрать разбор — модель молчит." });
    return { error: "модель не ответила", id };
  }

  let audio = await speak(env, speechify(written.script), env.AUDIO_MODE === "audio" ? "audio" : "voice");
  const left = Math.max(0, queue.filter((q) => index[q.i] && !index[q.i].s).length - 1);

  // Звук идёт отдельным сообщением: у подписи к voice лимит 1024 символа,
  // а разбор со ссылкой и действием в него не помещается.
  if (audio) {
    let res = await sendAudioMessage(env, chatId, audio, t);
    // Приватность телеграма может запрещать голосовые от ботов — тогда шлём файлом.
    if (!res.ok && /VOICE_MESSAGES_FORBIDDEN/.test(res.description ?? "")) {
      audio = await speak(env, written.script, "audio");
      res = audio ? await sendAudioMessage(env, chatId, audio, t) : { ok: false };
    }
    if (!res.ok) {
      await unwait();
      await tg(env, "sendMessage", { chat_id: chatId, text: `⚠️ Озвучка не отправилась: ${esc(res.description ?? "ошибка телеграма")}` });
      return { error: "телеграм не принял звук", id, tg: JSON.stringify(res).slice(0, 200) };
    }
    await unwait();
  }

  // Короткая заметка = микрокарточка: суть + одно действие. Никаких списков
  // и «Как внедрить» — форма не должна весить больше содержимого.
  const shortPost = src.full.length < 900;
  let middle;
  if (shortPost) {
    const act = written.steps[0] ?? t.apply;
    middle = act ? `\n→ ${esc(act)}\n` : "";
  } else {
    const points = written.points.length
      ? `\n${written.points.slice(0, 4).map((p) => `— ${esc(p)}`).join("\n")}\n`
      : "";
    const steps = written.steps.length
      ? `\n<b>Как внедрить</b>\n${written.steps.map((s, i) => `${i + 1}. ${esc(s)}`).join("\n")}\n`
      : t.apply
        ? `\n→ ${esc(t.apply)}\n`
        : "";
    middle = points + steps;
  }

  const body =
    `<b>${esc(t.summary ?? `@${t.author ?? "?"}`)}</b>\n` +
    `${esc(written.summary)}\n` +
    middle +
    (src.mediaNote ? `\n${src.mediaNote}\n` : "") +
    `\n${t.url}` +
    (queue.length ? `\n<i>осталось в очереди: ${left}</i>` : "") +
    (audio ? "" : `\n\n<i>(озвучка не собралась, вот текст)</i>\n${esc(written.script)}`);

  let sent = await tg(env, "sendMessage", {
    chat_id: chatId,
    text: body.length > 4000 ? body.slice(0, 3990) + "\n…" : body,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: decisionKeyboard(id, (written.quiz?.length ?? 0) > 0, GOAL_LANE[item.g] ?? null),
  });
  if (!sent.ok) {
    // чаще всего — битый HTML после обрезки: перешлём без разметки, но перешлём
    sent = await tg(env, "sendMessage", {
      chat_id: chatId,
      text: body.replace(/<[^>]+>/g, "").slice(0, 3990),
      link_preview_options: { is_disabled: true },
      reply_markup: decisionKeyboard(id, (written.quiz?.length ?? 0) > 0, GOAL_LANE[item.g] ?? null),
    });
  }
  if (!audio) await unwait();
  if (!sent.ok) {
    await tg(env, "sendMessage", { chat_id: chatId, text: "⚠️ Разбор собрался, но телеграм не принял сообщение." });
    return { error: "телеграм не принял текст", id, audio: audio ? audio.kind : null };
  }

  // Банк тестов сохраняем вместе с закладкой: кнопка «тест» отдаёт его мгновенно и бесплатно.
  if (written.quiz?.length) {
    t.quizBank = written.quiz;
    t.quizAttempts = 0;
    await env.VAULT.put(`tweet:${id}`, JSON.stringify(t)).catch(() => {});
  }

  if (!opts.dry && index[id]) {
    index[id].s = new Date().toISOString();
    await putIndex(env, index);
  }
  return { id, audio: audio ? audio.kind : null, tts: audio?.prov ?? null };
  } catch (e) {
    console.log(`sendSpoken crashed: ${e?.stack ?? e}`);
    await unwait();
    await tg(env, "sendMessage", { chat_id: chatId, text: `⚠️ Разбор упал по пути: ${esc(String(e).slice(0, 140))}. Попробуй ещё раз.` });
    return { error: "crash", id };
  }
}

const DECISION_LABEL = { do: "🎯 в дело", done: "✅ закрыто", later: "🕒 потом", drop: "🚱 мусор" };

async function handleCallback(cq, env) {
  const chatId = cq.message?.chat?.id;
  const meta = await env.VAULT.get("meta", "json");
  if (!chatId || !meta?.owner_chat_id || chatId !== meta.owner_chat_id) return;

  if (cq.data?.startsWith("more")) {
    const lane = cq.data.split(":")[1] ?? null;
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id });
    await enqueueJob(env, { type: "spoken", chatId, opts: { lane } });
    return;
  }

  const pl = /^p:(\d+)$/.exec(cq.data ?? "");
  if (pl) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "🎧 Ставлю разбор в очередь…" });
    await enqueueJob(env, { type: "spoken", chatId, opts: { id: pl[1] } });
    return;
  }

  const tq = /^t:(\d+)$/.exec(cq.data ?? "");
  if (tq) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Собираю тест…" });
    await startQuiz(env, chatId, tq[1]);
    return;
  }

  const qa = /^q:(\d+):([0-2])([0-2]):([0-2-]{3}):([0-2]{3})$/.exec(cq.data ?? "");
  if (qa) {
    await handleQuizAnswer(env, cq, chatId, qa[1], Number(qa[2]), Number(qa[3]), qa[4], qa[5]);
    return;
  }
  if (/^q:/.test(cq.data ?? ""))
    return void (await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "Тест пересобран — нажми «📝 тест» заново" }));

  const m = /^d:(do|done|later|drop):(\d+)$/.exec(cq.data ?? "");
  if (!m) return void (await tg(env, "answerCallbackQuery", { callback_query_id: cq.id }));
  const [, decision, id] = m;

  const t = await env.VAULT.get(`tweet:${id}`, "json");
  if (t) {
    t.decision = decision;
    t.decided_at = new Date().toISOString();
    await env.VAULT.put(`tweet:${id}`, JSON.stringify(t));
  }
  const index = await getIndex(env);
  if (index[id]) {
    index[id].d = decision;
    await putIndex(env, index);
  }

  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: DECISION_LABEL[decision] });
  await tg(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: cq.message.message_id,
    reply_markup: { inline_keyboard: [[{ text: `${DECISION_LABEL[decision]} ✓`, callback_data: "noop" }, { text: "▶️ ещё одну", callback_data: "more" }]] },
  });
}

// ---------- Веб-статьи ----------
// Любая ссылка не на X: тянем читаемый текст через r.jina.ai (без ключа),
// сохраняем в vault и сразу гоним через тот же конвейер разбора и озвучки.

function urlAllowed(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const h = parsed.hostname;
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(h)) return false;
  return true;
}

// Максимум 2 перехода по редиректам, каждый пункт назначения проверяется заново.
async function safeFetch(u, init = {}, maxRedirects = 2) {
  let target = u;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!urlAllowed(target)) return null;
    const res = await fetch(target, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hop === maxRedirects) return null;
      target = new URL(loc, target).toString();
      continue;
    }
    return res;
  }
  return null;
}

async function extractArticle(url) {
  // Основной путь — r.jina.ai (чистый текст без ключа), но он бывает медленным
  // или лимитированным; тогда парсим сырой HTML сами.
  if (!urlAllowed(url)) return null;
  try {
    const r = await fetch("https://r.jina.ai/" + url, {
      headers: { "user-agent": "tweetvault/1.0", "x-return-format": "markdown" },
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) {
      const md = await r.text();
      if (md.length >= 300) {
        const title =
          /^Title:\s*(.+)$/m.exec(md)?.[1] ?? /^#\s+(.+)$/m.exec(md)?.[1] ?? new URL(url).hostname;
        const bodyStart = md.indexOf("Markdown Content:");
        const body = bodyStart > -1 ? md.slice(bodyStart + 17) : md;
        return { title: title.trim().slice(0, 200), text: body.trim().slice(0, 30000) };
      }
    }
    console.log(`jina failed: ${r.status}`);
  } catch (e) {
    console.log(`jina error: ${e}`);
  }
  try {
    const r = await safeFetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; tweetvault/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!r || !r.ok) return null;
    const html = await r.text();
    const title = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1] ?? new URL(url).hostname;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 300) return null;
    return { title: title.trim().slice(0, 200), text: text.slice(0, 30000) };
  } catch {
    return null;
  }
}

async function ingestWebArticle(env, chatId, url) {
  try {
  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  const art = await extractArticle(url);
  if (!art)
    return void (await tg(env, "sendMessage", { chat_id: chatId, text: `Не смог вытащить текст: ${url}` }));
  const id = String(Date.now()); // числовой id — совместим с кнопками и тестом
  const now = new Date().toISOString();
  await env.VAULT.put(
    `tweet:${id}`,
    JSON.stringify(normalize({ id, url, author: new URL(url).hostname, name: art.title, summary: art.title, text: art.text, date: now })),
  );
  const index = await getIndex(env);
  index[id] = { a: now, s: now }; // вне очереди, показана сразу
  await putIndex(env, index);
  await sendSpoken(env, chatId, { id });
  } catch (e) {
    console.log(`ingest crashed: ${e?.stack ?? e}`);
    await tg(env, "sendMessage", { chat_id: chatId, text: `⚠️ Статья не разобралась: ${esc(String(e).slice(0, 140))}` });
  }
}

// ---------- Твиты ----------

export function isShortener(u) {
  return /^https?:\/\/(?:[\w-]+\.)?t\.co\//i.test(u);
}

export async function extractTweetIds(text) {
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  const ids = new Set();
  for (let u of urls) {
    u = u.replace(/[)\].,!?]+$/, "");
    if (isShortener(u)) {
      try {
        const res = await fetch(u, { redirect: "follow" });
        u = res.url || u;
      } catch { /* оставляем как есть */ }
    }
    const m = u.match(/(?:x\.com|twitter\.com)\/[^/]+\/status(?:es)?\/(\d{15,20})/);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

async function fetchTweet(id) {
  for (const base of [
    `https://api.fxtwitter.com/i/status/${id}`,
    `https://api.vxtwitter.com/i/status/${id}`,
  ]) {
    try {
      const res = await fetch(base, { headers: { "user-agent": "tweetvault/1.0" } });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.code && json.code !== 200) continue;
      return json;
    } catch { /* следующий источник */ }
  }
  return null;
}

function normalize(t) {
  return {
    id: t.id,
    url: t.url ?? `https://x.com/i/status/${t.id}`,
    author: t.author ?? null,
    name: t.name ?? null,
    text: t.text ?? t.preview ?? "",
    date: t.date ?? null,
    added_at: t.added_at ?? new Date().toISOString(),
    summary: t.summary ? String(t.summary).slice(0, 300) : null,
    tags: t.tags ?? [],
    value: t.value != null ? Math.max(0, Math.min(10, Number(t.value) || 0)) : null,
    verdict: t.verdict ? String(t.verdict).slice(0, 20) : null,
    apply: t.apply ? String(t.apply).slice(0, 250) : null,
  };
}

// ---------- Дайджесты ----------

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function pickIds(index, count) {
  const ids = Object.keys(index);
  // Непоказанные — ценные первыми (неоценённые считаем средними), вода тонет.
  const unseen = shuffle(ids.filter((id) => !index[id].s))
    .sort((a, b) => (index[b].v ?? 5) - (index[a].v ?? 5));
  const seen = ids
    .filter((id) => index[id].s)
    .sort((a, b) => (index[a].s < index[b].s ? -1 : 1));
  return [...unseen, ...seen].slice(0, count);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const VERDICT_EMOJI = {
  "инсайт": "💡", "инструмент": "🧰", "справка": "📌",
  "вдохновение": "✨", "мем": "🌚", "вода": "🚱",
};

function itemHtml(t) {
  const hook = (t.summary || `@${t.author ?? "?"}${t.name ? ` (${t.name})` : ""}`).slice(0, 140);
  const snippet = (t.text ?? "").replace(/\s+/g, " ").slice(0, 160);
  let meta = "";
  if (t.verdict || t.value != null) {
    const em = VERDICT_EMOJI[t.verdict] ?? "";
    const parts = [
      t.verdict ? `${em} ${t.verdict}`.trim() : null,
      t.value != null ? `${t.value}/10` : null,
    ].filter(Boolean);
    meta = `${esc(parts.join(" · "))}\n`;
  }
  const apply = t.apply ? `→ ${esc(t.apply)}\n` : "";
  return `<b>${esc(hook)}</b>\n${meta}${esc(snippet)}${(t.text ?? "").length > 160 ? "…" : ""}\n${apply}${t.url}`;
}

async function sendDigest(kind, env, manual = false) {
  const meta = await env.VAULT.get("meta", "json");
  if (!meta?.owner_chat_id) return false;

  const index = await getIndex(env);
  const total = Object.keys(index).length;
  if (total === 0) {
    if (manual)
      await tg(env, "sendMessage", { chat_id: meta.owner_chat_id, text: "Vault пуст — пришли ссылки на твиты." });
    return false;
  }

  const count = kind === "weekly" ? 6 : 3;
  const candidates = pickIds(index, count);
  const title = kind === "weekly" ? "🗂 Недельный дайджест" : "☕️ Утренняя доза";

  let body = `${title}\n`;
  const included = []; // помечаем показанными только реально вошедшие в сообщение
  const menu = [];     // кнопки «получить полный разбор» по каждому пункту
  for (const id of candidates) {
    const t = await env.VAULT.get(`tweet:${id}`, "json");
    if (!t) continue;
    const block = `\n${itemHtml(t)}\n`;
    if (body.length + block.length > 3800) break;
    body += block;
    included.push(id);
    menu.push([{ text: `🎧 ${included.length} · ${String(t.summary ?? t.author ?? "").slice(0, 30)}`, callback_data: `p:${id}` }]);
  }
  if (included.length === 0) return false;

  const unseenLeft = Object.keys(index).filter((id) => !index[id].s && !included.includes(id)).length;
  body += `\nВ vault: ${total} · ещё не показано: ${unseenLeft}`;

  const res = await tg(env, "sendMessage", {
    chat_id: meta.owner_chat_id,
    text: body + "\nЖми кнопку — пришлю полный разбор голосом (можно несколько):",
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: menu },
  });
  if (!res.ok) return false;

  const now = new Date().toISOString();
  for (const id of included) index[id].s = now;
  await putIndex(env, index);
  return true;
}
