// GET /api/wall?creator=&quote=   (env HELIUS_API_KEY)
// The wall = the launch wallet's quote-token balance. Holds = memos the engine wrote from that wallet:
//   BEDROCK-HOLD|<unix>|<floor>|<fillPrice>|<quoteSpent>|<bedrockBurned>|<buySig>
//   BEDROCK-WALL|<unix>|<floor>|<wallQuote>   (heartbeat every 30 min)
// Only memos in transactions whose fee payer is the launch wallet itself are trusted.
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NUM = '([-\\d.eE+]+)';
const HOLD = new RegExp(`BEDROCK-HOLD\\|(\\d+)\\|${NUM}\\|${NUM}\\|${NUM}\\|${NUM}\\|([1-9A-HJ-NP-Za-km-z]{32,90})`);
const BEAT = /BEDROCK-WALL\|(\d+)\|/;
const url = () => `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
async function rpc(body) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 429) { await new Promise(s => setTimeout(s, 800 * (i + 1))); continue; }
    if (!r.ok) throw new Error('rpc ' + r.status);
    return r.json();
  }
  throw new Error('rate limited');
}
const payer = x => { const k0 = x?.result?.transaction?.message?.accountKeys?.[0]; return typeof k0 === 'string' ? k0 : k0?.pubkey; };

module.exports = async (req, res) => {
  const creator = String(req.query.creator || ''), quote = String(req.query.quote || '');
  if (!B58.test(creator) || !B58.test(quote)) return res.status(400).json({ error: 'bad params' });
  try {
    const [bal, sigs] = await Promise.all([
      rpc({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [creator, { mint: quote }, { encoding: 'jsonParsed', commitment: 'confirmed' }] }),
      rpc({ jsonrpc: '2.0', id: 2, method: 'getSignaturesForAddress', params: [creator, { limit: 1000, commitment: 'confirmed' }] })
    ]);
    let wall = 0;
    for (const a of bal.result?.value || []) wall += Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmountString || 0);

    const holds = [], beats = [];
    for (const s of sigs.result || []) {
      if (s.err || !s.memo) continue;
      const m = s.memo.match(HOLD);
      if (m && holds.length < 60) holds.push({ sig: s.signature, t: +m[1], floor: +m[2], fill: +m[3], spent: +m[4], burned: +m[5], buySig: m[6] });
      const b = !m && s.memo.match(BEAT);
      if (b && beats.length < 3) beats.push({ sig: s.signature, t: +b[1] });
    }
    // verify fee payer = launch wallet
    const check = [...holds, ...beats.slice(0, 1)], ok = new Set();
    for (let i = 0; i < check.length; i += 20) {
      const chunk = check.slice(i, i + 20);
      const arr = await rpc(chunk.map((h, k) => ({ jsonrpc: '2.0', id: k, method: 'getTransaction', params: [h.sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] })));
      for (const x of Array.isArray(arr) ? arr : []) if (payer(x) === creator && !x.result.meta?.err) ok.add(chunk[x.id].sig);
      if (i + 20 < check.length) await new Promise(r => setTimeout(r, 1000));
    }
    const vh = holds.filter(h => ok.has(h.sig));
    const lastBeat = beats.find(b => ok.has(b.sig));
    const beat = Math.max(lastBeat?.t || 0, vh[0]?.t || 0);
    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
    res.json({ wall, holds: vh, beat });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
};
